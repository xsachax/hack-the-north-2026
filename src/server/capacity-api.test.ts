import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunSchema, personaSchema, type Attempt, type CreateRun, type Run } from "../lib/contracts";
import { controlledRunSchema, resolveControlledScope } from "../lib/controlled-run";
import { demoCriteria, demoRunSchema, demoScope } from "../lib/demo-run";
import { personas } from "../lib/personas";
import { rerunRequestSchema } from "../lib/rerun-contracts";
import { attemptSummariesResponseSchema } from "../lib/ui-contracts";
import { createApi } from "./api";
import { signature } from "./reports/aggregate";
import { Repository, type OwnerSession } from "./repository";

const origin = "http://127.0.0.1:3000";
const assignment = { goal: "Buy the mug using both coupons", criteria: [...demoCriteria] };
const body = (count: number): CreateRun => ({
  authorizationAcknowledged: true,
  scope: { targetUrl: "https://example.com/", allowedSubdomains: [], pathPrefixes: ["/"] },
  assignments: personas.slice(0, count).map(({ id }) => ({ personaId: id, ...assignment })),
});
type Path = "runs" | "demo-runs" | "controlled-runs";
const input = (path: Path, count: number) => path === "runs" ? body(count) : path === "demo-runs"
  ? demoRunSchema.parse({ authorizationAcknowledged: true, scenario: "fixed", assignments: body(count).assignments })
  : controlledRunSchema.parse({ authorizationAcknowledged: true, controlledSiteId: "store", assignments: body(count).assignments });

describe("eight-agent API admission and historical replay (offline)", () => {
  let dir: string, repository: Repository, db: DatabaseSync, session: OwnerSession & { token: string };
  const network = vi.fn(() => { throw new Error("Provider network is forbidden"); });
  const handler = () => createApi({
    repository,
    configuration: { origin, production: false, allowDemoRuns: true, accessCode: "offline-capacity-access-code-not-a-secret" },
    validateScope: async (scope) => scope,
  });
  const request = (path: string, payload?: unknown, key = randomUUID()) => new Request(`${origin}/api/v1/${path}`, {
    method: payload === undefined ? "GET" : "POST",
    headers: {
      origin, cookie: `ff_owner=${session.token}`, "x-csrf-token": session.csrf,
      "content-type": "application/json", "idempotency-key": key,
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const counts = () => ["runs", "attempts", "jobs", "usage_reservations", "launches", "events"]
    .map((table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  const appendAttempt = (runId: string, source: Attempt): string => {
    const id = randomUUID(), jobId = randomUUID();
    db.prepare("INSERT INTO attempts VALUES(?,?,?,?)")
      .run(id, runId, "queued", JSON.stringify({ ...source, id, runId, status: "queued" }));
    db.prepare("INSERT INTO jobs(id,run_id,attempt_id,status) VALUES(?,?,?,'queued')").run(jobId, runId, id);
    db.prepare("INSERT INTO usage_reservations(job_id) VALUES(?)").run(jobId);
    return id;
  };
  const historical = (path: Path, key: string): Run => {
    const first = input(path, 8);
    const run = path === "runs" ? repository.createRun(session.ownerId, key, createRunSchema.parse(first)).run
      : path === "demo-runs" ? repository.createDemoRun(session.ownerId, key, demoRunSchema.parse(first)).run
      : repository.createControlledRun(session.ownerId, key, controlledRunSchema.parse(first)).run;
    const scope = path === "runs" ? body(12).scope : path === "demo-runs" ? demoScope : resolveControlledScope("store");
    const canonical = createRunSchema.parse({ ...body(12), scope });
    const hashed = path === "runs" ? canonical : {
      request: canonical, ...(path === "demo-runs" ? { scenario: "fixed" } : { controlledSiteId: "store" }),
      mode: "controlled-fixture",
    };
    // Restore the exact pre-cap payload hash and twelve immutable attempts, bypassing new admission.
    db.prepare("UPDATE runs SET request_hash=? WHERE id=?")
      .run(createHash("sha256").update(JSON.stringify(hashed)).digest("hex"), run.id);
    const source = repository.attempts(session.ownerId, run.id)[0];
    for (const persona of personas.slice(8, 12)) appendAttempt(run.id, { ...source, persona: personaSchema.parse(persona) });
    return run;
  };

  beforeEach(() => {
    dir = join(process.cwd(), `.capacity-api-${randomUUID()}`);
    repository = new Repository(dir);
    db = new DatabaseSync(join(dir, "flash-flood.sqlite"));
    db.exec("PRAGMA foreign_keys=ON");
    session = repository.createSession();
    network.mockClear();
    vi.stubGlobal("fetch", network);
  });
  afterEach(() => {
    try { expect(network).not.toHaveBeenCalled(); }
    finally { db.close(); repository.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); }
  });

  it.each(["runs", "demo-runs", "controlled-runs"] as const)("accepts eight and rejects nine new %s assignments without durable side effects", async (path) => {
    const created = await handler()(request(path, input(path, 8)));
    expect(created.status).toBe(201);
    const run = (await created.json()).data as Run;
    expect(repository.attempts(session.ownerId, run.id)).toHaveLength(8);
    const before = counts();
    const rejected = await handler()(request(path, input(path, 9)));
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.code).toBe("invalid_request");
    expect(counts()).toEqual(before);
  });

  it.each(["runs", "demo-runs", "controlled-runs"] as const)("replays historical twelve-persona %s keys after restart before applying new-admission limits", async (path) => {
    const key = randomUUID(), run = historical(path, key);
    repository.cancelRun(session.ownerId, run.id);
    repository.close();
    repository = new Repository(dir);
    const before = counts();
    const replay = await handler()(request(path, input(path, 12), key));
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toMatchObject({ id: run.id, status: "cancelled" });
    const changed = input(path, 12);
    changed.assignments[0].goal = "Changed historical goal";
    expect((await handler()(request(path, changed, key))).status).toBe(409);
    expect((await handler()(request(path, input(path, 12)))).status).toBe(400);
    expect(counts()).toEqual(before);
    const attempts = await handler()(request(`runs/${run.id}/attempts`));
    expect((await attempts.json()).data.items).toHaveLength(12);
    const summaries = await handler()(request(`runs/${run.id}/summaries`));
    expect(attemptSummariesResponseSchema.parse((await summaries.json()).data).items).toHaveLength(12);
    const report = await handler()(request(`runs/${run.id}/reports`));
    expect(report.status).toBe(200);
    expect((await report.json()).data.agents).toHaveLength(12);
  });

  it("limits new reruns to eight while preserving twelve-attempt historical lineage and exact-key replay", async () => {
    const parent = historical("demo-runs", randomUUID());
    const attemptIds = repository.attempts(session.ownerId, parent.id).map(({ id }) => id);
    const path = `runs/${parent.id}/reruns`, key = randomUUID();
    const payload = { authorizationAcknowledged: true, attemptIds: attemptIds.slice(0, 8) };
    const response = await handler()(request(path, payload, key));
    expect(response.status).toBe(201);
    const child = (await response.json()).data.run as Run;
    const before = counts();
    expect((await handler()(request(path, { ...payload, attemptIds: attemptIds.slice(0, 9) }))).status).toBe(400);
    expect(counts()).toEqual(before);
    const saved = rerunRequestSchema.parse({ ...payload, attemptIds });
    db.prepare("UPDATE runs SET request_hash=? WHERE id=?")
      .run(signature({ version: "rerun-v1", parentRunId: parent.id, request: saved }), child.id);
    for (const attempt of repository.attempts(session.ownerId, parent.id).slice(8)) {
      const childId = appendAttempt(child.id, attempt);
      db.prepare("INSERT INTO rerun_attempts VALUES(?,?,?)").run(childId, attempt.id, child.id);
    }
    repository.close();
    repository = new Repository(dir);
    const historicalCounts = counts();
    const replay = await handler()(request(path, saved, key));
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toMatchObject({ run: { id: child.id }, created: false });
    expect(repository.rerunLineage(session.ownerId, parent.id, child.id)).toHaveLength(12);
    expect((await handler()(request(path, { ...saved, scenario: "second-coupon" }, key))).status).toBe(409);
    expect((await handler()(request(path, saved))).status).toBe(400);
    expect(counts()).toEqual(historicalCounts);
  });

  it("reads all twelve stored results after restart without changing historical usage", async () => {
    const run = historical("demo-runs", randomUUID());
    const outcome = { status: "gave_up", reason: "Historical offline fixture" };
    const result = {
      ...outcome, originalTerminal: outcome, checks: [], steps: 1, modelCalls: 1, durationMs: 1000,
      cleanup: { status: "closed", errors: [] }, errors: [],
    };
    for (const attempt of repository.attempts(session.ownerId, run.id)) {
      const jobId = db.prepare("SELECT id FROM jobs WHERE attempt_id=?").get(attempt.id)!.id;
      db.prepare("UPDATE attempts SET status='gave_up',snapshot=? WHERE id=?")
        .run(JSON.stringify({ ...attempt, status: "gave_up" }), attempt.id);
      db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(jobId);
      db.prepare("UPDATE usage_reservations SET reserved_seconds=120,consumed_seconds=1,released_seconds=119 WHERE job_id=?").run(jobId);
      db.prepare("INSERT INTO launches(job_id,correlation_token,state,created_at,summary,usage) VALUES(?,?,'settled',?,?,?)")
        .run(jobId, randomUUID(), attempt.createdAt, JSON.stringify(result),
          JSON.stringify({ reservedSeconds: 120, elapsedSeconds: 1, actualBrowserSeconds: 1, remoteStatus: "COMPLETED" }));
    }
    db.prepare("UPDATE runs SET status='gave_up' WHERE id=?").run(run.id);
    const ledger = db.prepare("SELECT * FROM usage_reservations ORDER BY job_id").all();
    repository.close();
    repository = new Repository(dir);
    const response = await handler()(request(`runs/${run.id}/summaries`));
    const summaries = attemptSummariesResponseSchema.parse((await response.json()).data);
    expect(summaries.items).toHaveLength(12);
    for (const summary of summaries.items) expect(summary).toMatchObject({
      status: "gave_up", launchState: "settled", summary: { steps: 1, modelCalls: 1, cleanup: { status: "closed" } },
      reservedSeconds: 120, consumedSeconds: 1, releasedSeconds: 119,
    });
    const report = await handler()(request(`runs/${run.id}/reports`));
    expect(report.status).toBe(200);
    expect((await report.json()).data.agents).toHaveLength(12);
    expect(db.prepare("SELECT * FROM usage_reservations ORDER BY job_id").all()).toEqual(ledger);
  });
});
