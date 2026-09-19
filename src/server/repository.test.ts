import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateRun, PersonaProfile, Run, TerminalStatus } from "../lib/contracts";
import { personas } from "../lib/personas";
import { migrations } from "./migrations";
import { Repository } from "./repository";

const page = { after: 0, limit: 100 };
const profile: PersonaProfile = {
  name: "Custom reader", character: "Checks every detail", device: "desktop",
  techComfort: "medium", patienceSteps: 12, readingStyle: "careful",
  quirks: ["Reads labels"], worries: ["Losing progress"],
};
const request = (ids: string[] = [personas[0].id]): CreateRun => ({
  authorizationAcknowledged: true,
  scope: { targetUrl: "https://example.com", allowedSubdomains: [], pathPrefixes: ["/"] },
  assignments: ids.map((personaId) => ({ personaId, goal: "Find help", criteria: ["Help is visible"] })),
});
const key = () => randomUUID();
const storageKey = () => randomUUID().replaceAll("-", "").repeat(2);
const expectError = (action: () => unknown, code: string, status: number) => {
  expect(action).toThrow(expect.objectContaining({ code, status }));
};

describe("SQLite repository (offline)", () => {
  let dir: string;
  let time: number;
  let repository: Repository;
  let owner: string;
  let other: string;
  let connections: Repository[];
  let databases: DatabaseSync[];
  let children: ChildProcess[];
  const open = () => {
    const connection = new Repository(dir, () => time);
    connections.push(connection);
    return connection;
  };
  const inspect = () => {
    const database = new DatabaseSync(join(dir, "flash-flood.sqlite"));
    databases.push(database);
    return database;
  };
  const create = (ids?: string[]) => repository.createRun(owner, key(), request(ids)).run;
  const firstAttempt = (runId: string) => repository.attempts(owner, runId)[0];
  const evidenceFor = (runId: string, attemptId: string) => ({
    runId, attemptId, kind: "observation" as const, summary: "Help link was hidden",
  });
  const findingFor = (runId: string, attemptId: string, evidenceIds: string[]) => ({
    runId, attemptId, title: "Hidden help", description: "The help link is difficult to locate", evidenceIds,
  });

  beforeEach(() => {
    // Keep disposable SQLite files inside the checkout, never the host's shared temp directory.
    dir = join(process.cwd(), `.repository-test-${randomUUID()}`);
    mkdirSync(dir, { mode: 0o700 });
    time = Date.parse("2026-09-19T06:00:00.000Z");
    connections = [];
    databases = [];
    children = [];
    repository = open();
    owner = repository.createSession().ownerId;
    other = repository.createSession().ownerId;
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await exited;
      }
    }
    for (const database of databases) database.close();
    for (const connection of connections) connection.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const close = (connection: Repository) => {
    connection.close();
    connections.splice(connections.indexOf(connection), 1);
  };

  it("migrates a real database once, persists across reopen, and secures database/sidecar permissions", () => {
    const session = repository.createSession();
    const custom = repository.createPersona(owner, profile);
    const run = create([custom.id]);
    const attempt = firstAttempt(run.id);
    const evidence = repository.recordEvidence(owner, evidenceFor(run.id, attempt.id), storageKey());
    const finding = repository.recordFinding(owner, findingFor(run.id, attempt.id, [evidence.id]));
    repository.cancelRun(owner, run.id);
    const events = repository.events(owner, run.id, page);
    const database = inspect();
    expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(migrations.length);
    expect(database.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    close(repository);
    repository = open();
    expect(repository.session(session.token)?.ownerId).toBe(session.ownerId);
    expect(repository.listPersonas(owner)).toContainEqual(custom);
    expect(repository.getRun(owner, run.id).status).toBe("cancelled");
    expect(repository.attempts(owner, run.id)[0].persona).toEqual(custom);
    expect(repository.getEvidence(owner, evidence.id)).toEqual(evidence);
    expect(repository.getFinding(owner, finding.id)).toEqual(finding);
    expect(repository.events(owner, run.id, page)).toEqual(events);
    expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  });

  it("tightens permissions on existing data and rejects databases from a newer schema", () => {
    close(repository);
    chmodSync(dir, 0o755);
    chmodSync(join(dir, "flash-flood.sqlite"), 0o644);
    repository = open();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "flash-flood.sqlite")).mode & 0o777).toBe(0o600);
    close(repository);
    inspect().exec(`PRAGMA user_version=${migrations.length + 1}`);
    expect(open).toThrow("Database version is newer");
  });

  it("stores only a hash of opaque session tokens, persists sessions, and expires them", () => {
    const session = repository.createSession();
    const row = inspect().prepare("SELECT * FROM owners WHERE id=?").get(session.ownerId);
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row?.session_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(session.token);
    expect(repository.session(session.token)).toEqual({
      ownerId: session.ownerId, csrf: session.csrf, expiresAt: session.expiresAt,
    });
    for (const token of ["", "../token", "a".repeat(43), session.token + "x"]) expect(repository.session(token)).toBeNull();
    time = session.expiresAt - 1;
    expect(repository.session(session.token)).not.toBeNull();
    time++;
    expect(repository.session(session.token)).toBeNull();
  });

  it("isolates custom personas and keeps predefined personas immutable", () => {
    const custom = repository.createPersona(owner, profile);
    expect(repository.listPersonas(other)).not.toContainEqual(custom);
    expectError(() => repository.updatePersona(other, custom.id, profile), "not_found", 404);
    expectError(() => repository.deletePersona(other, custom.id), "not_found", 404);
    expectError(() => repository.createRun(other, key(), request([custom.id])), "not_found", 404);
    for (const predefined of personas) {
      expectError(() => repository.updatePersona(owner, predefined.id, profile), "not_found", 404);
      expectError(() => repository.deletePersona(owner, predefined.id), "not_found", 404);
    }
    const exposed = repository.listPersonas(owner)[0];
    exposed.name = "Mutated response";
    exposed.quirks.push("Mutated array");
    expect(repository.listPersonas(owner)[0]).toEqual(personas[0]);
    expect(repository.updatePersona(owner, custom.id, { ...profile, name: "Updated" }).name).toBe("Updated");
    repository.deletePersona(owner, custom.id);
    expect(repository.listPersonas(owner).some((entry) => entry.id === custom.id)).toBe(false);
    expectError(() => repository.deletePersona(owner, custom.id), "not_found", 404);
  });

  it("snapshots custom profiles, goals and criteria so updates/deletion cannot alter a run", () => {
    const custom = repository.createPersona(owner, profile);
    const input = request([custom.id]);
    const run = repository.createRun(owner, key(), input).run;
    const snapshot = firstAttempt(run.id);
    repository.updatePersona(owner, custom.id, { ...profile, name: "Changed", quirks: ["Different"] });
    repository.deletePersona(owner, custom.id);
    input.assignments[0].criteria.push("Mutated input");
    input.assignments[0].goal = "Changed goal";
    close(repository);
    repository = open();
    expect(firstAttempt(run.id)).toEqual(snapshot);
    expect(snapshot.persona).toEqual(custom);
    expect(snapshot.goal).toBe("Find help");
    expect(snapshot.criteria).toEqual(["Help is visible"]);
  });

  it("uses owner-scoped idempotency across independent connections, even after cancellation and admission limits", () => {
    const second = open();
    const idempotencyKey = key();
    const input = request();
    const initial = repository.createRun(owner, idempotencyKey, input);
    expect(initial.created).toBe(true);
    expect(second.createRun(owner, idempotencyKey, input)).toEqual({ ...initial, created: false });
    const changed = { ...input, assignments: [{ ...input.assignments[0], goal: "Different goal" }] };
    expectError(() => second.createRun(owner, idempotencyKey, changed), "conflict", 409);
    expect(second.createRun(other, idempotencyKey, input).created).toBe(true);
    for (let index = 0; index < 4; index++) create();
    expectError(() => second.createRun(owner, key(), input), "rate_limited", 429);
    expect(second.createRun(owner, idempotencyKey, input).created).toBe(false);
    repository.cancelRun(owner, initial.run.id);
    expect(second.createRun(owner, idempotencyKey, input).run.status).toBe("cancelled");
    expect(repository.events(owner, initial.run.id, page).items.filter((event) => event.kind === "run.created")).toHaveLength(1);
  });

  it("rolls back a partially inserted run, attempts, jobs and reservations when a later insert fails", () => {
    const database = inspect();
    database.exec(`CREATE TRIGGER reject_second_reservation BEFORE INSERT ON usage_reservations
      WHEN (SELECT count(*) FROM usage_reservations) = 1
      BEGIN SELECT RAISE(ABORT, 'injected reservation failure'); END;`);
    const idempotencyKey = key();
    const input = request([personas[0].id, personas[1].id]);
    expect(() => repository.createRun(owner, idempotencyKey, input)).toThrow("injected reservation failure");
    for (const table of ["runs", "attempts", "jobs", "usage_reservations", "events"]) {
      expect(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
    }
    database.exec("DROP TRIGGER reject_second_reservation");
    const second = open();
    const result = second.createRun(owner, idempotencyKey, input);
    expect(result.created).toBe(true);
    expect(second.attempts(owner, result.run.id)).toHaveLength(2);
    expect(second.events(owner, result.run.id, page).items.map((event) => event.sequence)).toEqual([1]);
  });

  it.each(["commit", "crash"] as const)("waits for a competing subprocess transaction and recovers its %s", async (mode) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      db.prepare("INSERT INTO rate_limits VALUES ('subprocess-lock', 0, 1)").run();
      process.send({ locked: true });
      setTimeout(() => {
        if (process.argv[2] === "crash") process.exit(23);
        db.exec("COMMIT");
        db.close();
        process.exit(0);
      }, 350);
    `, join(dir, "flash-flood.sqlite"), mode], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`Lock holder exited before ready: ${stderr}`)));
    });
    const started = performance.now();
    const run = create();
    expect(performance.now() - started).toBeGreaterThanOrEqual(200);
    expect(run.status).toBe("queued");
    expect(await exited).toBe(mode === "crash" ? 23 : 0);
    const row = inspect().prepare("SELECT count FROM rate_limits WHERE bucket='subprocess-lock'").get();
    expect(row?.count).toBe(mode === "commit" ? 1 : undefined);
    close(repository);
    repository = open();
    expect(repository.getRun(owner, run.id)).toEqual(run);
    expect(inspect().prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  }, 10_000);

  it("persists rate buckets across connections/reopen and resets at the window boundary", () => {
    repository.consumeRate("owner:write", 2);
    close(repository);
    repository = open();
    repository.consumeRate("owner:write", 2);
    expectError(() => open().consumeRate("owner:write", 2), "rate_limited", 429);
    expectError(() => repository.consumeRate("owner:write", 2), "rate_limited", 429);
    repository.consumeRate("other:write", 2);
    time += 59_999;
    expectError(() => repository.consumeRate("owner:write", 2), "rate_limited", 429);
    time++;
    expect(() => repository.consumeRate("owner:write", 2)).not.toThrow();
  });

  it("enforces the custom persona cap per owner and frees capacity on deletion", () => {
    const customs = Array.from({ length: 50 }, () => repository.createPersona(owner, profile));
    expectError(() => open().createPersona(owner, profile), "rate_limited", 429);
    expect(() => repository.createPersona(other, profile)).not.toThrow();
    repository.deletePersona(owner, customs[0].id);
    expect(() => repository.createPersona(owner, profile)).not.toThrow();
    expect(repository.listPersonas(owner)).toHaveLength(personas.length + 50);
  });

  it("counts queued and running runs against the active cap and releases terminal runs", () => {
    const runs = Array.from({ length: 5 }, () => create());
    repository.startAttempt(owner, runs[0].id, firstAttempt(runs[0].id).id);
    expectError(() => open().createRun(owner, key(), request()), "rate_limited", 429);
    expect(() => repository.createRun(other, key(), request())).not.toThrow();
    repository.cancelRun(owner, runs[1].id);
    expect(() => create()).not.toThrow();
    repository.finishAttempt(owner, runs[0].id, firstAttempt(runs[0].id).id, "succeeded");
    expect(() => create()).not.toThrow();
  });

  it("enforces a persistent rolling daily cap, including terminal runs, without blocking another owner", () => {
    for (let index = 0; index < 100; index++) repository.cancelRun(owner, create().id);
    close(repository);
    repository = open();
    expectError(() => create(), "rate_limited", 429);
    expect(() => repository.createRun(other, key(), request())).not.toThrow();
    time += 86_400_001;
    expect(() => create()).not.toThrow();
  });

  it("returns not_found for all foreign-owned run, attempt, event, evidence and finding operations", () => {
    const run = create();
    const attempt = firstAttempt(run.id);
    const evidence = repository.recordEvidence(owner, evidenceFor(run.id, attempt.id), storageKey());
    const finding = repository.recordFinding(owner, findingFor(run.id, attempt.id, [evidence.id]));
    const calls = [
      () => repository.getRun(other, run.id),
      () => repository.attempts(other, run.id),
      () => repository.events(other, run.id, page),
      () => repository.cancelRun(other, run.id),
      () => repository.startAttempt(other, run.id, attempt.id),
      () => repository.finishAttempt(other, run.id, attempt.id, "succeeded"),
      () => repository.recordEvidence(other, evidenceFor(run.id, attempt.id), storageKey()),
      () => repository.getEvidence(other, evidence.id),
      () => repository.recordFinding(other, findingFor(run.id, attempt.id, [evidence.id])),
      () => repository.getFinding(other, finding.id),
    ];
    for (const call of calls) expectError(call, "not_found", 404);
    expect(repository.listRuns(other, page).items).toEqual([]);
    expect(repository.getRun(owner, run.id).status).toBe("queued");
    expect(repository.events(owner, run.id, page).items).toHaveLength(3);
  });

  it("cancels queued attempts exactly once and prevents a racing start from another connection", () => {
    const second = open();
    const run = create([personas[0].id, personas[1].id]);
    const cancelled = repository.cancelRun(owner, run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelRequestedAt).not.toBeNull();
    for (const attempt of repository.attempts(owner, run.id)) {
      expect(attempt.status).toBe("cancelled");
      expectError(() => second.startAttempt(owner, run.id, attempt.id), "conflict", 409);
      expect(second.finishAttempt(owner, run.id, attempt.id, "succeeded").status).toBe("cancelled");
    }
    time++;
    expect(second.cancelRun(owner, run.id)).toEqual(cancelled);
    const events = repository.events(owner, run.id, page).items;
    expect(events.map((event) => event.kind)).toEqual([
      "run.created", "run.cancel_requested", "attempt.finished", "attempt.finished", "run.finished",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(inspect().prepare("SELECT DISTINCT status FROM jobs WHERE run_id=?").all(run.id)).toEqual([{ status: "cancelled" }]);
  });

  it("lets cancellation win a running finish race while cancelling queued siblings immediately", () => {
    const second = open();
    const run = create([personas[0].id, personas[1].id]);
    const [running, queued] = repository.attempts(owner, run.id);
    repository.startAttempt(owner, run.id, running.id);
    expectError(() => second.startAttempt(owner, run.id, running.id), "conflict", 409);
    expect(second.cancelRun(owner, run.id).status).toBe("running");
    expect(repository.attempts(owner, run.id).map((attempt) => attempt.status)).toEqual(["running", "cancelled"]);
    expectError(() => repository.startAttempt(owner, run.id, queued.id), "conflict", 409);
    const finished = repository.finishAttempt(owner, run.id, running.id, "target_failed");
    expect(finished.status).toBe("cancelled");
    expect(second.finishAttempt(owner, run.id, running.id, "succeeded")).toEqual(finished);
    const terminal = second.getRun(owner, run.id);
    time++;
    expect(second.cancelRun(owner, run.id)).toEqual(terminal);
    const events = repository.events(owner, run.id, page).items;
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.filter((event) => event.kind === "run.cancel_requested")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "run.finished")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "attempt.finished")).toHaveLength(2);
  });

  it.each(["before", "after"] as const)("preserves infrastructure failure reported %s cancellation instead of claiming clean cancellation", (ordering) => {
    const second = open();
    const run = create([personas[0].id, personas[1].id, personas[2].id]);
    const [failed, running, queued] = repository.attempts(owner, run.id);
    repository.startAttempt(owner, run.id, failed.id);
    repository.startAttempt(owner, run.id, running.id);
    if (ordering === "before") repository.finishAttempt(owner, run.id, failed.id, "infrastructure_failed");
    expect(second.cancelRun(owner, run.id).status).toBe("running");
    if (ordering === "after") repository.finishAttempt(owner, run.id, failed.id, "infrastructure_failed");
    expect(repository.getRun(owner, run.id).status).toBe("running");
    expect(repository.finishAttempt(owner, run.id, running.id, "succeeded").status).toBe("cancelled");
    expect(repository.attempts(owner, run.id)).toEqual([
      expect.objectContaining({ id: failed.id, status: "infrastructure_failed" }),
      expect.objectContaining({ id: running.id, status: "cancelled" }),
      expect.objectContaining({ id: queued.id, status: "cancelled" }),
    ]);
    const terminal = second.getRun(owner, run.id);
    expect(terminal.status).toBe("infrastructure_failed");
    expect(terminal.cancelRequestedAt).not.toBeNull();
    const events = second.events(owner, run.id, page);
    time += 1000;
    expect(second.finishAttempt(owner, run.id, failed.id, "infrastructure_failed")).toEqual(firstAttempt(run.id));
    expectError(() => second.finishAttempt(owner, run.id, failed.id, "succeeded"), "conflict", 409);
    expect(second.cancelRun(owner, run.id)).toEqual(terminal);
    expect(second.events(owner, run.id, page)).toEqual(events);
    expect(events.items.map((event) => event.sequence)).toEqual(events.items.map((_, index) => index + 1));
    expect(events.items.filter((event) => event.kind === "run.cancel_requested")).toHaveLength(1);
    expect(events.items.filter((event) => event.kind === "attempt.finished")).toHaveLength(3);
    expect(events.items.filter((event) => event.kind === "run.finished")).toEqual([
      expect.objectContaining({ data: { status: "infrastructure_failed" } }),
    ]);
  });

  it.each([
    "succeeded", "gave_up", "blocked", "limit_reached", "infrastructure_failed", "target_failed", "cancelled",
  ] as TerminalStatus[])("keeps terminal %s attempts/runs immutable and repeated completion idempotent", (status) => {
    const run = create();
    const attempt = firstAttempt(run.id);
    expectError(() => repository.finishAttempt(owner, run.id, attempt.id, status), "conflict", 409);
    repository.startAttempt(owner, run.id, attempt.id);
    const finished = repository.finishAttempt(owner, run.id, attempt.id, status);
    const terminal = repository.getRun(owner, run.id);
    const events = repository.events(owner, run.id, page);
    time += 1000;
    const second = open();
    expect(second.finishAttempt(owner, run.id, attempt.id, status)).toEqual(finished);
    expect(second.cancelRun(owner, run.id)).toEqual(terminal);
    expectError(() => second.finishAttempt(owner, run.id, attempt.id, status === "succeeded" ? "gave_up" : "succeeded"), "conflict", 409);
    expectError(() => second.startAttempt(owner, run.id, attempt.id), "conflict", 409);
    expect(second.events(owner, run.id, page)).toEqual(events);
    expect(terminal.status).toBe(status);
    expect(terminal.cancelRequestedAt).toBeNull();
    expect(events.items.map((event) => event.kind)).toEqual(["run.created", "attempt.started", "attempt.finished", "run.finished"]);
  });

  it("does not finish a run while a sibling is active and reconciles mixed outcomes deterministically", () => {
    const run = create([personas[0].id, personas[1].id, personas[2].id]);
    const attempts = repository.attempts(owner, run.id);
    for (const attempt of attempts) repository.startAttempt(owner, run.id, attempt.id);
    repository.finishAttempt(owner, run.id, attempts[0].id, "succeeded");
    repository.finishAttempt(owner, run.id, attempts[1].id, "target_failed");
    expect(repository.getRun(owner, run.id).status).toBe("running");
    repository.finishAttempt(owner, run.id, attempts[2].id, "infrastructure_failed");
    expect(repository.getRun(owner, run.id).status).toBe("infrastructure_failed");
    expect(repository.events(owner, run.id, page).items.filter((event) => event.kind === "run.finished")).toHaveLength(1);
  });

  it("does not rewrite an already completed sibling when cancellation wins the remaining work", () => {
    const run = create([personas[0].id, personas[1].id]);
    const [completed, pending] = repository.attempts(owner, run.id);
    repository.startAttempt(owner, run.id, completed.id);
    const finished = repository.finishAttempt(owner, run.id, completed.id, "succeeded");
    const second = open();
    time += 1000;
    expect(second.cancelRun(owner, run.id).status).toBe("cancelled");
    expect(second.attempts(owner, run.id)).toEqual([
      finished,
      expect.objectContaining({ id: pending.id, status: "cancelled" }),
    ]);
    const finishes = repository.events(owner, run.id, page).items.filter((event) => event.kind === "attempt.finished");
    expect(finishes.map((event) => [event.attemptId, event.data.status])).toEqual([
      [completed.id, "succeeded"], [pending.id, "cancelled"],
    ]);
  });

  it.each([
    "succeeded", "gave_up", "blocked", "limit_reached", "target_failed",
  ] as TerminalStatus[])("replays completed %s unchanged after sibling cancellation without appending events", (outcome) => {
    const run = create([personas[0].id, personas[1].id]);
    const [completed, pending] = repository.attempts(owner, run.id);
    repository.startAttempt(owner, run.id, completed.id);
    const finished = repository.finishAttempt(owner, run.id, completed.id, outcome);
    const second = open();
    time += 1000;
    const cancelled = second.cancelRun(owner, run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(second.attempts(owner, run.id)).toEqual([
      finished,
      expect.objectContaining({ id: pending.id, status: "cancelled" }),
    ]);
    const events = second.events(owner, run.id, page);
    time += 1000;
    expect(repository.finishAttempt(owner, run.id, completed.id, outcome)).toEqual(finished);
    expect(second.finishAttempt(owner, run.id, completed.id, outcome)).toEqual(finished);
    expect(second.attempts(owner, run.id)[0]).toEqual(finished);
    expect(second.getRun(owner, run.id)).toEqual(cancelled);
    expect(second.events(owner, run.id, page)).toEqual(events);
    expect(events.items.filter((event) => event.kind === "attempt.finished" && event.attemptId === completed.id)).toEqual([
      expect.objectContaining({ data: { status: outcome } }),
    ]);
    expect(events.items.filter((event) => event.kind === "run.finished")).toHaveLength(1);
  });

  it("rolls back attempt and job completion if recording the terminal event fails", () => {
    const run = create();
    const attempt = firstAttempt(run.id);
    repository.startAttempt(owner, run.id, attempt.id);
    const before = {
      run: repository.getRun(owner, run.id),
      attempt: firstAttempt(run.id),
      events: repository.events(owner, run.id, page),
    };
    const database = inspect();
    database.exec(`CREATE TRIGGER reject_finish_event BEFORE INSERT ON events
      WHEN json_extract(NEW.event, '$.kind') = 'attempt.finished'
      BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;`);
    time += 1000;
    expect(() => repository.finishAttempt(owner, run.id, attempt.id, "succeeded")).toThrow("injected event failure");
    expect(repository.getRun(owner, run.id)).toEqual(before.run);
    expect(firstAttempt(run.id)).toEqual(before.attempt);
    expect(repository.events(owner, run.id, page)).toEqual(before.events);
    expect(database.prepare("SELECT status FROM jobs WHERE attempt_id=?").get(attempt.id)?.status).toBe("leased");
    database.exec("DROP TRIGGER reject_finish_event");
    expect(open().finishAttempt(owner, run.id, attempt.id, "succeeded").status).toBe("succeeded");
    expect(repository.events(owner, run.id, page).items.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("paginates runs and events at exact boundaries without duplicates or cross-owner leakage", () => {
    const runs: Run[] = [];
    for (let index = 0; index < 5; index++) {
      runs.push(create());
      repository.createRun(other, key(), request());
    }
    const first = repository.listRuns(owner, { after: 0, limit: 2 });
    const second = repository.listRuns(owner, { after: first.nextCursor!, limit: 2 });
    const last = repository.listRuns(owner, { after: second.nextCursor!, limit: 2 });
    expect([...first.items, ...second.items, ...last.items]).toEqual(runs);
    expect(first.nextCursor).toBe(first.items[1].cursor);
    expect(last.nextCursor).toBeNull();
    expect(repository.listRuns(owner, { after: runs[0].cursor, limit: 4 }).nextCursor).toBeNull();
    expect(repository.listRuns(owner, { after: runs[4].cursor, limit: 1 })).toEqual({ items: [], nextCursor: null });
    repository.cancelRun(owner, runs[0].id);
    const allEvents = repository.events(owner, runs[0].id, page).items;
    const eventFirst = repository.events(owner, runs[0].id, { after: 0, limit: 2 });
    const eventLast = repository.events(owner, runs[0].id, { after: eventFirst.nextCursor!, limit: 2 });
    expect([...eventFirst.items, ...eventLast.items]).toEqual(allEvents);
    expect(eventLast.nextCursor).toBeNull();
    expect(repository.events(owner, runs[0].id, { after: allEvents.at(-1)!.sequence, limit: 1 })).toEqual({ items: [], nextCursor: null });
    expect(() => repository.listRuns(owner, { after: -1, limit: 1 })).toThrow();
    expect(() => repository.events(owner, runs[0].id, { after: 0, limit: 101 })).toThrow();
  });

  it("requires evidence/finding references to belong to exactly the specified run and attempt", () => {
    const run = create([personas[0].id, personas[1].id]);
    const anotherRun = create();
    const [attempt, sibling] = repository.attempts(owner, run.id);
    const anotherAttempt = firstAttempt(anotherRun.id);
    const evidence = repository.recordEvidence(owner, evidenceFor(run.id, attempt.id), storageKey());
    const siblingEvidence = repository.recordEvidence(owner, evidenceFor(run.id, sibling.id), storageKey());
    const anotherEvidence = repository.recordEvidence(owner, evidenceFor(anotherRun.id, anotherAttempt.id), storageKey());
    const foreignRun = repository.createRun(other, key(), request()).run;
    const foreignAttempt = repository.attempts(other, foreignRun.id)[0];
    const foreignEvidence = repository.recordEvidence(other, evidenceFor(foreignRun.id, foreignAttempt.id), storageKey());
    const originalEvents = repository.events(owner, run.id, page);
    expectError(() => repository.recordEvidence(owner, evidenceFor(run.id, anotherAttempt.id), storageKey()), "not_found", 404);
    expectError(() => repository.startAttempt(owner, run.id, anotherAttempt.id), "not_found", 404);
    expectError(() => repository.finishAttempt(owner, run.id, anotherAttempt.id, "succeeded"), "not_found", 404);
    expectError(() => repository.recordFinding(owner, findingFor(run.id, anotherAttempt.id, [evidence.id])), "not_found", 404);
    for (const invalidEvidence of [siblingEvidence, anotherEvidence]) {
      expectError(() => repository.recordFinding(owner, findingFor(run.id, attempt.id, [evidence.id, invalidEvidence.id])), "conflict", 409);
    }
    for (const missing of [randomUUID(), foreignEvidence.id]) {
      expectError(() => repository.recordFinding(owner, findingFor(run.id, attempt.id, [missing])), "not_found", 404);
    }
    expect(repository.events(owner, run.id, page)).toEqual(originalEvents);
    expect(inspect().prepare("SELECT count(*) AS n FROM findings").get()?.n).toBe(0);
    const finding = repository.recordFinding(owner, findingFor(run.id, attempt.id, [evidence.id]));
    expect(repository.getFinding(owner, finding.id)).toEqual(finding);
    expect(inspect().prepare("SELECT evidence_id FROM finding_evidence WHERE finding_id=?").all(finding.id)).toEqual([{ evidence_id: evidence.id }]);
  });

  it("accepts opaque storage keys only, never exposes keys, and rolls back duplicate-key writes", () => {
    const run = create();
    const attempt = firstAttempt(run.id);
    const input = evidenceFor(run.id, attempt.id);
    for (const invalid of ["", "../secret", "/absolute/path", "https://example.com/file", "a".repeat(63), "a".repeat(65), "A".repeat(64), "a".repeat(64) + "\n"]) {
      expect(() => repository.recordEvidence(owner, input, invalid)).toThrow();
    }
    expect(repository.events(owner, run.id, page).items).toHaveLength(1);
    const storage = storageKey();
    const evidence = repository.recordEvidence(owner, input, storage);
    const events = repository.events(owner, run.id, page);
    expect(() => repository.recordEvidence(owner, input, storage)).toThrow();
    expect(repository.events(owner, run.id, page)).toEqual(events);
    expect(inspect().prepare("SELECT count(*) AS n FROM evidence").get()?.n).toBe(1);
    expect(repository.getEvidence(owner, evidence.id)).not.toHaveProperty("storageKey");
    expect(JSON.stringify(events)).not.toContain(storage);
    expect(inspect().prepare("SELECT storage_key FROM evidence WHERE id=?").get(evidence.id)?.storage_key).toBe(storage);
  });
});
