import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TerminalStatus } from "../../lib/contracts";
import { demoCriteria, type DemoRun } from "../../lib/demo-run";
import { personas } from "../../lib/personas";
import type { ArtifactReference } from "../execution/artifacts";
import type { CloudUsage, PrivateSessionReference } from "../execution/cloud";
import type { ExecutionResult } from "../execution/types";
import { readWorkerPolicy, workerPolicySchema, type WorkerPolicy } from "./config";
import { LeaseLostError, WorkerRepository, type Claim } from "./repository";

const page = { after: 0, limit: 100 };
const demo = (count = 1, scenario: DemoRun["scenario"] = "fixed"): DemoRun => ({
  authorizationAcknowledged: true,
  scenario,
  assignments: personas.slice(0, count).map(({ id }) => ({
    personaId: id, goal: "Buy the mug using both coupons", criteria: [...demoCriteria],
  })),
});
const result = (status: TerminalStatus = "succeeded"): ExecutionResult => ({
  status, reason: "offline test", checks: [], steps: 1, modelCalls: 1, durationMs: 10,
  cleanup: { status: "closed", errors: [] }, originalTerminal: { status, reason: "offline test" }, errors: [],
});
const usage = (extra: Partial<CloudUsage> = {}): CloudUsage => ({
  reservedSeconds: 240, elapsedSeconds: 1, remoteStatus: "COMPLETED", actualBrowserSeconds: 1, ...extra,
});
const reference = (extra: Partial<PrivateSessionReference> = {}): PrivateSessionReference => ({
  sessionId: randomUUID(), liveViewUrl: "https://www.browserbase.com/live",
  replayUrl: "https://browserbase.com/sessions/replay", timeoutSeconds: 240, ...extra,
});
const artifact = (): ArtifactReference => ({
  key: randomUUID().replaceAll("-", "").repeat(2), kind: "json", bytes: 12, sha256: "a".repeat(64),
});

describe("worker configuration (offline)", () => {
  it("has bounded defaults and preserves the external 363-second baseline", () => {
    expect(readWorkerPolicy({ NODE_ENV: "test" })).toEqual({
      globalConcurrency: 3, ownerConcurrency: 3, developmentBudgetSeconds: 324000,
      ownerBudgetSeconds: 3600, baselineSeconds: 363, sessionSeconds: 240,
      maxSteps: 14, maxModelCalls: 14, leaseMs: 30000, recoveryLimit: 6,
      lifetimeReservationLimitSeconds: 324000,
    });
    expect(workerPolicySchema.parse({})).toEqual(readWorkerPolicy({ NODE_ENV: "test" }));
  });

  const fields = [
    ["globalConcurrency", "MAX_CONCURRENT_SESSIONS", 1, 12],
    ["ownerConcurrency", "MAX_OWNER_SESSIONS", 1, 12],
    ["developmentBudgetSeconds", "DEVELOPMENT_BUDGET_SECONDS", 363, 324000],
    ["ownerBudgetSeconds", "OWNER_BUDGET_SECONDS", 1, 324000],
    ["baselineSeconds", "EXTERNAL_BASELINE_SECONDS", 363, 324000],
    ["sessionSeconds", "SESSION_TIMEOUT_SECONDS", 60, 300],
    ["maxSteps", "MAX_STEPS_PER_PERSONA", 1, 30],
    ["maxModelCalls", "MAX_MODEL_CALLS_PER_PERSONA", 1, 30],
    ["leaseMs", "WORKER_LEASE_MS", 5000, 120000],
    ["recoveryLimit", "WORKER_RECOVERY_LIMIT", 1, 10],
    ["lifetimeReservationLimitSeconds", "LIFETIME_RESERVATION_LIMIT_SECONDS", 60, 324000],
  ] as const;

  it.each(fields)("validates %s and reads %s without silently replacing invalid values", (field, env, min, max) => {
    for (const value of [min, max]) {
      expect(workerPolicySchema.parse({ [field]: value })[field]).toBe(value);
      expect(readWorkerPolicy({ NODE_ENV: "test", [env]: String(value) })[field]).toBe(value);
    }
    for (const value of [min - 1, max + 1, min + 0.5, NaN, Infinity, -Infinity, null, "1"]) {
      expect(() => workerPolicySchema.parse({ [field]: value })).toThrow();
    }
    for (const value of ["", " ", "not-a-number", "Infinity", "1.5", "-1"]) {
      expect(() => readWorkerPolicy({ NODE_ENV: "test", [env]: value })).toThrow();
    }
  });

  it("rejects unknown policy keys but ignores unrelated environment variables", () => {
    expect(() => workerPolicySchema.parse({ typo: 1 })).toThrow();
    expect(readWorkerPolicy({ NODE_ENV: "test", PATH: "/offline", BROWSERBASE_API_KEY: "never-used" }))
      .toEqual(readWorkerPolicy({ NODE_ENV: "test" }));
  });
});

describe("durable worker repository (offline)", () => {
  let dir: string;
  let time: number;
  let policy: Partial<WorkerPolicy>;
  let repository: WorkerRepository;
  let owner: string;
  let other: string;
  let connections: WorkerRepository[];
  let databases: DatabaseSync[];
  let children: ChildProcessWithoutNullStreams[];
  const open = () => {
    const connection = new WorkerRepository(dir, policy, () => time);
    connections.push(connection);
    return connection;
  };
  const close = (connection: WorkerRepository) => {
    connection.close();
    connections.splice(connections.indexOf(connection), 1);
  };
  const inspect = () => {
    const database = new DatabaseSync(join(dir, "flash-flood.sqlite"));
    database.exec("PRAGMA busy_timeout=5000");
    databases.push(database);
    return database;
  };
  const create = (who = owner, count = 1, scenario: DemoRun["scenario"] = "fixed") =>
    repository.createDemoRun(who, randomUUID(), demo(count, scenario)).run;
  const claim = (worker = "worker-a", connection = repository) => {
    const value = connection.claim(worker);
    expect(value).not.toBeNull();
    return value!;
  };
  const events = (runId: string, who = owner) => repository.events(who, runId, page).items;
  const configure = (input: Partial<WorkerPolicy>) => {
    // Every policy case gets an empty database, not an in-place policy edit.
    close(repository);
    rmSync(dir, { recursive: true, force: true });
    policy = input;
    repository = open();
    owner = repository.createSession().ownerId;
    other = repository.createSession().ownerId;
  };

  beforeEach(() => {
    dir = join(process.cwd(), `.worker-repository-test-${randomUUID()}`);
    mkdirSync(dir, { mode: 0o700 });
    time = Date.parse("2026-09-19T06:00:00.000Z");
    policy = {};
    connections = [];
    databases = [];
    children = [];
    repository = open();
    owner = repository.createSession().ownerId;
    other = repository.createSession().ownerId;
  });

  afterEach(async () => {
    try {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          child.kill("SIGKILL");
          await exited;
        }
      }
      for (const database of databases) database.close();
      for (const connection of connections) connection.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pins normalized policy across reopen and independent connections", () => {
    const second = open();
    expect(second.policy).toEqual(repository.policy);
    expect(repository.accounting()).toEqual({
      reservedSeconds: 0, consumedSeconds: 0, releasedSeconds: 0, committedSeconds: 0, baselineSeconds: 363,
    });
    expect(repository.accounting(owner).baselineSeconds).toBe(0);
    expect(() => new WorkerRepository(dir, { globalConcurrency: 2 }, () => time)).toThrow("worker_policy_mismatch");
    expect(() => new WorkerRepository(dir, { baselineSeconds: 0 }, () => time)).toThrow();
    create();
    expect(claim("second", second).generation).toBe(1);
    close(repository);
    repository = open();
    expect(repository.accounting().reservedSeconds).toBe(240);
    expect(inspect().prepare("SELECT count(*) AS n FROM worker_policy").get()?.n).toBe(1);
  });

  it.each(["fixed", "second-coupon"] as const)("reserves before committing one durable %s launch intent", (scenario) => {
    const run = create(owner, 1, scenario);
    const leased = claim();
    expect(leased).toMatchObject({
      ownerId: owner, runId: run.id, workerId: "worker-a", generation: 1, scenario, recovery: false,
      attempt: { status: "running", criteria: [...demoCriteria] },
    });
    expect(leased.correlationToken).toMatch(/^[\da-f-]{36}$/);
    const database = inspect();
    expect(database.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(database.prepare("SELECT state,session_reference FROM launches WHERE job_id=?").get(leased.jobId))
      .toEqual({ state: "intent", session_reference: null });
    expect(database.prepare("SELECT reserved_seconds FROM usage_reservations WHERE job_id=?").get(leased.jobId)?.reserved_seconds).toBe(240);
    expect(repository.getRun(owner, run.id).status).toBe("running");
    expect(repository.claim("again")).toBeNull();
    expect(events(run.id).map((event) => event.kind)).toEqual(["run.created", "attempt.started"]);
  });

  it("rolls reservation, run state and lifecycle back if durable launch insertion fails", () => {
    const run = create();
    const database = inspect();
    database.exec(`CREATE TRIGGER reject_launch BEFORE INSERT ON launches
      BEGIN SELECT RAISE(ABORT, 'injected launch failure'); END`);
    expect(() => repository.claim("worker")).toThrow("injected launch failure");
    expect(repository.accounting().reservedSeconds).toBe(0);
    expect(repository.getRun(owner, run.id).status).toBe("queued");
    expect(events(run.id).map((event) => event.kind)).toEqual(["run.created"]);
    expect(database.prepare("SELECT lease_generation FROM jobs").get()?.lease_generation).toBe(0);
    database.exec("DROP TRIGGER reject_launch");
    expect(claim().generation).toBe(1);
  });

  it("blocks public targets without reserving or launching and still claims eligible fixture work", () => {
    const run = repository.createRun(owner, randomUUID(), {
      authorizationAcknowledged: true,
      scope: { targetUrl: "https://example.com", allowedSubdomains: [], pathPrefixes: ["/"] },
      assignments: demo().assignments,
    }).run;
    const eligible = create();
    expect(claim().runId).toBe(eligible.id);
    expect(repository.getRun(owner, run.id).status).toBe("blocked");
    expect(events(run.id).find((event) => event.kind === "attempt.finished")?.data.reason).toBe("blocked_unsupported");
    expect(repository.accounting().reservedSeconds).toBe(240);
    expect(inspect().prepare("SELECT count(*) AS n FROM launches").get()?.n).toBe(1);
  });

  it("rejects unsupported requests at admission and blocks unsupported persisted criteria at claim", () => {
    const unsupported = demo();
    unsupported.assignments[0].criteria = ["Invented success criterion"];
    expect(() => repository.createDemoRun(owner, randomUUID(), unsupported)).toThrow(
      expect.objectContaining({ code: "unsupported_criteria" }),
    );
    const run = create();
    const attempt = repository.attempts(owner, run.id)[0];
    inspect().prepare("UPDATE attempts SET snapshot=? WHERE id=?")
      .run(JSON.stringify({ ...attempt, criteria: unsupported.assignments[0].criteria }), attempt.id);
    expect(repository.claim("worker")).toBeNull();
    expect(repository.getRun(owner, run.id).status).toBe("blocked");
    expect(events(run.id).find((event) => event.kind === "attempt.finished")?.data.reason).toBe("unsupported_criteria");
    expect(repository.accounting().reservedSeconds).toBe(0);
  });

  it("enforces owner and global slots atomically across connections without owner head-of-line blocking", () => {
    configure({ globalConcurrency: 2, ownerConcurrency: 1 });
    const first = create(owner, 2);
    const second = create(other);
    const connection = open();
    const a = claim();
    const b = claim("worker-b", connection);
    expect(a.runId).toBe(first.id);
    expect(b.runId).toBe(second.id);
    expect(connection.claim("full")).toBeNull();
    expect(repository.accounting(owner).reservedSeconds).toBe(240);
    expect(repository.accounting(other).reservedSeconds).toBe(240);
    repository.finish(a, result(), usage());
    expect(claim("worker-c", connection).runId).toBe(first.id);
    expect(repository.accounting().reservedSeconds).toBe(720);
  });

  it("does not let over 100 queued jobs from capped owners starve a later eligible owner", () => {
    configure({ globalConcurrency: 3, ownerConcurrency: 1, recoveryLimit: 1 });
    for (const cappedOwner of [owner, other]) {
      create(cappedOwner);
      const held = claim(`quarantine-${cappedOwner}`);
      repository.recover(held, { confirmed: false, sessions: [] });
    }
    const blockedRuns: { ownerId: string; runId: string }[] = [];
    for (const cappedOwner of [owner, other]) {
      for (let i = 0; i < 5; i++) {
        const run = create(cappedOwner, 12);
        expect(repository.attempts(cappedOwner, run.id)).toHaveLength(12);
        blockedRuns.push({ ownerId: cappedOwner, runId: run.id });
      }
    }
    const database = inspect();
    expect(database.prepare("SELECT count(*) AS n FROM jobs WHERE status='queued'").get()?.n).toBe(120);
    expect(database.prepare("SELECT count(*) AS n FROM launches WHERE state='quarantined'").get()?.n).toBe(2);
    const thirdOwner = repository.createSession().ownerId;
    const eligible = create(thirdOwner);
    const leased = claim("free-third-slot", open());
    expect(leased).toMatchObject({ ownerId: thirdOwner, runId: eligible.id, recovery: false });
    expect(repository.accounting().reservedSeconds).toBe(720);
    expect(database.prepare("SELECT count(*) AS n FROM jobs WHERE status='queued'").get()?.n).toBe(120);
    for (const blocked of blockedRuns) {
      expect(repository.getRun(blocked.ownerId, blocked.runId).status).toBe("queued");
      expect(events(blocked.runId, blocked.ownerId).map((event) => event.kind)).toEqual(["run.created"]);
    }
  });

  it.each([
    ["development", { developmentBudgetSeconds: 602 }],
    ["owner", { ownerBudgetSeconds: 239 }],
    ["lifetime", { lifetimeReservationLimitSeconds: 239 }],
  ] as const)("rejects exhausted %s budget before reservation, intent or lease", (_name, input) => {
    configure(input);
    const run = create();
    expect(repository.claim("worker")).toBeNull();
    expect(repository.getRun(owner, run.id).status).toBe("limit_reached");
    expect(events(run.id).find((event) => event.kind === "attempt.finished")?.data.reason).toBe("budget_exhausted");
    expect(repository.accounting().reservedSeconds).toBe(0);
    const database = inspect();
    expect(database.prepare("SELECT count(*) AS n FROM launches").get()?.n).toBe(0);
    expect(database.prepare("SELECT lease_generation FROM jobs").get()?.lease_generation).toBe(0);
  });

  it("admits exact budget equality and never refunds the lifetime reservation ceiling", () => {
    configure({ developmentBudgetSeconds: 603, ownerBudgetSeconds: 240, lifetimeReservationLimitSeconds: 240 });
    create();
    const leased = claim();
    repository.finish(leased, result(), usage({ actualBrowserSeconds: 0 }));
    expect(repository.accounting()).toMatchObject({ reservedSeconds: 240, releasedSeconds: 240, committedSeconds: 0 });
    const next = create();
    expect(repository.claim("next")).toBeNull();
    expect(repository.getRun(owner, next.id).status).toBe("limit_reached");
  });

  it("refunds measured settled usage for future development and owner admissions", () => {
    configure({ developmentBudgetSeconds: 604, ownerBudgetSeconds: 241 });
    create();
    repository.finish(claim(), result(), usage());
    create();
    expect(claim("next").recovery).toBe(false);
    expect(repository.accounting().committedSeconds).toBe(241);
  });

  it("skips an exhausted owner's queue without spending another owner's allowance", () => {
    configure({ ownerBudgetSeconds: 240 });
    create(owner);
    repository.finish(claim(), result(), usage({ actualBrowserSeconds: 240 }));
    const blocked = create(owner);
    const eligible = create(other);
    expect(claim("other-owner").runId).toBe(eligible.id);
    expect(repository.getRun(owner, blocked.id).status).toBe("limit_reached");
    expect(repository.accounting(owner).committedSeconds).toBe(240);
    expect(repository.accounting(other).committedSeconds).toBe(240);
  });

  it("extends a live lease and fails exactly at expiration without heartbeat resurrection", () => {
    create();
    const leased = claim();
    time += 29999;
    expect(repository.heartbeat(leased)).toBe(false);
    time += 29999;
    expect(() => repository.assertLease(leased)).not.toThrow();
    time++;
    expect(() => repository.heartbeat(leased)).toThrow(LeaseLostError);
    expect(() => repository.assertLease(leased, true)).toThrow(LeaseLostError);
    const recovered = claim("replacement");
    expect(recovered).toMatchObject({
      generation: 2, recovery: true, correlationToken: leased.correlationToken, jobId: leased.jobId,
    });
    expect(repository.accounting().reservedSeconds).toBe(240);
  });

  it("fences all stale writes after expiry/reassignment and does not append stale events", () => {
    const run = create();
    const stale = claim();
    const evidence = repository.recordArtifact(stale, artifact(), "observation");
    time += repository.policy.leaseMs;
    const current = claim("replacement");
    const before = events(run.id);
    for (const action of [
      () => repository.assertLease(stale),
      () => repository.heartbeat(stale),
      () => repository.sessionReference(stale, reference()),
      () => repository.recordArtifact(stale, artifact(), "screenshot"),
      () => repository.recordStep(stale, "action", evidence, { action: "click" }),
      () => repository.finish(stale, result(), usage()),
      () => repository.recover(stale, { confirmed: true, sessions: [{ sessionId: randomUUID(), status: "COMPLETED" }] }),
      () => repository.assertLease({ ...current, workerId: "impostor" }),
      () => repository.assertLease({ ...current, generation: current.generation + 1 }),
    ]) expect(action).toThrow(LeaseLostError);
    expect(events(run.id)).toEqual(before);
    expect(repository.accounting().consumedSeconds).toBe(0);
  });

  it("persists private session references through recovery without exposing cloud URLs in events", () => {
    const run = create();
    const leased = claim();
    const ref = reference();
    repository.sessionReference(leased, ref);
    repository.sessionReference(leased, { ...ref, liveViewUrl: "" });
    expect(() => repository.sessionReference(leased, reference())).toThrow("launch_session_changed");
    close(repository);
    repository = open();
    time += repository.policy.leaseMs;
    expect(claim("recovery")).toMatchObject({ sessionId: ref.sessionId, correlationToken: leased.correlationToken, recovery: true });
    expect(JSON.stringify(events(run.id))).not.toContain("browserbase");
    expect(JSON.stringify(events(run.id))).not.toContain(ref.sessionId);
  });

  it.each([
    { sessionId: "not-a-uuid" }, { timeoutSeconds: 0 }, { timeoutSeconds: 301 },
    { liveViewUrl: "http://browserbase.com/live" }, { replayUrl: "https://browserbase.com.evil.test/session" },
    { liveViewUrl: "https://evilbrowserbase.com/live" }, { replayUrl: "https://user:password@browserbase.com/session" },
    { replayUrl: "javascript:alert(1)" }, { liveViewUrl: "https://example.com" }, { replayUrl: "" },
  ])("rejects invalid private cloud references: %j", (invalid) => {
    create();
    const leased = claim();
    expect(() => repository.sessionReference(leased, reference(invalid))).toThrow();
    expect(inspect().prepare("SELECT state,session_reference FROM launches").get()).toEqual({ state: "intent", session_reference: null });
  });

  it("records fenced evidence and ordered agent steps, rejects foreign evidence and rolls invalid data back", () => {
    const run = create(owner, 2);
    const a = claim();
    const b = claim("worker-b");
    const evidence = repository.recordArtifact(a, artifact(), "observation");
    for (const kind of ["observation", "decision", "action"] as const) repository.recordStep(a, kind, evidence, { commentary: "Offline step" });
    expect(events(run.id).filter((event) => event.kind.startsWith("attempt.") && event.data.evidenceId))
      .toHaveLength(3);
    expect(inspect().prepare("SELECT ordinal,kind FROM attempt_steps ORDER BY ordinal").all()).toEqual([
      { ordinal: 1, kind: "observation" }, { ordinal: 2, kind: "decision" }, { ordinal: 3, kind: "action" },
    ]);
    expect(() => repository.recordStep(b, "action", evidence, {})).toThrow("step_evidence_mismatch");
    expect(() => repository.recordStep(a, "action", randomUUID(), {})).toThrow("step_evidence_mismatch");
    const before = events(run.id);
    expect(() => repository.recordStep(a, "action", evidence, { commentary: "x".repeat(241) })).toThrow();
    expect(() => repository.recordArtifact(a, { ...artifact(), key: "../unsafe" }, "observation")).toThrow();
    expect(events(run.id)).toEqual(before);
    expect(repository.getEvidence(owner, evidence)).toMatchObject({ runId: run.id, attemptId: a.attempt.id, kind: "observation" });
  });

  it("caps durable step events at 100 without partial insertion", () => {
    create();
    const leased = claim();
    const evidence = repository.recordArtifact(leased, artifact(), "observation");
    for (let i = 0; i < 100; i++) repository.recordStep(leased, "observation", evidence, {});
    expect(() => repository.recordStep(leased, "observation", evidence, {})).toThrow("step_event_limit");
    expect(inspect().prepare("SELECT count(*) AS n FROM attempt_steps").get()?.n).toBe(100);
  });

  it("cancels queued jobs idempotently without creating a launch or usage charge", () => {
    const run = create(owner, 3);
    repository.cancelRun(owner, run.id);
    const before = events(run.id);
    repository.cancelRun(owner, run.id);
    expect(events(run.id)).toEqual(before);
    expect(repository.claim("worker")).toBeNull();
    expect(repository.attempts(owner, run.id).every((attempt) => attempt.status === "cancelled")).toBe(true);
    expect(repository.accounting().reservedSeconds).toBe(0);
    expect(inspect().prepare("SELECT count(*) AS n FROM launches").get()?.n).toBe(0);
    expect(before.filter((event) => event.kind === "run.finished")).toHaveLength(1);
  });

  it.each(["cancel-first", "finish-first"] as const)("serializes the %s cancellation/completion race", (order) => {
    const run = create();
    const leased = claim();
    const second = open();
    if (order === "cancel-first") {
      second.cancelRun(owner, run.id);
      expect(repository.heartbeat(leased)).toBe(true);
      expect(() => repository.assertLease(leased)).toThrow(expect.objectContaining({ name: "AbortError" }));
      expect(() => repository.assertLease(leased, true)).not.toThrow();
      expect(() => repository.recordArtifact(leased, artifact(), "observation")).toThrow(expect.objectContaining({ name: "AbortError" }));
      repository.sessionReference(leased, reference());
      repository.finish(leased, result(), usage());
    } else {
      repository.finish(leased, result(), usage());
      second.cancelRun(owner, run.id);
    }
    expect(repository.getRun(owner, run.id).status).toBe(order === "cancel-first" ? "cancelled" : "succeeded");
    expect(events(run.id).filter((event) => event.kind === "attempt.finished")).toHaveLength(1);
    expect(events(run.id).filter((event) => event.kind === "run.finished")).toHaveLength(1);
    expect(() => repository.finish(leased, result(), usage())).toThrow(LeaseLostError);
    expect(repository.accounting().releasedSeconds).toBe(239);
  });

  it("cancels queued siblings but holds the live reservation until terminal cleanup is proven", () => {
    const run = create(owner, 3);
    const leased = claim();
    repository.cancelRun(owner, run.id);
    expect(repository.getRun(owner, run.id).status).toBe("running");
    expect(repository.attempts(owner, run.id).map((attempt) => attempt.status)).toEqual(["running", "cancelled", "cancelled"]);
    repository.finish(leased, result("cancelled"), usage({ remoteStatus: "RUNNING" }));
    expect(repository.accounting().releasedSeconds).toBe(0);
    time += 2000;
    const recovered = claim("cleanup");
    repository.recover(recovered, { confirmed: true, sessions: [{ sessionId: randomUUID(), status: "COMPLETED", actualBrowserSeconds: 2 }] });
    expect(repository.getRun(owner, run.id).status).toBe("infrastructure_failed");
    expect(repository.accounting().releasedSeconds).toBe(238);
  });

  it("rejects post-cancellation steps while allowing heartbeat and cleanup reference recording", () => {
    const run = create();
    const leased = claim();
    const evidence = repository.recordArtifact(leased, artifact(), "observation");
    repository.cancelRun(owner, run.id);
    const before = events(run.id);
    expect(() => repository.recordStep(leased, "action", evidence, {}))
      .toThrow(expect.objectContaining({ name: "AbortError" }));
    expect(repository.heartbeat(leased)).toBe(true);
    expect(() => repository.sessionReference(leased, reference())).not.toThrow();
    expect(events(run.id)).toEqual(before);
  });

  it.each(["COMPLETED", "ERROR", "TIMED_OUT"])("settles only confirmed remote terminal state %s", (remoteStatus) => {
    const run = create();
    const leased = claim();
    repository.finish(leased, result(), usage({ remoteStatus, actualBrowserSeconds: 1.01, reservedSeconds: 99999, elapsedSeconds: 99999 }));
    expect(repository.getRun(owner, run.id).status).toBe("succeeded");
    expect(repository.accounting()).toMatchObject({ reservedSeconds: 240, consumedSeconds: 2, releasedSeconds: 238, committedSeconds: 2 });
    expect(inspect().prepare("SELECT state FROM launches").get()?.state).toBe("settled");
  });

  it("rejects malformed execution results before mutating settlement or lifecycle state", () => {
    const run = create();
    const leased = claim();
    const before = events(run.id);
    const invalidResults: unknown[] = [
      null, {}, { ...result(), status: "running" }, { ...result(), reason: "x".repeat(2001) },
      { ...result(), steps: -1 }, { ...result(), steps: 31 }, { ...result(), modelCalls: 0.5 },
      { ...result(), modelCalls: 31 }, { ...result(), durationMs: -1 }, { ...result(), durationMs: Infinity },
      { ...result(), originalTerminal: { status: "queued", reason: "invalid" } },
      { ...result(), cleanup: { status: "unknown", errors: [] } },
      { ...result(), cleanup: { status: "closed", errors: ["x".repeat(2001)] } },
      { ...result(), checks: [{ criterion: "test", passed: "yes", evidence: "test" }] },
      { ...result(), errors: Array.from({ length: 101 }, () => "error") },
      { ...result(), extraField: true },
    ];
    for (const invalid of invalidResults) {
      expect(() => repository.finish(leased, invalid as ExecutionResult, usage())).toThrow();
    }
    expect(events(run.id)).toEqual(before);
    expect(repository.getRun(owner, run.id).status).toBe("running");
    expect(repository.accounting()).toMatchObject({ consumedSeconds: 0, releasedSeconds: 0, committedSeconds: 240 });
    expect(inspect().prepare("SELECT state,usage,summary FROM launches").get()).toEqual({ state: "intent", usage: null, summary: null });
    expect(() => repository.assertLease(leased)).not.toThrow();
  });

  it.each([
    { status: "failed", errors: [] },
    { status: "closed", errors: ["Cleanup failed"] },
    { status: "failed", errors: ["Cleanup failed"] },
  ] as const)("prioritizes cleanup failure over adapter success and cancellation: %j", (cleanup) => {
    const run = create();
    const leased = claim();
    repository.cancelRun(owner, run.id);
    repository.finish(leased, { ...result(), cleanup }, usage());
    expect(repository.getRun(owner, run.id).status).toBe("infrastructure_failed");
    expect(repository.attempts(owner, run.id)[0].status).toBe("infrastructure_failed");
    expect(events(run.id).find((event) => event.kind === "attempt.finished")?.data.status).toBe("infrastructure_failed");
    expect(repository.accounting()).toMatchObject({ consumedSeconds: 1, releasedSeconds: 239, committedSeconds: 1 });
    const stored = JSON.parse(String(inspect().prepare("SELECT summary FROM launches").get()?.summary));
    expect(stored.originalTerminal.status).toBe("succeeded");
    expect(stored.cleanup).toEqual(cleanup);
  });

  it.each([
    [0, 0, 240], [0.001, 1, 239], [239.1, 240, 0], [240.1, 241, 0], [999, 999, 0], [undefined, 240, 0],
  ])("accounts conservatively for actual usage %s", (actualBrowserSeconds, consumed, released) => {
    create();
    repository.finish(claim(), result(), usage({ actualBrowserSeconds }));
    expect(repository.accounting()).toMatchObject({
      reservedSeconds: 240, consumedSeconds: consumed, releasedSeconds: released, committedSeconds: consumed,
    });
  });

  it.each([-1, NaN, Infinity, -Infinity])("rejects invalid usage %s atomically", (actualBrowserSeconds) => {
    const run = create();
    const leased = claim();
    expect(() => repository.finish(leased, result(), usage({ actualBrowserSeconds }))).toThrow("invalid_usage");
    expect(repository.getRun(owner, run.id).status).toBe("running");
    expect(repository.accounting()).toMatchObject({ consumedSeconds: 0, releasedSeconds: 0, committedSeconds: 240 });
    expect(inspect().prepare("SELECT state,usage,summary FROM launches").get()).toEqual({ state: "intent", usage: null, summary: null });
    expect(() => repository.assertLease(leased)).not.toThrow();
  });

  it("rolls back the entire settlement when the terminal event cannot be durably appended", () => {
    const run = create();
    const leased = claim();
    const database = inspect();
    database.exec(`CREATE TRIGGER reject_finish BEFORE INSERT ON events
      WHEN json_extract(NEW.event, '$.kind')='attempt.finished'
      BEGIN SELECT RAISE(ABORT, 'injected finish failure'); END`);
    expect(() => repository.finish(leased, result(), usage())).toThrow("injected finish failure");
    expect(repository.getRun(owner, run.id).status).toBe("running");
    expect(repository.accounting()).toMatchObject({ consumedSeconds: 0, releasedSeconds: 0, committedSeconds: 240 });
    expect(database.prepare("SELECT state,usage,summary FROM launches").get()).toEqual({ state: "intent", usage: null, summary: null });
    expect(() => repository.assertLease(leased)).not.toThrow();
    database.exec("DROP TRIGGER reject_finish");
    repository.finish(leased, result(), usage());
    expect(repository.getRun(owner, run.id).status).toBe("succeeded");
  });

  it.each([undefined, "RUNNING", "REQUEST_RELEASE", "completed", "UNKNOWN"])("retains reservation and slot for unconfirmed state %s", (remoteStatus) => {
    configure({ globalConcurrency: 1 });
    const run = create();
    const leased = claim();
    create(other);
    repository.finish(leased, result(), usage({ remoteStatus }));
    expect(repository.getRun(owner, run.id).status).toBe("running");
    expect(repository.accounting()).toMatchObject({ reservedSeconds: 240, releasedSeconds: 0, committedSeconds: 240 });
    expect(repository.claim("too-early")).toBeNull();
    expect(events(run.id).some((event) => event.kind === "attempt.finished")).toBe(false);
    expect(() => repository.assertLease(leased)).toThrow(LeaseLostError);
    time += 2000;
    expect(claim("recovery")).toMatchObject({ recovery: true, jobId: leased.jobId, correlationToken: leased.correlationToken });
  });

  it("bounds exponential unknown-ID recovery, quarantines permanently and retains the occupied slot", () => {
    configure({ globalConcurrency: 1, recoveryLimit: 8 });
    const run = create();
    const initial = claim();
    create(other);
    let current = initial;
    for (let count = 1; count <= 8; count++) {
      repository.recover(current, { confirmed: true, sessions: [] });
      if (count < 8) {
        const wait = Math.min(60000, 1000 * 2 ** count);
        time += wait - 1;
        expect(repository.claim("before-due")).toBeNull();
        time++;
        current = claim(`recovery-${count}`);
        expect(current).toMatchObject({
          recovery: true, generation: count + 1, correlationToken: initial.correlationToken, sessionId: undefined,
        });
      }
    }
    expect(repository.getRun(owner, run.id).status).toBe("infrastructure_failed");
    expect(events(run.id).filter((event) => event.kind === "attempt.started")).toHaveLength(1);
    expect(events(run.id).filter((event) => event.kind === "attempt.finished")).toHaveLength(1);
    expect(events(run.id).find((event) => event.kind === "attempt.finished")?.data.reason).toBe("cleanup_unconfirmed");
    expect(repository.accounting()).toMatchObject({ reservedSeconds: 240, releasedSeconds: 0, committedSeconds: 240 });
    time += 3600000;
    close(repository);
    repository = open();
    expect(repository.claim("never-relaunch")).toBeNull();
    expect(inspect().prepare("SELECT state,recovery_count FROM launches").get()).toEqual({ state: "quarantined", recovery_count: 8 });
  });

  it("settles operator-claimed quarantine without changing its terminal outcome or duplicating lifecycle events", () => {
    configure({ globalConcurrency: 1, recoveryLimit: 1 });
    const run = create();
    const initial = claim();
    const pending = create(other);
    repository.recover(initial, { confirmed: false, sessions: [] });
    expect(repository.getRun(owner, run.id).status).toBe("infrastructure_failed");
    expect(repository.attempts(owner, run.id)[0].status).toBe("infrastructure_failed");
    expect(repository.accounting()).toMatchObject({ reservedSeconds: 240, releasedSeconds: 0, committedSeconds: 240 });
    expect(repository.claim("ordinary-worker")).toBeNull();
    const terminalEvents = events(run.id).filter((event) =>
      event.kind === "attempt.finished" || event.kind === "run.finished");
    expect(terminalEvents.map((event) => event.kind)).toEqual(["attempt.finished", "run.finished"]);

    close(repository);
    repository = open();
    const recovered = repository.claimQuarantined(initial.jobId, "operator-cleanup");
    expect(recovered).toMatchObject({
      jobId: initial.jobId, generation: initial.generation + 1, recovery: true,
      correlationToken: initial.correlationToken, attempt: { status: "infrastructure_failed" },
    });
    const database = inspect();
    expect(database.prepare("SELECT state,recovery_count,recovery_after FROM launches").get())
      .toEqual({ state: "recovering", recovery_count: 0, recovery_after: null });
    expect(() => repository.claimQuarantined(initial.jobId, "duplicate-operator")).toThrow("job_not_quarantined");
    expect(() => repository.assertLease(initial, true)).toThrow(LeaseLostError);
    expect(repository.claim("still-occupied")).toBeNull();
    expect(repository.accounting().reservedSeconds).toBe(240);

    repository.recover(recovered, { confirmed: true, sessions: [
      { sessionId: randomUUID(), status: "COMPLETED", actualBrowserSeconds: 12.2 },
    ] });
    expect(repository.accounting()).toMatchObject({
      reservedSeconds: 240, consumedSeconds: 13, releasedSeconds: 227, committedSeconds: 13,
    });
    expect(database.prepare("SELECT state FROM launches WHERE job_id=?").get(initial.jobId)?.state).toBe("settled");
    expect(database.prepare("SELECT status,lease_owner,lease_expires_at FROM jobs WHERE id=?").get(initial.jobId))
      .toEqual({ status: "completed", lease_owner: null, lease_expires_at: null });
    expect(repository.getRun(owner, run.id).status).toBe("infrastructure_failed");
    expect(repository.attempts(owner, run.id)[0].status).toBe("infrastructure_failed");
    expect(events(run.id).filter((event) => event.kind === "attempt.finished" || event.kind === "run.finished"))
      .toEqual(terminalEvents);
    expect(events(run.id).filter((event) => event.kind === "attempt.started")).toHaveLength(1);
    expect(() => repository.claimQuarantined(initial.jobId, "already-settled")).toThrow("job_not_quarantined");
    expect(claim("new-work").runId).toBe(pending.id);
    expect(repository.accounting(owner).reservedSeconds).toBe(240);
    expect(repository.accounting(other).reservedSeconds).toBe(240);
  });

  it("allows initially empty metadata lookup to become terminal without launching again", () => {
    const run = create();
    const initial = claim();
    time += repository.policy.leaseMs;
    let recovered = claim("recovery-1");
    repository.recover(recovered, { confirmed: false, sessions: [] });
    time += 2000;
    recovered = claim("recovery-2");
    repository.recover(recovered, { confirmed: true, sessions: [
      { sessionId: randomUUID(), status: "COMPLETED", actualBrowserSeconds: 1.2 },
      { sessionId: randomUUID(), status: "ERROR", actualBrowserSeconds: 2.2 },
    ] });
    expect(repository.getRun(owner, run.id).status).toBe("infrastructure_failed");
    expect(repository.accounting()).toMatchObject({ consumedSeconds: 4, releasedSeconds: 236, committedSeconds: 4 });
    expect(recovered.correlationToken).toBe(initial.correlationToken);
    expect(inspect().prepare("SELECT count(*) AS n FROM launches").get()?.n).toBe(1);
  });

  it("requires every discovered remote session to terminate and conservatively charges missing usage", () => {
    create();
    const initial = claim();
    const completedId = randomUUID();
    const pendingId = randomUUID();
    repository.recover(initial, { confirmed: true, sessions: [
      { sessionId: completedId, status: "COMPLETED" },
      { sessionId: pendingId, status: "RUNNING" },
    ] });
    expect(repository.accounting().releasedSeconds).toBe(0);
    time += 2000;
    repository.recover(claim("recovery"), { confirmed: true, sessions: [
      { sessionId: completedId, status: "COMPLETED" },
      { sessionId: pendingId, status: "TIMED_OUT" },
    ] });
    expect(repository.accounting()).toMatchObject({ consumedSeconds: 480, releasedSeconds: 0, committedSeconds: 480 });
  });

  it("releases a never-attempted allocation under the current lease without remote proof", () => {
    configure({ globalConcurrency: 1 });
    const run = create();
    const leased = claim();
    repository.cancelRun(owner, run.id);
    repository.finish(leased, result("cancelled"), { allocationAttempted: false, reservedSeconds: 240, elapsedSeconds: 1 });
    expect(repository.getRun(owner, run.id).status).toBe("cancelled");
    expect(repository.accounting()).toMatchObject({ consumedSeconds: 0, releasedSeconds: 240, committedSeconds: 0 });
    create(other);
    expect(claim("new-job").recovery).toBe(false);
  });

  it.each([undefined, true])("missing/attempted allocation proof %s never refunds an unknown launch", (allocationAttempted) => {
    configure({ globalConcurrency: 1, recoveryLimit: 1 });
    const run = create();
    repository.finish(claim(), result("infrastructure_failed"), { allocationAttempted, reservedSeconds: 240, elapsedSeconds: 1 });
    expect(repository.getRun(owner, run.id).status).toBe("infrastructure_failed");
    expect(repository.accounting()).toMatchObject({ consumedSeconds: 0, releasedSeconds: 0, committedSeconds: 240 });
    create(other);
    expect(repository.claim("no-duplicate")).toBeNull();
  });

  it("rejects contradictory no-allocation proof and never lets stale ownership refund", () => {
    create();
    const leased = claim();
    repository.sessionReference(leased, reference());
    expect(() => repository.finish(leased, result("cancelled"), {
      allocationAttempted: false, reservedSeconds: 240, elapsedSeconds: 1,
    })).toThrow("contradictory_allocation_evidence");
    expect(repository.accounting().releasedSeconds).toBe(0);
    time += repository.policy.leaseMs;
    expect(() => repository.finish(leased, result("cancelled"), {
      allocationAttempted: false, reservedSeconds: 240, elapsedSeconds: 1,
    })).toThrow(LeaseLostError);
  });

  it("retains a verified 400-second partial recovery charge before deciding another 240-second admission", () => {
    configure({ developmentBudgetSeconds: 863 });
    create();
    const leased = claim();
    const waiting = create(other);
    const sessionId = randomUUID();
    repository.recover(leased, { confirmed: false, sessions: [{ sessionId, status: "COMPLETED", actualBrowserSeconds: 400 }] });
    expect(repository.accounting()).toMatchObject({ consumedSeconds: 400, releasedSeconds: 0, committedSeconds: 400 });
    expect(repository.claim("cannot-spend-1003")).toBeNull();
    expect(repository.getRun(other, waiting.id).status).toBe("limit_reached");
    close(repository);
    repository = open();
    time += 2000;
    repository.recover(claim("retry"), { confirmed: false, sessions: [{ sessionId, status: "COMPLETED", actualBrowserSeconds: 400 }] });
    expect(repository.accounting().consumedSeconds).toBe(400);
    expect(inspect().prepare("SELECT count(*) AS n FROM remote_usage_observations").get()?.n).toBe(1);
  });

  it("aggregates disjoint partial sessions once and preserves their maximum observations across retries", () => {
    create();
    const a = randomUUID(), b = randomUUID();
    repository.recover(claim(), { confirmed: false, sessions: [{ sessionId: a, status: "COMPLETED", actualBrowserSeconds: 1.2 }] });
    time += 2000;
    repository.recover(claim("b"), { confirmed: false, sessions: [{ sessionId: b, status: "COMPLETED", actualBrowserSeconds: 2.2 }] });
    expect(repository.accounting()).toMatchObject({ consumedSeconds: 4, releasedSeconds: 0, committedSeconds: 240 });
    time += 4000;
    repository.recover(claim("retry-a"), { confirmed: false, sessions: [
      { sessionId: a, status: "COMPLETED", actualBrowserSeconds: 1 }, { sessionId: a, status: "COMPLETED", actualBrowserSeconds: 1.2 },
    ] });
    expect(repository.accounting().consumedSeconds).toBe(4);
    time += 8000;
    repository.recover(claim("final"), { confirmed: true, sessions: [
      { sessionId: a, status: "COMPLETED" }, { sessionId: b, status: "COMPLETED", actualBrowserSeconds: 2.2 },
    ] });
    expect(repository.accounting()).toMatchObject({ consumedSeconds: 4, releasedSeconds: 236, committedSeconds: 4 });
  });

  it("does not lose an outstanding known remote when a later partial list omits it", () => {
    const run = create();
    const a = randomUUID(), b = randomUUID();
    repository.recover(claim(), { confirmed: false, sessions: [{ sessionId: a, status: "RUNNING" }] });
    time += 2000;
    repository.recover(claim("partial-list"), { confirmed: true, sessions: [{ sessionId: b, status: "COMPLETED", actualBrowserSeconds: 20 }] });
    expect(repository.accounting()).toMatchObject({ consumedSeconds: 260, releasedSeconds: 0, committedSeconds: 260 });
    expect(repository.getRun(owner, run.id).status).toBe("running");
    time += 4000;
    repository.recover(claim("both-closed"), { confirmed: true, sessions: [
      { sessionId: a, status: "COMPLETED", actualBrowserSeconds: 10 }, { sessionId: b, status: "COMPLETED", actualBrowserSeconds: 20 },
    ] });
    expect(repository.getRun(owner, run.id).status).toBe("infrastructure_failed");
    expect(repository.accounting().consumedSeconds).toBe(260);
    expect(repository.attemptSummaries(owner, run.id)[0].usage?.actualBrowserSeconds).toBe(30);
  });

  it("does not infer release from terminal metadata when the recovery adapter cannot confirm cleanup", () => {
    const run = create();
    repository.recover(claim(), { confirmed: false, sessions: [
      { sessionId: randomUUID(), status: "COMPLETED", actualBrowserSeconds: 0 },
    ] });
    expect(repository.getRun(owner, run.id).status).toBe("running");
    expect(repository.accounting()).toMatchObject({ consumedSeconds: 0, releasedSeconds: 0, committedSeconds: 240 });
    expect(inspect().prepare("SELECT state FROM launches").get()?.state).toBe("recovering");
  });

  it("charges an observed overrun during uncertain cleanup without releasing a slot or reservation", () => {
    configure({ globalConcurrency: 1 });
    const run = create();
    repository.finish(claim(), result(), usage({ remoteStatus: "RUNNING", actualBrowserSeconds: 300.01 }));
    create(other);
    expect(repository.getRun(owner, run.id).status).toBe("running");
    expect(repository.accounting()).toMatchObject({ reservedSeconds: 240, consumedSeconds: 301, releasedSeconds: 0, committedSeconds: 301 });
    expect(repository.claim("blocked-by-uncertainty")).toBeNull();
  });

  it("preserves the maximum observed charge and model counters across recovery", () => {
    create();
    const initial = claim();
    const modelMetrics = { totalPromptTokens: 12, totalCompletionTokens: 3 } as CloudUsage["modelMetrics"];
    repository.finish(initial, result(), usage({ remoteStatus: "RUNNING", actualBrowserSeconds: 20.2, modelMetrics }));
    time += 2000;
    repository.recover(claim("recovery"), { confirmed: true, sessions: [
      { sessionId: randomUUID(), status: "COMPLETED", actualBrowserSeconds: 1 },
    ] });
    expect(repository.accounting()).toMatchObject({ consumedSeconds: 21, releasedSeconds: 219, committedSeconds: 21 });
    const persisted = JSON.parse(String(inspect().prepare("SELECT usage FROM launches").get()?.usage));
    expect(persisted.modelMetrics).toEqual(modelMetrics);
  });

  it("does not duplicate lifecycle events when clients poll or a completed claim is retried", () => {
    const run = create();
    const leased = claim();
    repository.finish(leased, result(), usage());
    const before = events(run.id);
    for (let i = 0; i < 10; i++) {
      repository.getRun(owner, run.id);
      repository.attempts(owner, run.id);
      repository.events(owner, run.id, page);
      expect(repository.claim("poll")).toBeNull();
      repository.cancelRun(owner, run.id);
    }
    expect(() => repository.recover(leased, { confirmed: true, sessions: [] })).toThrow(LeaseLostError);
    expect(events(run.id)).toEqual(before);
    expect(before.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(before.map((event) => event.kind)).toEqual(["run.created", "attempt.started", "attempt.finished", "run.finished"]);
  });

  it("rejects invalid worker IDs and corrupted snapshots before mutating reservations", () => {
    create();
    for (const worker of ["", "x".repeat(129)]) expect(() => repository.claim(worker)).toThrow();
    const database = inspect();
    database.exec("UPDATE attempts SET snapshot='{}'");
    expect(() => repository.claim("worker")).toThrow();
    expect(repository.accounting().reservedSeconds).toBe(0);
    expect(database.prepare("SELECT count(*) AS n FROM launches").get()?.n).toBe(0);
    expect(database.prepare("SELECT lease_generation FROM jobs").get()?.lease_generation).toBe(0);
  });

  it("rolls recovery lease acquisition back on a corrupt persisted session reference", () => {
    create();
    const leased = claim();
    const database = inspect();
    database.exec("UPDATE launches SET session_reference='{}'");
    time += repository.policy.leaseMs;
    expect(() => repository.claim("recovery")).toThrow();
    expect(database.prepare("SELECT lease_generation FROM jobs").get()?.lease_generation).toBe(1);
    expect(database.prepare("SELECT state FROM launches").get()?.state).toBe("intent");
    expect(events(leased.runId).filter((event) => event.kind === "attempt.recovering")).toHaveLength(0);
  });

  type Message = { kind: string; claim?: Claim | null; pid?: number; error?: string };
  const startChild = () => {
    const child = spawn(process.execPath, [
      "--import", "tsx", join(process.cwd(), "src/server/worker/fixtures/claim-process.ts"),
      dir, JSON.stringify(policy), String(time), `child-${randomUUID()}`,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    const messages: Message[] = [];
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    createInterface({ input: child.stdout }).on("line", (line) => messages.push(JSON.parse(line)));
    const wait = async (kind: string): Promise<Message> => {
      const deadline = performance.now() + 7000;
      while (performance.now() < deadline) {
        const found = messages.find((message) => message.kind === kind);
        if (found) return found;
        if (messages.some((message) => message.kind === "failed") || child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Fixture exited: ${JSON.stringify(messages)} ${stderr}`);
        }
        await delay(10);
      }
      throw new Error(`Fixture timed out waiting for ${kind}: ${JSON.stringify(messages)} ${stderr}`);
    };
    return { child, messages, wait };
  };

  it.each(["global", "owner"] as const)("enforces the %s cap with two actual contending Node/tsx processes", async (cap) => {
    configure(cap === "global" ? { globalConcurrency: 1 } : { globalConcurrency: 2, ownerConcurrency: 1 });
    create(owner, 2);
    if (cap === "global") create(other);
    const a = startChild();
    const b = startChild();
    await Promise.all([a.wait("ready"), b.wait("ready")]);
    const database = inspect();
    database.exec("BEGIN IMMEDIATE");
    try {
      a.child.stdin.write("claim\n");
      b.child.stdin.write("claim\n");
      await Promise.all([a.wait("attempting"), b.wait("attempting")]);
      await delay(100);
      expect(a.messages.some((message) => message.kind === "claimed")).toBe(false);
      expect(b.messages.some((message) => message.kind === "claimed")).toBe(false);
    } finally {
      database.exec("COMMIT");
    }
    const responses = await Promise.all([a.wait("claimed"), b.wait("claimed")]);
    expect(responses.filter((response) => response.claim !== null)).toHaveLength(1);
    expect(responses.filter((response) => response.claim === null)).toHaveLength(1);
    expect(repository.accounting().reservedSeconds).toBe(240);
    expect(database.prepare("SELECT count(*) AS n FROM launches").get()?.n).toBe(1);
    expect(database.prepare("SELECT count(*) AS n FROM jobs WHERE status='leased'").get()?.n).toBe(1);
    expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  }, 15000);

  it("recovers a specifically killed process after durable intent, never launching a second session", async () => {
    const run = create();
    const processFixture = startChild();
    const ready = await processFixture.wait("ready");
    expect(ready.pid).toBe(processFixture.child.pid);
    processFixture.child.stdin.write("claim\n");
    const original = (await processFixture.wait("claimed")).claim!;
    expect(original.recovery).toBe(false);
    const database = inspect();
    expect(database.prepare("SELECT state,session_reference FROM launches").get()).toEqual({ state: "intent", session_reference: null });
    const exited = new Promise<void>((resolve) => processFixture.child.once("exit", () => resolve()));
    processFixture.child.kill("SIGKILL");
    await exited;
    close(repository);
    repository = open();
    expect(repository.claim("before-expiry")).toBeNull();
    time += repository.policy.leaseMs;
    const replacement = claim("replacement");
    expect(replacement).toMatchObject({
      jobId: original.jobId, generation: original.generation + 1, recovery: true,
      correlationToken: original.correlationToken, sessionId: undefined,
    });
    expect(() => repository.finish(original, result(), usage())).toThrow(LeaseLostError);
    repository.recover(replacement, { confirmed: false, sessions: [] });
    expect(repository.accounting().reservedSeconds).toBe(240);
    expect(database.prepare("SELECT count(*) AS n FROM launches").get()?.n).toBe(1);
    expect(events(run.id).filter((event) => event.kind === "attempt.started")).toHaveLength(1);
  }, 15000);
});
