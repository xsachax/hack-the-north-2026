import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "../lib/contracts";
import { demoCriteria } from "../lib/demo-run";
import { createApi, type ApiConfiguration } from "./api";
import { WorkerRepository } from "./worker/repository";
import type { validateTargetScope } from "./target-policy";

const origin = "http://127.0.0.1:3000";
const input = () => ({
  authorizationAcknowledged: true, controlledSiteId: "project-board",
  assignments: [{ personaId: "careful-first-timer", goal: "Find the project board", criteria: ["The project board is visible"] }],
});
describe("explicit controlled-site admission", () => {
  let directory: string;
  let repository: WorkerRepository;
  let owner: ReturnType<WorkerRepository["createSession"]>;
  let other: typeof owner;
  let validateScope: ReturnType<typeof vi.fn<typeof validateTargetScope>>;
  const api = (extra: Partial<ApiConfiguration> = {}) => createApi({
    repository, validateScope,
    configuration: { origin, production: false, accessCode: "a".repeat(32), allowDemoRuns: true, ...extra },
  });
  const request = (body: unknown = input(), {
    path = "controlled-runs", session = owner, headers = {}, method = "POST",
  }: { path?: string; session?: typeof owner; headers?: Record<string, string>; method?: string } = {}) =>
    new Request(`${origin}/api/v1/${path}`, {
      method, headers: {
        origin, cookie: `ff_owner=${session.token}`, "x-csrf-token": session.csrf,
        "content-type": "application/json", "idempotency-key": randomUUID(), ...headers,
      }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
  const unwrap = async (response: Response) => (await response.json() as { data: Run }).data;
  beforeEach(() => {
    directory = resolve(`.controlled-api-${randomUUID()}`);
    repository = new WorkerRepository(directory);
    owner = repository.createSession();
    other = repository.createSession();
    validateScope = vi.fn<typeof validateTargetScope>(async (scope) => scope);
  });
  afterEach(() => {
    expect(validateScope).not.toHaveBeenCalled();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    { allowDemoRuns: false }, { allowDemoRuns: undefined },
    { accessCode: undefined }, { accessCode: "a".repeat(31) },
  ])("requires explicit operator enablement and the existing strong gate: %j", async (configuration) => {
    expect((await api(configuration)(request())).status).toBe(503);
    expect(repository.claim("worker")).toBeNull();
  });

  it.each([
    [{ cookie: "" }, 401], [{ "x-csrf-token": "" }, 403],
    [{ origin: "https://attacker.example" }, 403], [{ host: "attacker.example" }, 403],
    [{ "idempotency-key": "" }, 400],
  ] as const)("retains owner and mutation guards: %j", async (headers, status) => {
    expect((await api()(request(input(), { headers }))).status).toBe(status);
    expect(repository.claim("worker")).toBeNull();
  });

  it.each(["store", "project-board"])("admits registered %s with durable site and scope selection", async (controlledSiteId) => {
    const response = await api()(request({ ...input(), controlledSiteId }));
    expect(response.status).toBe(201);
    const run = await unwrap(response);
    expect(run).toMatchObject({ executionMode: "controlled-fixture", controlledSiteId });
    expect(new URL(run.scope.targetUrl).hostname).toBe(
      controlledSiteId === "store" ? "fixture.flash-flood.invalid" : "board.flash-flood.invalid",
    );
    repository.close();
    repository = new WorkerRepository(directory);
    expect(repository.getRun(owner.ownerId, run.id)).toEqual(run);
    const claim = repository.claim("worker")!;
    expect(claim).toMatchObject({ controlledSiteId, scope: run.scope, attempt: { criteria: input().assignments[0].criteria } });
    expect(claim.scenario).toBeUndefined();
  });

  it.each([
    { controlledSiteId: "arbitrary" }, { targetUrl: "https://example.com/" },
    { executionMode: "controlled-fixture" }, { scenario: "fixed" },
    { scope: { targetUrl: "https://example.com/" } },
    { scope: { targetPath: "//example.com/" } },
    { scope: { targetPath: "/demo/cart" } },
    { scope: { targetPath: "/project-board/../demo/cart" } },
    { scope: { pathPrefixes: ["/"] } },
    { scope: { pathPrefixes: ["/demo"] } },
    { scope: { targetPath: "/project-board/new", pathPrefixes: ["/project-board/projects"] } },
    { scope: { allowedSubdomains: ["example.com"] } },
    { assignments: [{ ...input().assignments[0], criteria: [] }] },
    { assignments: [{ ...input().assignments[0], criteria: ["Duplicate", "Duplicate"] }] },
    { assignments: [{ ...input().assignments[0], criteria: [{ type: "unknown", text: "anything" }] }] },
  ])("rejects malformed criteria, arbitrary targets and scope escapes: %j", async (extra) => {
    expect((await api()(request({ ...input(), ...extra }))).status).toBe(400);
    expect(repository.listRuns(owner.ownerId, { after: 0, limit: 100 }).items).toEqual([]);
    expect(repository.accounting().reservedSeconds).toBe(0);
  });

  it("snapshots custom persona, goal and criteria and isolates every owner view", async () => {
    const { id, ...profile } = repository.listPersonas(owner.ownerId)[0];
    expect(id).toBeTruthy();
    const persona = repository.createPersona(owner.ownerId, profile);
    const body = { ...input(), assignments: [{ ...input().assignments[0], personaId: persona.id }] };
    const run = await unwrap(await api()(request(body)));
    body.assignments[0].criteria[0] = "Changed after admission";
    repository.updatePersona(owner.ownerId, persona.id, { ...profile, name: "Changed" });
    repository.deletePersona(owner.ownerId, persona.id);
    expect(repository.attempts(owner.ownerId, run.id)[0]).toMatchObject({
      persona, goal: input().assignments[0].goal, criteria: input().assignments[0].criteria,
    });

    for (const suffix of ["", "/attempts", "/summaries", "/sessions", "/events"]) {
      expect((await api()(request(undefined, { method: "GET", path: `runs/${run.id}${suffix}`, session: other }))).status).toBe(404);
    }
    const otherPersona = repository.createPersona(other.ownerId, profile);
    expect((await api()(request({ ...body, assignments: [{ ...body.assignments[0], personaId: otherPersona.id }] }))).status).toBe(404);
  });

  it("persists structured criterion definitions without rewriting them to demo assertions", async () => {
    const criteria = [
      { id: "heading", kind: "visible_text", description: "Project heading is visible", semantics: "current", text: "Project board", match: "contains" },
      { id: "understand", kind: "semantic", description: "The board clearly explains project status", semantics: "milestone" },
    ];
    const response = await api()(request({ ...input(), assignments: [{ ...input().assignments[0], criteria }] }));
    expect(response.status).toBe(201);
    const run = await unwrap(response);
    expect(repository.attempts(owner.ownerId, run.id)[0].criteria).toEqual(criteria);
    expect(repository.claim("worker")!.attempt.criteria).toEqual(criteria);
    const legacy = await api()(request({
      authorizationAcknowledged: true, scenario: "fixed", assignments: [{ ...input().assignments[0], criteria }],
    }, { path: "demo-runs" }));
    expect(legacy.status).toBe(400);
    expect((await legacy.json()).error.code).toBe("unsupported_criteria");
  });

  it("rejects store-only legacy criteria on the board before allocating, without blocking explicit semantic descriptions", async () => {
    const assignments = [{ ...input().assignments[0], criteria: [...demoCriteria] }];
    const response = await api()(request({ ...input(), assignments }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("unsupported_criteria");
    expect(repository.listRuns(owner.ownerId, { after: 0, limit: 100 }).items).toEqual([]);
    expect(repository.claim("worker")).toBeNull();
    expect(repository.accounting(owner.ownerId).reservedSeconds).toBe(0);
    const explicit = await api()(request({
      ...input(), assignments: [{ ...input().assignments[0], criteria: [{
        id: "explicit", kind: "semantic", semantics: "current", description: demoCriteria[0],
      }] }],
    }));
    expect(explicit.status).toBe(201);
  });

  it("persists an explicitly narrowed scope and rejects idempotency reuse with another scope", async () => {
    const headers = { "idempotency-key": randomUUID() };
    const body = { ...input(), scope: { targetPath: "/project-board/new", pathPrefixes: ["/project-board/new"] } };
    const response = await api()(request(body, { headers }));
    expect(response.status).toBe(201);
    const run = await unwrap(response);
    expect(run.scope).toEqual({
      targetUrl: "https://board.flash-flood.invalid/project-board/new",
      pathPrefixes: ["/project-board/new"], allowedSubdomains: [],
    });
    expect(repository.claim("worker")!.scope).toEqual(run.scope);
    expect((await api()(request(input(), { headers }))).status).toBe(409);
  });

  it("separates controlled, legacy and website idempotency identities", async () => {
    const headers = { "idempotency-key": randomUUID() };
    const run = await unwrap(await api()(request(input(), { headers })));
    const replay = await api()(request(input(), { headers }));
    expect(replay.status).toBe(200);
    expect((await unwrap(replay)).id).toBe(run.id);
    expect((await api()(request({ ...input(), controlledSiteId: "store" }, { headers }))).status).toBe(409);
    expect((await api()(request({
      authorizationAcknowledged: true, scenario: "fixed",
      assignments: [{ ...input().assignments[0], criteria: [...demoCriteria] }],
    }, { headers, path: "demo-runs" }))).status).toBe(409);
  });
});
