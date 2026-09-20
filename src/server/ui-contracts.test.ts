import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assignmentSchema, attemptSchema, executionLimitsSchema, type CreateRun } from "../lib/contracts";
import { capabilitiesSchema, attemptSummariesResponseSchema, sessionsResponseSchema } from "../lib/ui-contracts";
import { demoCriteria } from "../lib/demo-run";
import { personas } from "../lib/personas";
import { createApi, type ApiConfiguration } from "./api";
import { migrations } from "./migrations";
import { publicPageUrl } from "./public-page-url";
import { Repository } from "./repository";
import { workerExecutionLimits, workerPolicySchema } from "./worker/config";
import { WorkerRepository } from "./worker/repository";

const origin = "http://127.0.0.1:3000";
const assignment = { personaId: personas[0].id, goal: "Read the cart", criteria: [demoCriteria[0]] };
const limits = { maxSteps: 3, maxModelCalls: 2, maxDurationMs: 2000 };
const input: CreateRun = {
  authorizationAcknowledged: true,
  scope: { targetUrl: "https://example.com/", allowedSubdomains: [], pathPrefixes: ["/"] },
  assignments: [{ ...assignment, limits }],
};
let dir: string;
let repository: Repository;
beforeEach(() => {
  dir = join(process.cwd(), `.ui-contracts-${randomUUID()}`);
  mkdirSync(dir, { mode: 0o700 });
  repository = new Repository(dir);
});
afterEach(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); });

describe("assignment limits and canonical read contracts", () => {
  it("validates strict bounded partial limits while retaining legacy assignments", () => {
    expect(assignmentSchema.parse(assignment)).toEqual(assignment);
    for (const value of [{}, limits, { maxSteps: 1 }, { maxModelCalls: 30, maxDurationMs: 240_000 }]) {
      expect(executionLimitsSchema.safeParse(value).success).toBe(true);
    }
    for (const value of [
      { maxSteps: 0 }, { maxSteps: 31 }, { maxSteps: 1.5 }, { maxModelCalls: 31 },
      { maxDurationMs: 999 }, { maxDurationMs: 240001 }, { maxSteps: "2" }, { retries: 1 }, null,
    ]) expect(executionLimitsSchema.safeParse(value).success).toBe(false);
  });

  it("persists optional limits for all admission modes, idempotency and cancellation across reopen", () => {
    const owner = repository.createSession().ownerId;
    const key = randomUUID();
    const website = repository.createRun(owner, key, input).run;
    const demo = repository.createDemoRun(owner, randomUUID(), {
      authorizationAcknowledged: true, scenario: "fixed", assignments: input.assignments,
    }).run;
    const controlled = repository.createControlledRun(owner, randomUUID(), {
      authorizationAcknowledged: true, controlledSiteId: "store", assignments: input.assignments,
    }).run;
    const legacy = repository.createRun(owner, randomUUID(), { ...input, assignments: [assignment] }).run;
    expect(repository.createRun(owner, key, input)).toEqual({ run: website, created: false });
    expect(() => repository.createRun(owner, key, {
      ...input, assignments: [{ ...assignment, limits: { maxSteps: 2 } }],
    })).toThrow(expect.objectContaining({ code: "conflict" }));
    repository.cancelRun(owner, controlled.id);
    repository.close();
    repository = new Repository(dir);
    for (const run of [website, demo, controlled]) {
      expect(repository.attempts(owner, run.id)[0].limits).toEqual(limits);
      expect(attemptSummariesResponseSchema.safeParse({ items: repository.attemptSummaries(owner, run.id) }).success).toBe(true);
      expect(sessionsResponseSchema.parse({ items: repository.sessionViews(owner, run.id) })).toEqual({ items: [] });
    }
    expect(repository.attempts(owner, legacy.id)[0]).not.toHaveProperty("limits");
  });

  it("upgrades old database snapshots without adding limits or rejecting duplicate legacy criteria", () => {
    repository.close();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o700 });
    const db = new DatabaseSync(join(dir, "flash-flood.sqlite"));
    const owner = randomUUID(), runId = randomUUID(), attemptId = randomUUID();
    const timestamp = new Date().toISOString();
    const snapshot = {
      id: attemptId, runId, persona: personas[0], goal: assignment.goal,
      criteria: [demoCriteria[0], demoCriteria[0]], status: "queued", createdAt: timestamp, updatedAt: timestamp,
    };
    try {
      db.exec(migrations[0]);
      db.exec("PRAGMA user_version=1");
      db.prepare("INSERT INTO owners VALUES(?,?,?,?)").run(owner, "hash", "csrf", Date.now() + 100000);
      db.prepare(`INSERT INTO runs(id,owner_id,idempotency_key,request_hash,status,scope,created_at,updated_at)
        VALUES(?,?,?,?,'queued',?,?,?)`).run(runId, owner, randomUUID(), "hash", JSON.stringify(input.scope), timestamp, timestamp);
      db.prepare("INSERT INTO attempts VALUES(?,?,?,?)").run(attemptId, runId, "queued", JSON.stringify(snapshot));
    } finally { db.close(); }
    repository = new Repository(dir);
    expect(repository.attempts(owner, runId)).toEqual([attemptSchema.parse(snapshot)]);
    expect(repository.persistedExecutionLimits()).toBeNull();
  });

  it("clamps each requested field, retaining policy defaults and cleanup headroom", () => {
    const policy = workerPolicySchema.parse({ maxSteps: 8, maxModelCalls: 4, sessionSeconds: 90 });
    expect(workerExecutionLimits(policy)).toEqual({ maxSteps: 8, maxModelCalls: 4, maxDurationMs: 30000 });
    expect(workerExecutionLimits(policy, limits)).toEqual(limits);
    expect(workerExecutionLimits(policy, { maxSteps: 30, maxModelCalls: 30, maxDurationMs: 240000 }))
      .toEqual({ maxSteps: 8, maxModelCalls: 4, maxDurationMs: 30000 });
    expect(workerExecutionLimits(workerPolicySchema.parse({ sessionSeconds: 60 })).maxDurationMs).toBe(1000);
  });
});

describe("safe capabilities", () => {
  const handler = (configuration: Partial<ApiConfiguration> = {}) => createApi({
    repository, configuration: { origin, production: false, ...configuration },
  });
  const request = (headers: Record<string, string> = {}, query = "") =>
    new Request(`${origin}/api/v1/capabilities${query}`, { headers });

  it("is unauthenticated, exact, uncached, and contains no configuration secrets", async () => {
    const secret = "not-a-real-access-code".repeat(3);
    const response = await handler({ accessCode: secret, allowDemoRuns: true, browserbaseKeyConfigured: true })(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
    const body = await response.json();
    expect(body).toEqual({ data: capabilitiesSchema.parse({
      controlledRunsEnabled: true, websiteExecutionEnabled: false, maxActiveViews: 3,
      publicExecutionEnabled: false, publicExecutionReason: "implementation_not_ready",
      accessCodeConfigured: true, browserbaseKeyConfigured: true,
      executionLimits: { maxSteps: 14, maxModelCalls: 14, maxDurationMs: 180000 },
      executionLimitsSource: "defaults",
    }) });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect((await (await handler()(request())).json()).data.controlledRunsEnabled).toBe(false);
  });

  it("uses persisted worker policy rather than API configuration and survives reopening", async () => {
    const worker = new WorkerRepository(dir, { maxSteps: 5, maxModelCalls: 3, sessionSeconds: 80 });
    worker.close();
    repository.close();
    repository = new Repository(dir);
    const response = await handler({ executionLimits: { maxSteps: 30, maxModelCalls: 30, maxDurationMs: 240000 } })(request());
    expect((await response.json()).data).toMatchObject({
      executionLimits: { maxSteps: 5, maxModelCalls: 3, maxDurationMs: 20000 },
      executionLimitsSource: "persisted-worker-policy",
    });
  });

  it("labels configured ceilings before initialization and enforces Host/Origin boundaries", async () => {
    expect((await (await handler({ executionLimits: limits })(request())).json()).data)
      .toMatchObject({ executionLimits: limits, executionLimitsSource: "configuration" });
    const blockedHeaders: Record<string, string>[] = [
      { host: "attacker.example" }, { origin: "https://attacker.example" }, { "sec-fetch-site": "cross-site" },
    ];
    for (const headers of blockedHeaders) expect((await handler()(request(headers))).status).toBe(403);
    expect((await handler()(request({}, "?secret=x"))).status).toBe(400);
    expect((await handler()(new Request(`${origin}/api/v1/personas`))).status).toBe(401);
  });
});

describe("public page URLs", () => {
  it("removes userinfo, queries, fragments, sensitive path data and known encoded secrets", () => {
    expect(publicPageUrl("https://user:password@example.com/cart?token=private#secret")).toBe("https://example.com/cart");
    const value = publicPageUrl("https://example.com/token/private/secret%252Dvalue?x=hidden", ["secret-value"]);
    expect(value).toBe("https://example.com/token/%5BREDACTED%5D/%5BREDACTED%5D");
    expect(publicPageUrl("https://example.com/password=private")).not.toContain("private");
    expect(publicPageUrl("javascript:alert(1)")).toBeUndefined();
    expect(publicPageUrl("not a URL")).toBeUndefined();
  });
});
