import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { attemptSchema, idempotencyKeySchema, idSchema, type Run } from "../../lib/contracts";
import { controlledNavigationScope, controlledSite } from "../../lib/controlled-sites";
import { newRerunRequestSchema, rerunRequestSchema, type RerunRequest, type RerunPair } from "../../lib/rerun-contracts";
import type { Repository } from "../repository";
import { ServiceError } from "../errors";
import { signature } from "../reports/aggregate";

const absent = () => new ServiceError("not_found", 404);

/** Called inside the repository's write transaction; no provider or live session is copied. */
export function insertRerun(
  db: DatabaseSync, repository: Repository, owner: string, key: string,
  parentRunId: string, input: RerunRequest, time: string,
): { run: Run; created: boolean } {
  idSchema.parse(parentRunId);
  idempotencyKeySchema.parse(key);
  const request = rerunRequestSchema.parse(input);
  const parent = repository.getRun(owner, parentRunId);
  const hash = signature({ version: "rerun-v1", parentRunId, request });
  const existing = db.prepare("SELECT id, request_hash FROM runs WHERE owner_id=? AND idempotency_key=?").get(owner, key);
  if (existing) {
    if (existing.request_hash !== hash) throw new ServiceError("conflict", 409);
    const id = z.string().parse(existing.id);
    readRerunLineage(db, repository, owner, parentRunId, id);
    return { run: repository.getRun(owner, id), created: false };
  }
  if (!newRerunRequestSchema.safeParse(request).success) throw new ServiceError("invalid_request", 400);
  const all = repository.attempts(owner, parentRunId);
  const selected = request.attemptIds.map((id) => {
    const attempt = all.find((entry) => entry.id === id);
    if (!attempt) throw absent();
    return attempt;
  });
  // Website admission remains gated. Only the server's immutable fixture identity is trusted.
  if (parent.executionMode !== "controlled-fixture") throw new ServiceError("invalid_request", 400);
  const site = controlledSite(parent.controlledSiteId ?? "store");
  try { controlledNavigationScope(site, parent.scope.targetUrl, parent.scope); }
  catch { throw new ServiceError("invalid_request", 400); }
  const persisted = db.prepare("SELECT scenario, controlled_site_id FROM runs WHERE id=? AND owner_id=?").get(parentRunId, owner);
  if (!persisted) throw absent();
  const originalScenario = z.enum(["fixed", "second-coupon"]).nullable().parse(persisted.scenario);
  if (request.scenario && site.id !== "store") throw new ServiceError("invalid_request", 400);
  const active = z.number().parse(db.prepare("SELECT count(*) AS n FROM runs WHERE owner_id=? AND status IN ('queued','running')").get(owner)?.n);
  const daily = z.number().parse(db.prepare("SELECT count(*) AS n FROM runs WHERE owner_id=? AND created_at>=?")
    .get(owner, new Date(Date.parse(time) - 86_400_000).toISOString())?.n);
  if (active >= 5 || daily >= 100) throw new ServiceError("rate_limited", 429);
  const id = randomUUID();
  db.prepare(`INSERT INTO runs(id,owner_id,idempotency_key,request_hash,status,scope,created_at,updated_at,execution_mode,scenario,controlled_site_id)
    VALUES(?,?,?,?,'queued',?,?,?,'controlled-fixture',?,?)`)
    .run(id, owner, key, hash, JSON.stringify(parent.scope), time, time,
      request.scenario ?? originalScenario, persisted.controlled_site_id);
  db.prepare("INSERT INTO rerun_runs VALUES(?,?,'fresh')").run(id, parentRunId);
  for (const snapshot of selected) {
    const attempt = attemptSchema.parse({
      id: randomUUID(), runId: id, persona: snapshot.persona, goal: snapshot.goal, criteria: snapshot.criteria,
      ...(snapshot.limits ? { limits: snapshot.limits } : {}),
      status: "queued", createdAt: time, updatedAt: time,
    });
    db.prepare("INSERT INTO attempts VALUES(?,?,'queued',?)").run(attempt.id, id, JSON.stringify(attempt));
    db.prepare("INSERT INTO rerun_attempts VALUES(?,?,?)").run(attempt.id, snapshot.id, id);
    const jobId = randomUUID();
    db.prepare("INSERT INTO jobs(id,run_id,attempt_id,status) VALUES(?,?,?,'queued')").run(jobId, id, attempt.id);
    db.prepare("INSERT INTO usage_reservations(job_id) VALUES(?)").run(jobId);
  }
  return { run: repository.getRun(owner, id), created: true };
}

export function readRerunLineage(
  db: DatabaseSync, repository: Repository, owner: string, parentRunId: string, childRunId: string,
): RerunPair[] {
  idSchema.parse(parentRunId);
  idSchema.parse(childRunId);
  repository.getRun(owner, parentRunId);
  repository.getRun(owner, childRunId);
  if (!db.prepare("SELECT 1 FROM rerun_runs WHERE parent_run_id=? AND child_run_id=? AND context='fresh'")
    .get(parentRunId, childRunId)) throw absent();
  const parents = repository.attempts(owner, parentRunId);
  const children = repository.attempts(owner, childRunId);
  const rows = db.prepare("SELECT parent_attempt_id,child_attempt_id FROM rerun_attempts WHERE child_run_id=? ORDER BY rowid").all(childRunId);
  if (!rows.length || rows.length !== children.length) throw absent();
  return rows.map((row) => {
    const parentAttemptId = z.string().parse(row.parent_attempt_id);
    const childAttemptId = z.string().parse(row.child_attempt_id);
    if (!parents.some((entry) => entry.id === parentAttemptId) || !children.some((entry) => entry.id === childAttemptId)) throw absent();
    return { parentAttemptId, childAttemptId };
  });
}
