import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi, type ApiConfiguration } from "../api";
import { Repository } from "../repository";
import { managedCreateSchema, managedRunSchema, managedSessionsSchema, MANAGED_EXECUTION_POLICY } from "../../lib/managed-contracts";
import { managedAllowedOrigins, managedCapabilities, requireManagedWorker } from "./config";
import { managedSpecialists } from "../../lib/managed-specialists";

const origin = "http://127.0.0.1:3000";
const input = () => managedCreateSchema.parse({
  executionPolicy: MANAGED_EXECUTION_POLICY, authorizationAcknowledged: true, managedPolicyAcknowledged: true,
  scope: { targetUrl: "https://www.iana.org/help/example-domains", allowedSubdomains: [], pathPrefixes: ["/help", "/domains"] },
  assignments: [{ personaId: "careful-first-timer", goal: "Find reserved domains", criteria: ["Destination heading is visible"] }],
});
describe("managed owner API with no provider operations", () => {
  let repository: Repository;
  let dir: string;
  let owner: ReturnType<Repository["createSession"]>;
  let other: typeof owner;
  const validateScope = vi.fn(async (scope) => scope);
  const handle = (change: Partial<ApiConfiguration> = {}) => createApi({
    repository, validateScope, configuration: {
      origin, production: false, accessCode: "x".repeat(32), browserbaseKeyConfigured: true,
      managedEnabled: true, managedAgentConfigured: true, managedProjectConfigured: true,
      managedAllowedOrigins: ["https://www.iana.org"], ...change,
    },
  });
  function request(path: string, method = "GET", body?: unknown, session = owner, key = randomUUID(), extra = {}) {
    return new Request(`${origin}/api/v1/${path}`, {
      method, headers: { origin, cookie: `ff_owner=${session.token}`, "x-csrf-token": session.csrf,
        "content-type": "application/json", "idempotency-key": key, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  beforeEach(() => {
    dir = resolve(`.managed-api-${randomUUID()}`);
    repository = new Repository(dir);
    owner = repository.createSession(); other = repository.createSession();
    validateScope.mockClear();
  });
  afterEach(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); });
  it("admits only a separate explicit policy, snapshots personas, and creates no native launch", async () => {
    const response = await handle()(request("managed-runs", "POST", input()));
    expect(response.status).toBe(201);
    const run = managedRunSchema.parse((await response.json()).data);
    expect(run.status).toBe("queued");
    expect(run.attempts[0]).toMatchObject({ reservedSeconds: 0, modelCalls: null, cleanup: "not_started" });
    expect(repository.listRuns(owner.ownerId, { after: 0, limit: 100 }).items).toEqual([]);
    expect(validateScope).toHaveBeenCalledOnce();
  });
  it("snapshots every demo specialist's concrete mission through the existing assignment API", async () => {
    const assignments = managedSpecialists.map(({ personaId, goal, criteria }) => ({ personaId, goal, criteria }));
    const body = { ...input(), assignments };
    const response = await handle()(request("managed-runs", "POST", body));
    expect(response.status).toBe(201);
    const run = managedRunSchema.parse((await response.json()).data);
    expect(run.attempts.map((attempt) => ({
      personaId: attempt.persona.id, goal: attempt.goal, criteria: attempt.criteria,
    }))).toEqual(assignments);
    expect(run.attempts.map((attempt) => attempt.persona.name)).toEqual(["Alex", "Ash", "Sam", "Lee", "Ari"]);
    expect(run.attempts.every((attempt) => attempt.status === "queued" && attempt.cleanup === "not_started")).toBe(true);
  });
  it.each([
    { managedEnabled: false }, { managedAgentConfigured: false }, { managedAllowedOrigins: [] },
    { browserbaseKeyConfigured: false }, { accessCode: "short" },
    { managedProjectConfigured: false },
  ])("rejects missing operator prerequisites before saving paid work %#", async (config) => {
    expect((await handle(config)(request("managed-runs", "POST", input()))).status).toBe(503);
    expect(repository.managed.list(owner.ownerId)).toEqual([]);
  });
  it("preserves idempotency after mode disablement and rejects changed requests", async () => {
    const key = randomUUID();
    const first = await handle()(request("managed-runs", "POST", input(), owner, key));
    const id = (await first.json()).data.id;
    const replay = await handle({ managedEnabled: false })(request("managed-runs", "POST", input(), owner, key));
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.id).toBe(id);
    const changed = input(); changed.assignments[0].goal = "Different task";
    expect((await handle()(request("managed-runs", "POST", changed, owner, key))).status).toBe(409);
  });
  it("enforces owner, CSRF and origin for admission and reports", async () => {
    const response = await handle()(request("managed-runs", "POST", input()));
    const id = (await response.json()).data.id;
    expect((await handle()(request(`managed-runs/${id}/report`, "GET", undefined, other))).status).toBe(404);
    expect((await handle()(request(`managed-runs/${id}/cancel`, "POST", {}, other))).status).toBe(404);
    expect((await handle()(request("managed-runs", "POST", input(), owner, randomUUID(), { "x-csrf-token": "" }))).status).toBe(403);
    expect((await handle()(request("managed-runs", "POST", input(), owner, randomUUID(), { origin: "https://other.example" }))).status).toBe(403);
    expect((await handle()(request("managed-runs", "GET", undefined, owner, randomUUID(), { cookie: "" }))).status).toBe(401);
  });
  it("serves owner-only live sessions with no link before the attempt is active", async () => {
    const created = await handle()(request("managed-runs", "POST", input()));
    const run = managedRunSchema.parse((await created.json()).data);
    const response = await handle()(request(`managed-runs/${run.id}/sessions`));
    expect(response.status).toBe(200);
    expect(managedSessionsSchema.parse((await response.json()).data)).toEqual({
      items: [{ attemptId: run.attempts[0].id, available: false, liveViewUrl: null }],
    });
    expect((await handle()(request(`managed-runs/${run.id}/sessions`, "GET", undefined, other))).status).toBe(404);
    expect((await handle()(request(`managed-runs/${run.id}/sessions`, "GET", undefined, owner, randomUUID(), { cookie: "" }))).status).toBe(401);
    expect((await handle()(request(`managed-runs/${run.id}/sessions`, "POST", {}))).status).toBe(404);
    expect((await handle()(request(`managed-runs/${run.id}/sessions?x=1`))).status).toBe(400);
  });
  it("requires exact approved initial origin and denies missing acknowledgement or ninth persona", async () => {
    const changed = input(); changed.scope.targetUrl = "https://iana.org/help";
    expect((await handle()(request("managed-runs", "POST", changed))).status).toBe(400);
    expect((await handle()(request("managed-runs", "POST", { ...input(), managedPolicyAcknowledged: false }))).status).toBe(400);
    expect((await handle()(request("managed-runs", "POST", {
      ...input(), assignments: Array.from({ length: 9 }, (_, index) => ({ ...input().assignments[0], personaId: `person-${index}` })),
    }))).status).toBe(400);
    expect(validateScope).not.toHaveBeenCalled();
  });
  it("cancels queued work without allocating and keeps report model usage unknown", async () => {
    const response = await handle()(request("managed-runs", "POST", input()));
    const id = (await response.json()).data.id;
    expect((await handle()(request(`managed-runs/${id}/cancel`, "POST", {}))).status).toBe(200);
    const report = await handle()(request(`managed-runs/${id}/report`));
    expect((await report.json()).data).toMatchObject({
      status: "cancelled", attempts: [{ cleanup: "closed", reservedSeconds: 0, actualBrowserSeconds: 0, modelCalls: null }],
    });
  });
});

describe("managed configuration", () => {
  it("is default-off with no silent approved origins", () => {
    expect(managedAllowedOrigins(undefined)).toEqual([]);
    expect(managedCapabilities({}).enabled).toBe(false);
    expect(() => requireManagedWorker({ NODE_ENV: "test" })).toThrow("managed_worker_configuration_required");
  });
  it.each(["http://127.0.0.1", "https://example.com/path", "https://example.com/", "https://user:pass@example.com",
    "https://example.com,https://example.com"])("rejects unsafe or noncanonical origin %s", (value) => {
    expect(() => managedAllowedOrigins(value)).toThrow();
  });
});
