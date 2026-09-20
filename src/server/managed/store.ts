import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import { idempotencyKeySchema, personaSchema, type Persona } from "../../lib/contracts";
import {
  managedCreateSchema, managedProgressSchema, managedResultSchema, managedRunSchema,
  type ManagedAttempt, type ManagedCreate, type ManagedResult, type ManagedRun,
} from "../../lib/managed-contracts";
import { targetScopeSchema } from "../../lib/target-scope";
import { ServiceError } from "../errors";
import { sanitizeEvidence } from "../execution/artifacts";
import { publicPageUrl } from "../public-page-url";
import {
  newWorkerPolicySchema, workerConcurrencyLimits, workerPolicySchema, type WorkerPolicy,
} from "../worker/config";
import type { ManagedClaim, ManagedOutcome } from "./types";

export type { ManagedClaim } from "./types";
type Row = Record<string, SQLOutputValue>;
const json = (value: unknown): unknown => JSON.parse(z.string().parse(value));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const notFound = () => new ServiceError("not_found", 404);
const safeText = (value: string, maximum: number, secrets: readonly string[] = []) =>
  String(sanitizeEvidence(value, secrets)).slice(0, maximum);
const identifier = z.string().trim().min(1).max(256);
const dispatchReferenceSchema = z.strictObject({
  agentId: z.string().min(1).max(256).refine((value) => value.trim().length > 0),
  task: z.string().min(1).max(65536).refine((value) => value.trim().length > 0),
});
const viewSchema = z.strictObject({
  liveViewUrl: z.string().max(8192),
  replayUrl: z.string().max(8192),
}).refine((value) => Object.values(value).filter(Boolean).every((entry) => {
  try {
    const url = new URL(entry);
    return url.protocol === "https:" && !url.username && !url.password &&
      (url.hostname === "browserbase.com" || url.hostname.endsWith(".browserbase.com"));
  } catch { return false; }
}));
const outcomeSchema = z.strictObject({
  status: z.enum(["completed", "failed", "cancelled"]),
  providerStatus: z.string().nullable(),
  cleanup: z.enum(["closed", "unconfirmed"]),
  result: managedResultSchema.nullable(),
  error: z.string().nullable(),
  actualBrowserSeconds: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  allocationAttempted: z.boolean(),
});

export class ManagedStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(work: () => T) => T,
    private readonly clock: () => number,
  ) {}

  existing(owner: string, key: string, input: ManagedCreate): ManagedRun | null {
    const request = managedCreateSchema.parse(input);
    idempotencyKeySchema.parse(key);
    const row = this.db.prepare("SELECT id,request_hash FROM managed_runs WHERE owner_id=? AND idempotency_key=?")
      .get(owner, key);
    if (!row) return null;
    if (row.request_hash !== digest(JSON.stringify(request))) throw new ServiceError("conflict", 409);
    return this.get(owner, z.string().parse(row.id));
  }

  create(owner: string, key: string, input: ManagedCreate, personas: readonly Persona[]): { run: ManagedRun; created: boolean } {
    const request = managedCreateSchema.parse(input);
    idempotencyKeySchema.parse(key);
    return this.transaction(() => {
      const existing = this.existing(owner, key, request);
      if (existing) return { run: existing, created: false };
      const snapshots = request.assignments.map((assignment) => {
        const persona = personas.find((item) => item.id === assignment.personaId);
        if (!persona) throw notFound();
        return personaSchema.parse(persona);
      });
      const id = randomUUID();
      const now = this.now();
      this.db.prepare(`INSERT INTO managed_runs
        (id,owner_id,idempotency_key,request_hash,execution_policy,scope,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(id, owner, key, digest(JSON.stringify(request)), request.executionPolicy,
          JSON.stringify(request.scope), now, now);
      for (const [index, assignment] of request.assignments.entries()) {
        this.db.prepare(`INSERT INTO managed_attempts(id,run_id,persona,goal,criteria,correlation_token)
          VALUES(?,?,?,?,?,?)`).run(randomUUID(), id, JSON.stringify(snapshots[index]), assignment.goal,
            JSON.stringify(assignment.criteria), randomUUID());
      }
      return { run: this.get(owner, id), created: true };
    });
  }

  get(owner: string, id: string): ManagedRun {
    const row = this.db.prepare("SELECT * FROM managed_runs WHERE id=? AND owner_id=?").get(id, owner);
    if (!row) throw notFound();
    const attempts = this.db.prepare("SELECT * FROM managed_attempts WHERE run_id=? ORDER BY rowid")
      .all(id).map((attempt) => this.publicAttempt(attempt));
    const statuses = attempts.map((attempt) => attempt.status);
    const status = statuses.includes("cleanup_required") ? "cleanup_required" :
      statuses.includes("running") ? "running" : statuses.includes("queued") ? "queued" :
        statuses.includes("failed") ? "failed" : statuses.includes("cancelled") ? "cancelled" : "completed";
    return managedRunSchema.parse({
      id: row.id, executionPolicy: row.execution_policy, scope: json(row.scope),
      createdAt: row.created_at, updatedAt: row.updated_at, status, attempts,
    });
  }

  list(owner: string): ManagedRun[] {
    return this.db.prepare("SELECT id FROM managed_runs WHERE owner_id=? ORDER BY cursor DESC LIMIT 30")
      .all(owner).map((row) => this.get(owner, z.string().parse(row.id)));
  }

  cancel(owner: string, id: string): ManagedRun {
    return this.transaction(() => {
      this.get(owner, id);
      const active = this.db.prepare("SELECT id FROM managed_attempts WHERE run_id=? AND state!='settled'").all(id);
      if (!active.length) return this.get(owner, id);
      this.db.prepare("UPDATE managed_runs SET cancel_requested_at=COALESCE(cancel_requested_at,?),updated_at=? WHERE id=?")
        .run(this.clock(), this.now(), id);
      this.db.prepare(`UPDATE managed_attempts SET cancel_requested_at=COALESCE(cancel_requested_at,?)
        WHERE run_id=? AND state!='settled'`).run(this.clock(), id);
      this.db.prepare(`UPDATE managed_attempts SET state='settled',status='cancelled',cleanup='closed',
        actual_browser_seconds=0,finished_at=? WHERE run_id=? AND state='queued'`).run(this.clock(), id);
      return this.get(owner, id);
    });
  }

  view(owner: string, runId: string, attemptId: string): { liveViewUrl: string; replayUrl: string } | null {
    const row = this.db.prepare(`SELECT a.cleanup,a.replay_url FROM managed_attempts a
      JOIN managed_runs r ON r.id=a.run_id WHERE a.id=? AND r.id=? AND r.owner_id=?`).get(attemptId, runId, owner);
    if (!row) throw notFound();
    if (row.cleanup !== "closed" || !row.replay_url) return null;
    return { liveViewUrl: "", replayUrl: z.string().parse(row.replay_url) };
  }

  claim(workerId: string, input: WorkerPolicy): ManagedClaim | null {
    z.string().min(1).max(128).parse(workerId);
    const policy = workerPolicySchema.parse(input);
    return this.transaction(() => {
      this.assertPolicy(policy);
      const expired = this.db.prepare(`SELECT a.id FROM managed_attempts a
        WHERE a.state IN ('reserved','dispatched','quarantined')
        AND (a.lease_expires_at IS NULL OR a.lease_expires_at<=?)
        AND (a.recovery_after IS NULL OR a.recovery_after<=?) AND a.recovery_count<?
        ORDER BY a.rowid LIMIT 1`).get(this.clock(), this.clock(), policy.recoveryLimit);
      if (expired) return this.acquire(z.string().parse(expired.id), workerId, policy, true);
      const concurrency = workerConcurrencyLimits(policy);
      if (this.occupancy() >= concurrency.globalConcurrency) return null;
      const queued = this.db.prepare(`SELECT a.id,a.run_id,r.owner_id FROM managed_attempts a
        JOIN managed_runs r ON r.id=a.run_id WHERE a.state='queued'
        AND a.cancel_requested_at IS NULL AND r.cancel_requested_at IS NULL ORDER BY a.rowid LIMIT 100`).all();
      for (const row of queued) {
        const owner = z.string().parse(row.owner_id);
        if (this.occupancy(owner) >= concurrency.ownerConcurrency) continue;
        const global = this.accounting();
        const owned = this.accounting(owner);
        const reserve = policy.sessionSeconds;
        if (global.committed + policy.baselineSeconds + reserve > policy.developmentBudgetSeconds ||
          owned.committed + reserve > policy.ownerBudgetSeconds ||
          global.reserved + reserve > policy.lifetimeReservationLimitSeconds) {
          this.db.prepare(`UPDATE managed_attempts SET state='settled',status='failed',cleanup='closed',
            actual_browser_seconds=0,error='budget_exhausted',finished_at=? WHERE id=?`).run(this.clock(), row.id);
          this.touch(z.string().parse(row.run_id));
          continue;
        }
        this.db.prepare(`UPDATE managed_attempts SET state='reserved',status='running',
          reserved_seconds=?,started_at=? WHERE id=?`).run(reserve, this.clock(), row.id);
        return this.acquire(z.string().parse(row.id), workerId, policy, false);
      }
      return null;
    });
  }

  assertLease(claim: ManagedClaim, allowCancelled = false): void {
    const row = this.db.prepare(`SELECT a.cancel_requested_at FROM managed_attempts a JOIN managed_runs r ON r.id=a.run_id
      WHERE a.id=? AND a.run_id=? AND r.owner_id=? AND a.correlation_token=?
      AND a.state IN ('reserved','dispatched','quarantined') AND a.lease_owner=? AND a.lease_generation=?
      AND a.lease_expires_at>?`).get(claim.id, claim.runId, claim.ownerId, claim.correlationToken,
        claim.workerId, claim.generation, this.clock());
    if (!row) throw new Error("managed_lease_lost");
    if (!allowCancelled && row.cancel_requested_at !== null) throw new DOMException("cancel_requested", "AbortError");
  }

  heartbeat(claim: ManagedClaim, leaseMs: number): boolean {
    z.int().min(5000).max(120000).parse(leaseMs);
    return this.transaction(() => {
      this.assertLease(claim, true);
      this.db.prepare("UPDATE managed_attempts SET lease_expires_at=? WHERE id=?").run(this.clock() + leaseMs, claim.id);
      return this.row(claim.id).cancel_requested_at !== null;
    });
  }

  dispatch(claim: ManagedClaim, input: { agentId: string; task: string }): void {
    const parsed = dispatchReferenceSchema.safeParse(input);
    if (!parsed.success) throw new Error("managed_dispatch_reference_invalid");
    const reference = parsed.data;
    this.transaction(() => {
      this.assertLease(claim);
      const row = this.row(claim.id);
      // A recovered reservation is cleanup-only, including a crash before the dispatch marker.
      if (claim.recovery || row.recovery_count !== 0) throw new Error("managed_recovery_cannot_dispatch");
      if (row.provider_agent_id !== null && row.provider_agent_id !== reference.agentId ||
        row.provider_task !== null && row.provider_task !== reference.task) {
        throw new Error("managed_dispatch_reference_changed");
      }
      if (row.dispatch_started || row.state !== "reserved") throw new Error("managed_dispatch_already_started");
      this.db.prepare(`UPDATE managed_attempts SET state='dispatched',dispatch_started=1,cleanup='unconfirmed',
        provider_agent_id=?,provider_task=? WHERE id=?`).run(reference.agentId, reference.task, claim.id);
      this.touch(claim.runId);
    });
  }

  identity(claim: ManagedClaim, input: { providerRunId: string; providerSessionId?: string }): void {
    const reference = z.strictObject({ providerRunId: identifier, providerSessionId: identifier.optional() }).parse(input);
    this.transaction(() => {
      // Persist late create responses after cancellation so cleanup can still find the allocation.
      this.assertLease(claim, true);
      const row = this.row(claim.id);
      if (!row.dispatch_started) throw new Error("managed_dispatch_not_started");
      if (row.provider_run_id && row.provider_run_id !== reference.providerRunId ||
        row.provider_session_id && reference.providerSessionId && row.provider_session_id !== reference.providerSessionId) {
        throw new Error("managed_identity_changed");
      }
      this.db.prepare(`UPDATE managed_attempts SET provider_run_id=?,provider_session_id=COALESCE(provider_session_id,?)
        WHERE id=?`).run(reference.providerRunId, reference.providerSessionId ?? null, claim.id);
      this.touch(claim.runId);
    });
  }

  progress(claim: ManagedClaim, input: { id: string; kind: "status" | "text" | "tool" | "error"; text: string }): void {
    const event = z.strictObject({
      id: z.string().min(1).max(4096), kind: managedProgressSchema.shape.kind, text: z.string(),
    }).parse(input);
    this.transaction(() => {
      this.assertLease(claim);
      const hash = digest(event.id);
      if (this.db.prepare("SELECT 1 FROM managed_progress WHERE attempt_id=? AND provider_event_hash=?").get(claim.id, hash)) return;
      const count = z.number().parse(this.db.prepare("SELECT count(*) AS n FROM managed_progress WHERE attempt_id=?").get(claim.id)?.n);
      if (count >= 500) throw new Error("managed_progress_limit");
      this.db.prepare("INSERT INTO managed_progress VALUES(?,?,?,?,?,?)")
        .run(claim.id, hash, count + 1, this.now(), event.kind, safeText(event.text, 2000, this.secrets(this.row(claim.id))));
      if (event.kind === "status" && ["PENDING", "RUNNING", "COMPLETED", "FAILED", "STOPPED", "TIMED_OUT"].includes(event.text)) {
        this.db.prepare("UPDATE managed_attempts SET provider_status=? WHERE id=?").run(event.text, claim.id);
      }
      this.touch(claim.runId);
    });
  }

  sessionView(claim: ManagedClaim, input: { liveViewUrl: string; replayUrl: string }): void {
    const view = viewSchema.parse(input);
    this.transaction(() => {
      this.assertLease(claim);
      if (!this.row(claim.id).provider_run_id) throw new Error("managed_identity_missing");
      this.db.prepare("UPDATE managed_attempts SET live_view_url=?,replay_url=? WHERE id=?")
        .run(view.liveViewUrl, view.replayUrl, claim.id);
      this.touch(claim.runId);
    });
  }

  finish(claim: ManagedClaim, input: ManagedOutcome): void {
    const outcome = outcomeSchema.parse(input);
    this.transaction(() => {
      this.assertLease(claim, true);
      const row = this.row(claim.id);
      const reserved = z.number().parse(row.reserved_seconds);
      const allocated = !!row.dispatch_started || !!row.provider_run_id || outcome.allocationAttempted;
      const previousActual = row.actual_browser_seconds === null ? null : z.number().parse(row.actual_browser_seconds);
      const actual = outcome.actualBrowserSeconds === null ? previousActual :
        Math.max(previousActual ?? 0, outcome.actualBrowserSeconds);
      const closed = outcome.cleanup === "closed";
      const consumed = Math.max(z.number().parse(row.consumed_seconds), Math.ceil(Math.max(actual ?? 0,
        closed && allocated && outcome.actualBrowserSeconds === null ? reserved : 0)));
      const released = closed ? Math.max(0, reserved - consumed) : 0;
      const status = !closed ? "cleanup_required" : row.cancel_requested_at !== null ? "cancelled" : outcome.status;
      const secrets = this.secrets(row);
      const result = outcome.result ? this.safeResult(outcome.result, secrets) : null;
      const retryAfter = this.clock() + Math.min(60_000, 2000 * 2 ** z.number().parse(row.recovery_count));
      this.db.prepare(`UPDATE managed_attempts SET state=?,status=?,cleanup=?,provider_status=?,result=?,error=?,
        actual_browser_seconds=?,consumed_seconds=?,released_seconds=?,lease_owner=NULL,lease_expires_at=NULL,
        recovery_after=?,finished_at=COALESCE(finished_at,?) WHERE id=?`).run(closed ? "settled" : "quarantined", status, outcome.cleanup,
          outcome.providerStatus === null ? null : safeText(outcome.providerStatus, 64, secrets),
          result ? JSON.stringify(result) : null, outcome.error === null ? null : safeText(outcome.error, 2000, secrets),
          actual ?? (closed && !allocated ? 0 : null), consumed, released, closed ? null : retryAfter,
          closed ? this.clock() : null, claim.id);
      this.touch(claim.runId);
    });
  }

  private now(): string { return new Date(this.clock()).toISOString(); }
  private touch(runId: string): void {
    this.db.prepare("UPDATE managed_runs SET updated_at=? WHERE id=?").run(this.now(), runId);
  }
  private row(id: string): Row {
    const row = this.db.prepare("SELECT * FROM managed_attempts WHERE id=?").get(id);
    if (!row) throw new Error("managed_lease_lost");
    return row;
  }
  private secrets(row: Row): string[] {
    return [row.provider_run_id, row.provider_session_id, row.provider_agent_id, row.provider_task,
      row.correlation_token, row.live_view_url, row.replay_url]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
  }
  private safeResult(result: ManagedResult, secrets: readonly string[]): ManagedResult {
    return {
      summary: safeText(result.summary, 4000, secrets),
      finalUrl: publicPageUrl(result.finalUrl, secrets) ?? "",
      criteria: result.criteria.map((item) => ({
        criterion: safeText(item.criterion, 500, secrets), status: item.status,
        observation: safeText(item.observation, 1500, secrets),
      })),
      limitations: result.limitations.map((item) => safeText(item, 500, secrets)),
    };
  }
  private publicAttempt(row: Row): ManagedAttempt {
    const secrets = this.secrets(row);
    return {
      id: z.string().parse(row.id), persona: personaSchema.parse(json(row.persona)), goal: z.string().parse(row.goal),
      criteria: z.array(z.string()).parse(json(row.criteria)), status: managedRunSchema.shape.status.parse(row.status),
      providerStatus: row.provider_status === null ? null : safeText(z.string().parse(row.provider_status), 64, secrets),
      cleanup: z.enum(["not_started", "unconfirmed", "closed"]).parse(row.cleanup),
      cancelRequested: row.cancel_requested_at !== null,
      progress: this.db.prepare("SELECT sequence,timestamp,kind,text FROM managed_progress WHERE attempt_id=? ORDER BY sequence")
        .all(row.id).map((event) => managedProgressSchema.parse({
          ...event, text: safeText(z.string().parse(event.text), 2000, secrets),
        })),
      result: row.result === null ? null : this.safeResult(managedResultSchema.parse(json(row.result)), secrets),
      error: row.error === null ? null : safeText(z.string().parse(row.error), 2000, secrets),
      reservedSeconds: z.number().parse(row.reserved_seconds),
      startedAt: row.started_at === null ? null : new Date(z.number().parse(row.started_at)).toISOString(),
      finishedAt: row.finished_at === null ? null : new Date(z.number().parse(row.finished_at)).toISOString(),
      actualBrowserSeconds: row.actual_browser_seconds === null ? null : z.number().parse(row.actual_browser_seconds),
      modelCalls: null,
    };
  }
  private assertPolicy(policy: WorkerPolicy): void {
    const encoded = JSON.stringify(policy);
    const existing = this.db.prepare("SELECT configuration FROM worker_policy WHERE singleton=1").get();
    if (existing) {
      if (existing.configuration !== encoded) throw new Error("worker_policy_mismatch");
    } else {
      newWorkerPolicySchema.parse(policy);
      this.db.prepare("INSERT INTO worker_policy VALUES(1,?,?)").run(encoded, policy.baselineSeconds);
    }
  }
  private acquire(id: string, workerId: string, policy: WorkerPolicy, recovery: boolean): ManagedClaim {
    this.db.prepare(`UPDATE managed_attempts SET lease_owner=?,lease_generation=lease_generation+1,lease_expires_at=?,
      recovery_count=recovery_count+? WHERE id=?`).run(workerId, this.clock() + policy.leaseMs, recovery ? 1 : 0, id);
    if (recovery) {
      this.db.prepare(`UPDATE managed_attempts SET state='quarantined',status='cleanup_required',cleanup='unconfirmed'
        WHERE id=?`).run(id);
    }
    const row = this.row(id);
    const run = this.db.prepare("SELECT owner_id,scope FROM managed_runs WHERE id=?").get(row.run_id)!;
    this.touch(z.string().parse(row.run_id));
    return {
      id, runId: z.string().parse(row.run_id), ownerId: z.string().parse(run.owner_id), workerId,
      generation: z.number().parse(row.lease_generation), correlationToken: z.string().parse(row.correlation_token),
      persona: personaSchema.parse(json(row.persona)), goal: z.string().parse(row.goal),
      criteria: z.array(z.string()).parse(json(row.criteria)), scope: targetScopeSchema.parse(json(run.scope)),
      reservedSeconds: z.number().parse(row.reserved_seconds), startedAt: z.number().parse(row.started_at),
      recovery, dispatchStarted: row.dispatch_started === 1,
      ...(row.provider_run_id ? { providerRunId: z.string().parse(row.provider_run_id) } : {}),
      ...(row.provider_session_id ? { providerSessionId: z.string().parse(row.provider_session_id) } : {}),
      ...(row.provider_agent_id ? { providerAgentId: z.string().parse(row.provider_agent_id) } : {}),
      ...(row.provider_task ? { providerTask: z.string().parse(row.provider_task) } : {}),
    };
  }
  private occupancy(owner?: string): number {
    return z.number().parse(this.db.prepare(`SELECT count(*) AS n FROM (
      SELECT r.owner_id FROM launches l JOIN jobs j ON j.id=l.job_id JOIN runs r ON r.id=j.run_id WHERE l.state!='settled'
      UNION ALL
      SELECT r.owner_id FROM managed_attempts a JOIN managed_runs r ON r.id=a.run_id WHERE a.state NOT IN ('queued','settled')
      ) occupied ${owner ? "WHERE owner_id=?" : ""}`).get(...(owner ? [owner] : []))?.n);
  }
  private accounting(owner?: string): { reserved: number; committed: number } {
    const row = this.db.prepare(`SELECT COALESCE(sum(reserved_seconds),0) AS reserved,
      COALESCE(sum(max(reserved_seconds-released_seconds,consumed_seconds)),0) AS committed FROM (
      SELECT u.reserved_seconds,u.consumed_seconds,u.released_seconds,r.owner_id FROM usage_reservations u
        JOIN jobs j ON j.id=u.job_id JOIN runs r ON r.id=j.run_id
      UNION ALL
      SELECT a.reserved_seconds,a.consumed_seconds,a.released_seconds,r.owner_id FROM managed_attempts a
        JOIN managed_runs r ON r.id=a.run_id
      ) usage ${owner ? "WHERE owner_id=?" : ""}`).get(...(owner ? [owner] : []))!;
    return { reserved: z.number().parse(row.reserved), committed: z.number().parse(row.committed) };
  }
}
