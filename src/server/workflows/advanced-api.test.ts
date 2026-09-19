import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../api";
import { WorkerRepository } from "../worker/repository";
import { demoCriteria } from "../../lib/demo-run";

let directory: string, now: number;
let repository: WorkerRepository;
let handler: ReturnType<typeof createApi>;
let owner: ReturnType<WorkerRepository["createSession"]>;
const origin = "http://127.0.0.1:3000";
function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return handler(new Request(`${origin}/api/v1${path}`, {
    method, headers: {
      origin, cookie: `ff_owner=${owner.token}`, "x-csrf-token": owner.csrf,
      "content-type": "application/json", ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
function source() {
  return repository.createDemoRun(owner.ownerId, randomUUID(), {
    authorizationAcknowledged: true, scenario: "second-coupon",
    assignments: [{
      personaId: "careful-first-timer", goal: "Apply both coupons", criteria: [demoCriteria[0]],
      limits: { maxSteps: 10, maxModelCalls: 12 },
    }],
  }).run;
}
function active() {
  const run = source();
  const claim = repository.claim("offline-worker")!;
  repository.sessionReference(claim, {
    sessionId: randomUUID(), liveViewUrl: "https://www.browserbase.com/live?private=reference",
    replayUrl: "https://www.browserbase.com/sessions/private", timeoutSeconds: 240,
  });
  return { run, claim };
}
beforeEach(() => {
  directory = mkdtempSync(join(process.cwd(), ".advanced-api-test-"));
  now = Date.now();
  repository = new WorkerRepository(directory, {}, () => now);
  owner = repository.createSession();
  handler = createApi({ repository, configuration: {
    origin, production: false, accessCode: "offline-advanced-strong-access-code", allowDemoRuns: true,
  } });
});
afterEach(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });

describe("actual owner takeover HTTP boundary", () => {
  it("requires durable worker acknowledgement and exact tab controller before revealing interactive control", async () => {
    const { claim } = active();
    const path = `/attempts/${claim.attempt.id}/takeover`;
    const controllerId = randomUUID(), key = randomUUID();
    const command = { action: "request", expectedVersion: 0, controllerId };
    const sent = await request(path, "POST", command, { "idempotency-key": key });
    expect(sent.status).toBe(200);
    expect((await sent.json()).data).toMatchObject({ phase: "requested", interactiveUrl: null });
    const control = repository.takeoverControl(claim);
    control.quiesce();
    control.acknowledge();
    expect((await (await request(path)).json()).data).toMatchObject({ phase: "human", interactiveUrl: null });
    expect((await (await request(`${path}?controllerId=${randomUUID()}`)).json()).data.interactiveUrl).toBeNull();
    const granted = (await (await request(`${path}?controllerId=${controllerId}`)).json()).data;
    expect(granted).toMatchObject({ phase: "human", controllerId, validForMs: 1500 });
    expect(granted.interactiveUrl).toContain("readOnly=false");
    const retry = await request(path, "POST", command, { "idempotency-key": key });
    expect((await retry.json()).data.phase).toBe("human");
    expect((await request(path, "POST", { ...command, action: "handback" }, { "idempotency-key": key })).status).toBe(409);
    expect((await request(path, "POST", {
      action: "handback", expectedVersion: granted.version, controllerId: randomUUID(),
    }, { "idempotency-key": randomUUID() })).status).toBe(409);
    const handed = await request(path, "POST", {
      action: "handback", expectedVersion: granted.version, controllerId,
    }, { "idempotency-key": randomUUID() });
    expect((await handed.json()).data.interactiveUrl).toBeNull();
    control.resume();
    expect(control.read().phase).toBe("resuming");
    now += 1500;
    control.resume();
    expect(control.read().phase).toBe("agent");
    const intervals = (await (await request(`${path}/intervals`)).json()).data.items;
    expect(intervals).toEqual([expect.objectContaining({ endReason: "handback", endedAt: now })]);
    expect(JSON.stringify(intervals)).not.toMatch(/private|password|typed|sessionId/);
    const events = repository.events(owner.ownerId, claim.runId, { after: 0, limit: 100 }).items;
    expect(events.filter((event) => event.kind === "attempt.control").map((event) => event.data.controlPhase))
      .toEqual(["requested", "quiescing", "human", "handback", "resuming", "agent"]);
  });

  it("fails closed across owners, CSRF/origin errors, stale commands and expired worker lease", async () => {
    const { claim } = active();
    const path = `/attempts/${claim.attempt.id}/takeover`;
    const controllerId = randomUUID();
    const command = { action: "request", expectedVersion: 0, controllerId };
    const other = repository.createSession();
    const foreign = { cookie: `ff_owner=${other.token}`, "x-csrf-token": other.csrf };
    expect((await request(path, "GET", undefined, foreign)).status).toBe(404);
    expect((await request(path, "POST", command, { ...foreign, "idempotency-key": randomUUID() })).status).toBe(404);
    expect((await request(path, "POST", command, { "x-csrf-token": "wrong" })).status).toBe(403);
    expect((await request(path, "POST", command, { origin: "https://foreign.invalid" })).status).toBe(403);
    expect((await request(`${path}?controllerId=${controllerId}&controllerId=${controllerId}`)).status).toBe(400);
    expect((await request(path, "POST", { ...command, expectedVersion: 9 }, { "idempotency-key": randomUUID() })).status).toBe(409);
    now += repository.policy.leaseMs + 1;
    expect((await request(path, "POST", command, { "idempotency-key": randomUUID() })).status).toBe(409);
    expect((await (await request(`${path}?controllerId=${controllerId}`)).json()).data).toMatchObject({
      phase: "closed", interactiveUrl: null,
    });
  });
});

describe("actual rerun HTTP boundary", () => {
  it("preserves selected immutable snapshots and replays the same durable request without private references", async () => {
    const { run, claim } = active();
    const before = repository.attempts(owner.ownerId, run.id);
    const events = repository.events(owner.ownerId, run.id, { after: 0, limit: 100 });
    const path = `/runs/${run.id}/reruns`;
    const body = { authorizationAcknowledged: true, attemptIds: [claim.attempt.id], scenario: "fixed" };
    const headers = { "idempotency-key": randomUUID() };
    const created = await request(path, "POST", body, headers);
    expect(created.status).toBe(201);
    const child = (await created.json()).data.run;
    expect(child.scope).toEqual(run.scope);
    expect(repository.attempts(owner.ownerId, child.id)[0]).toMatchObject({
      persona: claim.attempt.persona, goal: claim.attempt.goal, criteria: claim.attempt.criteria, limits: claim.attempt.limits,
    });
    expect(repository.attempts(owner.ownerId, child.id)[0].browserState).toBeUndefined();
    expect(repository.sessionViews(owner.ownerId, child.id)).toEqual([]);
    expect(repository.attempts(owner.ownerId, run.id)).toEqual(before);
    expect(repository.events(owner.ownerId, run.id, { after: 0, limit: 100 })).toEqual(events);
    const retry = await request(path, "POST", body, headers);
    expect(retry.status).toBe(200);
    expect((await retry.json()).data).toMatchObject({ created: false, run: { id: child.id } });
    expect((await request(path, "POST", { ...body, scenario: "second-coupon" }, headers)).status).toBe(409);
    const comparison = await request(`/runs/${run.id}/comparisons/${child.id}`);
    expect(comparison.status).toBe(200);
    expect((await comparison.json()).data).toMatchObject({ reportVersion: "report-v1", signatureVersion: "finding-v2", context: "fresh" });
  });

  it("does not clone or compare foreign parents/assignments even for an existing valid owner", async () => {
    const run = source();
    const attempt = repository.attempts(owner.ownerId, run.id)[0];
    const other = repository.createSession();
    const foreign = { cookie: `ff_owner=${other.token}`, "x-csrf-token": other.csrf, "idempotency-key": randomUUID() };
    expect((await request(`/runs/${run.id}/reruns`, "POST", {
      authorizationAcknowledged: true, attemptIds: [attempt.id],
    }, foreign)).status).toBe(404);
    expect((await request(`/runs/${run.id}/comparisons/${run.id}`, "GET", undefined, foreign)).status).toBe(404);
    expect((await request(`/runs/${run.id}/reruns`, "POST", {
      authorizationAcknowledged: true, attemptIds: [randomUUID()],
    }, { "idempotency-key": randomUUID() })).status).toBe(404);
  });
});
