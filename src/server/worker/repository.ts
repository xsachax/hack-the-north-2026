import { randomUUID } from "node:crypto";
import { z } from "zod";
import { attemptSchema, evidenceSchema, type Attempt, type RunEvent, type TerminalStatus } from "../../lib/contracts";
import { supportedDemoCriteria } from "../../lib/demo-run";
import { Repository } from "../repository";
import type { ArtifactReference } from "../execution/artifacts";
import { sanitizeEvidence } from "../execution/artifacts";
import type { CloudUsage, PrivateSessionReference } from "../execution/cloud";
import type { ExecutionResult } from "../execution/types";
import { workerPolicySchema, type WorkerPolicy } from "./config";
import { referenceSchema } from "./session-reference";
import { resultSchema } from "./result";

export class LeaseLostError extends Error {
  constructor() { super("worker_lease_lost"); }
}
export type Claim = {
  jobId: string; ownerId: string; workerId: string; generation: number;
  runId: string; attempt: Attempt; correlationToken: string;
  scenario: "fixed" | "second-coupon"; recovery: boolean; sessionId?: string;
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

  claim(workerId: string): Claim | null {
    z.string().min(1).max(128).parse(workerId);
    return this.transaction(() => {
      // Recovery consumes an already occupied slot; never allocate a second browser.
      const expired = this.db.prepare(`SELECT j.id FROM jobs j JOIN launches l ON l.job_id=j.id
        WHERE j.status='leased' AND j.lease_expires_at<=? AND l.state NOT IN ('settled','quarantined')
        AND (l.recovery_after IS NULL OR l.recovery_after<=?) ORDER BY j.rowid LIMIT 1`).get(this.now(), this.now());
      if (expired) return this.acquire(z.string().parse(expired.id), workerId, true);
      const queued = this.db.prepare(`SELECT j.id,r.owner_id,r.execution_mode,a.snapshot
        FROM jobs j JOIN runs r ON r.id=j.run_id JOIN attempts a ON a.id=j.attempt_id
        WHERE j.status='queued' AND j.cancel_requested_at IS NULL
        AND (r.execution_mode!='controlled-fixture' OR
          (SELECT count(*) FROM launches occupied JOIN jobs held ON held.id=occupied.job_id
           JOIN runs owned ON owned.id=held.run_id
           WHERE occupied.state!='settled' AND owned.owner_id=r.owner_id) < ?)
        ORDER BY j.rowid LIMIT 100`).all(this.policy.ownerConcurrency);
      for (const row of queued) {
        const attempt = attemptSchema.parse(json(row.snapshot));
        const jobId = z.string().parse(row.id);
        const ownerId = z.string().parse(row.owner_id);
        if (row.execution_mode !== "controlled-fixture" || !supportedDemoCriteria(attempt.criteria)) {
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
          this.endQueued(ownerId, jobId, attempt, "limit_reached", "budget_exhausted");
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
      this.db.prepare("UPDATE launches SET recovery_count=0,recovery_after=NULL WHERE job_id=?").run(jobId);
      return this.acquire(jobId, workerId, true);
    });
  }

  private acquire(jobId: string, workerId: string, recovery: boolean): Claim {
    this.db.prepare(`UPDATE jobs SET status='leased',lease_owner=?,lease_generation=lease_generation+1,lease_expires_at=?
      WHERE id=?`).run(workerId, new Date(this.clock() + this.policy.leaseMs).toISOString(), jobId);
    const row = this.db.prepare(`SELECT j.*,r.owner_id,r.scenario,a.snapshot,l.correlation_token,l.session_reference
      FROM jobs j JOIN runs r ON r.id=j.run_id JOIN attempts a ON a.id=j.attempt_id JOIN launches l ON l.job_id=j.id
      WHERE j.id=?`).get(jobId)!;
    if (recovery) {
      this.db.prepare("UPDATE launches SET state='recovering' WHERE job_id=?").run(jobId);
      this.append(z.string().parse(row.run_id), z.string().parse(row.attempt_id), "attempt.recovering", { reason: "worker_recovery" });
    }
    const ref = row.session_reference ? referenceSchema.parse(json(row.session_reference)) : undefined;
    return {
      jobId, ownerId: z.string().parse(row.owner_id), workerId,
      generation: z.number().parse(row.lease_generation), runId: z.string().parse(row.run_id),
      attempt: attemptSchema.parse(json(row.snapshot)), correlationToken: z.string().parse(row.correlation_token),
      scenario: z.enum(["fixed", "second-coupon"]).parse(row.scenario), recovery, sessionId: ref?.sessionId,
    };
  }

  assertLease(claim: Claim, allowCancelled = false): void {
    const row = this.db.prepare(`SELECT cancel_requested_at FROM jobs
      WHERE id=? AND status='leased' AND lease_owner=? AND lease_generation=? AND lease_expires_at>?`)
      .get(claim.jobId, claim.workerId, claim.generation, this.now());
    if (!row) throw new LeaseLostError();
    if (!allowCancelled && row.cancel_requested_at) throw new DOMException("cancel_requested", "AbortError");
  }

  heartbeat(claim: Claim): boolean {
    return this.transaction(() => {
      this.assertLease(claim, true);
      this.db.prepare("UPDATE jobs SET lease_expires_at=? WHERE id=?")
        .run(new Date(this.clock() + this.policy.leaseMs).toISOString(), claim.jobId);
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
      this.db.prepare("UPDATE launches SET session_reference=?,state='active' WHERE job_id=?")
        .run(JSON.stringify(reference), claim.jobId);
    });
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
      this.append(claim.runId, claim.attempt.id, `attempt.${kind}`, { ...data, actor: "agent", evidenceId });
    });
  }

  finish(claim: Claim, result: ExecutionResult, usage: CloudUsage): void {
    const parsed = resultSchema.parse(result);
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
      const confirmed = neverAttempted || terminalRemote(usage.remoteStatus);
      if (launch.session_reference && (usage.actualBrowserSeconds !== undefined || confirmed)) {
        this.observeCharge(claim, {
          sessionId: referenceSchema.parse(json(launch.session_reference)).sessionId,
          status: usage.remoteStatus ?? "RUNNING", actualBrowserSeconds: usage.actualBrowserSeconds,
        });
      }
      this.settle(claim, neverAttempted ? { ...usage, actualBrowserSeconds: 0 } : usage, confirmed);
      this.db.prepare("UPDATE launches SET summary=? WHERE job_id=?")
        .run(JSON.stringify(sanitizeEvidence(parsed)), claim.jobId);
      if (!confirmed) {
        this.deferRecovery(claim);
        return;
      }
      this.end(claim, parsed.cleanup.status === "failed" || parsed.cleanup.errors.length ? "infrastructure_failed" : parsed.status, "execution_complete");
    });
  }

  recover(claim: Claim, outcome: { confirmed: boolean; sessions: { sessionId: string; status: string; actualBrowserSeconds?: number }[] }): void {
    this.transaction(() => {
      this.assertLease(claim, true);
      for (const session of outcome.sessions) this.observeCharge(claim, session);
      const observed = this.db.prepare(`SELECT count(*) AS n, COALESCE(sum(charged_seconds),0) AS charged,
        sum(actual_seconds) AS actual, count(actual_seconds) AS measured, min(terminal) AS terminal
        FROM remote_usage_observations WHERE job_id=?`).get(claim.jobId)!;
      const charged = z.number().parse(observed.charged);
      const confirmed = outcome.confirmed && outcome.sessions.length > 0 && observed.terminal === 1 &&
        outcome.sessions.every((s) => terminalRemote(s.status));
      const usage: CloudUsage = {
        reservedSeconds: this.policy.sessionSeconds, elapsedSeconds: 0,
        ...(confirmed ? { remoteStatus: outcome.sessions[0].status } : {}),
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
    this.db.prepare("UPDATE launches SET usage=?,state=? WHERE job_id=?")
      .run(JSON.stringify(sanitizeEvidence(JSON.parse(JSON.stringify(usage)))), confirmed ? "settled" : "recovering", claim.jobId);
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
    const status = alreadyTerminal ? existing.status : run.cancelRequestedAt && outcome !== "infrastructure_failed" ? "cancelled" : outcome;
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
