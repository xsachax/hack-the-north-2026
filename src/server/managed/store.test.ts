import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoCriteria } from "../../lib/demo-run";
import { MANAGED_EXECUTION_POLICY, managedRunSchema, type ManagedCreate } from "../../lib/managed-contracts";
import { personas } from "../../lib/personas";
import type { ExecutionResult } from "../execution/types";
import { migrations } from "../migrations";
import { Repository } from "../repository";
import { workerPolicySchema, type WorkerPolicy } from "../worker/config";
import { WorkerRepository } from "../worker/repository";
import type { ManagedClaim, ManagedOutcome } from "./types";
import type { ManagedCreateFailure } from "./create-failure";

const createFailure: ManagedCreateFailure = {
  category: "http", httpStatus: 429, requestId: "original-post-id", requestIdHeader: "x-request-id",
};

const request = (ids: string[] = [personas[0].id]): ManagedCreate => ({
  executionPolicy: MANAGED_EXECUTION_POLICY,
  authorizationAcknowledged: true,
  managedPolicyAcknowledged: true,
  scope: { targetUrl: "https://example.com/", allowedSubdomains: [], pathPrefixes: ["/"] },
  assignments: ids.map((personaId) => ({ personaId, goal: "Find help", criteria: ["Help is visible"] })),
});
const outcome = (extra: Partial<ManagedOutcome> = {}): ManagedOutcome => ({
  status: "completed", providerStatus: "completed", cleanup: "closed", result: null,
  error: null, actualBrowserSeconds: 10.1, allocationAttempted: true, ...extra,
});
const nativeResult = (): ExecutionResult => ({
  status: "succeeded", reason: "offline test", checks: [], steps: 1, modelCalls: 1, durationMs: 10,
  cleanup: { status: "closed", errors: [] }, originalTerminal: { status: "succeeded", reason: "offline test" }, errors: [],
});
const views = {
  liveViewUrl: "https://www.browserbase.com/live?secret=private-view",
  replayUrl: "https://browserbase.com/sessions/private-session",
};

describe("managed durable store (offline)", () => {
  let dir: string;
  let time: number;
  let repository: WorkerRepository;
  let connections: Repository[];
  let databases: DatabaseSync[];
  let owner: string;
  let other: string;
  const open = (policy: Partial<WorkerPolicy> = { globalConcurrency: 8, ownerConcurrency: 8, sessionSeconds: 300 }) => {
    const value = new WorkerRepository(dir, policy, () => time);
    connections.push(value);
    return value;
  };
  const inspect = () => {
    const value = new DatabaseSync(join(dir, "flash-flood.sqlite"));
    databases.push(value);
    return value;
  };
  const configure = (policy: Partial<WorkerPolicy>) => {
    for (const connection of connections) connection.close();
    connections = [];
    rmSync(dir, { recursive: true, force: true });
    repository = open(policy);
    owner = repository.createSession().ownerId;
    other = repository.createSession().ownerId;
  };
  const create = (who = owner, count = 1, key = randomUUID()) =>
    repository.managed.create(who, key, request(personas.slice(0, count).map((persona) => persona.id)), repository.listPersonas(who)).run;
  const claim = (worker = "managed-worker", connection = repository): ManagedClaim => {
    const value = connection.managed.claim(worker, connection.policy);
    expect(value).not.toBeNull();
    return value!;
  };
  const dispatch = (leased: ManagedClaim, reference = { agentId: "agent-id", task: "task" }) =>
    repository.managed.dispatch(leased, reference);
  const native = (who = owner, count = 1) => repository.createDemoRun(who, randomUUID(), {
    authorizationAcknowledged: true, scenario: "fixed",
    assignments: personas.slice(0, count).map(({ id }) => ({
      personaId: id, goal: "Buy the mug using both coupons", criteria: [...demoCriteria],
    })),
  }).run;
  const finishNative = (leased: NonNullable<ReturnType<WorkerRepository["claim"]>>, seconds = 10) =>
    repository.finish(leased, nativeResult(), {
      reservedSeconds: repository.policy.sessionSeconds, elapsedSeconds: 1,
      remoteStatus: "COMPLETED", actualBrowserSeconds: seconds,
    });

  beforeEach(() => {
    dir = join(process.cwd(), `.managed-store-test-${randomUUID()}`);
    mkdirSync(dir, { mode: 0o700 });
    time = Date.parse("2026-09-19T06:00:00.000Z");
    connections = [];
    databases = [];
    repository = open();
    owner = repository.createSession().ownerId;
    other = repository.createSession().ownerId;
  });
  afterEach(() => {
    for (const database of databases) database.close();
    for (const connection of connections) connection.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("snapshots eight distinct actual personas without native jobs or HTTP-time reservations", () => {
    const run = create(owner, 8);
    expect(managedRunSchema.parse(run)).toEqual(run);
    expect(run).toMatchObject({ status: "queued", executionPolicy: MANAGED_EXECUTION_POLICY });
    expect(run.attempts).toHaveLength(8);
    expect(run.attempts.map((attempt) => attempt.persona)).toEqual(personas.slice(0, 8));
    for (const attempt of run.attempts) {
      expect(attempt).toMatchObject({
        status: "queued", reservedSeconds: 0, actualBrowserSeconds: null, modelCalls: null,
        cleanup: "not_started", cancelRequested: false, progress: [],
      });

    }
    const db = inspect();
    expect(db.prepare("SELECT count(*) AS n FROM jobs").get()?.n).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM launches").get()?.n).toBe(0);
    expect(db.prepare("SELECT sum(reserved_seconds) AS n FROM managed_attempts").get()?.n).toBe(0);
    expect(repository.claim("old-native-worker")).toBeNull();
  });

  it("distinguishes claim startup from provider running and freezes elapsed time only after closure", () => {
    const run = create();
    expect(repository.managed.get(owner, run.id).attempts[0]).toMatchObject({ startedAt: null, finishedAt: null, providerStatus: null });
    const leased = claim();
    const startedAt = new Date(time).toISOString();
    expect(repository.managed.get(owner, run.id).attempts[0]).toMatchObject({ startedAt, finishedAt: null, providerStatus: null });
    dispatch(leased);
    repository.managed.progress(leased, { id: "pending", kind: "status", text: "PENDING" });
    time += 1000;
    repository.managed.progress(leased, { id: "running", kind: "status", text: "RUNNING" });
    expect(repository.managed.get(owner, run.id).attempts[0].providerStatus).toBe("RUNNING");
    time += 2000;
    repository.managed.finish(leased, outcome());
    const finishedAt = new Date(time).toISOString();
    time += 5000;
    expect(repository.managed.get(owner, run.id).attempts[0]).toMatchObject({ startedAt, finishedAt, actualBrowserSeconds: 10.1 });
  });

  it("allows exactly five shared claims while unresolved cleanup retains its slot", () => {
    configure({ globalConcurrency: 5, ownerConcurrency: 5, sessionSeconds: 60 });
    create(owner, 5);
    const claims = Array.from({ length: 5 }, () => claim());
    for (const leased of claims) dispatch(leased);
    time += 1;
    create(owner);
    create(other);
    expect(repository.managed.claim("additional-worker", repository.policy)).toBeNull();
    repository.managed.finish(claims[0], outcome({ cleanup: "unconfirmed" }));
    expect(repository.managed.claim("additional-worker", repository.policy)).toBeNull();
    expect(inspect().prepare("SELECT sum(reserved_seconds) AS n FROM managed_attempts").get()?.n).toBe(300);
  });

  it("rejects nine, duplicate, and unresolved assignments atomically", () => {
    const profiles = repository.listPersonas(owner);
    expect(() => repository.managed.create(owner, randomUUID(),
      request(Array.from({ length: 9 }, (_, index) => `persona-${index}`)), profiles)).toThrow();
    expect(() => repository.managed.create(owner, randomUUID(), request([personas[0].id, personas[0].id]), profiles)).toThrow();
    expect(() => repository.managed.create(owner, randomUUID(), request([personas[0].id, "missing"]), profiles))
      .toThrow("not_found");
    expect(repository.managed.list(owner)).toEqual([]);
  });

  it("keeps canonical idempotency after persona deletion and never changes native requests", () => {
    const custom = repository.createPersona(owner, {
      name: "Original reader", character: "Reads carefully", device: "desktop", techComfort: "medium",
      patienceSteps: 12, readingStyle: "careful", quirks: ["Reads labels"], worries: ["Losing progress"],
    });
    const input = request([custom.id]);
    const key = randomUUID();
    const original = repository.managed.create(owner, key, input, repository.listPersonas(owner));
    expect(original.created).toBe(true);
    repository.deletePersona(owner, custom.id);
    const reordered: ManagedCreate = {
      assignments: input.assignments, scope: input.scope,
      managedPolicyAcknowledged: true as const, authorizationAcknowledged: true as const,
      executionPolicy: MANAGED_EXECUTION_POLICY,
    };
    expect(repository.managed.existing(owner, key, reordered)).toEqual(original.run);
    expect(repository.managed.create(owner, key, reordered, [])).toEqual({ run: original.run, created: false });
    expect(original.run.attempts[0].persona).toEqual(custom);
    expect(() => repository.managed.existing(owner, key, {
      ...input, assignments: [{ ...input.assignments[0], goal: "Different goal" }],
    })).toThrow("conflict");
    expect(repository.managed.existing(other, key, input)).toBeNull();
    const legacy = repository.createDemoRun(owner, key, {
      authorizationAcknowledged: true, scenario: "fixed",
      assignments: [{ personaId: personas[0].id, goal: "Buy the mug", criteria: [...demoCriteria] }],
    }).run;
    expect(repository.getRun(owner, legacy.id)).toEqual(legacy);
    expect(repository.managed.get(owner, original.run.id)).toEqual(original.run);
  });

  it("isolates get, list, cancellation and private views by both owner and run", () => {
    const run = create();
    const otherRun = create(other);
    const leased = claim();
    expect(repository.managed.view(owner, run.id, leased.id)).toBeNull();
    for (const operation of [
      () => repository.managed.get(other, run.id),
      () => repository.managed.cancel(other, run.id),
      () => repository.managed.view(other, run.id, leased.id),
      () => repository.managed.view(owner, otherRun.id, leased.id),
    ]) expect(operation).toThrow(expect.objectContaining({ code: "not_found", status: 404 }));
    dispatch(leased);
    repository.managed.identity(leased, { providerRunId: "private-run", providerSessionId: "private-session" });
    repository.managed.sessionView(leased, views);
    expect(repository.managed.view(owner, run.id, leased.id)).toBeNull();
    expect(repository.managed.list(other).map((item) => item.id)).toEqual([otherRun.id]);
    const encoded = JSON.stringify(repository.managed.get(owner, run.id));
    for (const privateValue of ["private-run", "private-session", "private-view", leased.correlationToken, leased.workerId]) {
      expect(encoded).not.toContain(privateValue);
    }
    expect(() => repository.managed.sessionView(leased, {
      ...views, liveViewUrl: "https://browserbase.com.evil.example/live",
    })).toThrow();
    expect(repository.managed.view(owner, run.id, leased.id)).toBeNull();
    repository.managed.finish(leased, outcome());
    expect(repository.managed.view(owner, run.id, leased.id)).toEqual({ liveViewUrl: "", replayUrl: views.replayUrl });
  });

  it("stores a live view only after session identity and never exposes it in the run payload", () => {
    const run = create();
    const leased = claim();
    dispatch(leased);
    expect(() => repository.managed.liveView(leased, { liveViewUrl: views.liveViewUrl })).toThrow("managed_identity_missing");
    repository.managed.identity(leased, { providerRunId: "private-run" });
    expect(() => repository.managed.liveView(leased, { liveViewUrl: views.liveViewUrl })).toThrow("managed_identity_missing");
    repository.managed.identity(leased, { providerRunId: "private-run", providerSessionId: "private-session" });
    expect(() => repository.managed.liveView(leased, { liveViewUrl: "https://browserbase.com.evil.example/live" })).toThrow();
    expect(() => repository.managed.liveView(leased, { liveViewUrl: "http://www.browserbase.com/live" })).toThrow();
    repository.managed.liveView(leased, { liveViewUrl: views.liveViewUrl });
    expect(inspect().prepare("SELECT live_view_url FROM managed_attempts WHERE id=?").get(leased.id))
      .toEqual({ live_view_url: views.liveViewUrl });
    const encoded = JSON.stringify(repository.managed.get(owner, run.id));
    expect(encoded).not.toContain(views.liveViewUrl);
    expect(encoded).not.toContain("private-view");
  });

  it("serves the live view only while running, leased, uncancelled and unfinished", () => {
    const live = (failure?: Partial<ManagedOutcome>, gate?: (runId: string) => void) => {
      const run = create();
      const leased = claim();
      const unavailable = [{ attemptId: leased.id, available: false, liveViewUrl: null }];
      dispatch(leased);
      repository.managed.identity(leased, { providerRunId: `run-${run.id}`, providerSessionId: `session-${run.id}` });
      expect(repository.managed.sessions(owner, run.id)).toEqual(unavailable);
      repository.managed.liveView(leased, { liveViewUrl: views.liveViewUrl });
      expect(repository.managed.sessions(owner, run.id)).toEqual(unavailable);
      repository.managed.progress(leased, { id: "status", kind: "status", text: "RUNNING" });
      expect(repository.managed.sessions(owner, run.id))
        .toEqual([{ attemptId: leased.id, available: true, liveViewUrl: views.liveViewUrl }]);
      expect(() => repository.managed.sessions(other, run.id))
        .toThrow(expect.objectContaining({ code: "not_found", status: 404 }));
      if (gate) gate(run.id);
      else {
        repository.managed.finish(leased, outcome(failure));
        expect(inspect().prepare("SELECT live_view_url FROM managed_attempts WHERE id=?").get(leased.id))
          .toEqual({ live_view_url: "" });
      }
      expect(repository.managed.sessions(owner, run.id)).toEqual(unavailable);
      if (gate) repository.managed.finish(claimOrSame(leased), outcome());
    };
    const claimOrSame = (leased: ManagedClaim) => {
      try { repository.managed.assertLease(leased, true); return leased; } catch { return claim(leased.workerId); }
    };
    live();
    live({ status: "failed", cleanup: "unconfirmed" });
    live(undefined, (runId) => { repository.managed.cancel(owner, runId); });
    live(undefined, () => { time += repository.policy.leaseMs + 1; });
  });

  it("requires RUNNING status before a stored live view becomes available", () => {
    const run = create();
    const leased = claim();
    dispatch(leased);
    repository.managed.identity(leased, { providerRunId: "private-run", providerSessionId: "private-session" });
    repository.managed.progress(leased, { id: "status", kind: "status", text: "RUNNING" });
    expect(repository.managed.sessions(owner, run.id)).toEqual([{ attemptId: leased.id, available: false, liveViewUrl: null }]);
    repository.managed.liveView(leased, { liveViewUrl: views.liveViewUrl });
    expect(repository.managed.sessions(owner, run.id)[0]).toEqual({ attemptId: leased.id, available: true, liveViewUrl: views.liveViewUrl });
  });

  it("returns one session item per attempt in run order", () => {
    const run = create(owner, 3);
    expect(repository.managed.sessions(owner, run.id)).toEqual(run.attempts.map((attempt) => ({
      attemptId: attempt.id, available: false, liveViewUrl: null,
    })));
    expect(() => repository.managed.sessions(owner, randomUUID()))
      .toThrow(expect.objectContaining({ code: "not_found", status: 404 }));
  });

  it("lists only the newest thirty owner runs and survives reopen", () => {
    const ids = Array.from({ length: 32 }, () => create().id);
    create(other);
    const second = open();
    expect(second.managed.list(owner).map((run) => run.id)).toEqual(ids.slice(-30).reverse());
    expect(second.managed.get(owner, ids[0])).toEqual(repository.managed.get(owner, ids[0]));
  });

  it("reserves durably before the one-way dispatch marker and keeps a stable original deadline", () => {
    const run = create();
    const first = claim();
    expect(first).toMatchObject({
      id: run.attempts[0].id, ownerId: owner, runId: run.id, generation: 1,
      reservedSeconds: 300, startedAt: time, recovery: false, dispatchStarted: false,
      persona: personas[0], scope: run.scope, goal: "Find help", criteria: ["Help is visible"],
    });
    expect(repository.accounting(owner).reservedSeconds).toBe(300);
    expect(() => repository.managed.identity(first, { providerRunId: "early" })).toThrow("managed_dispatch_not_started");
    dispatch(first);
    expect(() => dispatch(first)).toThrow("managed_dispatch_already_started");
    const db = inspect();
    expect(db.prepare("SELECT state,dispatch_started,reserved_seconds FROM managed_attempts WHERE id=?").get(first.id))
      .toEqual({ state: "dispatched", dispatch_started: 1, reserved_seconds: 300 });
    repository.managed.identity(first, { providerRunId: "run-id", providerSessionId: "session-id" });
    time += repository.policy.leaseMs + 1;
    const recovered = claim("replacement", open());
    expect(recovered).toMatchObject({
      id: first.id, generation: 2, recovery: true, dispatchStarted: true,
      startedAt: first.startedAt, correlationToken: first.correlationToken,
      providerRunId: "run-id", providerSessionId: "session-id",
    });
    expect(repository.accounting(owner).reservedSeconds).toBe(300);
    expect(() => dispatch(recovered)).toThrow("managed_recovery_cannot_dispatch");
  });

  it("pins the exact private agent and task for unknown-create recovery despite source or configuration changes", () => {
    const run = create();
    const first = claim();
    const configured = { agentId: "original-agent", task: "  Original private task\nExact instructions, version one.\n " };
    const saved = { ...configured };
    dispatch(first, configured);
    configured.agentId = "reconfigured-agent";
    configured.task = "Rebuilt instructions from changed source";
    expect(() => dispatch(first, configured)).toThrow("managed_dispatch_reference_changed");
    const db = inspect();
    expect(db.prepare("SELECT provider_agent_id,provider_task,dispatch_started FROM managed_attempts WHERE id=?").get(first.id))
      .toEqual({ provider_agent_id: saved.agentId, provider_task: saved.task, dispatch_started: 1 });
    expect(() => db.prepare("UPDATE managed_attempts SET provider_agent_id=? WHERE id=?").run(configured.agentId, first.id))
      .toThrow("immutable_managed_dispatch");
    expect(() => db.prepare("UPDATE managed_attempts SET provider_task=? WHERE id=?").run(configured.task, first.id))
      .toThrow("immutable_managed_dispatch");
    expect(() => db.prepare("UPDATE managed_attempts SET dispatch_started=0 WHERE id=?").run(first.id))
      .toThrow("immutable_managed_dispatch");

    time += repository.policy.leaseMs + 1;
    const recovered = claim("new-worker", open());
    expect(recovered).toMatchObject({
      id: first.id, recovery: true, dispatchStarted: true, startedAt: first.startedAt,
      providerAgentId: saved.agentId, providerTask: saved.task,
    });
    expect(recovered.providerRunId).toBeUndefined();
    expect(() => dispatch(recovered, configured)).toThrow("managed_recovery_cannot_dispatch");
    repository.managed.progress(recovered, { id: "private-reference", kind: "error", text: `${saved.agentId}: ${saved.task}` });
    repository.managed.finish(recovered, outcome({
      cleanup: "unconfirmed", actualBrowserSeconds: null, error: `${saved.agentId}: ${saved.task}`,
    }));
    const visible = repository.managed.get(owner, run.id);
    expect(visible.attempts[0]).toMatchObject({
      status: "cleanup_required", error: "[REDACTED]: [REDACTED]",
      progress: [expect.objectContaining({ text: "[REDACTED]: [REDACTED]" })],
    });
    for (const privateValue of [saved.agentId, saved.task, "providerAgentId", "providerTask"]) {
      expect(JSON.stringify(visible)).not.toContain(privateValue);
    }
    expect(repository.accounting(owner)).toMatchObject({ reservedSeconds: 300, committedSeconds: 300 });
  });

  it("rejects missing, blank, and oversized dispatch references without setting a marker or exposing task input", () => {
    create();
    const first = claim();
    const privateTask = "private task must not appear in validation errors";
    for (const reference of [
      undefined, { agentId: "", task: privateTask }, { agentId: " \t", task: privateTask },
      { agentId: "a".repeat(257), task: privateTask }, { agentId: "agent-id", task: "" },
      { agentId: "agent-id", task: "\n \t" }, { agentId: "agent-id", task: "x".repeat(65537) },
    ]) {
      expect(() => repository.managed.dispatch(first, reference as { agentId: string; task: string }))
        .toThrow(new Error("managed_dispatch_reference_invalid"));
    }
    const db = inspect();
    expect(db.prepare("SELECT provider_agent_id,provider_task,dispatch_started,state FROM managed_attempts WHERE id=?").get(first.id))
      .toEqual({ provider_agent_id: null, provider_task: null, dispatch_started: 0, state: "reserved" });
    expect(() => db.prepare("UPDATE managed_attempts SET dispatch_started=1 WHERE id=?").run(first.id))
      .toThrow("managed_dispatch_reference_invalid");
    dispatch(first, { agentId: "a".repeat(256), task: "x".repeat(65536) });
    expect(db.prepare("SELECT length(provider_task) AS n FROM managed_attempts WHERE id=?").get(first.id)?.n).toBe(65536);
  });

  it("recovers pre-dispatch crashes without creating and releases operating but not lifetime reservation", () => {
    const run = create();
    const original = claim();
    time += repository.policy.leaseMs + 1;
    const recovered = claim("replacement");
    expect(recovered).toMatchObject({ dispatchStarted: false, recovery: true, startedAt: original.startedAt });
    expect(() => dispatch({ ...recovered, recovery: false })).toThrow("managed_recovery_cannot_dispatch");
    repository.managed.finish(recovered, outcome({
      status: "failed", providerStatus: null, actualBrowserSeconds: null, allocationAttempted: false,
    }));
    expect(repository.accounting(owner)).toMatchObject({
      reservedSeconds: 300, consumedSeconds: 0, releasedSeconds: 300, committedSeconds: 0,
    });
    expect(repository.managed.get(owner, run.id).attempts[0]).toMatchObject({
      status: "failed", cleanup: "closed", actualBrowserSeconds: 0, modelCalls: null,
    });
    expect(repository.managed.claim("next", repository.policy)).toBeNull();
  });

  it("quarantines unknown create responses, retains slots, and bounds delayed safe recovery", () => {
    configure({ globalConcurrency: 1, ownerConcurrency: 1, recoveryLimit: 2 });
    const run = create();
    const first = claim();
    dispatch(first);
    repository.managed.createFailure(first, createFailure);
    const recorded = JSON.stringify({ ...createFailure, recordedAt: new Date(time).toISOString() });
    repository.managed.finish(first, outcome({
      status: "failed", providerStatus: null, cleanup: "unconfirmed", actualBrowserSeconds: null,
      error: "lost create response",
    }));
    create(other);
    const waitingNative = native(other);
    expect(repository.managed.get(owner, run.id).status).toBe("cleanup_required");
    expect(repository.accounting(owner)).toMatchObject({
      reservedSeconds: 240, consumedSeconds: 0, releasedSeconds: 0, committedSeconds: 240,
    });
    expect(repository.managed.claim("too-soon", repository.policy)).toBeNull();
    expect(repository.claim("native-waiting")).toBeNull();
    expect(repository.getRun(other, waitingNative.id).status).toBe("queued");
    for (let recovery = 1; recovery <= 2; recovery++) {
      time += 60_000;
      const recovered = claim(`recovery-${recovery}`);
      expect(recovered).toMatchObject({
        id: first.id, generation: recovery + 1, startedAt: first.startedAt,
        recovery: true, dispatchStarted: true,
      });
      expect(recovered.providerRunId).toBeUndefined();
      expect(() => dispatch(recovered)).toThrow("managed_recovery_cannot_dispatch");
      expect(() => repository.managed.createFailure(recovered, { ...createFailure, httpStatus: 503 }))
        .toThrow("managed_recovery_cannot_record_create_failure");
      repository.managed.finish(recovered, outcome({
        status: "failed", providerStatus: null, cleanup: "unconfirmed", actualBrowserSeconds: null,
        error: "managed_recovery_unconfirmed",
      }));
      expect(inspect().prepare("SELECT first_create_failure FROM managed_attempts WHERE id=?").get(first.id)?.first_create_failure)
        .toBe(recorded);
      expect(repository.accounting(owner)).toMatchObject({
        reservedSeconds: 240, consumedSeconds: 0, releasedSeconds: 0, committedSeconds: 240,
      });
    }
    time += 600_000;
    expect(repository.managed.claim("exhausted", repository.policy)).toBeNull();
    expect(repository.claim("still-held")).toBeNull();
    expect(repository.accounting(owner).reservedSeconds).toBe(240);
    expect(inspect().prepare("SELECT recovery_count,state FROM managed_attempts WHERE id=?").get(first.id))
      .toEqual({ recovery_count: 2, state: "quarantined" });
    expect(repository.managed.get(owner, run.id).attempts[0]).toMatchObject({
      error: "managed_recovery_unconfirmed", actualBrowserSeconds: null,
    });
  });

  it("persists create diagnostics once under the original lease, even after cancellation, and keeps them private", () => {
    const run = create();
    const first = claim();
    expect(() => repository.managed.createFailure(first, createFailure)).toThrow("managed_dispatch_not_started");
    dispatch(first);
    repository.managed.cancel(owner, run.id);
    repository.managed.createFailure(first, createFailure);
    const db = inspect();
    const read = () => db.prepare("SELECT first_create_failure FROM managed_attempts WHERE id=?").get(first.id)?.first_create_failure;
    const recorded = JSON.stringify({ ...createFailure, recordedAt: new Date(time).toISOString() });
    expect(read()).toBe(recorded);
    expect(() => repository.managed.createFailure(first, { ...createFailure, httpStatus: 500 }))
      .toThrow("managed_create_failure_already_recorded");
    for (const value of [null, JSON.stringify({ ...createFailure, httpStatus: 500 })]) {
      expect(() => db.prepare("UPDATE managed_attempts SET first_create_failure=? WHERE id=?").run(value, first.id))
        .toThrow("immutable_managed_create_failure");
    }
    repository.managed.finish(first, outcome({ cleanup: "unconfirmed", actualBrowserSeconds: null }));
    expect(read()).toBe(recorded);
    const visible = JSON.stringify(open().managed.get(owner, run.id));
    expect(visible).not.toContain("first_create_failure");
    expect(visible).not.toContain(createFailure.requestId);
    expect(repository.accounting(owner)).toMatchObject({ reservedSeconds: 300, consumedSeconds: 0, releasedSeconds: 0 });
    time += 60_000;
    const recovered = claim();
    repository.managed.finish(recovered, outcome());
    expect(read()).toBe(recorded);
  });

  it("rejects invalid diagnostic fields and removes private identity values from request IDs", () => {
    create();
    const first = claim();
    dispatch(first);
    expect(() => repository.managed.createFailure(first, { ...createFailure, requestId: "unsafe\nid" }))
      .toThrow("managed_create_failure_invalid");
    repository.managed.createFailure(first, { ...createFailure, requestId: first.correlationToken });
    const saved = inspect().prepare("SELECT first_create_failure FROM managed_attempts WHERE id=?").get(first.id)?.first_create_failure;
    expect(saved).toBe(JSON.stringify({
      ...createFailure, requestId: null, requestIdHeader: null, recordedAt: new Date(time).toISOString(),
    }));
  });

  it("fences every stale journal write, including same-worker lease-generation reuse", () => {
    create();
    const first = claim();
    dispatch(first);
    repository.managed.identity(first, { providerRunId: "stable-run" });
    time += repository.policy.leaseMs + 1;
    const recovered = claim(first.workerId);
    const stale = [
      () => repository.managed.assertLease(first, true),
      () => repository.managed.heartbeat(first, repository.policy.leaseMs),
      () => dispatch(first),
      () => repository.managed.createFailure(first, createFailure),
      () => repository.managed.identity(first, { providerRunId: "stable-run" }),
      () => repository.managed.progress(first, { id: "stale", kind: "text", text: "stale" }),
      () => repository.managed.sessionView(first, views),
      () => repository.managed.liveView(first, { liveViewUrl: views.liveViewUrl }),
      () => repository.managed.finish(first, outcome()),
    ];
    for (const write of stale) expect(write).toThrow("managed_lease_lost");
    for (const fake of [
      { ...recovered, ownerId: other }, { ...recovered, runId: randomUUID() },
      { ...recovered, correlationToken: randomUUID() }, { ...recovered, workerId: "wrong" },
    ]) expect(() => repository.managed.assertLease(fake, true)).toThrow("managed_lease_lost");
    repository.managed.finish(recovered, outcome());
    expect(() => repository.managed.finish(recovered, outcome())).toThrow("managed_lease_lost");
    expect(repository.accounting(owner)).toMatchObject({ consumedSeconds: 11, releasedSeconds: 289 });
  });

  it("rejects expired leases before another worker has claimed and heartbeat cannot revive them", () => {
    create();
    const first = claim();
    time += repository.policy.leaseMs - 1;
    expect(repository.managed.heartbeat(first, repository.policy.leaseMs)).toBe(false);
    time += repository.policy.leaseMs;
    expect(() => repository.managed.heartbeat(first, repository.policy.leaseMs)).toThrow("managed_lease_lost");
    expect(() => dispatch(first)).toThrow("managed_lease_lost");
  });

  it("cancels queued and pre-dispatch work without consumption but keeps acquired lifetime reservations", () => {
    const run = create(owner, 2);
    const first = claim();
    const cancelled = repository.managed.cancel(owner, run.id);
    expect(cancelled.attempts[1]).toMatchObject({ status: "cancelled", cleanup: "closed", reservedSeconds: 0 });
    expect(repository.managed.heartbeat(first, repository.policy.leaseMs)).toBe(true);
    expect(() => repository.managed.assertLease(first)).toThrow("cancel_requested");
    expect(() => dispatch(first)).toThrow("cancel_requested");
    expect(() => repository.managed.progress(first, { id: "cancelled", kind: "text", text: "no" })).toThrow("cancel_requested");
    repository.managed.finish(first, outcome({
      status: "cancelled", providerStatus: null, actualBrowserSeconds: null, allocationAttempted: false,
    }));
    expect(repository.managed.get(owner, run.id).status).toBe("cancelled");
    expect(repository.accounting(owner)).toMatchObject({
      reservedSeconds: 300, consumedSeconds: 0, releasedSeconds: 300, committedSeconds: 0,
    });
    expect(repository.managed.cancel(owner, run.id)).toEqual(repository.managed.get(owner, run.id));
  });

  it("records late provider identities for cancellation cleanup without changing or reusing identity", () => {
    const run = create();
    const first = claim();
    dispatch(first);
    repository.managed.cancel(owner, run.id);
    repository.managed.identity(first, { providerRunId: "one" });
    repository.managed.identity(first, { providerRunId: "one", providerSessionId: "session-one" });
    repository.managed.identity(first, { providerRunId: "one" });
    expect(() => repository.managed.identity(first, { providerRunId: "two" })).toThrow("managed_identity_changed");
    expect(() => repository.managed.identity(first, { providerRunId: "one", providerSessionId: "other-session" }))
      .toThrow("managed_identity_changed");
    expect(() => repository.managed.sessionView(first, views)).toThrow("cancel_requested");
    repository.managed.finish(first, outcome({ actualBrowserSeconds: null, allocationAttempted: false }));
    expect(repository.managed.get(owner, run.id).status).toBe("cancelled");
    expect(repository.accounting(owner)).toMatchObject({ reservedSeconds: 300, consumedSeconds: 300, releasedSeconds: 0 });
    create();
    const second = claim();
    dispatch(second);
    expect(() => repository.managed.identity(second, { providerRunId: "one" })).toThrow();
  });

  it("deduplicates provider event IDs durably, rejects journal overflow, and redacts before truncation", () => {
    const run = create();
    const first = claim();
    dispatch(first);
    repository.managed.identity(first, { providerRunId: "private-run", providerSessionId: "private-session" });
    repository.managed.sessionView(first, views);
    const event = {
      id: "provider-event-secret", kind: "text" as const,
      text: `private-run private-session ${views.liveViewUrl} password=hunter2 bb_live_privatecredentials ${"x".repeat(2200)}`,
    };
    repository.managed.progress(first, event);
    open().managed.progress(first, { ...event, text: "duplicate must not replace the original" });
    for (let index = 1; index < 500; index++) {
      repository.managed.progress(first, { id: `event-${index}`, kind: "status", text: `Progress ${index}` });
    }
    const full = repository.managed.get(owner, run.id);
    time++;
    expect(() => open().managed.progress(first, { ...event, text: "duplicate at capacity" })).not.toThrow();
    for (const id of ["event-500", "event-501"]) {
      expect(() => repository.managed.progress(first, { id, kind: "status", text: "Overflow" }))
        .toThrow(new Error("managed_progress_limit"));
    }
    expect(repository.managed.get(owner, run.id)).toEqual(full);
    const progress = repository.managed.get(owner, run.id).attempts[0].progress;
    expect(progress).toHaveLength(500);
    expect(progress[0].text).toHaveLength(2000);
    expect(progress.map((entry) => entry.sequence)).toEqual(Array.from({ length: 500 }, (_, index) => index + 1));
    const encoded = JSON.stringify(progress);
    for (const secret of ["private-run", "private-session", "private-view", "hunter2", "bb_live_", event.id, "duplicate must"]) {
      expect(encoded).not.toContain(secret);
    }
    expect(inspect().prepare("SELECT count(*) AS n FROM managed_progress").get()?.n).toBe(500);
  });

  it("sanitizes results and errors, strips private URL data, and never fabricates model-call counts", () => {
    const run = create();
    const first = claim();
    dispatch(first);
    repository.managed.identity(first, { providerRunId: "private-run", providerSessionId: "private-session" });
    repository.managed.finish(first, outcome({
      providerStatus: `completed-${"x".repeat(80)}`,
      error: `private-session token=hide ${"x".repeat(2200)}`,
      result: {
        summary: "Checked private-run and password=hidden", finalUrl: "https://example.com/help?token=secret#private",
        criteria: [{ criterion: "Help is visible", status: "met", observation: `Opened ${views.liveViewUrl}` }],
        limitations: ["Provider model-call usage is unavailable"],
      },
    }));
    const attempt = repository.managed.get(owner, run.id).attempts[0];
    expect(attempt).toMatchObject({
      modelCalls: null, actualBrowserSeconds: 10.1, result: { finalUrl: "https://example.com/help" },
    });
    expect(attempt.providerStatus).toHaveLength(64);
    expect(attempt.error).toHaveLength(2000);
    for (const secret of ["private-run", "private-session", "hidden", "token=secret", "private-view"]) {
      expect(JSON.stringify(attempt)).not.toContain(secret);
    }
  });

  it.each([
    { actual: 5.1, consumed: 6, released: 294 },
    { actual: null, consumed: 300, released: 0 },
    { actual: 401.2, consumed: 402, released: 0 },
    { actual: 0, consumed: 0, released: 300 },
  ])("accounts confirmed provider usage $actual without truncating over-reservation spend", ({ actual, consumed, released }) => {
    create();
    const leased = claim();
    dispatch(leased);
    repository.managed.finish(leased, outcome({ actualBrowserSeconds: actual }));
    expect(repository.accounting(owner)).toEqual({
      reservedSeconds: 300, consumedSeconds: consumed, releasedSeconds: released, committedSeconds: consumed, baselineSeconds: 0,
    });
    expect(repository.accounting().baselineSeconds).toBe(363);
  });

  it("retains observed overages across recovery and never rewrites historical consumption downward", () => {
    create();
    const first = claim();
    dispatch(first);
    repository.managed.finish(first, outcome({ cleanup: "unconfirmed", actualBrowserSeconds: 350.2 }));
    expect(repository.accounting(owner)).toMatchObject({ consumedSeconds: 351, committedSeconds: 351, releasedSeconds: 0 });
    time += 60_000;
    const recovered = claim("cleanup");
    repository.managed.finish(recovered, outcome({ actualBrowserSeconds: 2 }));
    expect(repository.accounting(owner)).toMatchObject({ reservedSeconds: 300, consumedSeconds: 351, committedSeconds: 351 });
  });

  it("does not mistake earlier partial usage for final usage when confirmed cleanup has no final meter", () => {
    create();
    const first = claim();
    dispatch(first);
    repository.managed.finish(first, outcome({ cleanup: "unconfirmed", actualBrowserSeconds: 5 }));
    time += 60_000;
    const recovered = claim("cleanup");
    repository.managed.finish(recovered, outcome({ actualBrowserSeconds: null }));
    expect(repository.accounting(owner)).toMatchObject({ consumedSeconds: 300, committedSeconds: 300, releasedSeconds: 0 });
  });

  it("unions native and managed product occupancy, including unknown reservations", () => {
    native(owner, 2);
    expect(repository.claim("native-a")).not.toBeNull();
    expect(repository.claim("native-b")).not.toBeNull();
    create(owner, 8);
    for (let index = 0; index < 6; index++) claim(`managed-${index}`);
    expect(repository.managed.claim("ninth", repository.policy)).toBeNull();
    const queuedNative = native(other);
    expect(repository.claim("also-ninth")).toBeNull();
    expect(repository.getRun(other, queuedNative.id).status).toBe("queued");
    expect(repository.accounting().reservedSeconds).toBe(2400);
  });

  it("applies lower owner and global limits in both directions without head-of-line owner blocking", () => {
    configure({ globalConcurrency: 3, ownerConcurrency: 1 });
    native();
    expect(repository.claim("native-owner")).not.toBeNull();
    const waitingManaged = create();
    const otherManaged = create(other);
    expect(claim().runId).toBe(otherManaged.id);
    const waitingNative = native(other);
    expect(repository.claim("other-owner-waiting")).toBeNull();
    expect(repository.managed.claim("same-owner-waiting", repository.policy)).toBeNull();
    expect(repository.managed.get(owner, waitingManaged.id).status).toBe("queued");
    expect(repository.getRun(other, waitingNative.id).status).toBe("queued");
  });

  it("preserves a 900-second native lifetime ledger and policy bytes in the same database", () => {
    configure({ globalConcurrency: 3, ownerConcurrency: 3, sessionSeconds: 300, lifetimeReservationLimitSeconds: 1200 });
    native(owner, 3);
    for (let index = 0; index < 3; index++) finishNative(repository.claim(`native-${index}`)!);
    expect(repository.accounting()).toEqual({
      reservedSeconds: 900, consumedSeconds: 30, releasedSeconds: 870, committedSeconds: 30, baselineSeconds: 363,
    });
    const db = inspect();
    const policyBefore = db.prepare("SELECT * FROM worker_policy").get();
    const nativeBefore = db.prepare("SELECT * FROM usage_reservations ORDER BY job_id").all();
    create();
    const managed = claim();
    dispatch(managed);
    repository.managed.finish(managed, outcome({ actualBrowserSeconds: 5.2 }));
    const blocked = create();
    expect(repository.managed.claim("lifetime-exhausted", repository.policy)).toBeNull();
    expect(repository.managed.get(owner, blocked.id).attempts[0].error).toBe("budget_exhausted");
    const nativeBlocked = native();
    expect(repository.claim("native-lifetime-exhausted")).toBeNull();
    expect(repository.getRun(owner, nativeBlocked.id).status).toBe("limit_reached");
    const second = open(repository.policy);
    expect(second.accounting()).toEqual({
      reservedSeconds: 1200, consumedSeconds: 36, releasedSeconds: 1164, committedSeconds: 36, baselineSeconds: 363,
    });
    expect(db.prepare("SELECT * FROM worker_policy").get()).toEqual(policyBefore);
    expect(db.prepare("SELECT * FROM usage_reservations WHERE reserved_seconds>0 ORDER BY job_id").all()).toEqual(nativeBefore);
  });

  it.each(["global", "owner"] as const)("includes native spend when enforcing managed %s budgets and vice versa", (budget) => {
    configure({
      globalConcurrency: 2, ownerConcurrency: 2, sessionSeconds: 300,
      ...(budget === "global" ? { developmentBudgetSeconds: 663 } : { ownerBudgetSeconds: 300 }),
    });
    native();
    const first = repository.claim("native-spend")!;
    finishNative(first, 1);
    const blocked = create();
    expect(repository.managed.claim("insufficient", repository.policy)).toBeNull();
    expect(repository.managed.get(owner, blocked.id).attempts[0]).toMatchObject({ error: "budget_exhausted", reservedSeconds: 0 });
    configure({
      globalConcurrency: 2, ownerConcurrency: 2, sessionSeconds: 300,
      ...(budget === "global" ? { developmentBudgetSeconds: 663 } : { ownerBudgetSeconds: 300 }),
    });
    create();
    const second = claim();
    dispatch(second);
    repository.managed.finish(second, outcome({ actualBrowserSeconds: 1 }));
    const nativeBlocked = native();
    expect(repository.claim("native-insufficient")).toBeNull();
    expect(repository.getRun(owner, nativeBlocked.id).status).toBe("limit_reached");
  });

  it("applies the appended migration without altering persisted historical policy and caps it at eight", () => {
    for (const connection of connections) connection.close();
    connections = [];
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o700 });
    const db = inspect();
    db.exec(migrations.slice(0, -1).join("\n"));
    db.exec(`PRAGMA user_version=${migrations.length - 1}`);
    const policy = workerPolicySchema.parse({ globalConcurrency: 12, ownerConcurrency: 12, sessionSeconds: 300 });
    const encoded = JSON.stringify(policy);
    db.prepare("INSERT INTO worker_policy VALUES(1,?,?)").run(encoded, policy.baselineSeconds);
    repository = open(policy);
    owner = repository.createSession().ownerId;
    other = repository.createSession().ownerId;
    create(owner, 8);
    create(other);
    for (let index = 0; index < 8; index++) claim(`managed-${index}`);
    expect(repository.managed.claim("historical-ninth", policy)).toBeNull();
    native(other);
    expect(repository.claim("historical-native-ninth")).toBeNull();
    expect(db.prepare("SELECT configuration FROM worker_policy").get()?.configuration).toBe(encoded);
    expect(() => repository.managed.claim("mismatch", { ...policy, globalConcurrency: 8 })).toThrow("worker_policy_mismatch");
    expect(db.prepare("SELECT configuration FROM worker_policy").get()?.configuration).toBe(encoded);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(migrations.length);
  });

  it("initializes absent policy only at worker admission, then rejects policy changes", () => {
    for (const connection of connections) connection.close();
    connections = [];
    rmSync(dir, { recursive: true, force: true });
    const api = new Repository(dir, () => time);
    connections.push(api);
    const session = api.createSession();
    api.managed.create(session.ownerId, randomUUID(), request(), api.listPersonas(session.ownerId));
    const db = inspect();
    expect(db.prepare("SELECT * FROM worker_policy").get()).toBeUndefined();
    const policy = workerPolicySchema.parse({});
    expect(api.managed.claim("first-worker", policy)).not.toBeNull();
    expect(db.prepare("SELECT configuration FROM worker_policy").get()?.configuration).toBe(JSON.stringify(policy));
    expect(() => api.managed.claim("mismatched-worker", { ...policy, sessionSeconds: 300 })).toThrow("worker_policy_mismatch");
    expect(open(policy).policy).toEqual(policy);
  });

  it("leaves four historical unknown creates untouched when adding diagnostics, without inventing original evidence", () => {
    const policy = repository.policy;
    for (const connection of connections) connection.close();
    connections = [];
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o700 });
    const db = inspect();
    db.exec(migrations.slice(0, -1).join("\n"));
    db.exec(`PRAGMA user_version=${migrations.length - 1}`);
    db.prepare("INSERT INTO worker_policy VALUES(1,?,?)").run(JSON.stringify(policy), policy.baselineSeconds);
    db.prepare("INSERT INTO owners VALUES(?,?,?,?)").run(owner, "legacy-hash", "legacy-csrf", time + 60_000);
    const runId = randomUUID();
    const now = new Date(time).toISOString();
    db.prepare(`INSERT INTO managed_runs(id,owner_id,idempotency_key,request_hash,execution_policy,scope,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(runId, owner, randomUUID(), "legacy-request", MANAGED_EXECUTION_POLICY,
        JSON.stringify(request().scope), now, now);
    for (let index = 0; index < 4; index++) {
      db.prepare(`INSERT INTO managed_attempts(id,run_id,persona,goal,criteria,correlation_token,status,state,cleanup,
        dispatch_started,reserved_seconds,started_at,recovery_count,error,provider_agent_id,provider_task)
        VALUES(?,?,?,?,?,?,'cleanup_required','quarantined','unconfirmed',1,60,?,6,'managed_recovery_unconfirmed',?,?)`)
        .run(randomUUID(), runId, JSON.stringify(personas[index]), "Find help", JSON.stringify(["Help is visible"]),
          randomUUID(), time - 60_000, "old-agent", "original task");
    }
    const rows = db.prepare("SELECT * FROM managed_attempts ORDER BY id").all();
    const originalPolicy = db.prepare("SELECT * FROM worker_policy").get();
    repository = open(policy);
    const upgraded = inspect();
    expect(upgraded.prepare("PRAGMA user_version").get()?.user_version).toBe(migrations.length);
    expect(upgraded.prepare("SELECT * FROM managed_attempts ORDER BY id").all())
      .toEqual(rows.map((row) => ({ ...row, first_create_failure: null })));
    expect(upgraded.prepare("SELECT * FROM worker_policy").get()).toEqual(originalPolicy);
    expect(repository.managed.claim("no-counter-reset", policy)).toBeNull();
    expect(repository.accounting(owner)).toMatchObject({
      reservedSeconds: 240, consumedSeconds: 0, releasedSeconds: 0, committedSeconds: 240,
    });
    for (const attempt of repository.managed.get(owner, runId).attempts) {
      expect(attempt).toMatchObject({ status: "cleanup_required", cleanup: "unconfirmed", actualBrowserSeconds: null });
    }
  });

  it("adds dispatch snapshot columns to an existing preview ledger without guessing legacy task or agent values", () => {
    const policy = repository.policy;
    for (const connection of connections) connection.close();
    connections = [];
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o700 });
    const db = inspect();
    db.exec(migrations.slice(0, -1).join("\n"));
    db.exec(`PRAGMA user_version=${migrations.length - 1}`);
    db.prepare("INSERT INTO worker_policy VALUES(1,?,?)").run(JSON.stringify(policy), policy.baselineSeconds);
    db.prepare("INSERT INTO owners VALUES(?,?,?,?)").run(owner, "preview-hash", "preview-csrf", time + 60_000);
    const runId = randomUUID();
    const attemptId = randomUUID();
    const now = new Date(time).toISOString();
    db.prepare(`INSERT INTO managed_runs(id,owner_id,idempotency_key,request_hash,execution_policy,scope,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(runId, owner, randomUUID(), "preview-request", MANAGED_EXECUTION_POLICY,
        JSON.stringify(request().scope), now, now);
    db.prepare(`INSERT INTO managed_attempts(id,run_id,persona,goal,criteria,correlation_token,
      status,state,cleanup,dispatch_started,reserved_seconds,started_at,lease_expires_at)
      VALUES(?,?,?,?,?,?,'running','dispatched','unconfirmed',1,300,?,?)`)
      .run(attemptId, runId, JSON.stringify(personas[0]), "Find help", JSON.stringify(["Help is visible"]),
        randomUUID(), time - 31_000, time - 1);
    repository = open(policy);
    const recovered = claim();
    expect(recovered).toMatchObject({ id: attemptId, recovery: true, dispatchStarted: true, reservedSeconds: 300 });
    expect(recovered.providerAgentId).toBeUndefined();
    expect(recovered.providerTask).toBeUndefined();
    expect(repository.accounting(owner)).toMatchObject({ reservedSeconds: 300, consumedSeconds: 0, committedSeconds: 300 });
    expect(db.prepare("SELECT configuration FROM worker_policy").get()?.configuration).toBe(JSON.stringify(policy));
    expect(() => dispatch(recovered)).toThrow("managed_recovery_cannot_dispatch");
  });
});
