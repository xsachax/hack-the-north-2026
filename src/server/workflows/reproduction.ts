import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  couponRecipeSchema, DEFAULT_REPRODUCTION_LIMITS, reproductionLimitsSchema, reproductionViewSchema,
  type CouponRecipe, type ReproductionLimits, type ReproductionReason, type ReproductionStatus, type ReproductionView,
} from "../../lib/reproduction-contracts";
import { ServiceError } from "../errors";
import { groundCouponReproduction, type ReproductionSource } from "./reproduction-grounding";
import { exportCouponRegression } from "./reproduction-export";
import { REPRODUCTION_SETUP_STEPS, REPRODUCTION_SIGNATURE, type CandidateInput, type CandidateResult, type CandidateRunner } from "./reproduction-runner";

export const reproductionMigration = `
CREATE TABLE IF NOT EXISTS reproductions (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
  status TEXT NOT NULL, reason TEXT NOT NULL, recipe TEXT, best TEXT,
  limits_json TEXT NOT NULL, candidate_count INTEGER NOT NULL DEFAULT 0,
  steps_charged INTEGER NOT NULL DEFAULT 0, seconds_charged INTEGER NOT NULL DEFAULT 0,
  time_charged INTEGER NOT NULL DEFAULT 0, cursor INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0, active_candidate TEXT, deadline INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, run_id, attempt_id)
);
CREATE TABLE IF NOT EXISTS reproduction_candidates (
  id TEXT PRIMARY KEY, reproduction_id TEXT NOT NULL REFERENCES reproductions(id),
  ordinal INTEGER NOT NULL, steps_json TEXT NOT NULL, status TEXT NOT NULL,
  signature TEXT, cleanup TEXT, session_hash TEXT,
  charged_steps INTEGER NOT NULL, charged_seconds INTEGER NOT NULL, charged_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL, finished_at INTEGER,
  UNIQUE(reproduction_id, ordinal)
);
CREATE INDEX IF NOT EXISTS reproduction_queue ON reproductions(status, created_at);
`;

type Job = {
  id: string; owner_id: string; run_id: string; attempt_id: string;
  status: ReproductionStatus; reason: ReproductionReason;
  recipe: string | null; best: string | null; limits_json: string;
  candidate_count: number; steps_charged: number; seconds_charged: number; time_charged: number;
  cursor: number; cancel_requested: number; active_candidate: string | null; deadline: number | null;
  created_at: number; updated_at: number;
};
export type ReproductionHooks = {
  /** Must authorize owner AND return registered, private raw evidence for this run. */
  loadSource(owner: string, runId: string): ReproductionSource;
  /** Only for runNext's explicitly supplied adapter; durable workers use dispatchNext/completeCandidate. */
  runner?: CandidateRunner;
  /** Existing worker's actual per-allocation reservation, not an elapsed-time estimate. */
  reservationSeconds: number;
  limits?: ReproductionLimits;
  clock?: () => number;
};
export type ReproductionDispatch = Omit<CandidateInput, "signal"> & {
  ownerId: string;
  sourceRunId: string;
  sourceAttemptId: string;
  /** Absolute startup + execution + cleanup ceiling; maxDurationMs separately bounds replay after startup. */
  deadline: number;
};
const NOTICE = "Controlled-store coupon setup only. Fresh seeded mug cart; no secrets or purchases replayed. " +
  "Shortest path FOUND within cumulative limits, not a claim of global minimality. Model calls: zero.";
const candidateResultSchema = z.strictObject({
  outcome: z.enum(["reproduced", "not_reproduced", "unknown"]),
  signature: z.literal(REPRODUCTION_SIGNATURE).nullable(),
  cleanup: z.enum(["confirmed", "unknown"]),
  environment: z.enum(["trusted_fixture", "uncertain"]),
  sessionIdentity: z.string().max(4096),
});

export class ReproductionService {
  private readonly clock: () => number;
  private readonly limits: ReproductionLimits;
  constructor(private readonly db: DatabaseSync, private readonly hooks: ReproductionHooks) {
    this.clock = hooks.clock ?? Date.now;
    this.limits = reproductionLimitsSchema.parse(hooks.limits ?? DEFAULT_REPRODUCTION_LIMITS);
    if (!Number.isSafeInteger(hooks.reservationSeconds) || hooks.reservationSeconds < 1 ||
      hooks.reservationSeconds > 1800 || (hooks.runner !== undefined && typeof hooks.runner !== "function")) {
      throw new Error("Invalid reproduction worker hooks");
    }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private job(id: string, owner?: string): Job {
    const row = owner === undefined
      ? this.db.prepare("SELECT * FROM reproductions WHERE id=?").get(id)
      : this.db.prepare("SELECT * FROM reproductions WHERE id=? AND owner_id=?").get(id, owner);
    if (!row) throw new ServiceError("not_found", 404);
    return row as unknown as Job;
  }
  private view(job: Job): ReproductionView {
    const recipe = job.recipe ? couponRecipeSchema.parse(JSON.parse(job.recipe)) : null;
    const best = job.best ? couponRecipeSchema.parse(JSON.parse(job.best)) : null;
    return reproductionViewSchema.parse({
      id: job.id, runId: job.run_id, attemptId: job.attempt_id, status: job.status, reason: job.reason,
      originalSteps: recipe?.steps.length ?? 0, shortestSteps: best?.steps.length ?? null,
      candidatesAttempted: job.candidate_count, stepsCharged: job.steps_charged, modelCalls: 0,
      reservedSecondsCharged: job.seconds_charged, durationMsCharged: job.time_charged, limits: JSON.parse(job.limits_json),
      exportAvailable: !!best && ["found", "limit_reached"].includes(job.status),
      cancelRequested: !!job.cancel_requested,
      createdAt: new Date(job.created_at).toISOString(), updatedAt: new Date(job.updated_at).toISOString(), notice: NOTICE,
    });
  }

  /** Idempotent for the lifetime of this source attempt; repeated POSTs never refill limits. */
  prepare(owner: string, runId: string, attemptId: string): ReproductionView {
    const source = this.hooks.loadSource(owner, runId);
    if (source.source.run.id !== runId || !source.source.attempts.some((attempt) => attempt.id === attemptId)) {
      throw new ServiceError("not_found", 404);
    }
    if (source.source.run.executionMode === "public-readonly") throw new ServiceError("public_reproduction_unsupported", 400);
    const existing = this.db.prepare("SELECT id FROM reproductions WHERE owner_id=? AND run_id=? AND attempt_id=?")
      .get(owner, runId, attemptId);
    if (existing) return this.view(this.job(String(existing.id), owner));
    const attempt = source.source.attempts.find((entry) => entry.id === attemptId)!;
    const summary = source.source.summaries.find((entry) => entry.attemptId === attemptId);
    if (["queued", "running"].includes(attempt.status) || (attempt.status === "target_failed" &&
      (summary?.launchState !== "settled" || summary.summary?.cleanup.status !== "closed"))) {
      throw new ServiceError("conflict", 409);
    }
    const grounded = groundCouponReproduction(source, attemptId);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM reproductions WHERE owner_id=? AND run_id=? AND attempt_id=?")
        .get(owner, runId, attemptId);
      if (existing) return this.view(this.job(String(existing.id), owner));
      const id = randomUUID(), now = this.clock();
      this.db.prepare(`INSERT INTO reproductions
        (id,owner_id,run_id,attempt_id,status,reason,recipe,limits_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        id, owner, runId, attemptId, grounded.status === "ready" ? "queued" : grounded.status,
        grounded.status === "ready" ? "ready" : grounded.reason,
        grounded.status === "ready" ? JSON.stringify(grounded.recipe) : null, JSON.stringify(this.limits), now, now,
      );
      return this.view(this.job(id, owner));
    });
  }
  status(owner: string, id: string): ReproductionView { return this.view(this.job(id, owner)); }
  cancel(owner: string, id: string): ReproductionView {
    return this.transaction(() => {
      const job = this.job(id, owner);
      if (job.status === "queued") this.db.prepare(`UPDATE reproductions SET
        cancel_requested=1,status='cancelled',reason='cancelled',updated_at=? WHERE id=?`).run(this.clock(), id);
      else if (job.status === "running") this.db.prepare(
        "UPDATE reproductions SET cancel_requested=1,updated_at=? WHERE id=?",
      ).run(this.clock(), id);
      return this.view(this.job(id, owner));
    });
  }
  export(owner: string, id: string): string {
    const job = this.job(id, owner);
    if (!this.view(job).exportAvailable || !job.best) throw new ServiceError("conflict", 409);
    return exportCouponRegression(couponRecipeSchema.parse(JSON.parse(job.best)));
  }

  /** Expired in-flight work is NEVER replayed/refunded. Parent must reconcile its worker reservation. */
  recoverExpired(): number {
    return this.transaction(() => {
      const jobs = this.db.prepare("SELECT id,active_candidate FROM reproductions WHERE status='running' AND deadline<=?")
        .all(this.clock());
      for (const job of jobs) {
        this.db.prepare("UPDATE reproductions SET status='unknown_cleanup',reason='unknown_cleanup',updated_at=? WHERE id=?")
          .run(this.clock(), job.id);
        this.db.prepare("UPDATE reproduction_candidates SET status='unknown',cleanup='unknown',finished_at=? WHERE id=?")
          .run(this.clock(), job.active_candidate);
      }
      return jobs.length;
    });
  }
  private finish(id: string, status: ReproductionStatus, reason: ReproductionReason): void {
    this.db.prepare("UPDATE reproductions SET status=?,reason=?,active_candidate=NULL,deadline=NULL,updated_at=? WHERE id=?")
      .run(status, reason, this.clock(), id);
  }

  /**
   * Durable outbox claim: charge cumulative caps before parent enqueues a UNIQUE
   * child run/attempt/job for candidateId. No browser work and no runner fallback.
   * A crash between this transaction and enqueue is resumed via pendingCandidates.
   */
  dispatchNext(): ReproductionDispatch | null {
    this.recoverExpired();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT id FROM reproductions WHERE status='queued' ORDER BY created_at,id LIMIT 1").get();
      if (!row) return null;
      const job = this.job(String(row.id));
      const limits = reproductionLimitsSchema.parse(JSON.parse(job.limits_json));
      const recipe = couponRecipeSchema.parse(JSON.parse(job.best ?? job.recipe!));
      if (job.cancel_requested) { this.finish(job.id, "cancelled", "cancelled"); return null; }
      if (job.best && job.cursor >= recipe.steps.length) {
        this.finish(job.id, "found", "shortest_path_found"); return null;
      }
      const steps = job.best ? recipe.steps.filter((_, index) => index !== job.cursor) : recipe.steps;
      // Charge reset, seed and navigation even when an adapter combines setup operations.
      const charge = steps.length + REPRODUCTION_SETUP_STEPS;
      if (!steps.length) { this.finish(job.id, "found", "shortest_path_found"); return null; }
      if (job.candidate_count + 1 > limits.candidates || job.steps_charged + charge > limits.steps ||
        job.seconds_charged + this.hooks.reservationSeconds > limits.reservedSeconds ||
        job.time_charged + limits.candidateMs > limits.durationMs ||
        this.clock() - job.created_at >= limits.durationMs) {
        this.finish(job.id, "limit_reached", "budget_exhausted"); return null;
      }
      const candidateId = randomUUID(), now = this.clock();
      const deadline = Math.min(
        job.created_at + limits.durationMs,
        now + this.hooks.reservationSeconds * 1000 + 5000,
      );
      if (deadline - now <= 5000) {
        this.finish(job.id, "limit_reached", "budget_exhausted"); return null;
      }
      this.db.prepare(`INSERT INTO reproduction_candidates
        (id,reproduction_id,ordinal,steps_json,status,charged_steps,charged_seconds,charged_ms,created_at)
        VALUES(?,?,?,?,'running',?,?,?,?)`).run(
        candidateId, job.id, job.candidate_count + 1, JSON.stringify(steps), charge,
        this.hooks.reservationSeconds, limits.candidateMs, now,
      );
      this.db.prepare(`UPDATE reproductions SET status='running',reason='reducing',
        candidate_count=candidate_count+1,steps_charged=steps_charged+?,seconds_charged=seconds_charged+?,
        time_charged=time_charged+?,active_candidate=?,deadline=?,updated_at=? WHERE id=?`).run(
        charge, this.hooks.reservationSeconds, limits.candidateMs, candidateId, deadline, now, job.id,
      );
      return {
        ownerId: job.owner_id, sourceRunId: job.run_id, sourceAttemptId: job.attempt_id,
        reproductionId: job.id, candidateId, steps, signature: REPRODUCTION_SIGNATURE,
        maxDurationMs: limits.candidateMs, reservationSeconds: this.hooks.reservationSeconds,
        deadline,
      };
    });
  }

  /** Parent checks this again inside normal worker claim/heartbeat before allocation or dispatch. */
  candidateDispatch(candidateId: string): ReproductionDispatch | null {
    const row = this.db.prepare(`SELECT c.*,r.owner_id,r.run_id,r.attempt_id,r.deadline FROM reproduction_candidates c
      JOIN reproductions r ON r.id=c.reproduction_id WHERE c.id=? AND c.status='running'
      AND r.status='running' AND r.active_candidate=c.id AND r.cancel_requested=0 AND r.deadline>?`)
      .get(candidateId, this.clock());
    if (!row) return null;
    return {
      ownerId: String(row.owner_id), sourceRunId: String(row.run_id), sourceAttemptId: String(row.attempt_id),
      reproductionId: String(row.reproduction_id), candidateId: String(row.id),
      steps: couponRecipeSchema.shape.steps.parse(JSON.parse(String(row.steps_json))),
      signature: REPRODUCTION_SIGNATURE, maxDurationMs: Number(row.charged_ms),
      reservationSeconds: Number(row.charged_seconds), deadline: Number(row.deadline),
    };
  }

  /** Re-delivery is intentional: parent candidateId -> child job mapping MUST be unique/idempotent. */
  pendingCandidates(): ReproductionDispatch[] {
    const rows = this.db.prepare(`SELECT c.id FROM reproduction_candidates c JOIN reproductions r ON r.id=c.reproduction_id
      WHERE c.status='running' AND r.status='running' AND r.active_candidate=c.id
      AND r.cancel_requested=0 AND r.deadline>? ORDER BY c.created_at,c.id LIMIT 100`).all(this.clock());
    return rows.flatMap((row) => {
      const dispatch = this.candidateDispatch(String(row.id));
      return dispatch ? [dispatch] : [];
    });
  }

  /** Explicit adapter convenience for offline tests; production should use durable dispatch/settlement. */
  async runNext(shutdown: AbortSignal = new AbortController().signal): Promise<boolean> {
    if (shutdown.aborted) return false;
    const runner = this.hooks.runner;
    if (!runner) throw new ServiceError("unavailable", 503);
    const claim = this.dispatchNext();
    if (!claim) return false;
    const controller = new AbortController();
    const signal = AbortSignal.any([shutdown, controller.signal]);
    const monitor = setInterval(() => {
      try { if (this.job(claim.reproductionId).cancel_requested) controller.abort(); }
      catch { controller.abort(); }
    }, 50);
    monitor.unref();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const unknown: CandidateResult = {
      outcome: "unknown", signature: null, cleanup: "unknown", environment: "uncertain", sessionIdentity: "",
    };
    let result: CandidateResult = unknown;
    try {
      const input: CandidateInput = {
        reproductionId: claim.reproductionId, candidateId: claim.candidateId, steps: claim.steps,
        signature: REPRODUCTION_SIGNATURE, maxDurationMs: claim.maxDurationMs,
        reservationSeconds: claim.reservationSeconds, signal,
      };
      result = await Promise.race([
        Promise.resolve().then(() => runner(input)).catch(() => unknown),
        new Promise<CandidateResult>((resolve) => {
          timeout = setTimeout(() => { controller.abort(); resolve(unknown); }, claim.maxDurationMs + 1000);
        }),
      ]);
      const parsed = candidateResultSchema.safeParse(result);
      result = parsed.success ? parsed.data : unknown;
    } finally {
      clearInterval(monitor);
      clearTimeout(timeout);
    }
    this.completeCandidate(claim.candidateId, result, shutdown.aborted || signal.aborted);
    return true;
  }

  /**
   * Parent persists this exact result with child worker settlement, then calls
   * this method (also on restart). Never derive reproduction from target_failed.
   * Duplicate and stale completions cannot advance or replenish the search.
   */
  completeCandidate(candidateId: string, input: CandidateResult, cancelled = false): boolean {
    const parsed = candidateResultSchema.safeParse(input);
    const result: CandidateResult = parsed.success ? parsed.data : {
      outcome: "unknown", signature: null, cleanup: "unknown", environment: "uncertain", sessionIdentity: "",
    };
    return this.transaction(() => {
      const candidate = this.db.prepare("SELECT reproduction_id,steps_json FROM reproduction_candidates WHERE id=?")
        .get(candidateId);
      if (!candidate) return false;
      const job = this.job(String(candidate.reproduction_id));
      if (job.status !== "running" || job.active_candidate !== candidateId) return false;
      const recipe = couponRecipeSchema.parse({
        ...JSON.parse(job.recipe!), steps: JSON.parse(String(candidate.steps_json)),
      });
      const sessionHash = typeof result.sessionIdentity === "string" && result.sessionIdentity.length > 0 &&
        result.sessionIdentity.length <= 4096 ? createHash("sha256").update(result.sessionIdentity).digest("hex") : null;
      const reused = sessionHash && this.db.prepare(
        "SELECT id FROM reproduction_candidates WHERE session_hash=? AND id<>? LIMIT 1",
      ).get(sessionHash, candidateId);
      const reproduced = result.outcome === "reproduced" && result.signature === REPRODUCTION_SIGNATURE;
      const untrusted = !sessionHash || reused || (job.deadline !== null && this.clock() >= job.deadline) ||
        result.environment !== "trusted_fixture" ||
        !["reproduced", "not_reproduced"].includes(result.outcome) ||
        (result.outcome === "reproduced" && !reproduced) ||
        (result.outcome === "not_reproduced" && result.signature !== null);
      this.db.prepare(`UPDATE reproduction_candidates SET status=?,signature=?,cleanup=?,session_hash=?,finished_at=? WHERE id=?`)
        .run(untrusted ? "unknown" : reproduced ? "reproduced" : "not_reproduced",
          reproduced ? REPRODUCTION_SIGNATURE : null, result.cleanup === "confirmed" ? "confirmed" : "unknown",
          sessionHash, this.clock(), candidateId);
      if (result.cleanup !== "confirmed") { this.finish(job.id, "unknown_cleanup", "unknown_cleanup"); return true; }
      if (job.cancel_requested || cancelled) { this.finish(job.id, "cancelled", "cancelled"); return true; }
      if (untrusted) { this.finish(job.id, "uncertain_environment", "uncertain_environment"); return true; }
      if (!job.best && !reproduced) { this.finish(job.id, "not_reproduced", "baseline_not_reproduced"); return true; }
      if (reproduced) {
        this.db.prepare("UPDATE reproductions SET best=?,cursor=0 WHERE id=?").run(JSON.stringify(recipe), job.id);
      } else this.db.prepare("UPDATE reproductions SET cursor=cursor+1 WHERE id=?").run(job.id);
      this.finish(job.id, "queued", "reducing");
      return true;
    });
  }
}

export { groundCouponReproduction, exportCouponRegression };
export type { ReproductionSource, CouponRecipe };
