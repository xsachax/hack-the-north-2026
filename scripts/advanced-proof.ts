import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { Page } from "playwright-core";
import type { TakeoverStatus } from "../src/lib/takeover-contracts";
import { controlledSites } from "../src/lib/controlled-sites";
import type { Brain, BrowserDriver } from "../src/server/execution/types";

export const advancedPolicy = Object.freeze({
  globalConcurrency: 3, ownerConcurrency: 3, sessionSeconds: 300,
  maxSteps: 20, maxModelCalls: 28, baselineSeconds: 985,
  developmentBudgetSeconds: 4585, ownerBudgetSeconds: 3600,
  lifetimeReservationLimitSeconds: 3600,
});
export const ADVANCED_RESUME_TTL_MS = 15 * 60 * 1000;
export const ADVANCED_RESUME_MAX_BYTES = 8192;
export const advancedPhases = [
  "offline-gates-and-review", "prior-exact-closure", "owner-ui-save-context",
  "acknowledged-human-ui-click", "handback-fresh-observation", "saved-context-closed",
  "returning-marker-observation", "fresh-marker-contrast", "immutable-rerun-comparison",
  "optional-bounded-reproduction", "desktop-mobile-image-inspection",
  "all-correlated-sessions-closed", "context-retirement", "credential-removal",
] as const;
export type AdvancedMode = "offline" | "paid" | "resume";
export type AdvancedOperation = "readback" | "local-ui" | "worker" | "create-run" | "cancel-run" |
  "context-mutation" | "takeover" | "provider-read" | "provider-attach" | "reproduction";

export function parseAdvancedArgs(args: readonly string[]): { mode: AdvancedMode; invocationId?: string } {
  if (args.length === 1 && args[0] === "--offline-preflight") return { mode: "offline" };
  if (args.length === 1 && args[0] === "--confirm-paid") return { mode: "paid" };
  if (args.length === 2 && args[0] === "--resume" && z.uuid().safeParse(args[1]).success) {
    return { mode: "resume", invocationId: args[1] };
  }
  throw new Error("advanced_explicit_mode_required");
}

export function assertAdvancedOperation(mode: AdvancedMode, operation: AdvancedOperation): void {
  const allowed = mode === "paid" || operation === "readback" ||
    (mode === "offline" && operation === "local-ui") || (mode === "resume" && operation === "provider-read");
  if (!allowed) throw new Error("advanced_operation_forbidden");
}

export function canReserveAdvanced(reservedSeconds: number, attempts = 1): boolean {
  return Number.isInteger(reservedSeconds) && reservedSeconds >= 0 && reservedSeconds % 300 === 0 &&
    Number.isInteger(attempts) && attempts > 0 &&
    reservedSeconds + attempts * advancedPolicy.sessionSeconds <= advancedPolicy.lifetimeReservationLimitSeconds;
}

const launchSchema = z.strictObject({
  jobId: z.uuid(), runId: z.uuid(), attemptId: z.uuid(), ownerId: z.uuid(),
  correlationToken: z.uuid(), sessionId: z.uuid().nullable(),
  reservedSeconds: z.literal(300), consumedSeconds: z.int().nonnegative(),
  releasedSeconds: z.int().min(0).max(300), state: z.string(), jobStatus: z.string(),
  attemptStatus: z.string(),
  createdAt: z.iso.datetime(), usage: z.string().nullable(),
});
export type AdvancedLaunch = z.infer<typeof launchSchema>;
export const advancedLedgerSchema = z.strictObject({
  version: z.literal(1), baselineSeconds: z.literal(985),
  reservedSeconds: z.int().min(0).max(3600), launches: z.array(launchSchema).max(12),
}).superRefine((ledger, ctx) => {
  if (ledger.reservedSeconds !== ledger.launches.reduce((sum, item) => sum + item.reservedSeconds, 0)) {
    ctx.addIssue({ code: "custom", message: "reservation_sum_mismatch" });
  }
  for (const key of ["jobId", "attemptId", "correlationToken"] as const) {
    if (new Set(ledger.launches.map((item) => item[key])).size !== ledger.launches.length) {
      ctx.addIssue({ code: "custom", message: "duplicate_launch_identity" });
    }
  }
  const sessions = ledger.launches.flatMap((item) => item.sessionId ? [item.sessionId] : []);
  if (new Set(sessions).size !== sessions.length) ctx.addIssue({ code: "custom", message: "duplicate_session" });
});
export type AdvancedLedger = z.infer<typeof advancedLedgerSchema>;

export function assertAdvancedStoredPolicy(db: DatabaseSync): void {
  const row = db.prepare("SELECT configuration FROM worker_policy WHERE singleton=1").get();
  const policy = z.record(z.string(), z.unknown()).parse(JSON.parse(z.string().parse(row?.configuration)));
  if (Object.entries(advancedPolicy).some(([key, value]) => policy[key] !== value)) {
    throw new Error("advanced_stored_policy_mismatch");
  }
}

/** Read all lifetime reservations, including failed and refunded attempts; never reset the cap. */
export function readAdvancedLedger(db: DatabaseSync): AdvancedLedger {
  const rows = db.prepare(`SELECT j.id jobId,j.run_id runId,j.attempt_id attemptId,r.owner_id ownerId,
    l.correlation_token correlationToken,l.session_reference reference,u.reserved_seconds reservedSeconds,
    u.consumed_seconds consumedSeconds,u.released_seconds releasedSeconds,l.state,j.status jobStatus,a.status attemptStatus,
    l.created_at createdAt,l.usage
    FROM launches l JOIN jobs j ON j.id=l.job_id JOIN runs r ON r.id=j.run_id JOIN attempts a ON a.id=j.attempt_id
    JOIN usage_reservations u ON u.job_id=j.id ORDER BY l.correlation_token`).all();
  const reserved = db.prepare("SELECT coalesce(sum(reserved_seconds),0) n FROM usage_reservations").get()?.n;
  return advancedLedgerSchema.parse({
    version: 1, baselineSeconds: 985, reservedSeconds: reserved,
    launches: rows.map(({ reference, ...row }) => ({
      ...row, sessionId: reference ? z.object({ sessionId: z.uuid() }).parse(
        JSON.parse(z.string().parse(reference)),
      ).sessionId : null,
    })),
  });
}

export function ledgerDigest(ledger: AdvancedLedger): string {
  const parsed = advancedLedgerSchema.parse(ledger);
  return createHash("sha256").update(JSON.stringify({
    ...parsed, launches: [...parsed.launches].sort((a, b) => a.correlationToken.localeCompare(b.correlationToken)),
  })).digest("hex");
}

export function exactAdvancedLedger(before: AdvancedLedger, after: AdvancedLedger): boolean {
  try { return ledgerDigest(before) === ledgerDigest(after); } catch { return false; }
}

const advancedContextSchema = z.strictObject({
  id: z.uuid(), ownerId: z.uuid(), scopeSignature: z.string(),
  remoteIdDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  status: z.string(), persistence: z.string(), createdAt: z.int(),
  availableAfter: z.int().nullable(), expiresAt: z.int(), revoked: z.boolean(),
  heldJob: z.string().nullable(), operationTokenDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});
const advancedContextOperationSchema = z.strictObject({
  sequence: z.int().positive(), contextId: z.uuid(), operation: z.string(), status: z.string(), createdAt: z.int(),
});
const advancedContextInventorySchema = z.strictObject({
  version: z.literal(1), contexts: z.array(advancedContextSchema), operations: z.array(advancedContextOperationSchema),
}).superRefine((inventory, ctx) => {
  if (new Set(inventory.contexts.map((item) => item.id)).size !== inventory.contexts.length ||
    new Set(inventory.operations.map((item) => item.sequence)).size !== inventory.operations.length) {
    ctx.addIssue({ code: "custom", message: "duplicate_context_inventory_identity" });
  }
});
export type AdvancedContext = z.infer<typeof advancedContextSchema>;
export type AdvancedContextOperation = z.infer<typeof advancedContextOperationSchema>;
export type AdvancedContextInventory = z.infer<typeof advancedContextInventorySchema>;

/** Cumulative, transaction-consistent inventory; provider identities never leave as plaintext. */
export function readAdvancedContextInventory(db: DatabaseSync): AdvancedContextInventory {
  const identityDigest = (value: unknown): string | null => value === null ? null :
    createHash("sha256").update(z.string().min(1).parse(value)).digest("hex");
  db.exec("SAVEPOINT advanced_context_inventory");
  try {
    const contexts = db.prepare(`SELECT id,owner_id ownerId,scope_signature scopeSignature,remote_id,
      status,persistence,created_at createdAt,available_after availableAfter,expires_at expiresAt,
      revoked,held_job heldJob,operation_token FROM browser_contexts ORDER BY id`).all()
      .map(({ remote_id, operation_token, revoked, ...row }) => ({
        ...row, revoked: z.union([z.literal(0), z.literal(1)]).parse(revoked) === 1,
        remoteIdDigest: identityDigest(remote_id), operationTokenDigest: identityDigest(operation_token),
      }));
    const operations = db.prepare(`SELECT sequence,context_id contextId,operation,status,created_at createdAt
      FROM context_operations ORDER BY sequence`).all();
    return advancedContextInventorySchema.parse({ version: 1, contexts, operations });
  } finally { db.exec("RELEASE advanced_context_inventory"); }
}

export function contextInventoryDigest(inventory: AdvancedContextInventory): string {
  const parsed = advancedContextInventorySchema.parse(inventory);
  return createHash("sha256").update(JSON.stringify({
    ...parsed,
    contexts: [...parsed.contexts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    operations: [...parsed.operations].sort((a, b) => a.sequence - b.sequence),
  })).digest("hex");
}

/** Local retirement proof includes historical unknown allocations, not only this invocation's IDs. */
export function advancedContextsRetired(inventory: AdvancedContextInventory): boolean {
  const parsed = advancedContextInventorySchema.safeParse(inventory);
  if (!parsed.success) return false;
  const { contexts, operations } = parsed.data;
  if (operations.some((operation) => !contexts.some((context) => context.id === operation.contextId))) return false;
  return contexts.every((context) => {
    if (context.status !== "deleted" || !context.revoked || context.heldJob !== null ||
      context.remoteIdDigest !== null) return false;
    let creation: "none" | "dispatched" | "returned" | "uncertain" = "none";
    let deletion: "none" | "dispatched" | "uncertain" | "confirmed" = "none";
    for (const event of operations.filter((item) => item.contextId === context.id)
      .sort((a, b) => a.sequence - b.sequence)) {
      if (event.operation === "create") {
        if (deletion !== "none") return false;
        if (event.status === "dispatched" && creation === "none") creation = "dispatched";
        else if (event.status === "returned" && creation === "dispatched") creation = "returned";
        else if (event.status === "uncertain" && creation === "dispatched") creation = "uncertain";
        else return false;
      } else if (event.operation === "delete") {
        if (event.status === "dispatched" && deletion === "none" &&
          (creation === "returned" || creation === "uncertain")) deletion = "dispatched";
        else if (event.status === "uncertain" && deletion === "dispatched") deletion = "uncertain";
        else if (event.status === "confirmed" && ["dispatched", "uncertain"].includes(deletion)) deletion = "confirmed";
        else return false;
      } else if (event.operation === "inspect") {
        if (event.status !== "failed") return false;
      } else if (event.operation === "session_settlement") {
        if (!["closed", "uncertain"].includes(event.status)) return false;
      } else return false;
    }
    // An unallocated revoked context needs no provider deletion; any creation intent does.
    return creation === "none" ? deletion === "none" : deletion === "confirmed";
  });
}

export const advancedResumeSchema = z.strictObject({
  version: z.literal(1), mode: z.enum(["paid", "offline-test"]),
  invocationId: z.uuid(), ownerId: z.uuid(), ownerCookie: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  runIds: z.array(z.uuid()).min(1).max(12),
  createdAt: z.int().nonnegative(), expiresAt: z.int().nonnegative(),
  reservedSeconds: z.int().min(0).max(3600), ledgerDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).refine((state) => state.expiresAt === state.createdAt + ADVANCED_RESUME_TTL_MS &&
  state.reservedSeconds % 300 === 0 && new Set(state.runIds).size === state.runIds.length &&
  (state.mode !== "offline-test" || state.reservedSeconds === 0));
export type AdvancedResumeState = z.infer<typeof advancedResumeSchema>;

/** Reject symlinks in every ancestor, not just the final file. */
export async function assertPrivateDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  let ancestor = absolute;
  while (true) {
    const info = await lstat(ancestor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("advanced_unsafe_directory");
    if (ancestor === absolute && ((info.mode & 0o777) !== 0o700 ||
      (process.getuid && info.uid !== process.getuid()))) throw new Error("advanced_unsafe_directory");
    if (dirname(ancestor) === ancestor) break;
    ancestor = dirname(ancestor);
  }
  if (await realpath(absolute) !== absolute) throw new Error("advanced_unsafe_directory");
}

async function credentialDirectory(root: string, id: string): Promise<string> {
  z.uuid().parse(id);
  await assertPrivateDirectory(root);
  const directory = join(resolve(root), id);
  await assertPrivateDirectory(directory);
  return directory;
}

export async function readPrivateJson(path: string, maxBytes = ADVANCED_RESUME_MAX_BYTES): Promise<unknown> {
  await assertPrivateDirectory(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
      (process.getuid && info.uid !== process.getuid()) || info.size <= 0 || info.size > maxBytes) {
      throw new Error("advanced_unsafe_private_file");
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      throw new Error("advanced_private_file_changed");
    }
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await assertPrivateDirectory(dirname(path));
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
}

export async function saveAdvancedResume(root: string, state: AdvancedResumeState): Promise<void> {
  const parsed = advancedResumeSchema.parse(state);
  const directory = await credentialDirectory(root, parsed.invocationId);
  if (Buffer.byteLength(JSON.stringify(parsed, null, 2)) > ADVANCED_RESUME_MAX_BYTES) {
    throw new Error("advanced_resume_too_large");
  }
  // Exclusive creation makes the original 15-minute deadline nonrenewable.
  await writePrivateJson(join(directory, "owner-resume.json"), parsed);
}

export async function removeAdvancedResume(root: string, id: string): Promise<void> {
  const directory = await credentialDirectory(root, id);
  await unlink(join(directory, "owner-resume.json")).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  });
}

export async function loadAdvancedResume(
  root: string, id: string, mode: AdvancedResumeState["mode"] = "paid", now = Date.now(),
): Promise<AdvancedResumeState> {
  let directory: string | undefined;
  try {
    directory = await credentialDirectory(root, id);
    const state = advancedResumeSchema.parse(await readPrivateJson(join(directory, "owner-resume.json")));
    if (state.invocationId !== id || state.mode !== mode || now < state.createdAt || now >= state.expiresAt) {
      throw new Error("advanced_expired_resume");
    }
    return state;
  } catch {
    if (directory) await unlink(join(directory, "owner-resume.json")).catch(() => {});
    throw new Error("advanced_resume_invalid");
  }
}

export function verifyAdvancedResume(db: DatabaseSync, state: AdvancedResumeState, ledger: AdvancedLedger, now = Date.now()): void {
  if (now < state.createdAt || now >= state.expiresAt || state.reservedSeconds !== ledger.reservedSeconds ||
    state.ledgerDigest !== ledgerDigest(ledger)) throw new Error("advanced_resume_ledger_changed");
  const session = db.prepare("SELECT id,expires_at FROM owners WHERE session_hash=?")
    .get(createHash("sha256").update(state.ownerCookie).digest("hex"));
  if (session?.id !== state.ownerId || Number(session.expires_at) <= now) throw new Error("advanced_resume_owner_invalid");
  for (const runId of state.runIds) {
    if (db.prepare("SELECT owner_id FROM runs WHERE id=?").get(runId)?.owner_id !== state.ownerId) {
      throw new Error("advanced_resume_run_owner_invalid");
    }
  }
}

export type ClosedAdvancedSession = {
  correlationToken: string; sessionId: string; status: string;
  startedAt: number; endedAt: number; actualBrowserSeconds: number;
};
export function exactAdvancedClosure(ledger: AdvancedLedger, sessions: readonly ClosedAdvancedSession[]): boolean {
  if (!advancedLedgerSchema.safeParse(ledger).success || ledger.launches.length === 0 ||
    sessions.length !== ledger.launches.length || new Set(sessions.map((item) => item.sessionId)).size !== sessions.length ||
    new Set(sessions.map((item) => item.correlationToken)).size !== sessions.length) return false;
  return ledger.launches.every((launch) => {
    const session = sessions.find((item) => item.correlationToken === launch.correlationToken);
    return !!session && launch.sessionId === session.sessionId && ["COMPLETED", "ERROR", "TIMED_OUT"].includes(session.status) &&
      Number.isFinite(session.startedAt) && Number.isFinite(session.endedAt) && session.endedAt >= session.startedAt &&
      Number.isFinite(session.actualBrowserSeconds) && session.actualBrowserSeconds >= 0 &&
      session.actualBrowserSeconds === (session.endedAt - session.startedAt) / 1000;
  });
}

export function successfulAdvancedClosure(ledger: AdvancedLedger, sessions: readonly ClosedAdvancedSession[]): boolean {
  return exactAdvancedClosure(ledger, sessions) && sessions.every((session) => session.status === "COMPLETED");
}

export function observedPeakConcurrency(sessions: readonly ClosedAdvancedSession[]): number {
  const edges = sessions.filter((item) => item.endedAt > item.startedAt).flatMap((item) =>
    [{ at: item.startedAt, delta: 1 }, { at: item.endedAt, delta: -1 }]);
  edges.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  for (const edge of edges) { current += edge.delta; peak = Math.max(peak, current); }
  return peak;
}

export type AdvancedControlEvent = { sequence: number; kind: string; data: Record<string, unknown> };
export type AdvancedDispatchOperation = "observe" | "act" | "decide" | "evaluate" | "quiesce";
export type AdvancedDispatchAudit = {
  operation: AdvancedDispatchOperation; startedAt: number; endedAt: number | null; startedPhase: string;
};

export function auditAdvancedExecution(
  execution: { driver: BrowserDriver; brain: Brain },
  begin: (operation: AdvancedDispatchOperation) => () => void,
): { driver: BrowserDriver; brain: Brain } {
  const measured = async <T>(operation: AdvancedDispatchOperation, work: () => Promise<T>): Promise<T> => {
    const finish = begin(operation);
    try { return await work(); } finally { finish(); }
  };
  const { driver, brain } = execution;
  return {
    driver: {
      observe: (signal) => measured("observe", () => driver.observe(signal)),
      act: (action, signal) => measured("act", () => driver.act(action, signal)),
      close: () => driver.close(),
    },
    brain: {
      managesModelBudget: brain.managesModelBudget,
      decide: (input, signal, budget) => measured("decide", () => brain.decide(input, signal, budget)),
      ...(brain.evaluate ? { evaluate: (...args: Parameters<NonNullable<Brain["evaluate"]>>) =>
        measured("evaluate", () => brain.evaluate!(...args)) } : {}),
      ...(brain.quiesce ? { quiesce: () => measured("quiesce", () => brain.quiesce!()) } : {}),
      ...(brain.drain ? { drain: () => brain.drain!() } : {}),
    },
  };
}

export function noAdvancedDispatchOverlap(rows: readonly AdvancedDispatchAudit[], start: number, end: number): boolean {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !rows.length ||
    !rows.some((row) => row.operation === "quiesce" && row.endedAt !== null && row.endedAt <= start) ||
    !rows.some((row) => row.operation === "observe" && row.startedAt >= end)) return false;
  return rows.every((row) => Number.isFinite(row.startedAt) &&
    (row.endedAt === null || Number.isFinite(row.endedAt) && row.endedAt >= row.startedAt) &&
    (row.operation === "quiesce" || row.startedPhase === "agent") &&
    !(row.startedAt < end && (row.endedAt === null || row.endedAt > start)));
}

export function validAdvancedHumanGrant(
  status: TakeoverStatus, attemptId: string, controllerId: string, requestStarted: number, now: number,
): boolean {
  return status.attemptId === attemptId && status.phase === "human" && status.controllerId === controllerId &&
    !!status.interactiveUrl && status.validUntil !== null && status.validForMs !== null &&
    status.validForMs > 0 && status.validForMs <= 1500 && Number.isFinite(requestStarted) &&
    Number.isFinite(now) && now >= requestStarted && requestStarted + status.validForMs > now + 100;
}

export function exclusiveHumanInterval(
  events: readonly AdvancedControlEvent[], acknowledged: number, handback: number, resumedObservation: number,
): boolean {
  if (!(acknowledged > 0 && handback > acknowledged && resumedObservation > handback) ||
    new Set(events.map((event) => event.sequence)).size !== events.length ||
    events.some((event) => !Number.isInteger(event.sequence) || event.sequence < 1)) return false;
  const start = events.find((event) => event.sequence === acknowledged);
  const end = events.find((event) => event.sequence === handback);
  if (start?.kind !== "attempt.control" || start.data.phase !== "human" ||
    end?.kind !== "attempt.control" || end.data.phase !== "handback") return false;
  const interval = events.filter((event) => event.sequence > acknowledged && event.sequence < handback);
  if (!interval.some((event) => event.data.actor === "human")) return false;
  if (interval.some((event) => event.data.actor === "agent" ||
    /dispatch|model\.|decision|action\.started/.test(event.kind))) return false;
  const observation = events.find((event) => event.sequence === resumedObservation);
  return !!observation && observation.kind === "attempt.observation" && observation.data.actor === "agent" &&
    typeof observation.data.evidenceId === "string" &&
    !events.some((event) => event.sequence < resumedObservation && event.kind === "attempt.observation" &&
      event.data.evidenceId === observation.data.evidenceId) &&
    !events.some((event) => event.sequence > handback && event.sequence < resumedObservation && event.data.actor === "agent");
}

export type MarkerObservation = {
  runId: string; attemptId: string; contextId: string | null; mode: "save" | "returning" | "fresh";
  textBlocks: readonly string[]; screenshotSha256: string; screenshotBytes: number;
  manualStorageSeeded: boolean;
};
export function returningMarkerContrast(saved: MarkerObservation, returning: MarkerObservation, fresh: MarkerObservation): boolean {
  const remembered = (item: MarkerObservation) => item.textBlocks.some((text) => text.includes("Synthetic preference: remembered"));
  const isFresh = (item: MarkerObservation) => item.textBlocks.some((text) => text.includes("Synthetic preference: fresh"));
  return saved.mode === "save" && returning.mode === "returning" && fresh.mode === "fresh" &&
    !!saved.contextId && saved.contextId === returning.contextId && fresh.contextId === null &&
    new Set([saved.attemptId, returning.attemptId, fresh.attemptId]).size === 3 &&
    fresh.screenshotSha256 !== returning.screenshotSha256 &&
    [saved, returning, fresh].every((item) => !item.manualStorageSeeded && /^[a-f0-9]{64}$/.test(item.screenshotSha256) &&
      item.screenshotBytes > 1024) && remembered(saved) && remembered(returning) && !isFresh(returning) &&
    isFresh(fresh) && !remembered(fresh);
}

export const ADVANCED_PREFERENCE_KEY = "flash-flood.synthetic-preference.v1";
export type AdvancedPreferenceCapture = {
  marker: "remembered" | "fresh";
  storageValue: string | null;
  screenshot: Buffer;
  screenshotSha256: string;
  clickedRemember: boolean;
};

/**
 * The caller stops human commands before handback and owns the attachment until worker cleanup.
 * Each guard must recheck the acknowledged attempt/controller, not merely a
 * previously accepted takeover request. This helper never seeds browser state.
 */
export async function captureAdvancedPreference(
  page: Page, mode: "save" | "returning" | "fresh",
  assertAcknowledgedOwnerControl: () => Promise<void>,
): Promise<AdvancedPreferenceCapture> {
  const guard = async () => {
    await assertAcknowledgedOwnerControl();
    const url = new URL(page.url());
    if (!Object.values(controlledSites).some((site) => site.origin === url.origin &&
      site.navigationPaths.includes(url.pathname)) || url.username || url.password || url.search || url.hash) {
      throw new Error("advanced_marker_outside_controlled_fixture");
    }
  };
  await guard();
  const summary = page.getByText("Returning-user demo preference", { exact: true });
  // Open via the actual details UI; never manufacture a returning marker.
  if (!await summary.evaluate((element) => element.closest("details")?.open === true)) {
    await guard();
    await summary.click({ timeout: 5000 });
  }
  await guard();
  if (mode === "save") {
    await page.getByRole("button", { name: "Remember this demo visit", exact: true }).click({ timeout: 5000 });
    await guard();
  }
  const storageValue = await page.evaluate((key) => localStorage.getItem(key), ADVANCED_PREFERENCE_KEY);
  await guard();
  const marker = mode === "fresh" ? "fresh" : "remembered";
  const text = await page.getByRole("status").filter({ hasText: `Synthetic preference: ${marker}` }).innerText({ timeout: 5000 });
  if (!text.includes(`Synthetic preference: ${marker}`) ||
    (marker === "remembered" ? storageValue !== "remembered" : storageValue !== null)) {
    throw new Error("advanced_actual_marker_not_observed");
  }
  await guard();
  const screenshot = await page.screenshot({ fullPage: true, timeout: 5000 });
  await guard();
  if (screenshot.length <= 1024 ||
    !screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("advanced_marker_screenshot_missing");
  }
  return { marker, storageValue, screenshot, screenshotSha256: createHash("sha256").update(screenshot).digest("hex"),
    clickedRemember: mode === "save" };
}

export function immutableParent(before: unknown, after: unknown): boolean {
  return before !== undefined && after !== undefined && isDeepStrictEqual(before, after);
}

export const advancedApprovalSchema = z.strictObject({
  version: z.literal(1), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  offlinePassed: z.literal(true), lintPassed: z.literal(true), typecheckPassed: z.literal(true),
  testsPassed: z.literal(true), buildPassed: z.literal(true), reviewPassed: z.literal(true),
  paidAuthorized: z.literal(true), reviewedAt: z.int().nonnegative(),
});

export function approvedAdvancedProof(value: unknown, sourceDigest: string, now = Date.now()): boolean {
  const result = advancedApprovalSchema.safeParse(value);
  return result.success && result.data.sourceDigest === sourceDigest &&
    result.data.reviewedAt <= now && now - result.data.reviewedAt < ADVANCED_RESUME_TTL_MS;
}

export const advancedImageInspectionSchema = z.strictObject({
  version: z.literal(1), invocationId: z.uuid(), inspectedAt: z.int().nonnegative(),
  images: z.array(z.strictObject({
    file: z.string().regex(/^[a-z0-9-]+\.png$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), inspected: z.literal(true),
  })).min(1).max(20),
});

export function exactAdvancedImageInspection(
  receipt: unknown, invocationId: string, images: readonly { file: string; sha256: string }[],
  createdAt: number, now = Date.now(),
): boolean {
  const parsed = advancedImageInspectionSchema.safeParse(receipt);
  if (!parsed.success || !images.length || parsed.data.invocationId !== invocationId ||
    parsed.data.inspectedAt < createdAt || parsed.data.inspectedAt > now ||
    parsed.data.images.length !== images.length ||
    new Set(images.map((image) => image.file)).size !== images.length ||
    new Set(parsed.data.images.map((image) => image.file)).size !== images.length) return false;
  return images.every((image) => parsed.data.images.some((entry) => entry.file === image.file && entry.sha256 === image.sha256));
}
