import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { RunReport } from "../src/lib/report-contracts";
import type { RunComparison } from "../src/lib/rerun-contracts";
import { advancedLedgerSchema, assertPrivateDirectory, observedPeakConcurrency,
  type AdvancedLedger, type ClosedAdvancedSession } from "./advanced-proof";
import { advancedSourceDigest } from "./advanced-build";

export const releasePolicy = Object.freeze({
  globalConcurrency: 3, ownerConcurrency: 3, sessionSeconds: 300,
  maxSteps: 20, maxModelCalls: 28, baselineSeconds: 1092,
  developmentBudgetSeconds: 4692, ownerBudgetSeconds: 3600,
  lifetimeReservationLimitSeconds: 3600,
});
export const releasePlan = Object.freeze([
  { phase: "broken-multi-persona", attempts: 2, scenario: "second-coupon" },
  { phase: "active-cancellation", attempts: 1, scenario: "fixed" },
  { phase: "selected-fixed-rerun", attempts: 1, scenario: "fixed" },
] as const);
export const RELEASE_PLANNED_SECONDS = 1200;
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const releaseLedgerSchema = z.strictObject({
  ...advancedLedgerSchema.shape, baselineSeconds: z.literal(1092),
}).superRefine((ledger, ctx) => {
  const checked = advancedLedgerSchema.safeParse({ ...ledger, baselineSeconds: 985 });
  if (!checked.success) ctx.addIssue({ code: "custom", message: "release_reservation_identity_or_sum_invalid" });
});
export type ReleaseLedger = z.infer<typeof releaseLedgerSchema>;

export function parseReleaseArgs(args: readonly string[]): "offline" | "paid" {
  if (args.length === 1 && args[0] === "--offline-preflight") return "offline";
  if (args.length === 1 && args[0] === "--confirm-paid") return "paid";
  // Deliberately no owner-resume capability or persisted owner credential.
  throw new Error("release_explicit_mode_required");
}

export function canReserveRelease(reserved: number, count = 1): boolean {
  return Number.isInteger(reserved) && reserved >= 0 && reserved % 300 === 0 &&
    Number.isInteger(count) && count > 0 && reserved + count * 300 <= 3600;
}

export function assertReleasePolicy(db: DatabaseSync): void {
  const row = db.prepare("SELECT configuration FROM worker_policy WHERE singleton=1").get();
  const policy = JSON.parse(z.string().parse(row?.configuration));
  if (Object.entries(releasePolicy).some(([key, value]) => policy[key] !== value)) {
    throw new Error("release_stored_policy_mismatch");
  }
}

/** All reservations, not only successful jobs or the current invocation/owner. */
export function readReleaseLedger(db: DatabaseSync): ReleaseLedger {
  db.exec("SAVEPOINT release_ledger");
  try {
    const rows = db.prepare(`SELECT j.id jobId,j.run_id runId,j.attempt_id attemptId,r.owner_id ownerId,
      l.correlation_token correlationToken,l.session_reference reference,u.reserved_seconds reservedSeconds,
      u.consumed_seconds consumedSeconds,u.released_seconds releasedSeconds,l.state,j.status jobStatus,
      a.status attemptStatus,l.created_at createdAt,l.usage
      FROM launches l JOIN jobs j ON j.id=l.job_id JOIN runs r ON r.id=j.run_id
      JOIN attempts a ON a.id=j.attempt_id JOIN usage_reservations u ON u.job_id=j.id
      ORDER BY l.correlation_token`).all();
    const reserved = db.prepare("SELECT coalesce(sum(reserved_seconds),0) n FROM usage_reservations").get()?.n;
    return releaseLedgerSchema.parse({
      version: 1, baselineSeconds: 1092, reservedSeconds: reserved,
      launches: rows.map(({ reference, ...row }) => ({
        ...row, sessionId: reference ? z.object({ sessionId: z.uuid(), timeoutSeconds: z.number().max(300) })
          .parse(JSON.parse(z.string().parse(reference))).sessionId : null,
      })),
    });
  } finally { db.exec("RELEASE release_ledger"); }
}

export function releaseLedgerDigest(value: ReleaseLedger): string {
  const ledger = releaseLedgerSchema.parse(value);
  return sha256(JSON.stringify({ ...ledger,
    launches: [...ledger.launches].sort((a, b) => a.correlationToken.localeCompare(b.correlationToken)),
  }));
}

/** Reuse the existing provider GET-only adapter without changing its layer07 baseline. */
export function asAdvancedReadback(ledger: ReleaseLedger): AdvancedLedger {
  return advancedLedgerSchema.parse({ ...releaseLedgerSchema.parse(ledger), baselineSeconds: 985 });
}

export function exactReleaseClosure(ledger: ReleaseLedger, sessions: readonly ClosedAdvancedSession[]): boolean {
  if (!releaseLedgerSchema.safeParse(ledger).success ||
    ledger.launches.length === 0 ||
    sessions.length !== ledger.launches.length ||
    new Set(sessions.map((item) => item.correlationToken)).size !== sessions.length ||
    new Set(sessions.map((item) => item.sessionId)).size !== sessions.length) return false;
  return observedPeakConcurrency(sessions) <= 3 && ledger.launches.every((launch) => {
    const remote = sessions.find((item) => item.correlationToken === launch.correlationToken);
    return !!remote && remote.sessionId === launch.sessionId && remote.status === "COMPLETED" &&
      launch.state === "settled" && ["completed", "cancelled"].includes(launch.jobStatus) &&
      Number.isFinite(remote.startedAt) && Number.isFinite(remote.endedAt) && remote.endedAt >= remote.startedAt &&
      remote.actualBrowserSeconds === (remote.endedAt - remote.startedAt) / 1000 &&
      remote.actualBrowserSeconds >= 0 && remote.actualBrowserSeconds <= 300;
  });
}

export async function releaseSourceDigest(): Promise<string> {
  return sha256(`${await advancedSourceDigest()}\0${await readFile("docs/REHEARSAL.md", "utf8")}`);
}

export const releaseApprovalSchema = z.strictObject({
  version: z.literal(1), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
  ledgerDigest: z.string().regex(/^[a-f0-9]{64}$/),
  offlinePassed: z.literal(true), lintPassed: z.literal(true), typecheckPassed: z.literal(true),
  testsPassed: z.literal(true), buildPassed: z.literal(true), reviewPassed: z.literal(true),
  paidAuthorized: z.literal(true), privateMediaReadbackAuthorized: z.literal(true),
  plannedSessions: z.literal(4), reviewedAt: z.int().nonnegative(),
});
export function approvedRelease(value: unknown, sourceDigest: string, packageDigest: string,
  ledgerDigest: string, now = Date.now()): boolean {
  const parsed = releaseApprovalSchema.safeParse(value);
  return parsed.success && parsed.data.sourceDigest === sourceDigest && parsed.data.packageDigest === packageDigest &&
    parsed.data.ledgerDigest === ledgerDigest && parsed.data.reviewedAt <= now &&
    now - parsed.data.reviewedAt < 15 * 60 * 1000;
}

export type PrivateAsset = { file: string; sha256: string; bytes: number; kind: "image" | "video" };
export async function sealReleaseAsset(directory: string, file: string): Promise<void> {
  await assertPrivateDirectory(directory);
  if (!/^[a-z0-9-]+\.(png|webm)$/.test(file)) throw new Error("release_private_asset_name");
  const handle = await open(join(directory, file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) {
      throw new Error("release_private_asset_unsafe");
    }
    await handle.chmod(0o600);
  } finally { await handle.close(); }
}

export async function inventoryReleaseAsset(directory: string, file: string): Promise<PrivateAsset> {
  await assertPrivateDirectory(directory);
  if (!/^[a-z0-9-]+\.(png|webm)$/.test(file)) throw new Error("release_private_asset_name");
  const handle = await open(join(directory, file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
      (process.getuid && info.uid !== process.getuid()) || info.size < 1024) throw new Error("release_private_asset_unsafe");
    const data = await handle.readFile();
    const after = await handle.stat();
    if (data.length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      throw new Error("release_private_asset_changed");
    }
    const video = file.endsWith(".webm");
    const magic = video ? Buffer.from([0x1a, 0x45, 0xdf, 0xa3]) : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (!data.subarray(0, magic.length).equals(magic)) throw new Error("release_private_asset_invalid");
    return { file, sha256: sha256(data), bytes: data.length, kind: video ? "video" : "image" };
  } finally { await handle.close(); }
}

export const releaseInspectionSchema = z.strictObject({
  version: z.literal(1), invocationId: z.uuid(), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  inspectedAt: z.int().nonnegative(), privatePixelsConsented: z.literal(true),
  assets: z.array(z.strictObject({
    file: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    inspected: z.literal(true),
  })).min(1).max(30),
});
export function exactReleaseInspection(value: unknown, inventory: readonly PrivateAsset[],
  invocationId: string, digest: string, capturedAt: number, now = Date.now()): boolean {
  const parsed = releaseInspectionSchema.safeParse(value);
  if (!parsed.success || !inventory.length || !inventory.some((item) => item.kind === "video")) return false;
  const receipt = parsed.data;
  return receipt.invocationId === invocationId && receipt.sourceDigest === digest &&
    receipt.inspectedAt >= capturedAt && receipt.inspectedAt <= now &&
    receipt.assets.length === inventory.length &&
    new Set(receipt.assets.map((item) => item.file)).size === inventory.length &&
    new Set(inventory.map((item) => item.file)).size === inventory.length &&
    inventory.every((item) => receipt.assets.some((entry) => entry.file === item.file && entry.sha256 === item.sha256));
}

export async function assertExactAssetInventory(directory: string, expected: readonly PrivateAsset[]): Promise<void> {
  const files = (await readdir(directory)).filter((file) => /\.(png|webm)$/.test(file)).sort();
  if (!isDeepStrictEqual(files, expected.map((item) => item.file).sort())) throw new Error("release_asset_set_changed");
  for (const asset of expected) {
    if (!isDeepStrictEqual(asset, await inventoryReleaseAsset(directory, asset.file))) throw new Error("release_asset_changed");
  }
}

export function confirmedReleaseDefect(report: RunReport): string | undefined {
  if (report.finality !== "final" || report.agents.length !== 2 ||
    new Set(report.agents.map((agent) => agent.persona.id)).size !== 2 ||
    report.agents.some((agent) => agent.cleanup !== "closed" || agent.launchState !== "settled" ||
      agent.steps < 1 || agent.steps > 20 || agent.modelCalls < 1 || agent.modelCalls > 28)) return;
  const group = report.groups.find((entry) => entry.category === "functional_defect" &&
    entry.title === "Second coupon application throws the verified fixture exception" &&
    entry.page === "https://fixture.flash-flood.invalid/demo/cart" && entry.occurrences.length > 0);
  const occurrence = group?.occurrences.find((item) => report.agents.some((agent) =>
    agent.attemptId === item.attemptId && agent.status === "target_failed" && item.evidenceIds.length > 0 &&
    item.evidenceIds.every((id) => agent.evidence.some((evidence) => evidence.id === id && evidence.state === "available"))));
  return occurrence?.attemptId;
}

export function confirmedReleaseComparison(parent: RunReport, child: RunReport, comparison: RunComparison,
  selected: string, parentAfter: RunReport): boolean {
  const pair = comparison.pairs[0];
  const defect = parent.groups.find((group) => group.category === "functional_defect" &&
    group.occurrences.some((item) => item.attemptId === selected));
  return isDeepStrictEqual(parent, parentAfter) && child.status === "succeeded" && child.finality === "final" &&
    child.agents.length === 1 && child.agents[0].cleanup === "closed" && child.agents[0].modelCalls > 0 &&
    comparison.parentRunId === parent.runId && comparison.childRunId === child.runId &&
    comparison.parentRevision === parent.revision && comparison.childRevision === child.revision &&
    comparison.context === "fresh" && comparison.comparable && comparison.pairs.length === 1 &&
    !!pair && pair.parentAttemptId === selected && pair.childAttemptId === child.agents[0].attemptId &&
    !pair.parentHumanAssisted && !pair.childHumanAssisted && pair.comparable &&
    pair.criteria.length > 0 && pair.criteria.every((criterion) => criterion.tested && criterion.confirmedMet) &&
    !!defect && comparison.groups.some((group) => group.signature === defect.signature &&
      group.category === "functional_defect" && group.state === "confirmed_fixed" && group.after.confirmed === 1);
}

export async function assertReleaseDataIgnored(): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["check-ignore", "--quiet", "data/release-rehearsal/private.webm"], { stdio: "ignore" });
  try {
    const info = await lstat("data");
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("release_unsafe_data_parent");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
