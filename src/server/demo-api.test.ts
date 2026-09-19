import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonaProfile, Run } from "../lib/contracts";
import { demoCriteria, demoScope, type DemoRun } from "../lib/demo-run";
import { createApi, type ApiConfiguration } from "./api";
import type { Repository } from "./repository";
import { WorkerRepository } from "./worker/repository";
import type { ExecutionResult } from "./execution/types";
import type { validateTargetScope } from "./target-policy";

const origin = "http://127.0.0.1:3000";
const accessCode = "offline-access-gate-".repeat(3);
const input = (): DemoRun => ({
  authorizationAcknowledged: true, scenario: "fixed",
  assignments: [{
    personaId: "careful-first-timer",
    goal: "Find the mug and verify the advertised coupon total.",
    criteria: [...demoCriteria],
  }],
});
const profile: PersonaProfile = {
  name: "Custom shopper", character: "Carefully checks prices.", device: "desktop",
  techComfort: "medium", patienceSteps: 8, readingStyle: "careful",
  quirks: ["Checks labels"], worries: ["Unexpected costs"],
};
const result: ExecutionResult = {
  status: "succeeded", reason: "Offline verification", checks: [], steps: 2, modelCalls: 2, durationMs: 50,
  cleanup: { status: "closed", errors: [] },
  originalTerminal: { status: "succeeded", reason: "Offline verification" }, errors: [],
};
type Session = ReturnType<Repository["createSession"]>;
const unwrap = async <T>(response: Response) => (await response.json() as { data: T }).data;

describe("explicit demo API and owner-only execution views (offline)", () => {
  let directory: string;
  let repository: WorkerRepository;
  let owner: Session;
  let other: Session;
  let handler: ReturnType<typeof createApi>;
  let validateScope: ReturnType<typeof vi.fn<typeof validateTargetScope>>;
  const api = (configuration: Partial<ApiConfiguration> = {}) => createApi({
    repository, validateScope,
    configuration: { origin, production: false, accessCode, allowDemoRuns: true, ...configuration },
  });
  function request(path = "demo-runs", {
    method = "POST", body = input(), session = owner, headers = {},
  }: { method?: string; body?: unknown; session?: Session; headers?: Record<string, string> } = {}) {
    return new Request(`${origin}/api/v1/${path}`, {
      method,
      headers: {
        origin, cookie: `ff_owner=${session.token}`, "x-csrf-token": session.csrf,
        "content-type": "application/json", "idempotency-key": randomUUID(), ...headers,
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function create(body = input(), headers: Record<string, string> = {}) {
    const response = await handler(request("demo-runs", { body, headers }));
    expect(response.status).toBe(201);
    return unwrap<Run>(response);
  }
  async function expectError(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ error: { code, message: code.replaceAll("_", " ") } });
  }
  const list = (runId: string, view: "sessions" | "summaries", session = owner) =>
    handler(request(`runs/${runId}/${view}`, { method: "GET", session }));

  beforeEach(() => {
    directory = resolve(`.demo-api-test-${randomUUID()}`);
    repository = new WorkerRepository(directory);
    owner = repository.createSession();
    other = repository.createSession();
    validateScope = vi.fn<typeof validateTargetScope>(async (scope) => scope);
    handler = api();
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network prohibited"); }));
  });

  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([undefined, false])("disables demos unless explicitly enabled (%s)", async (allowDemoRuns) => {
    await expectError(await api({ allowDemoRuns })(request()), 503, "demo_disabled");
    expect(repository.listRuns(owner.ownerId, { after: 0, limit: 100 }).items).toEqual([]);
    expect(validateScope).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "a".repeat(31)])("requires a 32-character access code even in development (%s)", async (configured) => {
    await expectError(await api({ accessCode: configured })(request()), 503, "demo_disabled");
    expect(repository.claim("offline-worker")).toBeNull();
  });

  it("accepts the exact 32-character access-code boundary in development", async () => {
    const response = await api({ accessCode: "a".repeat(32) })(request());
    expect(response.status).toBe(201);
  });

  it("retains the production minimum access-code length", async () => {
    const production = createApi({
      repository, configuration: {
        origin: "https://app.example", production: true, allowDemoRuns: true, accessCode: "a".repeat(31),
      },
    });
    await expectError(await production(new Request("https://app.example/api/v1/demo-runs", {
      method: "POST", headers: {
        origin: "https://app.example", cookie: `__Host-ff_owner=${owner.token}`,
        "x-csrf-token": owner.csrf, "content-type": "application/json", "idempotency-key": randomUUID(),
      },
      body: JSON.stringify(input()),
    })), 503, "unavailable");
  });

  it("gates owner bootstrap behind the configured access code", async () => {
    await expectError(await handler(request("session", { body: {}, headers: { cookie: "" } })), 401, "unauthorized");
    await expectError(await handler(request("session", {
      body: { accessCode: "incorrect" }, headers: { cookie: "" },
    })), 401, "unauthorized");
    const response = await handler(request("session", { body: { accessCode }, headers: { cookie: "" } }));
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
  });

  it.each([
    [{ cookie: "" }, 401, "unauthorized"],
    [{ "x-csrf-token": "" }, 403, "forbidden"],
    [{ origin: "https://attacker.example" }, 403, "forbidden"],
    [{ host: "attacker.example" }, 403, "forbidden"],
    [{ "sec-fetch-site": "cross-site" }, 403, "forbidden"],
    [{ "idempotency-key": "" }, 400, "invalid_request"],
  ] as const)("applies existing admission guards %j", async (headers, status, code) => {
    await expectError(await handler(request("demo-runs", { headers })), status, code);
    expect(repository.claim("offline-worker")).toBeNull();
  });

  it("creates only a controlled fixture run, without DNS or target-policy calls", async () => {
    const run = await create();
    expect(run.executionMode).toBe("controlled-fixture");
    expect(run.scope).toEqual(demoScope);
    expect(validateScope).not.toHaveBeenCalled();
    const claim = repository.claim("offline-worker")!;
    expect(claim.scenario).toBe("fixed");
    expect(claim.runId).toBe(run.id);
  });

  it("retains the legacy unsupported_criteria error for duplicate demo strings", async () => {
    const body = input();
    body.assignments[0].criteria = [demoCriteria[0], demoCriteria[0]];
    await expectError(await handler(request("demo-runs", { body })), 400, "unsupported_criteria");
    expect(repository.accounting(owner.ownerId).reservedSeconds).toBe(0);
  });

  it("returns unsupported_criteria before any run or reservation is admitted", async () => {
    const body = input();
    body.assignments[0].criteria = ["Pay with a real credit card"];
    await expectError(await handler(request("demo-runs", { body })), 400, "unsupported_criteria");
    expect(repository.listRuns(owner.ownerId, { after: 0, limit: 100 }).items).toEqual([]);
    expect(repository.accounting(owner.ownerId).reservedSeconds).toBe(0);
    expect(repository.claim("offline-worker")).toBeNull();
  });

  it.each([
    { scope: demoScope }, { targetUrl: "https://example.com" }, { allowDemoRuns: true },
    { executionMode: "controlled-fixture" }, { bypassPolicy: true },
    { scenario: "arbitrary-site" }, { authorizationAcknowledged: false },
  ])("rejects unknown flags, URLs and invalid demo inputs %j", async (extra) => {
    await expectError(await handler(request("demo-runs", { body: { ...input(), ...extra } })), 400, "invalid_request");
    expect(repository.claim("offline-worker")).toBeNull();
  });

  it("rejects arbitrary flags within assignments and query parameters", async () => {
    const body = input();
    await expectError(await handler(request("demo-runs", {
      body: { ...body, assignments: [{ ...body.assignments[0], targetUrl: "https://example.com" }] },
    })), 400, "invalid_request");
    await expectError(await handler(request("demo-runs?enabled=true")), 400, "invalid_request");
  });

  it("retains custom persona, goal and criteria snapshots after persona edits and deletion", async () => {
    const persona = repository.createPersona(owner.ownerId, profile);
    const body = input();
    body.assignments[0] = {
      personaId: persona.id, goal: "Verify both advertised offers as this cautious shopper.",
      criteria: [demoCriteria[0]],
    };
    const run = await create(body);
    repository.updatePersona(owner.ownerId, persona.id, { ...profile, name: "Changed" });
    repository.deletePersona(owner.ownerId, persona.id);
    const attempts = await unwrap<{ items: ReturnType<Repository["attempts"]> }>(
      await handler(request(`runs/${run.id}/attempts`, { method: "GET" })),
    );
    expect(attempts.items).toHaveLength(1);
    expect(attempts.items[0]).toMatchObject({
      persona, goal: body.assignments[0].goal, criteria: body.assignments[0].criteria,
    });
    expect(repository.claim("offline-worker")!.attempt).toMatchObject({
      persona, goal: body.assignments[0].goal, criteria: body.assignments[0].criteria,
    });
  });

  it("does not admit a custom persona belonging to another owner", async () => {
    const persona = repository.createPersona(other.ownerId, profile);
    const body = input();
    body.assignments[0].personaId = persona.id;
    await expectError(await handler(request("demo-runs", { body })), 404, "not_found");
  });

  it("replays matching idempotency keys but conflicts on scenario, goal and criteria changes", async () => {
    const key = randomUUID();
    const headers = { "idempotency-key": key };
    const run = await create(input(), headers);
    const replay = await handler(request("demo-runs", { headers }));
    expect(replay.status).toBe(200);
    expect((await unwrap<Run>(replay)).id).toBe(run.id);
    for (const body of [
      { ...input(), scenario: "second-coupon" },
      { ...input(), assignments: [{ ...input().assignments[0], goal: "Another goal" }] },
      { ...input(), assignments: [{ ...input().assignments[0], criteria: [demoCriteria[0]] }] },
    ]) {
      await expectError(await handler(request("demo-runs", { body, headers })), 409, "conflict");
    }
    const otherRun = await handler(request("demo-runs", { headers, session: other }));
    expect(otherRun.status).toBe(201);
    expect((await unwrap<Run>(otherRun)).id).not.toBe(run.id);
  });

  it("keeps website admission unchanged and never silently turns it into a demo", async () => {
    const website = {
      authorizationAcknowledged: true,
      scope: { targetUrl: "https://example.com/", allowedSubdomains: [], pathPrefixes: ["/"] },
      assignments: input().assignments,
    };
    const response = await api({ allowDemoRuns: false })(request("runs", { body: website }));
    expect(response.status).toBe(201);
    const run = await unwrap<Run>(response);
    expect(run.executionMode).toBe("website");
    expect(validateScope).toHaveBeenCalledExactlyOnceWith(website.scope, undefined);
    expect(repository.claim("offline-worker")).toBeNull();
    expect(repository.getRun(owner.ownerId, run.id).status).toBe("blocked");
  });

  it("does not reuse a website idempotency key for a fixture run", async () => {
    const headers = { "idempotency-key": randomUUID() };
    const response = await handler(request("runs", {
      headers, body: { authorizationAcknowledged: true, scope: demoScope, assignments: input().assignments },
    }));
    expect(response.status).toBe(201);
    await expectError(await handler(request("demo-runs", { headers })), 409, "conflict");
  });

  it("provides only the active owner's live view, never replay/session/storage references", async () => {
    const run = await create();
    const claim = repository.claim("offline-worker")!;
    const liveViewUrl = "https://www.browserbase.com/live/offline-view";
    repository.sessionReference(claim, {
      sessionId: randomUUID(), liveViewUrl,
      replayUrl: "https://www.browserbase.com/sessions/offline-replay", timeoutSeconds: 240,
    });
    const response = await list(run.id, "sessions");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await unwrap(response)).toEqual({
      items: [{ attemptId: claim.attempt.id, available: true, liveViewUrl }],
    });
    await expectError(await list(run.id, "sessions", other), 404, "not_found");
    await expectError(await list(run.id, "summaries", other), 404, "not_found");
    repository.finish(claim, result, {
      reservedSeconds: 240, elapsedSeconds: 2, actualBrowserSeconds: 2, remoteStatus: "COMPLETED",
    });
    expect(await unwrap(await list(run.id, "sessions"))).toEqual({
      items: [{ attemptId: claim.attempt.id, available: false, liveViewUrl: null }],
    });
    expect(await unwrap(await list(run.id, "summaries"))).toEqual({
      items: [{
        attemptId: claim.attempt.id, status: "succeeded", launchState: "settled",
        summary: { steps: 2, modelCalls: 2, durationMs: 50, cleanup: { status: "closed" }, checks: [] },
        usage: { elapsedSeconds: 2, actualBrowserSeconds: 2, remoteStatus: "COMPLETED" },
        reservedSeconds: 240, consumedSeconds: 2, releasedSeconds: 238,
      }],
    });
  });

  it.each(["sessions", "summaries"] as const)("guards the %s view before and after launch", async (view) => {
    const run = await create();
    expect((await list(run.id, view)).status).toBe(200);
    await expectError(await list(run.id, view, other), 404, "not_found");
    await expectError(await list(randomUUID(), view), 404, "not_found");
    await expectError(await handler(request(`runs/${run.id}/${view}?after=0`, { method: "GET" })), 400, "invalid_request");
    await expectError(await handler(request(`runs/${run.id}/${view}`, {
      method: "GET", headers: { cookie: "" },
    })), 401, "unauthorized");
    await expectError(await handler(request(`runs/${run.id}/${view}`, {
      method: "GET", headers: { origin: "https://attacker.example" },
    })), 403, "forbidden");
  });
});

describe("demo runtime opt-in", () => {
  afterEach(() => {
    vi.doUnmock("./api");
    vi.doUnmock("./repository");
    vi.doUnmock("server-only");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([undefined, "false", "TRUE", "1", "true"])("enables demos only for exact true (%s)", async (flag) => {
    vi.resetModules();
    vi.stubEnv("ENABLE_DEMO_RUNS", flag);
    vi.stubEnv("FLASH_FLOOD_ACCESS_CODE", accessCode);
    const create = vi.fn(() => async () => Response.json({ data: {} }));
    vi.doMock("server-only", () => ({}));
    vi.doMock("./api", () => ({ createApi: create, validateApiConfiguration: vi.fn() }));
    vi.doMock("./repository", () => ({ Repository: class {} }));
    const { handleApi } = await import("./api-runtime");
    expect((await handleApi(new Request(`${origin}/api/v1/runs`))).status).toBe(200);
    expect(create).toHaveBeenCalledWith({
      repository: expect.any(Object),
      configuration: expect.objectContaining({ allowDemoRuns: flag === "true", accessCode }),
    });
  });
});
