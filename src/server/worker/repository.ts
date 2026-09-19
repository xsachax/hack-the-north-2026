import { randomUUID } from "node:crypto";
import { z } from "zod";
import { attemptSchema, evidenceSchema, type Attempt, type RunEvent, type TerminalStatus } from "../../lib/contracts";
import { supportedDemoCriteria } from "../../lib/demo-run";
import { isLegacyCriterion } from "../../lib/criteria";
import { Repository } from "../repository";
import type { ArtifactReference } from "../execution/artifacts";
import { sanitizeEvidence } from "../execution/artifacts";
import type { CloudUsage, PrivateSessionReference } from "../execution/cloud";
import type { ExecutionResult } from "../execution/types";
import { workerExecutionLimits, workerPolicySchema, type WorkerPolicy } from "./config";
import { referenceSchema } from "./session-reference";
import { resultSchema } from "./result";
import { targetScopeSchema, type TargetScope } from "../../lib/target-scope";
import { publicPageUrl } from "../public-page-url";
import type { ContextProvider } from "../workflows/context-provider";
import type { ReproductionDispatch } from "../workflows/reproduction";
import type { CandidateResult } from "../workflows/reproduction-runner";
import { REPRODUCTION_SETUP_STEPS, REPRODUCTION_SIGNATURE } from "../workflows/reproduction-runner";
import { insertRerun } from "../workflows/rerun";
import { ServiceError } from "../errors";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../../lib/public-execution";
import { nativeResourceSchema, type NativeResource } from "../execution/native-resources";
import { mergeNativeResource } from "./native-journal";
import { isRecoveredNativeSessionRetired, type CloudRecoveryResult } from "./cloud-recovery";
import { PUBLIC_EXECUTION_IMPLEMENTATION_READY } from "../public-execution-readiness";

/** Runtime gates can further restrict admission, never override the source-level checkpoint stop. */
export type PublicWorkerAdmission = { enabled: boolean; implementationReady: boolean; controlledEnabled?: boolean };

export class LeaseLostError extends Error {
  constructor() { super("worker_lease_lost"); }
}
export type Claim = {
  jobId: string; ownerId: string; workerId: string; generation: number;
  runId: string; attempt: Attempt; correlationToken: string;
  scenario?: "fixed" | "second-coupon"; controlledSiteId?: "store" | "project-board";
  scope: TargetScope; recovery: boolean; sessionId?: string;
  reproductionCandidateId?: string;
  executionMode: "controlled-fixture" | "public-readonly" | "website";
  executionPolicy?: typeof PUBLIC_EXECUTION_POLICY;
  assetPolicy?: typeof PUBLIC_ASSET_POLICY;
};
const json = (value: unknown): unknown => JSON.parse(z.string().parse(value));
const terminalRemote = (status?: string) => !!status && ["COMPLETED", "ERROR", "TIMED_OUT"].includes(status);
export class WorkerRepository extends Repository {
  readonly policy: WorkerPolicy;
  constructor(dataDir: string, input: Partial<WorkerPolicy> = {}, clock = () => Date.now()) {
    super(dataDir, clock);
    try {
      this.policy = workerPolicySchema.parse(input);
      this.transaction(() => {
        const encoded = JSON.stringify(this.policy);
        this.db.prepare("INSERT OR IGNORE INTO worker_policy VALUES(1, ?, ?)").run(encoded, this.policy.baselineSeconds);
        if (this.db.prepare("SELECT configuration FROM worker_policy WHERE singleton=1").get()?.configuration !== encoded) {
          throw new Error("worker_policy_mismatch");
        }
      });
    } catch (error) { this.close(); throw error; }
  }

  accounting(ownerId?: string) {
    const row = this.db.prepare(`SELECT COALESCE(sum(u.reserved_seconds),0) AS reserved,
      COALESCE(sum(u.consumed_seconds),0) AS consumed, COALESCE(sum(u.released_seconds),0) AS released,
      COALESCE(sum(max(u.reserved_seconds-u.released_seconds,u.consumed_seconds)),0) AS committed
      FROM usage_reservations u JOIN jobs j ON j.id=u.job_id JOIN runs r ON r.id=j.run_id
      ${ownerId ? "WHERE r.owner_id=?" : ""}`).get(...(ownerId ? [ownerId] : []))!;
    return {
      reservedSeconds: z.number().parse(row.reserved), consumedSeconds: z.number().parse(row.consumed),
      releasedSeconds: z.number().parse(row.released), committedSeconds: z.number().parse(row.committed),
      baselineSeconds: ownerId ? 0 : this.policy.baselineSeconds,
    };
  }

  claim(workerId: string, publicAdmission?: PublicWorkerAdmission): Claim | null {
    z.string().min(1).max(128).parse(workerId);
    return this.transaction(() => {
      // Recovery consumes an already occupied slot; never allocate a second browser.
      const expired = this.db.prepare(`SELECT j.id FROM jobs j JOIN launches l ON l.job_id=j.id
        JOIN runs r ON r.id=j.run_id
        WHERE j.status='leased' AND j.lease_expires_at<=? AND l.state NOT IN ('settled','quarantined')
        AND (l.recovery_after IS NULL OR l.recovery_after<=?)
        AND (? OR (r.execution_mode='controlled-fixture'
          AND NOT EXISTS (SELECT 1 FROM native_resources n WHERE n.job_id=j.id)
          AND NOT EXISTS (SELECT 1 FROM native_resource_events n WHERE n.job_id=j.id)))
        ORDER BY j.rowid LIMIT 1`).get(this.now(), this.now(), PUBLIC_EXECUTION_IMPLEMENTATION_READY ? 1 : 0);
      if (expired) return this.acquire(z.string().parse(expired.id), workerId, true);
      const queued = this.db.prepare(`SELECT j.id,r.owner_id,r.execution_mode,r.controlled_site_id,r.scope,a.snapshot,
        r.public_execution_policy,r.public_asset_policy,selection.attempt_id AS context_selection
        FROM jobs j JOIN runs r ON r.id=j.run_id JOIN attempts a ON a.id=j.attempt_id
        LEFT JOIN context_selections selection ON selection.attempt_id=a.id
        LEFT JOIN browser_contexts context ON context.id=selection.context_id
        WHERE j.status='queued' AND j.cancel_requested_at IS NULL
        AND (? OR r.execution_mode!='controlled-fixture')
        AND (context.id IS NULL OR context.revoked=1 OR context.expires_at<=?
          OR (context.held_job IS NULL AND
            (context.status!='persisting' OR context.available_after<=?)))
        AND (r.execution_mode!='controlled-fixture' OR
          (SELECT count(*) FROM launches occupied JOIN jobs held ON held.id=occupied.job_id
           JOIN runs owned ON owned.id=held.run_id
           WHERE occupied.state!='settled' AND owned.owner_id=r.owner_id) < ?)
        ORDER BY j.rowid LIMIT 100`).all(publicAdmission?.controlledEnabled === false ? 0 : 1,
          this.clock(), this.clock(), this.policy.ownerConcurrency);
      for (const row of queued) {
        const attempt = attemptSchema.parse(json(row.snapshot));
        const jobId = z.string().parse(row.id);
        const ownerId = z.string().parse(row.owner_id);
        const reproduction = this.db.prepare("SELECT candidate_id FROM reproduction_worker_jobs WHERE job_id=?").get(jobId);
        const candidate = reproduction ? this.reproductionService().candidateDispatch(z.string().parse(reproduction.candidate_id)) : null;
        if (reproduction && !candidate) {
          this.endQueued(ownerId, jobId, attempt, "cancelled", "reproduction_stopped");
          continue;
        }
        if (candidate && candidate.steps.length + REPRODUCTION_SETUP_STEPS > workerExecutionLimits(this.policy, attempt.limits).maxSteps) {
          this.stopUnallocatedReproduction(candidate.candidateId);
          this.endQueued(ownerId, jobId, attempt, "limit_reached", "budget_exhausted");
          continue;
        }
        const isPublic = row.execution_mode === "website" &&
          row.public_execution_policy === PUBLIC_EXECUTION_POLICY && row.public_asset_policy === PUBLIC_ASSET_POLICY;
        const publicAllowed = PUBLIC_EXECUTION_IMPLEMENTATION_READY && isPublic && publicAdmission?.enabled === true &&
          publicAdmission.implementationReady === true && !row.context_selection && !reproduction &&
          (!attempt.browserState || attempt.browserState.mode === "fresh") &&
          !attempt.criteria.some(isLegacyCriterion);
        if ((!publicAllowed && row.execution_mode !== "controlled-fixture") ||
          (row.execution_mode === "controlled-fixture" && (
          (!row.controlled_site_id && !supportedDemoCriteria(attempt.criteria)) ||
          (row.controlled_site_id === "project-board" && attempt.criteria.some(isLegacyCriterion))))) {
          this.endQueued(ownerId, jobId, attempt, "blocked",
            row.execution_mode !== "controlled-fixture" ? "blocked_unsupported" : "unsupported_criteria");
          continue;
        }

        const count = (owner?: string) => z.number().parse(this.db.prepare(`SELECT count(*) AS n FROM launches l
          JOIN jobs j ON j.id=l.job_id JOIN runs r ON r.id=j.run_id WHERE l.state!='settled'
          ${owner ? "AND r.owner_id=?" : ""}`).get(...(owner ? [owner] : []))?.n);
        if (count() >= this.policy.globalConcurrency) return null;
        if (count(ownerId) >= this.policy.ownerConcurrency) continue;
        const global = this.accounting();
        const owned = this.accounting(ownerId);
        const reserve = this.policy.sessionSeconds;
        if (global.committedSeconds + global.baselineSeconds + reserve > this.policy.developmentBudgetSeconds ||
          owned.committedSeconds + reserve > this.policy.ownerBudgetSeconds ||
          global.reservedSeconds + reserve > this.policy.lifetimeReservationLimitSeconds) {
          if (reproduction) this.stopUnallocatedReproduction(z.string().parse(reproduction.candidate_id));
          this.endQueued(ownerId, jobId, attempt, "limit_reached", "budget_exhausted");
          continue;
        }
        const context = publicAllowed ? undefined : this.contexts.claim({
          ownerId, jobId, attempt, scope: targetScopeSchema.parse(json(row.scope)),
        });
        if (context === "wait") continue;
        if (context === "invalid") {
          this.endQueued(ownerId, jobId, attempt, "blocked", "context_unavailable");
          continue;
        }
        this.db.prepare("UPDATE usage_reservations SET reserved_seconds=? WHERE job_id=?").run(reserve, jobId);
        this.db.prepare("INSERT INTO launches(job_id,correlation_token,state,created_at) VALUES(?,?,'intent',?)")
          .run(jobId, randomUUID(), this.now());
        this.saveAttempt({ ...attempt, status: "running", updatedAt: this.now() });
        this.db.prepare("UPDATE runs SET status='running',updated_at=? WHERE id=?").run(this.now(), attempt.runId);
        this.append(attempt.runId, attempt.id, "attempt.started", { status: "running" });
        return this.acquire(jobId, workerId, false);
      }
      return null;
    });
  }

  claimQuarantined(jobId: string, workerId: string): Claim {
    z.uuid().parse(jobId);
    z.string().min(1).max(128).parse(workerId);
    return this.transaction(() => {
      const row = this.db.prepare("SELECT job_id FROM launches WHERE job_id=? AND state='quarantined'").get(jobId);
      if (!row) throw new Error("job_not_quarantined");
      if (!PUBLIC_EXECUTION_IMPLEMENTATION_READY && this.hasPublicRecoveryState(jobId)) {
        throw new Error("public_recovery_checkpoint_disabled");
      }
      this.db.prepare("UPDATE launches SET recovery_count=0,recovery_after=NULL WHERE job_id=?").run(jobId);
      return this.acquire(jobId, workerId, true);
    });
  }

  hasPublicRecoveryState(jobId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM jobs j JOIN runs r ON r.id=j.run_id WHERE j.id=?
      AND (r.execution_mode!='controlled-fixture'
        OR EXISTS (SELECT 1 FROM native_resources n WHERE n.job_id=j.id)
        OR EXISTS (SELECT 1 FROM native_resource_events n WHERE n.job_id=j.id))`).get(jobId);
  }

  private acquire(jobId: string, workerId: string, recovery: boolean): Claim {
    this.db.prepare(`UPDATE jobs SET status='leased',lease_owner=?,lease_generation=lease_generation+1,lease_expires_at=?
      WHERE id=?`).run(workerId, new Date(this.clock() + this.policy.leaseMs).toISOString(), jobId);
    const row = this.db.prepare(`SELECT j.*,r.owner_id,r.scenario,r.controlled_site_id,r.scope,r.execution_mode,
      r.public_execution_policy,r.public_asset_policy,a.snapshot,l.correlation_token,l.session_reference
      FROM jobs j JOIN runs r ON r.id=j.run_id JOIN attempts a ON a.id=j.attempt_id JOIN launches l ON l.job_id=j.id
      WHERE j.id=?`).get(jobId)!;
    if (recovery) {
      this.db.prepare("UPDATE launches SET state='recovering' WHERE job_id=?").run(jobId);
      this.append(z.string().parse(row.run_id), z.string().parse(row.attempt_id), "attempt.recovering", { reason: "worker_recovery" });
    }
    const ref = row.session_reference ? referenceSchema.parse(json(row.session_reference)) : undefined;
    const reproduction = this.db.prepare("SELECT candidate_id FROM reproduction_worker_jobs WHERE job_id=?").get(jobId);
    return {
      jobId, ownerId: z.string().parse(row.owner_id), workerId,
      generation: z.number().parse(row.lease_generation), runId: z.string().parse(row.run_id),
      attempt: attemptSchema.parse(json(row.snapshot)), correlationToken: z.string().parse(row.correlation_token),
      ...(row.scenario ? { scenario: z.enum(["fixed", "second-coupon"]).parse(row.scenario) } : {}),
      ...(row.controlled_site_id ? { controlledSiteId: z.enum(["store", "project-board"]).parse(row.controlled_site_id) } : {}),
      scope: targetScopeSchema.parse(json(row.scope)), recovery, sessionId: ref?.sessionId,
      executionMode: row.execution_mode === "controlled-fixture" ? "controlled-fixture" :
        row.public_execution_policy === PUBLIC_EXECUTION_POLICY && row.public_asset_policy === PUBLIC_ASSET_POLICY
          ? "public-readonly" : "website",
      ...(row.public_execution_policy === PUBLIC_EXECUTION_POLICY ? { executionPolicy: PUBLIC_EXECUTION_POLICY } : {}),
      ...(row.public_asset_policy === PUBLIC_ASSET_POLICY ? { assetPolicy: PUBLIC_ASSET_POLICY } : {}),
      ...(reproduction ? { reproductionCandidateId: z.string().parse(reproduction.candidate_id) } : {}),
    };
  }

  assertPublicClaim(claim: Claim, admission?: PublicWorkerAdmission): void {
    this.assertLease(claim);
    const row = this.db.prepare(`SELECT r.public_execution_policy,r.public_asset_policy,r.execution_mode
      FROM jobs j JOIN runs r ON r.id=j.run_id
      WHERE j.id=? AND j.run_id=? AND j.attempt_id=? AND r.owner_id=?`)
      .get(claim.jobId, claim.runId, claim.attempt.id, claim.ownerId);
    if (!PUBLIC_EXECUTION_IMPLEMENTATION_READY || !admission?.enabled || !admission.implementationReady || claim.executionMode !== "public-readonly" ||
      claim.executionPolicy !== PUBLIC_EXECUTION_POLICY || claim.assetPolicy !== PUBLIC_ASSET_POLICY ||
      row?.execution_mode !== "website" || row.public_execution_policy !== PUBLIC_EXECUTION_POLICY ||
      row.public_asset_policy !== PUBLIC_ASSET_POLICY || claim.reproductionCandidateId ||
      (claim.attempt.browserState && claim.attempt.browserState.mode !== "fresh") ||
      claim.attempt.criteria.some(isLegacyCriterion) ||
      this.db.prepare("SELECT 1 FROM context_selections WHERE attempt_id=?").get(claim.attempt.id)) {
      throw new Error("blocked_unsupported");
    }
  }

  blockUnsupported(claim: Claim): void {
    this.transaction(() => {
      this.assertLease(claim, true);
      if (this.db.prepare("SELECT 1 FROM native_resources WHERE job_id=?").get(claim.jobId) ||
        this.db.prepare("SELECT session_reference FROM launches WHERE job_id=?").get(claim.jobId)?.session_reference) {
        throw new Error("allocation_already_started");
      }
      this.settle(claim, { allocationAttempted: false, reservedSeconds: this.policy.sessionSeconds,
        elapsedSeconds: 0, actualBrowserSeconds: 0 }, true);
      this.end(claim, "blocked", "blocked_unsupported");
    });
  }

  assertLease(claim: Claim, allowCancelled = false): void {
    const row = this.db.prepare(`SELECT cancel_requested_at FROM jobs
      WHERE id=? AND status='leased' AND lease_owner=? AND lease_generation=? AND lease_expires_at>?`)
      .get(claim.jobId, claim.workerId, claim.generation, this.now());
    if (!row) throw new LeaseLostError();
    if (!allowCancelled && row.cancel_requested_at) throw new DOMException("cancel_requested", "AbortError");
    if (!allowCancelled) this.contexts.assertActive(claim);
    if (!allowCancelled && claim.reproductionCandidateId && !this.reproductionService().candidateDispatch(claim.reproductionCandidateId)) {
      throw new DOMException("reproduction_stopped", "AbortError");
    }
  }

  prepareContext(claim: Claim, provider?: ContextProvider) {
    return this.contexts.prepare(claim, () => this.assertLease(claim), provider);
  }

  retireContext(provider?: ContextProvider): Promise<void> {
    return this.contexts.retireOne(provider);
  }

  takeoverControl(
    claim: Claim,
    assertLease = (allowCancelled = false) => this.assertLease(claim, allowCancelled),
  ) {
    return this.takeovers.executionControl(claim, assertLease);
  }

  reproductionDispatch(claim: Claim): ReproductionDispatch | undefined {
    this.assertLease(claim);
    if (!claim.reproductionCandidateId) return undefined;
    const dispatch = this.reproductionService().candidateDispatch(claim.reproductionCandidateId);
    if (!dispatch || dispatch.ownerId !== claim.ownerId) throw new DOMException("reproduction_stopped", "AbortError");
    const remaining = Math.min(dispatch.maxDurationMs, dispatch.deadline - this.clock() - 5000);
    if (remaining <= 0) throw new DOMException("reproduction_deadline", "AbortError");
    return { ...dispatch, maxDurationMs: remaining };
  }

  pumpReproductions(): void {
    const service = this.reproductionService();
    service.recoverExpired();
    const rows = this.db.prepare(`SELECT w.candidate_id,w.result_json,j.status,l.state
      FROM reproduction_worker_jobs w JOIN jobs j ON j.id=w.job_id
      JOIN reproduction_candidates c ON c.id=w.candidate_id JOIN reproductions r ON r.id=c.reproduction_id
      LEFT JOIN launches l ON l.job_id=j.id
      WHERE r.status='running' AND r.active_candidate=c.id LIMIT 100`).all();
    for (const row of rows) {
      const candidateId = z.string().parse(row.candidate_id);
      const unknown: CandidateResult = {
        outcome: "unknown", signature: null, cleanup: row.state ? "unknown" : "confirmed",
        environment: "uncertain", sessionIdentity: "",
      };
      if (row.result_json && row.state === "settled") {
        const result = z.strictObject({
          outcome: z.enum(["reproduced", "not_reproduced", "unknown"]),
          signature: z.literal(REPRODUCTION_SIGNATURE).nullable(),
          cleanup: z.enum(["confirmed", "unknown"]), environment: z.enum(["trusted_fixture", "uncertain"]),
          sessionIdentity: z.string().max(4096),
        }).parse(json(row.result_json));
        service.completeCandidate(candidateId, result, row.status === "cancelled");
      } else if (["recovering", "quarantined"].includes(String(row.state)) ||
        ["completed", "cancelled"].includes(String(row.status))) {
        service.completeCandidate(candidateId, unknown, row.status === "cancelled");
      }
    }
    const next = service.dispatchNext();
    const pending = service.pendingCandidates();
    if (next && !pending.some((candidate) => candidate.candidateId === next.candidateId)) pending.push(next);
    for (const dispatch of pending) {
      try { this.transaction(() => {
        if (this.db.prepare("SELECT job_id FROM reproduction_worker_jobs WHERE candidate_id=?").get(dispatch.candidateId) ||
          !service.candidateDispatch(dispatch.candidateId)) return;
        if (dispatch.reservationSeconds !== this.policy.sessionSeconds) throw new Error("reproduction_reservation_mismatch");
        const cloned = insertRerun(this.db, this, dispatch.ownerId, `reproduction_${dispatch.candidateId}`, dispatch.sourceRunId, {
          authorizationAcknowledged: true, attemptIds: [dispatch.sourceAttemptId],
        }, this.now());
        if (cloned.created) this.append(cloned.run.id, null, "run.created", {
          status: "queued", reason: "reproduction_candidate",
          commentary: "Deterministic controlled-fixture replay; no persona inference.",
        });
        const attempt = this.attempts(dispatch.ownerId, cloned.run.id)[0];
        const jobId = z.string().parse(this.db.prepare("SELECT id FROM jobs WHERE attempt_id=? AND run_id=?")
          .get(attempt.id, cloned.run.id)?.id);
        this.db.prepare("INSERT INTO reproduction_worker_jobs(candidate_id,job_id) VALUES(?,?)").run(dispatch.candidateId, jobId);
        this.db.prepare(`INSERT INTO takeover_controls(attempt_id,phase,lease_generation)
          VALUES(?,'closed',0)`).run(attempt.id);
      }); } catch (error) {
        if (!(error instanceof ServiceError && error.code === "rate_limited")) throw error;
        this.transaction(() => this.stopUnallocatedReproduction(dispatch.candidateId));
      }
    }
  }

  /** Called within claim/outbox transactions, before any browser allocation. Charges are retained. */
  private stopUnallocatedReproduction(candidateId: string): void {
    if (this.db.prepare(`SELECT 1 FROM reproduction_worker_jobs w JOIN launches l ON l.job_id=w.job_id
      WHERE w.candidate_id=?`).get(candidateId)) throw new Error("reproduction_already_allocated");
    const row = this.db.prepare(`SELECT r.id FROM reproductions r JOIN reproduction_candidates c ON c.reproduction_id=r.id
      WHERE c.id=? AND r.active_candidate=c.id AND r.status='running'`).get(candidateId);
    if (!row) return;
    this.db.prepare(`UPDATE reproduction_candidates SET status='not_started',cleanup='confirmed',finished_at=? WHERE id=?`)
      .run(this.clock(), candidateId);
    this.db.prepare(`UPDATE reproductions SET status='limit_reached',reason='budget_exhausted',
      active_candidate=NULL,deadline=NULL,updated_at=? WHERE id=?`).run(this.clock(), row.id);
  }

  heartbeat(claim: Claim): boolean {
    return this.transaction(() => {
      this.assertLease(claim, true);
      this.db.prepare("UPDATE jobs SET lease_expires_at=? WHERE id=?")
        .run(new Date(this.clock() + this.policy.leaseMs).toISOString(), claim.jobId);
      if (claim.reproductionCandidateId && !this.reproductionService().candidateDispatch(claim.reproductionCandidateId)) {
        this.db.prepare("UPDATE jobs SET cancel_requested_at=COALESCE(cancel_requested_at,?) WHERE id=?").run(this.now(), claim.jobId);
      }
      return !!this.db.prepare("SELECT cancel_requested_at FROM jobs WHERE id=?").get(claim.jobId)?.cancel_requested_at;
    });
  }

  sessionReference(claim: Claim, input: PrivateSessionReference): void {
    const reference = referenceSchema.parse(input);
    this.transaction(() => {
      // Record an early ID even after cancel; cancellation must still clean it up.
      this.assertLease(claim, true);
      const row = this.db.prepare("SELECT session_reference FROM launches WHERE job_id=?").get(claim.jobId)!;
      if (row.session_reference && referenceSchema.parse(json(row.session_reference)).sessionId !== reference.sessionId) {
        throw new Error("launch_session_changed");
      }
      const binding = this.db.prepare("SELECT job_id FROM browser_session_bindings WHERE session_id=?").get(reference.sessionId);
      if (binding && binding.job_id !== claim.jobId) throw new Error("launch_session_mismatch");
      if (claim.executionMode === "public-readonly" &&
        this.nativeResourceSnapshot(claim.jobId)?.sessionId !== reference.sessionId) {
        throw new Error("native_resource_session_mismatch");
      }
      this.db.prepare("INSERT OR IGNORE INTO browser_session_bindings VALUES(?,?)").run(reference.sessionId, claim.jobId);
      this.db.prepare("UPDATE launches SET session_reference=?,state='active' WHERE job_id=?")
        .run(JSON.stringify(reference), claim.jobId);
    });
  }

  nativeResource(claim: Claim, input: Readonly<NativeResource>): undefined {
    const resource = nativeResourceSchema.parse(input);
    try {
      this.transaction(() => {
        this.assertLease(claim, true);
        this.assertNativeBinding(claim);
        const previous = this.nativeResourceSnapshot(claim.jobId);
        const next = previous ? mergeNativeResource(previous, resource) : resource;
        if (!previous && (next.state !== "upload_intent" || next.extensionId ||
          next.sessionId || next.sessionAllocationAttempted)) throw new Error("native_resource_missing_intent");
        this.saveNativeResource(claim.jobId, next);
      });
    } catch (error) {
      if (!(error instanceof LeaseLostError)) throw error;
      // Discovery is deliberately append-only: stale holders cannot touch current
      // snapshots, leases, launch state, accounting, or provider cleanup authority.
      this.transaction(() => {
        this.assertNativeBinding(claim);
        let previous = this.nativeResourceSnapshot(claim.jobId);
        if (!previous) return;
        for (const row of this.db.prepare("SELECT resource FROM native_resource_events WHERE job_id=? ORDER BY sequence").all(claim.jobId)) {
          const discovered = nativeResourceSchema.parse(json(row.resource));
          if (discovered.extensionId || discovered.sessionId) previous = mergeNativeResource(previous, discovered, true);
        }
        const next = mergeNativeResource(previous, resource, true);
        if ((!next.extensionId || previous.extensionId) && (!next.sessionId || previous.sessionId)) return;
        this.db.prepare("INSERT INTO native_resource_events(job_id,resource,created_at) VALUES(?,?,?)")
          .run(claim.jobId, JSON.stringify(next), this.now());
      });
      throw error;
    }
    return undefined;
  }

  private assertNativeBinding(claim: Claim): void {
    const row = this.db.prepare(`SELECT j.lease_generation,j.lease_owner FROM jobs j JOIN runs r ON r.id=j.run_id
      JOIN launches l ON l.job_id=j.id WHERE j.id=? AND j.run_id=? AND j.attempt_id=?
      AND r.owner_id=? AND l.correlation_token=? AND r.public_execution_policy=?
      AND r.public_asset_policy=?`).get(claim.jobId, claim.runId, claim.attempt.id, claim.ownerId,
      claim.correlationToken, PUBLIC_EXECUTION_POLICY, PUBLIC_ASSET_POLICY);
    if (!row || !Number.isInteger(claim.generation) || claim.generation < 1 ||
      Number(row.lease_generation) < claim.generation ||
      (row.lease_generation === claim.generation && row.lease_owner !== null && row.lease_owner !== claim.workerId)) {
      throw new Error("native_resource_binding_mismatch");
    }
  }

  private nativeResourceSnapshot(jobId: string): NativeResource | undefined {
    const row = this.db.prepare("SELECT resource FROM native_resources WHERE job_id=?").get(jobId);
    return row ? nativeResourceSchema.parse(json(row.resource)) : undefined;
  }

  private saveNativeResource(jobId: string, resource: NativeResource): void {
    if (resource.extensionId) {
      const other = this.db.prepare("SELECT job_id FROM native_resources WHERE extension_id=?").get(resource.extensionId);
      if (other && other.job_id !== jobId) throw new Error("native_resource_extension_already_bound");
    }
    this.db.prepare(`INSERT INTO native_resources(job_id,extension_id,resource,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET extension_id=excluded.extension_id,resource=excluded.resource,updated_at=excluded.updated_at`)
      .run(jobId, resource.extensionId ?? null, JSON.stringify(resource), this.now());
    this.db.prepare("INSERT INTO native_resource_events(job_id,resource,created_at) VALUES(?,?,?)")
      .run(jobId, JSON.stringify(resource), this.now());
  }

  reconcileNativeResource(claim: Claim): NativeResource | undefined {
    return this.transaction(() => {
      this.assertLease(claim, true);
      this.assertNativeBinding(claim);
      let resource = this.nativeResourceSnapshot(claim.jobId);
      if (!resource) return;
      const initial = JSON.stringify(resource);
      for (const event of this.db.prepare("SELECT resource FROM native_resource_events WHERE job_id=? ORDER BY sequence").all(claim.jobId)) {
        const discovered = nativeResourceSchema.parse(json(event.resource));
        // Journal history is not a state replay. Only newly discovered identities
        // are folded into the current authoritative snapshot.
        if ((discovered.extensionId && !resource.extensionId) || (discovered.sessionId && !resource.sessionId)) {
          resource = mergeNativeResource(resource, discovered, true);
        } else if ((discovered.extensionId && resource.extensionId !== discovered.extensionId) ||
          (discovered.sessionId && resource.sessionId !== discovered.sessionId) ||
          discovered.archiveSha256 !== resource.archiveSha256) throw new Error("native_resource_identity_changed");
      }
      if (JSON.stringify(resource) !== initial) this.saveNativeResource(claim.jobId, resource);
      return resource;
    });
  }
  nativePredispatchProof(claim: Claim): boolean {
    this.assertLease(claim, true);
    this.assertNativeBinding(claim);
    const resource = this.nativeResourceSnapshot(claim.jobId);
    if (!resource?.extensionId || resource.sessionAllocationAttempted || resource.sessionId) return false;
    const events = this.db.prepare("SELECT resource FROM native_resource_events WHERE job_id=? ORDER BY sequence")
      .all(claim.jobId).map((row) => nativeResourceSchema.parse(json(row.resource)));
    // Every session dispatch requires the synchronous allocated record first.
    // Never interpret an empty provider metadata list as predispatch evidence.
    return events.length > 0 && events[0].state === "upload_intent" &&
      events.every((event) => event.archiveSha256 === resource.archiveSha256 &&
        !event.sessionAllocationAttempted && !event.sessionId) &&
      events.some((event) => event.extensionId === resource.extensionId);
  }

  recordArtifact(claim: Claim, artifact: ArtifactReference, kind: "screenshot" | "observation" | "console"): string {
    return this.persistArtifact(claim, artifact, kind, false);
  }

  recordCleanupArtifact(claim: Claim, artifact: ArtifactReference): string {
    return this.persistArtifact(claim, artifact, "console", true);
  }

  private persistArtifact(claim: Claim, artifact: ArtifactReference, kind: "screenshot" | "observation" | "console", allowCancelled: boolean): string {
    return this.transaction(() => {
      this.assertLease(claim, allowCancelled);
      z.string().regex(/^[a-f0-9]{64}$/).parse(artifact.key);
      const evidence = evidenceSchema.parse({
        id: randomUUID(), runId: claim.runId, attemptId: claim.attempt.id, kind, createdAt: this.now(), summary: `Agent ${kind}`,
      });
      this.db.prepare("INSERT INTO evidence VALUES(?,?,?,?,?)")
        .run(evidence.id, claim.runId, claim.attempt.id, artifact.key, JSON.stringify(evidence));
      this.append(claim.runId, claim.attempt.id, "evidence.recorded", { evidenceId: evidence.id });
      return evidence.id;
    });
  }

  recordStep(claim: Claim, kind: "observation" | "decision" | "action", evidenceId: string, data: RunEvent["data"]): void {
    this.transaction(() => {
      this.assertLease(claim);
      const found = this.db.prepare("SELECT id FROM evidence WHERE id=? AND attempt_id=?").get(evidenceId, claim.attempt.id);
      if (!found) throw new Error("step_evidence_mismatch");
      const ordinal = z.number().parse(this.db.prepare("SELECT COALESCE(max(ordinal),0)+1 AS n FROM attempt_steps WHERE attempt_id=?").get(claim.attempt.id)?.n);
      if (ordinal > 100) throw new Error("step_event_limit");
      this.db.prepare("INSERT INTO attempt_steps VALUES(?,?,?,?)").run(claim.attempt.id, ordinal, kind, evidenceId);
      const { pageUrl: rawPageUrl, ...safeData } = data;
      const pageUrl = rawPageUrl ? publicPageUrl(rawPageUrl) : undefined;
      this.append(claim.runId, claim.attempt.id, `attempt.${kind}`, {
        ...safeData, ...(pageUrl ? { pageUrl } : {}), actor: "agent", evidenceId,
      });
    });
  }

  finish(claim: Claim, result: ExecutionResult, usage: CloudUsage, reproductionResult?: CandidateResult): void {
    const parsed = resultSchema.parse(result);
    const native = claim.executionMode === "public-readonly" ? this.reconcileNativeResource(claim) : undefined;
    this.transaction(() => {
      this.assertLease(claim, true);
      const launch = this.db.prepare(`SELECT l.session_reference,l.usage,u.consumed_seconds FROM launches l
        JOIN usage_reservations u ON u.job_id=l.job_id WHERE l.job_id=?`).get(claim.jobId)!;
      const neverAttempted = usage.allocationAttempted === false;
      const previousAllocation = launch.usage ? z.object({ allocationAttempted: z.boolean().optional() }).parse(json(launch.usage)).allocationAttempted : undefined;
      if (neverAttempted && (launch.session_reference || usage.remoteStatus ||
        previousAllocation === true || z.number().parse(launch.consumed_seconds) > 0 ||
        (usage.actualBrowserSeconds !== undefined && usage.actualBrowserSeconds !== 0) ||
        this.db.prepare("SELECT session_id FROM remote_usage_observations WHERE job_id=? LIMIT 1").get(claim.jobId))) {
        throw new Error("contradictory_allocation_evidence");
      }
      const nativeConfirmed = claim.executionMode !== "public-readonly" ||
        (native ? ["deleted", "not_dispatched"].includes(native.state) : neverAttempted);
      if (neverAttempted && native?.sessionAllocationAttempted) throw new Error("contradictory_allocation_evidence");
      const confirmed = (neverAttempted || terminalRemote(usage.remoteStatus)) && nativeConfirmed;
      if (reproductionResult) {
        if (!claim.reproductionCandidateId) throw new Error("unexpected_reproduction_result");
        if (!launch.session_reference ||
          referenceSchema.parse(json(launch.session_reference)).sessionId !== reproductionResult.sessionIdentity) {
          throw new Error("reproduction_session_mismatch");
        }
        const stored = this.db.prepare("UPDATE reproduction_worker_jobs SET result_json=? WHERE job_id=? AND candidate_id=?")
          .run(JSON.stringify({
            ...reproductionResult,
            cleanup: confirmed && parsed.cleanup.status === "closed" ? reproductionResult.cleanup : "unknown",
          }), claim.jobId, claim.reproductionCandidateId);
        if (stored.changes !== 1) throw new Error("reproduction_job_mismatch");
      }
      this.contexts.settle(claim.jobId, {
        confirmed, neverAllocated: neverAttempted,
        clean: parsed.cleanup.status === "closed" && parsed.cleanup.errors.length === 0,
      });
      if (launch.session_reference && (usage.actualBrowserSeconds !== undefined || confirmed)) {
        this.observeCharge(claim, {
          sessionId: referenceSchema.parse(json(launch.session_reference)).sessionId,
          status: usage.remoteStatus ?? "RUNNING", actualBrowserSeconds: usage.actualBrowserSeconds,
        });
      }
      this.settle(claim, neverAttempted ? { ...usage, actualBrowserSeconds: 0 } : usage, confirmed);
      this.db.prepare("UPDATE launches SET summary=? WHERE job_id=?")
        .run(JSON.stringify(parsed), claim.jobId);
      if (!confirmed) {
        this.deferRecovery(claim);
        return;
      }
      this.end(claim, parsed.cleanup.status === "failed" || parsed.cleanup.errors.length ? "infrastructure_failed" : parsed.status, "execution_complete");
    });
  }

  recover(claim: Claim, outcome: CloudRecoveryResult): void {
    const native = claim.executionMode === "public-readonly" ? this.reconcileNativeResource(claim) : undefined;
    this.transaction(() => {
      this.assertLease(claim, true);
      for (const session of outcome.sessions) this.observeCharge(claim, session);
      const observed = this.db.prepare(`SELECT count(*) AS n, COALESCE(sum(charged_seconds),0) AS charged,
        sum(actual_seconds) AS actual, count(actual_seconds) AS measured, min(terminal) AS terminal
        FROM remote_usage_observations WHERE job_id=?`).get(claim.jobId)!;
      const charged = z.number().parse(observed.charged);
      const predispatch = claim.executionMode === "public-readonly" && outcome.allocationAttempted === false &&
        outcome.nativeResourceConfirmed === true && !!native && !native.sessionAllocationAttempted &&
        !native.sessionId && ["deleted", "not_dispatched"].includes(native.state) &&
        outcome.sessions.length === 0 && observed.n === 0;
      const nativeConfirmed = claim.executionMode !== "public-readonly" ||
        outcome.nativeResourceConfirmed === true && !!native && ["deleted", "not_dispatched"].includes(native.state) &&
        (predispatch || !!native.sessionId && outcome.sessions.some((session) =>
          session.sessionId === native.sessionId && isRecoveredNativeSessionRetired(session)) &&
          outcome.sessions.every(isRecoveredNativeSessionRetired));
      const confirmed = outcome.confirmed && nativeConfirmed && (predispatch ||
        outcome.sessions.length > 0 && observed.terminal === 1 &&
        outcome.sessions.every((s) => terminalRemote(s.status)));
      this.contexts.settle(claim.jobId, {
        confirmed, neverAllocated: predispatch, clean: false, recovered: true,
      });
      const usage: CloudUsage = {
        reservedSeconds: this.policy.sessionSeconds, elapsedSeconds: 0,
        ...(confirmed && !predispatch ? { remoteStatus: outcome.sessions[0].status } : {}),
        ...(predispatch ? { allocationAttempted: false, actualBrowserSeconds: 0 } : {}),
        ...(observed.n && observed.measured === observed.n ? { actualBrowserSeconds: z.number().parse(observed.actual) } : {}),
      };
      // Preserve model counters/startup details from the original process if available.
      const previous = this.db.prepare("SELECT usage FROM launches WHERE job_id=?").get(claim.jobId)?.usage;
      const prior = previous ? z.record(z.string(), z.unknown()).parse(json(previous)) : {};
      const recordedUsage: CloudUsage = { ...prior, ...usage };
      if (observed.n && observed.measured !== observed.n) delete recordedUsage.actualBrowserSeconds;
      if (!confirmed && terminalRemote(recordedUsage.remoteStatus)) delete recordedUsage.remoteStatus;
      this.settle(claim, recordedUsage, confirmed, charged);
      if (confirmed) this.end(claim, "infrastructure_failed", "worker_recovery");
      else this.deferRecovery(claim);
    });
  }

  private observeCharge(claim: Claim, session: { sessionId: string; status: string; actualBrowserSeconds?: number }): void {
    z.string().min(1).max(200).parse(session.sessionId);
    z.enum(["PENDING", "RUNNING", "COMPLETED", "ERROR", "TIMED_OUT"]).parse(session.status);
    const seconds = session.actualBrowserSeconds;
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0 || seconds > Number.MAX_SAFE_INTEGER)) throw new Error("invalid_usage");
    this.db.prepare(`INSERT INTO remote_usage_observations VALUES(?,?,?,?,?)
      ON CONFLICT(job_id,session_id) DO UPDATE SET
      charged_seconds=max(charged_seconds,CASE WHEN excluded.actual_seconds IS NULL AND actual_seconds IS NOT NULL
        THEN actual_seconds ELSE excluded.charged_seconds END),
      actual_seconds=CASE WHEN excluded.actual_seconds IS NULL THEN actual_seconds
        WHEN actual_seconds IS NULL THEN excluded.actual_seconds ELSE max(actual_seconds,excluded.actual_seconds) END,
      terminal=max(terminal,excluded.terminal)`)
      .run(claim.jobId, session.sessionId, seconds ?? this.policy.sessionSeconds, seconds ?? null, terminalRemote(session.status) ? 1 : 0);
  }

  private settle(claim: Claim, usage: CloudUsage, confirmed: boolean, observedCharge = 0): void {
    const seconds = usage.actualBrowserSeconds;
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0)) throw new Error("invalid_usage");
    const consumed = Math.ceil(Math.max(seconds ?? (confirmed ? this.policy.sessionSeconds : 0), observedCharge));
    this.db.prepare(`UPDATE usage_reservations SET consumed_seconds=max(consumed_seconds,?),
      released_seconds=CASE WHEN ? THEN max(0,reserved_seconds-max(consumed_seconds,?)) ELSE 0 END WHERE job_id=?`)
      .run(consumed, confirmed ? 1 : 0, consumed, claim.jobId);
    const privateUsage: Record<string, unknown> = { ...usage };
    delete privateUsage.nativeResource;
    delete privateUsage.nativePolicy;
    delete privateUsage.nativeObservedBrowserVersion;
    this.db.prepare("UPDATE launches SET usage=?,state=? WHERE job_id=?")
    .run(JSON.stringify(sanitizeEvidence(privateUsage)), confirmed ? "settled" : "recovering", claim.jobId);
  }

  private deferRecovery(claim: Claim): void {
    const count = z.number().parse(this.db.prepare("UPDATE launches SET recovery_count=recovery_count+1 WHERE job_id=? RETURNING recovery_count").get(claim.jobId)?.recovery_count);
    if (count >= this.policy.recoveryLimit) {
      this.db.prepare("UPDATE launches SET state='quarantined' WHERE job_id=?").run(claim.jobId);
      this.end(claim, "infrastructure_failed", "cleanup_unconfirmed");
    } else {
      const next = new Date(this.clock() + Math.min(60000, 1000 * 2 ** count)).toISOString();
      this.db.prepare("UPDATE launches SET recovery_after=? WHERE job_id=?").run(next, claim.jobId);
      this.db.prepare("UPDATE jobs SET lease_expires_at=? WHERE id=?").run(this.now(), claim.jobId);
    }
  }

  private end(claim: Claim, outcome: TerminalStatus, reason: RunEvent["data"]["reason"]): void {
    const run = this.getRun(claim.ownerId, claim.runId);
    const existing = this.attempts(claim.ownerId, claim.runId).find((attempt) => attempt.id === claim.attempt.id)!;
    const alreadyTerminal = !["queued", "running"].includes(existing.status);
    const jobCancelled = this.db.prepare("SELECT cancel_requested_at FROM jobs WHERE id=?").get(claim.jobId)?.cancel_requested_at;
    const status = alreadyTerminal ? existing.status :
      (run.cancelRequestedAt || jobCancelled) && outcome !== "infrastructure_failed" ? "cancelled" : outcome;
    this.saveAttempt({ ...claim.attempt, status, updatedAt: this.now() });
    this.db.prepare("UPDATE jobs SET status=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?")
      .run(status === "cancelled" ? "cancelled" : "completed", claim.jobId);
    if (!alreadyTerminal) {
      this.append(claim.runId, claim.attempt.id, "attempt.finished", { status, reason });
      this.reconcile(claim.ownerId, claim.runId);
    }
  }

  private endQueued(ownerId: string, jobId: string, attempt: Attempt, status: TerminalStatus, reason: RunEvent["data"]["reason"]): void {
    this.saveAttempt({ ...attempt, status, updatedAt: this.now() });
    this.db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(jobId);
    this.append(attempt.runId, attempt.id, "attempt.finished", { status, reason });
    this.reconcile(ownerId, attempt.runId);
  }
}
