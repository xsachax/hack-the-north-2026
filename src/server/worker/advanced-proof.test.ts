import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import type { TakeoverStatus } from "../../lib/takeover-contracts";
import {
  ADVANCED_RESUME_MAX_BYTES, ADVANCED_RESUME_TTL_MS, advancedApprovalSchema,
  advancedLedgerSchema, advancedPolicy, advancedResumeSchema, approvedAdvancedProof,
  assertAdvancedOperation, assertAdvancedStoredPolicy, canReserveAdvanced, captureAdvancedPreference, exactAdvancedClosure, exactAdvancedLedger,
  exclusiveHumanInterval, exactAdvancedImageInspection, immutableParent, ledgerDigest, loadAdvancedResume, observedPeakConcurrency,
  auditAdvancedExecution, noAdvancedDispatchOverlap, advancedContextsRetired, contextInventoryDigest,
  parseAdvancedArgs, readAdvancedLedger, readPrivateJson, removeAdvancedResume, returningMarkerContrast,
  readAdvancedContextInventory, saveAdvancedResume, successfulAdvancedClosure,
  validAdvancedHumanGrant, verifyAdvancedResume, writePrivateJson,
  type AdvancedLaunch, type AdvancedLedger, type AdvancedMode, type AdvancedOperation,
  type AdvancedResumeState, type ClosedAdvancedSession, type MarkerObservation,
} from "../../../scripts/advanced-proof";
import { ADVANCED_REVIEW_REQUIREMENTS, ownerSessionBinding, retrieveAdvancedClosure } from "../../../scripts/advanced-integration";
import type { Brain, BrowserDriver } from "../execution/types";
import { contextMigration } from "../workflows/contexts";

const provider = vi.hoisted(() => ({
  options: vi.fn(), list: vi.fn(), retrieve: vi.fn(), create: vi.fn(), update: vi.fn(),
}));
vi.mock("@browserbasehq/sdk", () => ({
  default: class {
    sessions = provider;
    constructor(options: unknown) { provider.options(options); }
  },
}));

const now = 1_800_000_000_000;
function launch(changes: Partial<AdvancedLaunch> = {}): AdvancedLaunch {
  return { jobId: randomUUID(), runId: randomUUID(), attemptId: randomUUID(), ownerId: randomUUID(),
    correlationToken: randomUUID(), sessionId: randomUUID(), reservedSeconds: 300, consumedSeconds: 11,
    releasedSeconds: 289, state: "settled", jobStatus: "completed", attemptStatus: "succeeded", createdAt: new Date(now).toISOString(),
    usage: JSON.stringify({ modelCalls: 3, actualBrowserSeconds: 10.5 }), ...changes };
}
function ledger(launches: AdvancedLaunch[] = [launch()]): AdvancedLedger {
  return { version: 1, baselineSeconds: 985, reservedSeconds: launches.length * 300, launches };
}
function closed(item: AdvancedLaunch, changes: Partial<ClosedAdvancedSession> = {}): ClosedAdvancedSession {
  return { correlationToken: item.correlationToken, sessionId: item.sessionId!, status: "COMPLETED",
    startedAt: now, endedAt: now + 10_500, actualBrowserSeconds: 10.5, ...changes };
}

describe("explicit advanced invocation and operation fences", () => {
  it("accepts exactly one explicit mode and a genuine-shaped resume UUID", () => {
    expect(parseAdvancedArgs(["--offline-preflight"])).toEqual({ mode: "offline" });
    expect(parseAdvancedArgs(["--confirm-paid"])).toEqual({ mode: "paid" });
    const id = randomUUID();
    expect(parseAdvancedArgs(["--resume", id])).toEqual({ mode: "resume", invocationId: id });
  });
  it.each([[], ["--resume"], ["--resume", "../outside"], ["--confirm-paid", "--retry"],
    ["--offline-preflight", "--confirm-paid"], ["--resume", randomUUID(), "--confirm-paid"]].map((args) => ({ args })))(
    "fails closed for ambiguous arguments $args", ({ args }) => expect(() => parseAdvancedArgs(args)).toThrow(),
  );
  it.each(["worker", "create-run", "cancel-run", "context-mutation", "takeover", "provider-attach", "reproduction"] as AdvancedOperation[])(
    "resume cannot perform %s", (operation) => expect(() => assertAdvancedOperation("resume", operation)).toThrow(),
  );
  it.each(["provider-read", "provider-attach", "worker", "reproduction"] as AdvancedOperation[])(
    "offline never performs %s", (operation) => expect(() => assertAdvancedOperation("offline", operation)).toThrow(),
  );
  it("readback is allowed, but does not authorize mutation", () => {
    for (const mode of ["paid", "offline", "resume"] as AdvancedMode[]) assertAdvancedOperation(mode, "readback");
    assertAdvancedOperation("resume", "provider-read");
    expect(() => assertAdvancedOperation("resume", "local-ui")).toThrow();
  });
  it("does not report image capture as inspection or silently launch reproductions", () => {
    expect(ADVANCED_REVIEW_REQUIREMENTS).toEqual(expect.arrayContaining([
      expect.stringContaining("Inspect every"), expect.stringContaining("image-inspection.json"),
      expect.stringContaining("Reproduction is separate"),
    ]));
  });
});

describe("nonrefundable lifetime ledger and exact remote set", () => {
  it("fixes baseline, TTL and concurrency independently of refunds", () => {
    expect(advancedPolicy).toMatchObject({ baselineSeconds: 985, sessionSeconds: 300, globalConcurrency: 3,
      ownerConcurrency: 3, lifetimeReservationLimitSeconds: 3600, developmentBudgetSeconds: 4585 });
    expect(Object.isFrozen(advancedPolicy)).toBe(true);
    expect(canReserveAdvanced(3300)).toBe(true);
    expect(canReserveAdvanced(3600)).toBe(false);
    expect(canReserveAdvanced(2400, 4)).toBe(true);
    expect(canReserveAdvanced(2700, 4)).toBe(false);
    const exhausted = ledger(Array.from({ length: 12 }, () => launch({ consumedSeconds: 0, releasedSeconds: 300 })));
    expect(canReserveAdvanced(exhausted.reservedSeconds)).toBe(false);
  });
  it.each([-1, 0.5, 301, NaN, Infinity])("rejects malformed prior reservation %s", (value) => {
    expect(canReserveAdvanced(value)).toBe(false);
  });
  it("rejects undercount, duplicate identities, and a thirteenth failed reservation", () => {
    const value = ledger();
    expect(advancedLedgerSchema.safeParse({ ...value, reservedSeconds: 0 }).success).toBe(false);
    expect(advancedLedgerSchema.safeParse(ledger([value.launches[0], value.launches[0]])).success).toBe(false);
    expect(advancedLedgerSchema.safeParse(ledger(Array.from({ length: 13 }, () => launch()))).success).toBe(false);
  });
  it("verifies the exact original ledger independent of order, including failures and usage", () => {
    const value = ledger([launch(), launch({ state: "quarantined", releasedSeconds: 0 })]);
    expect(exactAdvancedLedger(value, { ...value, launches: [...value.launches].reverse() })).toBe(true);
    for (const change of [
      { sessionId: randomUUID() }, { correlationToken: randomUUID() }, { runId: randomUUID() },
      { attemptId: randomUUID() }, { releasedSeconds: 288 }, { state: "active" }, { usage: "{}" },
    ]) {
      expect(exactAdvancedLedger(value, { ...value, launches: [{ ...value.launches[0], ...change }, value.launches[1]] })).toBe(false);
    }
  });
  it("requires each independently retrieved session, never an empty metadata claim", () => {
    const value = ledger([launch(), launch()]);
    const proof = value.launches.map((item) => closed(item));
    expect(exactAdvancedClosure(value, proof)).toBe(true);
    expect(exactAdvancedClosure(ledger([]), [])).toBe(false);
    expect(exactAdvancedClosure(value, proof.slice(1))).toBe(false);
    expect(exactAdvancedClosure(value, [proof[0], proof[0]])).toBe(false);
    expect(exactAdvancedClosure(value, [...proof, closed(launch())])).toBe(false);
    expect(exactAdvancedClosure(ledger([launch({ sessionId: null })]), [proof[0]])).toBe(false);
  });
  it.each(["ERROR", "TIMED_OUT"])("retains %s failures as closed charged attempts, not refunded new budget", (status) => {
    const value = ledger();
    expect(exactAdvancedClosure(value, [closed(value.launches[0], { status })])).toBe(true);
    expect(successfulAdvancedClosure(value, [closed(value.launches[0], { status })])).toBe(false);
    expect(value.reservedSeconds).toBe(300);
  });
  it("requires exact accounting and every correlated session to complete successfully", () => {
    const value = ledger([launch(), launch()]);
    const proof = value.launches.map((item) => closed(item));
    expect(successfulAdvancedClosure(value, proof)).toBe(true);
    expect(successfulAdvancedClosure(value, proof.slice(1))).toBe(false);
    expect(successfulAdvancedClosure(value, [proof[0], proof[0]])).toBe(false);
    expect(successfulAdvancedClosure(ledger([]), [])).toBe(false);
    for (const status of ["ERROR", "TIMED_OUT", "RUNNING"]) {
      expect(successfulAdvancedClosure(value, [proof[0], { ...proof[1], status }])).toBe(false);
    }
  });
  it.each([
    { status: "RUNNING" }, { status: "PENDING" }, { status: "CLOSED" }, { actualBrowserSeconds: NaN },
    { endedAt: now - 1 }, { actualBrowserSeconds: 0 }, { sessionId: randomUUID() },
  ])("rejects incomplete or contradictory closure %j", (changes) => {
    const value = ledger();
    expect(exactAdvancedClosure(value, [closed(value.launches[0], changes)])).toBe(false);
  });
  it("computes true observed peak with half-open session lifetimes, not reservation count", () => {
    const item = launch();
    expect(observedPeakConcurrency([
      closed(item, { startedAt: 0, endedAt: 20 }), closed(item, { startedAt: 10, endedAt: 30 }),
      closed(item, { startedAt: 20, endedAt: 40 }), closed(item, { startedAt: 25, endedAt: 25 }),
    ])).toBe(2);
  });
});

describe("cumulative context inventory using the real SQLite context migration", () => {
  let db: DatabaseSync;
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const remoteId = id(900);
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE owners(id TEXT PRIMARY KEY); CREATE TABLE jobs(id TEXT PRIMARY KEY);
      CREATE TABLE attempts(id TEXT PRIMARY KEY); ${contextMigration}`);
    db.prepare("INSERT INTO owners VALUES(?)").run(id(800));
    db.prepare("INSERT INTO owners VALUES(?)").run(id(801));
    db.prepare("INSERT INTO jobs VALUES(?)").run(id(802));
  });
  afterEach(() => db.close());
  function context(n: number, status = "deleted", remote: string | null = null): void {
    db.prepare(`INSERT INTO browser_contexts
      (id,owner_id,scope_signature,remote_id,status,persistence,created_at,expires_at,revoked)
      VALUES(?,?,?,?,?,'never_saved',?,?,1)`).run(id(n), id(800 + n % 2), `scope-${n}`, remote, status, now - n, now - 1);
  }
  function operation(n: number, kind: string, status: string): void {
    db.prepare("INSERT INTO context_operations(context_id,operation,status,created_at) VALUES(?,?,?,?)")
      .run(id(n), kind, status, now);
  }
  function deleted(n: number): void {
    context(n);
    operation(n, "create", "dispatched");
    operation(n, "create", "returned");
    operation(n, "session_settlement", "closed");
    operation(n, "delete", "dispatched");
    operation(n, "delete", "confirmed");
  }
  it("reads every lifetime resource across owners, expiry and more than the UI's 100-row limit", () => {
    for (let n = 1; n <= 105; n++) context(n);
    operation(1, "session_settlement", "closed");
    const inventory = readAdvancedContextInventory(db);
    expect(inventory.contexts).toHaveLength(105);
    expect(inventory.contexts[0]).toEqual({
      id: id(1), ownerId: id(801), scopeSignature: "scope-1", remoteIdDigest: null,
      status: "deleted", persistence: "never_saved", createdAt: now - 1, availableAfter: null,
      expiresAt: now - 1, revoked: true, heldJob: null, operationTokenDigest: null,
    });
    expect(inventory.operations).toEqual([
      { sequence: 1, contextId: id(1), operation: "session_settlement", status: "closed", createdAt: now },
    ]);
    expect(advancedContextsRetired(inventory)).toBe(true);
  });
  it("binds exact remote identities without exposing them and detects identity replacement", () => {
    context(1, "available", remoteId);
    const before = readAdvancedContextInventory(db);
    expect(before.contexts[0].remoteIdDigest).toBe(createHash("sha256").update(remoteId).digest("hex"));
    expect(JSON.stringify(before)).not.toContain(remoteId);
    db.prepare("UPDATE browser_contexts SET remote_id=?").run(id(901));
    expect(contextInventoryDigest(readAdvancedContextInventory(db))).not.toBe(contextInventoryDigest(before));
    expect(advancedContextsRetired(before)).toBe(false);
  });
  it.each([
    ["owner_id", id(801)], ["scope_signature", "changed-scope"], ["status", "revoked"],
    ["revoked", 0], ["held_job", id(802)], ["persistence", "uncertain"],
    ["created_at", now + 1], ["available_after", now + 1], ["expires_at", now + 1],
    ["operation_token", id(903)],
  ])("binds the context's exact %s to the digest", (column, value) => {
    context(2);
    const before = contextInventoryDigest(readAdvancedContextInventory(db));
    db.prepare(`UPDATE browser_contexts SET ${column}=?`).run(value);
    expect(contextInventoryDigest(readAdvancedContextInventory(db))).not.toBe(before);
  });
  it.each([
    ["context_id", id(2)], ["sequence", 100], ["operation", "delete"],
    ["status", "uncertain"], ["created_at", now + 1],
  ])("binds the operation's exact %s to the digest", (column, value) => {
    context(1);
    context(2);
    operation(1, "create", "dispatched");
    const before = contextInventoryDigest(readAdvancedContextInventory(db));
    db.prepare(`UPDATE context_operations SET ${column}=?`).run(value);
    expect(contextInventoryDigest(readAdvancedContextInventory(db))).not.toBe(before);
  });
  it("has an ordered stable digest and rejects omitted, additional or duplicated lifetime resources", () => {
    deleted(2);
    deleted(1);
    const inventory = readAdvancedContextInventory(db);
    expect(contextInventoryDigest({ ...inventory, contexts: [...inventory.contexts].reverse(),
      operations: [...inventory.operations].reverse() })).toBe(contextInventoryDigest(inventory));
    expect(contextInventoryDigest({ ...inventory, contexts: inventory.contexts.slice(1) }))
      .not.toBe(contextInventoryDigest(inventory));
    expect(contextInventoryDigest({ ...inventory, operations: inventory.operations.slice(1) }))
      .not.toBe(contextInventoryDigest(inventory));
    expect(() => contextInventoryDigest({ ...inventory, contexts: [...inventory.contexts, inventory.contexts[0]] })).toThrow();
    expect(advancedContextsRetired({ ...inventory, operations: [...inventory.operations, inventory.operations[0]] })).toBe(false);
    context(3);
    expect(contextInventoryDigest(readAdvancedContextInventory(db))).not.toBe(contextInventoryDigest(inventory));
  });
  it.each(["available", "pending", "in_use", "persisting", "creating", "creation_unknown",
    "quarantined", "revoked", "deleting", "deletion_unknown", "unexpected"])(
    "does not call the cumulative set clean with a prior invocation's %s resource", (status) => {
      deleted(2);
      context(1, status);
      expect(advancedContextsRetired(readAdvancedContextInventory(db))).toBe(false);
    },
  );
  it.each(["hold", "revocation", "remote", "missing-delete", "unknown-create", "unknown-delete", "orphan", "unknown-operation"])(
    "fails closed even with a deleted row when evidence has %s", (reason) => {
      deleted(1);
      if (reason === "hold") db.prepare("UPDATE browser_contexts SET held_job=?").run(id(802));
      if (reason === "revocation") db.exec("UPDATE browser_contexts SET revoked=0");
      if (reason === "remote") db.prepare("UPDATE browser_contexts SET remote_id=?").run(remoteId);
      if (reason === "missing-delete") db.exec("DELETE FROM context_operations WHERE operation='delete'");
      if (reason === "unknown-create") {
        context(2);
        operation(2, "create", "dispatched");
        operation(2, "create", "uncertain");
      }
      if (reason === "unknown-delete") db.exec("UPDATE context_operations SET status='uncertain' WHERE status='confirmed'");
      if (reason === "orphan") {
        db.exec("PRAGMA foreign_keys=OFF");
        operation(3, "create", "dispatched");
      }
      if (reason === "unknown-operation") operation(1, "unexpected", "confirmed");
      expect(advancedContextsRetired(readAdvancedContextInventory(db))).toBe(false);
    },
  );
  it("accepts the fully confirmed deleted set, including resolved uncertainty and unallocated retirement", () => {
    expect(advancedContextsRetired(readAdvancedContextInventory(db))).toBe(true);
    deleted(1);
    deleted(2);
    context(3);
    db.prepare("UPDATE context_operations SET status='uncertain' WHERE context_id=? AND status='returned'").run(id(2));
    expect(advancedContextsRetired(readAdvancedContextInventory(db))).toBe(true);
    context(4, "available", remoteId);
    expect(advancedContextsRetired(readAdvancedContextInventory(db))).toBe(false);
  });
  it("uses a read-only snapshot without committing the caller's transaction", () => {
    db.exec("BEGIN");
    context(1);
    expect(readAdvancedContextInventory(db).contexts).toHaveLength(1);
    db.exec("ROLLBACK");
    expect(readAdvancedContextInventory(db).contexts).toEqual([]);
  });
});

describe("read-only provider readback transport (fake SDK only)", () => {
  beforeEach(() => vi.clearAllMocks());
  it("retrieves and lists each exact correlation once with SDK retries disabled and never releases", async () => {
    const value = ledger([launch(), launch()]);
    const projectId = randomUUID();
    const sessions = value.launches.map((item) => ({
      id: item.sessionId, projectId, userMetadata: { correlationToken: item.correlationToken },
      status: "COMPLETED", startedAt: new Date(now).toISOString(), endedAt: new Date(now + 10_500).toISOString(),
    }));
    sessions.forEach((session) => provider.list.mockResolvedValueOnce([session]));
    sessions.forEach((session) => provider.retrieve.mockResolvedValueOnce(session));
    expect(exactAdvancedClosure(value, await retrieveAdvancedClosure(value, { apiKey: "offline-fake", projectId }))).toBe(true);
    expect(provider.options).toHaveBeenCalledWith({ apiKey: "offline-fake", maxRetries: 0, timeout: 10000 });
    expect(provider.list).toHaveBeenCalledTimes(2);
    expect(provider.retrieve).toHaveBeenCalledTimes(2);
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.update).not.toHaveBeenCalled();
  });
  it("fails immediately on unknown allocation without retry or metadata request", async () => {
    await expect(retrieveAdvancedClosure(ledger([launch({ sessionId: null })]), {
      apiKey: "offline-fake", projectId: randomUUID(),
    })).rejects.toThrow("advanced_unknown_allocation_no_retry");
    expect(provider.list).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });
  it("does not release a running browser or retry a failed GET", async () => {
    const value = ledger();
    const projectId = randomUUID();
    const session = { id: value.launches[0].sessionId, projectId,
      userMetadata: { correlationToken: value.launches[0].correlationToken }, status: "RUNNING" };
    provider.list.mockResolvedValueOnce([session]);
    provider.retrieve.mockResolvedValueOnce(session);
    await expect(retrieveAdvancedClosure(value, { apiKey: "offline-fake", projectId })).rejects.toThrow("advanced_remote_not_closed");
    expect(provider.update).not.toHaveBeenCalled();
    provider.list.mockRejectedValueOnce(new Error("offline simulated transport failure"));
    await expect(retrieveAdvancedClosure(value, { apiKey: "offline-fake", projectId })).rejects.toThrow();
    expect(provider.list).toHaveBeenCalledTimes(2);
    expect(provider.retrieve).toHaveBeenCalledTimes(1);
  });
  it("rejects additional provider matches instead of adopting or releasing them", async () => {
    provider.list.mockResolvedValueOnce([{ id: randomUUID() }, { id: randomUUID() }]);
    await expect(retrieveAdvancedClosure(ledger(), { apiKey: "offline-fake", projectId: randomUUID() }))
      .rejects.toThrow("advanced_remote_set_not_exact");
    expect(provider.retrieve).not.toHaveBeenCalled();
    expect(provider.update).not.toHaveBeenCalled();
  });
});

describe("short-lived private genuine-owner credentials", () => {
  let root: string;
  let directory: string;
  let state: AdvancedResumeState;
  beforeEach(async () => {
    root = resolve("data", `advanced-proof-test-${randomUUID()}`);
    const invocationId = randomUUID();
    directory = join(root, invocationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const value = ledger();
    state = { version: 1, mode: "paid", invocationId, ownerId: value.launches[0].ownerId,
      runIds: [value.launches[0].runId], ownerCookie: "a".repeat(43), createdAt: now,
      expiresAt: now + ADVANCED_RESUME_TTL_MS, reservedSeconds: 300, ledgerDigest: ledgerDigest(value) };
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));
  const file = () => join(directory, "owner-resume.json");
  it("uses mode600 under mode700, exclusive creation and deletes only the named credential", async () => {
    await saveAdvancedResume(root, state);
    expect((await lstat(file())).mode & 0o777).toBe(0o600);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect(await loadAdvancedResume(root, state.invocationId, "paid", now + 1)).toEqual(state);
    await expect(saveAdvancedResume(root, { ...state, createdAt: now + 1, expiresAt: state.expiresAt + 1 })).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(file(), "utf8")).expiresAt).toBe(state.expiresAt);
    await removeAdvancedResume(root, state.invocationId);
    await expect(lstat(file())).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([
    { expiresAt: now + ADVANCED_RESUME_TTL_MS + 1 }, { expiresAt: now + 1 },
    { ownerCookie: "fake" }, { invocationId: "../outside" }, { runIds: [] },
    { reservedSeconds: 301 }, { mode: "offline-test" }, { apiKey: "not-allowed" },
  ])("rejects malformed credential %j", (changes) => {
    expect(advancedResumeSchema.safeParse({ ...state, ...changes }).success).toBe(false);
  });
  it.each(["expired", "future", "oversized", "malformed", "wrong-mode", "permissions"] as const)(
    "deletes the invalid credential on %s without renewing TTL", async (reason) => {
      await saveAdvancedResume(root, state);
      if (reason === "oversized") await writeFile(file(), "x".repeat(ADVANCED_RESUME_MAX_BYTES + 1));
      if (reason === "malformed") await writeFile(file(), "{");
      if (reason === "permissions") await chmod(file(), 0o644);
      await expect(loadAdvancedResume(root, state.invocationId, reason === "wrong-mode" ? "offline-test" : "paid",
        reason === "expired" ? state.expiresAt : reason === "future" ? now - 1 : now + 1)).rejects.toThrow("advanced_resume_invalid");
      await expect(lstat(file())).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("unlinks a credential symlink without reading or deleting its target", async () => {
    const target = join(root, "untouched.json");
    await writePrivateJson(target, { private: true });
    await symlink(target, file());
    await expect(loadAdvancedResume(root, state.invocationId, "paid", now)).rejects.toThrow();
    expect(await readPrivateJson(target)).toEqual({ private: true });
    await expect(lstat(file())).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not follow an invocation-directory symlink even during invalid-state cleanup", async () => {
    const target = join(root, "untouched-directory");
    await mkdir(target, { mode: 0o700 });
    await writePrivateJson(join(target, "owner-resume.json"), state);
    await rm(directory, { recursive: true });
    await symlink(target, directory);
    await expect(loadAdvancedResume(root, state.invocationId, "paid", now)).rejects.toThrow();
    expect(await readPrivateJson(join(target, "owner-resume.json"))).toEqual(state);
  });
  it("does not read through unsafe directory permissions", async () => {
    await saveAdvancedResume(root, state);
    await chmod(directory, 0o755);
    await expect(loadAdvancedResume(root, state.invocationId, "paid", now)).rejects.toThrow();
    expect((await lstat(file())).isFile()).toBe(true);
  });
  it("authenticates the original cookie and exact run owners before permitting readback", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE owners(id TEXT,session_hash TEXT,expires_at INTEGER); CREATE TABLE runs(id TEXT,owner_id TEXT)");
      db.prepare("INSERT INTO owners VALUES(?,?,?)").run(state.ownerId,
        createHash("sha256").update(state.ownerCookie).digest("hex"), state.expiresAt);
      db.prepare("INSERT INTO runs VALUES(?,?)").run(state.runIds[0], state.ownerId);
      const value = ledger([launch({ ownerId: state.ownerId, runId: state.runIds[0] })]);
      state.ledgerDigest = ledgerDigest(value);
      expect(() => verifyAdvancedResume(db, state, value, now)).not.toThrow();
      expect(() => verifyAdvancedResume(db, { ...state, ownerCookie: "b".repeat(43) }, value, now)).toThrow("advanced_resume_owner_invalid");
      expect(() => verifyAdvancedResume(db, state, ledger(), now)).toThrow("advanced_resume_ledger_changed");
      db.prepare("UPDATE runs SET owner_id=?").run(randomUUID());
      expect(() => verifyAdvancedResume(db, state, value, now)).toThrow("advanced_resume_run_owner_invalid");
      expect(() => verifyAdvancedResume(db, state, value, state.expiresAt)).toThrow();
    } finally { db.close(); }
  });
});

describe("ledger SQL, human control, actual markers and approval", () => {
  it("refuses to adopt another persisted worker policy or silently migrate its cap", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE worker_policy(singleton INTEGER,configuration TEXT)");
      db.prepare("INSERT INTO worker_policy VALUES(1,?)").run(JSON.stringify({ ...advancedPolicy, leaseMs: 30000 }));
      expect(() => assertAdvancedStoredPolicy(db)).not.toThrow();
      db.prepare("UPDATE worker_policy SET configuration=?").run(JSON.stringify({ ...advancedPolicy, baselineSeconds: 944 }));
      expect(() => assertAdvancedStoredPolicy(db)).toThrow("advanced_stored_policy_mismatch");
      db.prepare("UPDATE worker_policy SET configuration=?").run(JSON.stringify({ ...advancedPolicy, lifetimeReservationLimitSeconds: 7200 }));
      expect(() => assertAdvancedStoredPolicy(db)).toThrow("advanced_stored_policy_mismatch");
    } finally { db.close(); }
  });

  describe("acknowledged real-page preference operations (fake page, no provider)", () => {
    it("rejects an operation dispatched before acknowledgment that remains in flight during human control", () => {
      const before = { operation: "quiesce" as const, startedAt: 5, endedAt: 10, startedPhase: "quiescing" };
      const resumed = { operation: "observe" as const, startedAt: 21, endedAt: 22, startedPhase: "agent" };
      expect(noAdvancedDispatchOverlap([before, resumed], 11, 20)).toBe(true);
      expect(noAdvancedDispatchOverlap([before, resumed, { operation: "decide", startedAt: 6, endedAt: 15, startedPhase: "agent" }], 11, 20)).toBe(false);
      expect(noAdvancedDispatchOverlap([before, resumed, { operation: "act", startedAt: 6, endedAt: null, startedPhase: "agent" }], 11, 20)).toBe(false);
      expect(noAdvancedDispatchOverlap([before, resumed, { operation: "evaluate", startedAt: 12, endedAt: 13, startedPhase: "human" }], 11, 20)).toBe(false);
      expect(noAdvancedDispatchOverlap([resumed], 11, 20)).toBe(false);
      expect(noAdvancedDispatchOverlap([before], 11, 20)).toBe(false);
    });
    it("instruments actual adapter promise settlement, not only persisted post-operation events", async () => {
      const calls: string[] = [];
      let settle!: () => void;
      const pending = new Promise<void>((done) => { settle = done; });
      const driver = { act: async () => { await pending; }, observe: vi.fn(), close: vi.fn() } as unknown as BrowserDriver;
      const brain = { decide: vi.fn(), quiesce: async () => { await pending; } } as unknown as Brain;
      const audited = auditAdvancedExecution({ driver, brain }, (operation) => {
        calls.push(`${operation}:start`);
        return () => { calls.push(`${operation}:end`); };
      });
      const active = audited.driver.act({ actor: "agent", action: "wait", candidateId: null, value: null, commentary: "" }, new AbortController().signal);
      const quiescing = audited.brain.quiesce!();
      expect(calls).toEqual(["act:start", "quiesce:start"]);
      settle();
      await Promise.all([active, quiescing]);
      expect(calls).toEqual(["act:start", "quiesce:start", "act:end", "quiesce:end"]);
    });
    it("uses request-start monotonic grants, not server wall-clock trust", () => {
      const attemptId = randomUUID(), controllerId = randomUUID();
      const grant: TakeoverStatus = {
        attemptId, controllerId, phase: "human", version: 3, deadline: now + 60000,
        interactiveUrl: "https://www.browserbase.com/live/offline-fake", validUntil: 1, validForMs: 1500,
      };
      expect(validAdvancedHumanGrant(grant, attemptId, controllerId, 100, 200)).toBe(true);
      expect(validAdvancedHumanGrant(grant, attemptId, controllerId, 100, 1500)).toBe(false);
      expect(validAdvancedHumanGrant(grant, attemptId, controllerId, 100, 99)).toBe(false);
      expect(validAdvancedHumanGrant({ ...grant, phase: "requested" }, attemptId, controllerId, 100, 200)).toBe(false);
      expect(validAdvancedHumanGrant({ ...grant, validForMs: 1501 }, attemptId, controllerId, 100, 200)).toBe(false);
      expect(validAdvancedHumanGrant(grant, randomUUID(), controllerId, 100, 200)).toBe(false);
      expect(validAdvancedHumanGrant(grant, attemptId, randomUUID(), 100, 200)).toBe(false);
    });
    it("requires a genuine unexpired owner and exact active SQL session binding before CDP attachment", () => {
      const db = new DatabaseSync(":memory:");
      const item = launch(), cookie = "c".repeat(43), controllerId = randomUUID();
      try {
        db.exec(`CREATE TABLE owners(id TEXT,session_hash TEXT,expires_at INTEGER);
          CREATE TABLE runs(id TEXT,owner_id TEXT,cancel_requested_at TEXT);
          CREATE TABLE jobs(id TEXT,run_id TEXT,attempt_id TEXT,status TEXT,lease_expires_at TEXT,cancel_requested_at TEXT,lease_generation INTEGER);
          CREATE TABLE attempts(id TEXT,status TEXT);
          CREATE TABLE launches(job_id TEXT,session_reference TEXT,state TEXT);
          CREATE TABLE browser_session_bindings(session_id TEXT,job_id TEXT);
          CREATE TABLE takeover_controls(attempt_id TEXT,phase TEXT,controller_id TEXT,deadline INTEGER,lease_generation INTEGER)`);
        db.prepare("INSERT INTO owners VALUES(?,?,?)").run(item.ownerId, createHash("sha256").update(cookie).digest("hex"), Date.now() + 900000);
        db.prepare("INSERT INTO runs VALUES(?,?,NULL)").run(item.runId, item.ownerId);
        db.prepare("INSERT INTO jobs VALUES(?,?,?,'leased',?,NULL,1)").run(item.jobId, item.runId, item.attemptId, new Date(Date.now() + 30000).toISOString());
        db.prepare("INSERT INTO attempts VALUES(?,'running')").run(item.attemptId);
        db.prepare("INSERT INTO takeover_controls VALUES(?,'human',?,?,1)").run(item.attemptId, controllerId, Date.now() + 60000);
        db.prepare("INSERT INTO launches VALUES(?,?,'active')").run(item.jobId, JSON.stringify({ sessionId: item.sessionId }));
        db.prepare("INSERT INTO browser_session_bindings VALUES(?,?)").run(item.sessionId, item.jobId);
        expect(ownerSessionBinding(db, item.ownerId, cookie, item.runId, item.attemptId, controllerId)).toBe(item.sessionId);
        expect(() => ownerSessionBinding(db, item.ownerId, "x".repeat(43), item.runId, item.attemptId, controllerId)).toThrow();
        expect(() => ownerSessionBinding(db, randomUUID(), cookie, item.runId, item.attemptId, controllerId)).toThrow();
        expect(() => ownerSessionBinding(db, item.ownerId, cookie, randomUUID(), item.attemptId, controllerId)).toThrow();
        expect(() => ownerSessionBinding(db, item.ownerId, cookie, item.runId, item.attemptId, randomUUID())).toThrow();
        db.exec("UPDATE takeover_controls SET lease_generation=2");
        expect(() => ownerSessionBinding(db, item.ownerId, cookie, item.runId, item.attemptId, controllerId)).toThrow();
        db.exec("UPDATE takeover_controls SET lease_generation=1");
        db.prepare("UPDATE browser_session_bindings SET session_id=?").run(randomUUID());
        expect(() => ownerSessionBinding(db, item.ownerId, cookie, item.runId, item.attemptId, controllerId)).toThrow();
      } finally { db.close(); }
    });
    it("requires an exact original-image coordinator inspection receipt", () => {
      const invocationId = randomUUID();
      const images = [{ file: "desktop-report.png", sha256: "a".repeat(64) }, { file: "fresh-worker-marker.png", sha256: "b".repeat(64) }];
      const receipt = { version: 1, invocationId, inspectedAt: now, images: images.map((image) => ({ ...image, inspected: true })) };
      expect(exactAdvancedImageInspection(receipt, invocationId, images, now - 1, now)).toBe(true);
      expect(exactAdvancedImageInspection({ ...receipt, images: [receipt.images[0]] }, invocationId, images, now - 1, now)).toBe(false);
      expect(exactAdvancedImageInspection({ ...receipt, invocationId: randomUUID() }, invocationId, images, now - 1, now)).toBe(false);
      expect(exactAdvancedImageInspection(receipt, invocationId, images, now + 1, now)).toBe(false);
      expect(exactAdvancedImageInspection(receipt, invocationId, [{ ...images[0], sha256: "c".repeat(64) }, images[1]], now - 1, now)).toBe(false);
      expect(exactAdvancedImageInspection({ ...receipt, images: receipt.images.map((image) => ({ ...image, inspected: false })) },
        invocationId, images, now - 1, now)).toBe(false);
    });
    function pageFixture(value: string | null) {
      const remember = vi.fn(async () => {});
      const details = vi.fn(async () => {});
      const storageRead = vi.fn(async () => value);
      const status = { innerText: vi.fn(async () => `Synthetic preference: ${value === "remembered" ? "remembered" : "fresh"}.`) };
      const pixels = Buffer.alloc(2048, 17);
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pixels);
      const screenshot = vi.fn(async () => pixels);
      const raw = {
        url: () => "https://board.flash-flood.invalid/project-board",
        getByText: vi.fn(() => ({ evaluate: vi.fn(async () => false), click: details })),
        getByRole: vi.fn((role: string) => role === "button" ? { click: remember } : { filter: () => status }),
        evaluate: storageRead, screenshot,
      };
      return { page: raw as unknown as Page, raw, remember, details, storageRead, screenshot };
    }
    it("sets the marker only through the actual Remember UI click during acknowledged human control", async () => {
      const fixture = pageFixture("remembered");
      const acknowledged = vi.fn(async () => {});
      const result = await captureAdvancedPreference(fixture.page, "save", acknowledged);
      expect(fixture.details).toHaveBeenCalledOnce();
      expect(fixture.remember).toHaveBeenCalledOnce();
      expect(fixture.raw.getByRole).toHaveBeenCalledWith("button", { name: "Remember this demo visit", exact: true });
      expect(acknowledged.mock.calls.length).toBeGreaterThanOrEqual(6);
      expect(result).toMatchObject({ marker: "remembered", storageValue: "remembered", clickedRemember: true });
      expect(result.screenshotSha256).toBe(createHash("sha256").update(result.screenshot).digest("hex"));
      const readFunction = String((fixture.storageRead.mock.calls as unknown[][])[0]?.[0]);
      expect(readFunction).toContain("getItem");
      expect(readFunction).not.toContain("setItem");
    });
    it.each(["returning", "fresh"] as const)("observes %s state without clicking Remember or writing storage", async (mode) => {
      const fixture = pageFixture(mode === "returning" ? "remembered" : null);
      const result = await captureAdvancedPreference(fixture.page, mode, async () => {});
      expect(fixture.remember).not.toHaveBeenCalled();
      expect(result.clickedRemember).toBe(false);
      expect(fixture.storageRead).toHaveBeenCalledOnce();
    });
    it("does not touch the page unless control is already acknowledged", async () => {
      const fixture = pageFixture("remembered");
      await expect(captureAdvancedPreference(fixture.page, "save", async () => { throw new Error("not_acknowledged"); }))
        .rejects.toThrow("not_acknowledged");
      expect(fixture.details).not.toHaveBeenCalled();
      expect(fixture.remember).not.toHaveBeenCalled();
      expect(fixture.storageRead).not.toHaveBeenCalled();
    });
    it("stops if handback/control loss occurs before the page click", async () => {
      const fixture = pageFixture("remembered");
      let checks = 0;
      await expect(captureAdvancedPreference(fixture.page, "save", async () => {
        if (++checks === 3) throw new Error("control_lost");
      })).rejects.toThrow("control_lost");
      expect(fixture.remember).not.toHaveBeenCalled();
      expect(fixture.screenshot).not.toHaveBeenCalled();
    });
    it("does not infer persistence from a remembered label when actual storage is fresh", async () => {
      const fixture = pageFixture(null);
      await expect(captureAdvancedPreference(fixture.page, "returning", async () => {}))
        .rejects.toThrow("advanced_actual_marker_not_observed");
      expect(fixture.remember).not.toHaveBeenCalled();
    });
    it("cannot use this helper to interact outside a registered controlled fixture", async () => {
      const fixture = pageFixture("remembered");
      fixture.raw.url = () => "https://outside.invalid/project-board";
      await expect(captureAdvancedPreference(fixture.page, "save", async () => {}))
        .rejects.toThrow("advanced_marker_outside_controlled_fixture");
      expect(fixture.remember).not.toHaveBeenCalled();
    });
  });
  it("reads all reservations including settled refunds and quarantined failures", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE runs(id TEXT,owner_id TEXT);
        CREATE TABLE jobs(id TEXT,run_id TEXT,attempt_id TEXT,status TEXT);
        CREATE TABLE attempts(id TEXT,status TEXT);
        CREATE TABLE launches(job_id TEXT,correlation_token TEXT,session_reference TEXT,state TEXT,created_at TEXT,usage TEXT);
        CREATE TABLE usage_reservations(job_id TEXT,reserved_seconds INTEGER,consumed_seconds INTEGER,released_seconds INTEGER)`);
      const values = [launch(), launch({ state: "quarantined", releasedSeconds: 0 })];
      for (const item of values) {
        db.prepare("INSERT INTO runs VALUES(?,?)").run(item.runId, item.ownerId);
        db.prepare("INSERT INTO jobs VALUES(?,?,?,?)").run(item.jobId, item.runId, item.attemptId, item.jobStatus);
        db.prepare("INSERT INTO attempts VALUES(?,?)").run(item.attemptId, item.attemptStatus);
        db.prepare("INSERT INTO launches VALUES(?,?,?,?,?,?)").run(item.jobId, item.correlationToken,
          JSON.stringify({ sessionId: item.sessionId }), item.state, item.createdAt, item.usage);
        db.prepare("INSERT INTO usage_reservations VALUES(?,?,?,?)").run(item.jobId, 300, item.consumedSeconds, item.releasedSeconds);
      }
      expect(exactAdvancedLedger(readAdvancedLedger(db), ledger(values))).toBe(true);
      db.prepare("INSERT INTO usage_reservations VALUES(?,?,?,?)").run(randomUUID(), 300, 0, 300);
      expect(() => readAdvancedLedger(db)).toThrow();
    } finally { db.close(); }
  });
  it("requires a human interval with no agent event and a distinct fresh observation after handback", () => {
    const events = [
      { sequence: 1, kind: "attempt.control", data: { actor: "human", phase: "human" } },
      { sequence: 2, kind: "human.ui-click", data: { actor: "human" } },
      { sequence: 3, kind: "attempt.control", data: { actor: "human", phase: "handback" } },
      { sequence: 4, kind: "attempt.observation", data: { actor: "agent", evidenceId: randomUUID() } },
    ];
    expect(exclusiveHumanInterval(events, 1, 3, 4)).toBe(true);
    expect(exclusiveHumanInterval(events.filter((event) => event.sequence !== 1), 1, 3, 4)).toBe(false);
    expect(exclusiveHumanInterval(events.filter((event) => event.sequence !== 3), 1, 3, 4)).toBe(false);
    expect(exclusiveHumanInterval(events.filter((event) => event.sequence !== 2), 1, 3, 4)).toBe(false);
    expect(exclusiveHumanInterval([...events, { sequence: 2.5, kind: "browser.dispatch", data: {} }], 1, 3, 4)).toBe(false);
    expect(exclusiveHumanInterval([...events, { sequence: 2.5, kind: "attempt.decision", data: { actor: "agent" } }], 1, 3, 4)).toBe(false);
    expect(exclusiveHumanInterval(events, 1, 3, 2)).toBe(false);
  });
  it("requires actual marker evidence plus separate fresh contrast, never a manually seeded returning browser", () => {
    const contextId = randomUUID();
    const marker = (mode: MarkerObservation["mode"]): MarkerObservation => ({
      runId: randomUUID(), attemptId: randomUUID(), contextId: mode === "fresh" ? null : contextId, mode,
      textBlocks: [`Synthetic preference: ${mode === "fresh" ? "fresh" : "remembered"}`],
      screenshotSha256: (mode === "fresh" ? "b" : "a").repeat(64), screenshotBytes: 3000, manualStorageSeeded: false,
    });
    const saved = marker("save"), returning = marker("returning"), fresh = marker("fresh");
    expect(returningMarkerContrast(saved, returning, fresh)).toBe(true);
    expect(returningMarkerContrast(saved, { ...returning, manualStorageSeeded: true }, fresh)).toBe(false);
    expect(returningMarkerContrast(saved, { ...returning, textBlocks: [] }, fresh)).toBe(false);
    expect(returningMarkerContrast(saved, { ...returning, screenshotBytes: 0 }, fresh)).toBe(false);
    expect(returningMarkerContrast(saved, returning, { ...fresh, textBlocks: returning.textBlocks })).toBe(false);
  });
  it("compares immutable parent bytes without calling not-observed confirmed-fixed", () => {
    const before = { agents: [{ outcome: "target_failed" }], finality: "final" };
    expect(immutableParent(before, structuredClone(before))).toBe(true);
    expect(immutableParent(before, { ...before, finality: "pending" })).toBe(false);
    expect(immutableParent(undefined, undefined)).toBe(false);
  });
  it("requires all offline gates, coordinator review, explicit authorization and current source digest", () => {
    const value = { version: 1, sourceDigest: "a".repeat(64), offlinePassed: true, lintPassed: true,
      typecheckPassed: true, testsPassed: true, buildPassed: true, reviewPassed: true, paidAuthorized: true, reviewedAt: now };
    expect(approvedAdvancedProof(value, value.sourceDigest, now)).toBe(true);
    expect(approvedAdvancedProof(value, "b".repeat(64), now)).toBe(false);
    expect(approvedAdvancedProof(value, value.sourceDigest, now + ADVANCED_RESUME_TTL_MS)).toBe(false);
    expect(approvedAdvancedProof(value, value.sourceDigest, now - 1)).toBe(false);
    for (const key of ["offlinePassed", "lintPassed", "typecheckPassed", "testsPassed", "buildPassed", "reviewPassed", "paidAuthorized"]) {
      expect(advancedApprovalSchema.safeParse({ ...value, [key]: false }).success).toBe(false);
    }
  });
});
