import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createRunSchema } from "../src/lib/contracts";
import { isLegacyCriterion } from "../src/lib/criteria";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../src/lib/public-execution";
import { nativeResourceSchema } from "../src/server/execution/native-resources";
import { publicExecutionPolicy } from "../src/server/execution/public-policy";
import { workerPolicySchema } from "../src/server/worker/config";
import { assertPaidDataNotRestored } from "../src/server/deployment/database";
import { assertReleaseBuild, releaseSourceDigest } from "../src/server/deployment/build";
import { buildComposedExtension } from "../src/server/execution/composed-extension";
import { assertPrivateDirectory, readPrivateJson, writePrivateJson } from "./advanced-proof";
import { publicHarnessDigest } from "./public-proof-source";

export const PUBLIC_PROOF_LIFETIME_SECONDS = 1800;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const publicProofHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const parseJson = (value: unknown): unknown => JSON.parse(z.string().parse(value));

export const publicProofRequestSchema = createRunSchema.refine((value) =>
  value.executionPolicy === PUBLIC_EXECUTION_POLICY && value.assetPolicy === PUBLIC_ASSET_POLICY &&
  value.assignments.length <= 2 && value.assignments.every((assignment) => !assignment.criteria.some(isLegacyCriterion) &&
    assignment.criteria.some((criterion) => typeof criterion !== "string" && criterion.kind !== "semantic")),
"Public proof requires explicit policies, one or two fresh personas and at least one structural criterion per persona");

export const publicProofPolicySchema = workerPolicySchema.refine((value) =>
  value.globalConcurrency <= 2 && value.ownerConcurrency <= 2 && value.sessionSeconds > 80 &&
  value.lifetimeReservationLimitSeconds === PUBLIC_PROOF_LIFETIME_SECONDS,
"Public proof requires concurrency <=2, TTL >80 and <=300, and the shared 1800-second lifetime cap");

const launchSchema = z.strictObject({
  jobId: z.uuid(), runId: z.uuid(), correlationToken: z.uuid(),
  sessionId: z.uuid().nullable(), state: z.string(),
  reservedSeconds: z.int().min(0).max(300), consumedSeconds: z.int().nonnegative(),
  releasedSeconds: z.int().nonnegative(),
  allocationAttempted: z.boolean().nullable(), actualBrowserSeconds: z.number().finite().nonnegative().nullable(),
  resource: nativeResourceSchema.nullable(),
});
export type PublicProofLaunch = z.infer<typeof launchSchema>;

/** This reader never creates, migrates, resets or refunds the authoritative ledger. */
export function readPublicProofLedger(db: DatabaseSync) {
  db.exec("SAVEPOINT public_proof_snapshot");
  try {
    const policy = publicProofPolicySchema.parse(parseJson(db.prepare(
      "SELECT configuration FROM worker_policy WHERE singleton=1").get()?.configuration));
    const launches = db.prepare(`SELECT j.id jobId,j.run_id runId,l.correlation_token correlationToken,
      l.session_reference reference,l.state,u.reserved_seconds reservedSeconds,
      u.consumed_seconds consumedSeconds,u.released_seconds releasedSeconds,n.resource,r.execution_mode mode,l.usage
      FROM launches l JOIN jobs j ON j.id=l.job_id JOIN runs r ON r.id=j.run_id
      JOIN usage_reservations u ON u.job_id=j.id LEFT JOIN native_resources n ON n.job_id=j.id
      ORDER BY l.correlation_token`).all().map(({ reference, resource, mode, usage, ...row }) => {
      if (mode !== "website") throw new Error("public_proof_requires_dedicated_existing_ledger");
      const native = resource ? nativeResourceSchema.parse(parseJson(resource)) : null;
      const sessionId = reference ? z.object({ sessionId: z.uuid() }).parse(parseJson(reference)).sessionId
        : native?.sessionId ?? null;
      if (native?.sessionId && native.sessionId !== sessionId) throw new Error("public_proof_session_identity_conflict");
      const recorded = usage ? z.object({ allocationAttempted: z.boolean().optional(),
        actualBrowserSeconds: z.number().finite().nonnegative().optional() }).parse(parseJson(usage)) : {};
      return launchSchema.parse({ ...row, sessionId, resource: native,
        allocationAttempted: recorded.allocationAttempted ?? null, actualBrowserSeconds: recorded.actualBrowserSeconds ?? null });
    });
    const reservations = db.prepare("SELECT job_id,reserved_seconds,consumed_seconds,released_seconds FROM usage_reservations ORDER BY job_id").all();
    const reservedSeconds = reservations.reduce((sum, row) => sum + z.int().nonnegative().parse(row.reserved_seconds), 0);
    const committedSeconds = reservations.reduce((sum, row) => sum + Math.max(
      z.int().nonnegative().parse(row.reserved_seconds) - z.int().nonnegative().parse(row.released_seconds),
      z.int().nonnegative().parse(row.consumed_seconds)), 0);
    if (reservedSeconds > PUBLIC_PROOF_LIFETIME_SECONDS || reservedSeconds !== launches.reduce((sum, row) => sum + row.reservedSeconds, 0)) {
      throw new Error("public_proof_reservation_mismatch");
    }
    const unfinished = z.int().parse(db.prepare("SELECT count(*) n FROM jobs WHERE status IN ('queued','leased')").get()?.n);
    const resourceEvents = db.prepare("SELECT sequence,job_id,resource FROM native_resource_events ORDER BY sequence").all();
    const resources = db.prepare("SELECT job_id,extension_id,resource FROM native_resources ORDER BY job_id").all();
    const jobs = db.prepare("SELECT id,run_id,status,lease_generation,cancel_requested_at FROM jobs ORDER BY id").all();
    const rawLaunches = db.prepare("SELECT * FROM launches ORDER BY job_id").all();
    const remoteUsage = db.prepare(`SELECT job_id,session_id,charged_seconds,actual_seconds,terminal
      FROM remote_usage_observations ORDER BY job_id,session_id`).all().map((row) => z.strictObject({
        job_id: z.uuid(), session_id: z.uuid(), charged_seconds: z.number().finite().nonnegative(),
        actual_seconds: z.number().finite().nonnegative().nullable(), terminal: z.union([z.literal(0), z.literal(1)]),
      }).parse(row));
    const fingerprint = publicProofHash({ policy, reservations, jobs, launches: rawLaunches, resources, resourceEvents, remoteUsage });
    return { policy, launches, reservedSeconds, committedSeconds, unfinished, fingerprint, resourceEvents, remoteUsage };
  } finally { db.exec("RELEASE public_proof_snapshot"); }
}

export type PublicProofLedger = ReturnType<typeof readPublicProofLedger>;
export function assertPublicProofSettled(ledger: PublicProofLedger) {
  if (ledger.unfinished || ledger.launches.some((launch) => {
    const resource = launch.resource;
    if (launch.state !== "settled") return true;
    if (!resource) return launch.allocationAttempted !== false || launch.actualBrowserSeconds !== 0 ||
      launch.sessionId !== null || launch.consumedSeconds !== 0 || launch.releasedSeconds !== launch.reservedSeconds;
    return Boolean(
      !["not_dispatched", "deleted"].includes(resource.state) ||
      resource.sessionAllocationAttempted !== !!launch.sessionId ||
      resource.state === "deleted" && !resource.extensionId ||
      resource.state === "not_dispatched" && (resource.extensionId || resource.sessionAllocationAttempted));
  })) throw new Error("public_proof_prior_resources_unsettled");
  for (const event of ledger.resourceEvents) {
    const resource = nativeResourceSchema.parse(parseJson(event.resource));
    const launch = ledger.launches.find((item) => item.jobId === event.job_id);
    if (!launch?.resource || resource.extensionId && resource.extensionId !== launch.resource.extensionId ||
      resource.sessionId && resource.sessionId !== launch.sessionId) throw new Error("public_proof_discovery_unreconciled");
  }
  for (const observation of ledger.remoteUsage) {
    const launch = ledger.launches.find((item) => item.jobId === observation.job_id);
    if (!launch?.sessionId || observation.session_id !== launch.sessionId || observation.terminal !== 1) {
      throw new Error("public_proof_recovered_sessions_unreconciled");
    }
  }
}

export async function openPublicProofLedger(directory: string) {
  const absolute = resolve(directory);
  await assertPrivateDirectory(absolute);
  const path = join(absolute, "flash-flood.sqlite");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o077 ||
    process.getuid && stat.uid !== process.getuid()) throw new Error("public_existing_private_ledger_required");
  assertPaidDataNotRestored(absolute, true);
  return new DatabaseSync(path, { readOnly: true });
}

export async function publicLedgerPreflight(directory: string) {
  const db = await openPublicProofLedger(directory);
  try {
    const ledger = readPublicProofLedger(db);
    let localResourcesSettled = true;
    try { assertPublicProofSettled(ledger); }
    catch (error) {
      if (!(error instanceof Error) || ![
        "public_proof_prior_resources_unsettled", "public_proof_discovery_unreconciled",
        "public_proof_recovered_sessions_unreconciled",
      ].includes(error.message)) throw error;
      localResourcesSettled = false;
    }
    return {
      phase: "public-ledger-preflight", providerCalls: 0, modelCalls: 0, ledgerDigest: ledger.fingerprint,
      reservedSeconds: ledger.reservedSeconds, remainingReservationSeconds: PUBLIC_PROOF_LIFETIME_SECONDS - ledger.reservedSeconds,
      committedSeconds: ledger.committedSeconds, launches: ledger.launches.length, unfinishedJobs: ledger.unfinished,
      localResourcesSettled, independentRemoteClosureVerified: false,
    };
  } finally { db.close(); }
}

export const publicProofPlanSchema = z.strictObject({
  version: z.literal(1), dataDir: z.string().min(1), packageDir: z.string().min(1),
  request: publicProofRequestSchema, sourceDigest: digest, packageDigest: digest, harnessDigest: digest,
  harnessPackageDigest: digest,
  archiveDigest: digest, ledgerDigest: digest, policy: publicProofPolicySchema,
  reservedBefore: z.int().min(0).max(PUBLIC_PROOF_LIFETIME_SECONDS),
  plannedReservations: z.int().min(81).max(600),
  projectId: z.uuid(), createdAt: z.int().nonnegative(),
}).refine((plan) => plan.plannedReservations === plan.request.assignments.length * plan.policy.sessionSeconds &&
  plan.reservedBefore + plan.plannedReservations <= PUBLIC_PROOF_LIFETIME_SECONDS, "Public lifetime budget exceeded");
export type PublicProofPlan = z.infer<typeof publicProofPlanSchema>;

export async function preparePublicProof(inputPath: string, outputPath: string) {
  const input = z.strictObject({
    dataDir: z.string().min(1), packageDir: z.string().min(1), projectId: z.uuid(), request: publicProofRequestSchema,
  }).parse(await readPrivateJson(resolve(inputPath), 65536));
  const packageDir = resolve(input.packageDir);
  if (packageDir === process.cwd()) throw new Error("public_clean_package_required");
  await assertPrivateDirectory(packageDir);
  // Pure syntax/scope policy only. Preparing a plan never resolves a public host.
  publicExecutionPolicy({ ...input.request, executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY });
  const sourceDigest = await releaseSourceDigest();
  if (sourceDigest !== await releaseSourceDigest(packageDir)) throw new Error("public_package_source_mismatch");
  const db = await openPublicProofLedger(input.dataDir);
  try {
    const ledger = readPublicProofLedger(db);
    assertPublicProofSettled(ledger);
    const plannedReservations = input.request.assignments.length * ledger.policy.sessionSeconds;
    if (ledger.committedSeconds + ledger.policy.baselineSeconds + plannedReservations > ledger.policy.developmentBudgetSeconds ||
      plannedReservations > ledger.policy.ownerBudgetSeconds) throw new Error("public_proof_operating_budget_exceeded");
    const bundle = await buildComposedExtension();
    const plan = publicProofPlanSchema.parse({
      version: 1, dataDir: resolve(input.dataDir), packageDir, request: input.request, projectId: input.projectId,
      sourceDigest, packageDigest: await assertReleaseBuild(packageDir), harnessDigest: await publicHarnessDigest(),
      harnessPackageDigest: await assertReleaseBuild(),
      archiveDigest: bundle.sha256, ledgerDigest: ledger.fingerprint, policy: ledger.policy,
      reservedBefore: ledger.reservedSeconds, plannedReservations,
      createdAt: Date.now(),
    });
    await writePrivateJson(resolve(outputPath), plan);
    return { phase: "public-plan", planDigest: publicProofHash(plan), providerCalls: 0, modelCalls: 0,
      reservedBefore: plan.reservedBefore, plannedReservations: plan.plannedReservations,
      remainingAfterPlan: PUBLIC_PROOF_LIFETIME_SECONDS - plan.reservedBefore - plan.plannedReservations };
  } finally { db.close(); }
}

export const publicProofApprovalSchema = z.strictObject({
  version: z.literal(1), planDigest: digest, approvedAt: z.int().nonnegative(), expiresAt: z.int().nonnegative(),
  explicitUserApproval: z.literal(true), authorizedTarget: z.literal(true),
  authoritativeLedgerConfirmed: z.literal(true), providerReadsUploadsAllocationsAndInference: z.literal(true),
  privateEvidenceCapture: z.literal(true),
});

export function assertPublicProofApproval(value: unknown, plan: PublicProofPlan, now = Date.now()) {
  const approval = publicProofApprovalSchema.parse(value);
  if (approval.planDigest !== publicProofHash(publicProofPlanSchema.parse(plan)) ||
    approval.approvedAt < plan.createdAt || approval.approvedAt > now || approval.expiresAt <= now ||
    approval.expiresAt - approval.approvedAt > 15 * 60 * 1000) throw new Error("public_fresh_digest_bound_approval_required");
}
