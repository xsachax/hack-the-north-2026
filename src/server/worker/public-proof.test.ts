import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Browserbase from "@browserbasehq/sdk";
import { WorkerRepository } from "./repository";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../../lib/public-execution";
import { personas } from "../../lib/personas";
import {
  assertPublicProofApproval, assertPublicProofSettled, assertNativeOnlyProofInventory, openPublicProofLedger, publicProofHash,
  publicProofPlanSchema, publicProofPolicySchema, publicProofRequestSchema, readPublicProofLedger, publicLedgerPreflight,
} from "../../../scripts/public-proof";
import { runPublicGoal, verifyPublicProofClosure } from "../../../scripts/public-goal";
import { releaseRuntimeEnvironment } from "../../../scripts/release-runtime";

vi.mock("server-only", () => ({}));
vi.mock("../public-execution-readiness", () => ({ PUBLIC_EXECUTION_IMPLEMENTATION_READY: false }));
const request = publicProofRequestSchema.parse({
  authorizationAcknowledged: true as const, executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY,
  scope: { targetUrl: "https://example.com/docs", allowedSubdomains: [], pathPrefixes: ["/docs"] },
  assignments: [{ personaId: personas[0].id, goal: "Follow the visible guide link and read the guide",
    criteria: [{ id: "guide", kind: "visible_text" as const, text: "Guide", match: "exact" as const,
      description: "The guide heading is visible", semantics: "current" as const }] }],
});
const policy = publicProofPolicySchema.parse({
  globalConcurrency: 1, ownerConcurrency: 1, sessionSeconds: 300, baselineSeconds: 1346,
  developmentBudgetSeconds: 3146, ownerBudgetSeconds: 1800, lifetimeReservationLimitSeconds: 1800,
});
let directory: string;
let repository: WorkerRepository;
let db: DatabaseSync;
beforeEach(() => {
  mkdirSync("data/public-proof-tests", { recursive: true, mode: 0o700 });
  directory = mkdtempSync(resolve("data/public-proof-tests/run-"));
  repository = new WorkerRepository(directory, policy);
  db = new DatabaseSync(join(directory, "flash-flood.sqlite"));
});
afterEach(() => {
  db.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks();
});
function insertSettled() {
  const owner = repository.createSession().ownerId;
  const run = repository.createRun(owner, randomUUID(), request).run;
  const jobId = String(db.prepare("SELECT id FROM jobs WHERE run_id=?").get(run.id)!.id);
  const correlationToken = randomUUID(), sessionId = randomUUID(), extensionId = randomUUID();
  db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(jobId);
  db.prepare("INSERT INTO launches(job_id,correlation_token,state,session_reference,created_at) VALUES(?,?,'settled',?,?)")
    .run(jobId, correlationToken, JSON.stringify({ sessionId }), new Date().toISOString());
  db.prepare("UPDATE usage_reservations SET reserved_seconds=300,consumed_seconds=10,released_seconds=290 WHERE job_id=?").run(jobId);
  db.prepare("INSERT INTO native_resources(job_id,extension_id,resource,updated_at) VALUES(?,?,?,?)").run(
    jobId, extensionId, JSON.stringify({ version: 1, state: "deleted", archiveSha256: "a".repeat(64),
      sessionAllocationAttempted: true, sessionId, extensionId }), new Date().toISOString());
  return { jobId, correlationToken, sessionId, extensionId };
}

describe("bounded public proof planning and existing ledger", () => {
  it("does not let the native-only harness omit managed work from its approved inventory", async () => {
    expect(() => assertNativeOnlyProofInventory(db)).not.toThrow();
    const owner = repository.createSession().ownerId;
    repository.managed.create(owner, randomUUID(), {
      executionPolicy: "browserbase-managed-v1", authorizationAcknowledged: true, managedPolicyAcknowledged: true,
      scope: request.scope, assignments: [{ personaId: personas[0].id, goal: "Read guide", criteria: ["Guide visible"] }],
    }, repository.listPersonas(owner));
    expect(() => assertNativeOnlyProofInventory(db)).toThrow("public_proof_mixed_ledger_requires_managed_harness");
    await expect(publicLedgerPreflight(directory)).rejects.toThrow("public_proof_mixed_ledger_requires_managed_harness");
  });

  it("does not create a missing authoritative ledger", async () => {
    await expect(openPublicProofLedger(join(directory, "missing"))).rejects.toThrow();
    const readOnly = await openPublicProofLedger(directory);
    try { expect(() => readOnly.exec("DELETE FROM worker_policy")).toThrow(); }
    finally { readOnly.close(); }
  });

  it("counts failed/refunded lifetime reservations without renewing them", () => {
    for (let index = 0; index < 6; index++) insertSettled();
    const ledger = readPublicProofLedger(db);
    expect(ledger.reservedSeconds).toBe(1800);
    expect(ledger.committedSeconds).toBe(60);
    assertPublicProofSettled(ledger);
    expect(() => publicProofPlanSchema.parse({
      version: 1, dataDir: directory, packageDir: "/private/package", projectId: randomUUID(),
      request, policy, createdAt: Date.now(), sourceDigest: "a".repeat(64), packageDigest: "b".repeat(64),
      harnessDigest: "c".repeat(64), archiveDigest: "d".repeat(64), ledgerDigest: ledger.fingerprint,
      harnessPackageDigest: "f".repeat(64),
      reservedBefore: ledger.reservedSeconds, plannedReservations: 300,
    })).toThrow();
  });

  it("binds resource discovery and reservation state, not only successful sessions", () => {
    const launch = insertSettled();
    const before = readPublicProofLedger(db);
    db.prepare("INSERT INTO native_resource_events(job_id,resource,created_at) VALUES(?,?,?)").run(
      launch.jobId, JSON.stringify({ version: 1, state: "quarantined", archiveSha256: "a".repeat(64),
        sessionAllocationAttempted: true, sessionId: randomUUID(), extensionId: launch.extensionId }), new Date().toISOString());
    const after = readPublicProofLedger(db);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(() => assertPublicProofSettled(after)).toThrow("discovery_unreconciled");
  });

  it("blocks unsettled jobs and unknown native allocations", () => {
    const owner = repository.createSession().ownerId;
    repository.createRun(owner, randomUUID(), request);
    expect(() => assertPublicProofSettled(readPublicProofLedger(db))).toThrow("prior_resources_unsettled");
  });

  it("permits explicit pre-start non-allocation without a native row while retaining its lifetime reservation", async () => {
    const launch = insertSettled();
    db.prepare("DELETE FROM native_resources WHERE job_id=?").run(launch.jobId);
    db.prepare("UPDATE launches SET session_reference=NULL,usage=? WHERE job_id=?")
      .run(JSON.stringify({ allocationAttempted: false, actualBrowserSeconds: 0 }), launch.jobId);
    db.prepare("UPDATE usage_reservations SET consumed_seconds=0,released_seconds=300 WHERE job_id=?").run(launch.jobId);
    const ledger = readPublicProofLedger(db);
    expect(ledger.reservedSeconds).toBe(300);
    expect(ledger.committedSeconds).toBe(0);
    const provider = { sessions: { retrieve: vi.fn() }, extensions: { retrieve: vi.fn() } };
    expect(await verifyPublicProofClosure(provider, randomUUID(), ledger)).toEqual([]);
    expect(provider.sessions.retrieve).not.toHaveBeenCalled();
    expect(provider.extensions.retrieve).not.toHaveBeenCalled();
    db.prepare("UPDATE launches SET usage='{}' WHERE job_id=?").run(launch.jobId);
    expect(() => assertPublicProofSettled(readPublicProofLedger(db))).toThrow("prior_resources_unsettled");
  });

  it("reports unresolved local ledger status without publishing identities or claiming provider closure", async () => {
    const owner = repository.createSession().ownerId;
    const run = repository.createRun(owner, randomUUID(), request).run;
    const before = readPublicProofLedger(db).fingerprint;
    const result = await publicLedgerPreflight(directory);
    expect(result).toMatchObject({ providerCalls: 0, modelCalls: 0, ledgerDigest: before,
      remainingReservationSeconds: 1800, unfinishedJobs: 1, localResourcesSettled: false,
      independentRemoteClosureVerified: false });
    expect(JSON.stringify(result)).not.toContain(owner);
    expect(JSON.stringify(result)).not.toContain(run.id);
    expect(readPublicProofLedger(db).fingerprint).toBe(before);
  });

  it("fingerprints all recovered usage and rejects extra session identities before provider reads", async () => {
    const launch = insertSettled();
    const before = readPublicProofLedger(db);
    db.prepare("INSERT INTO remote_usage_observations VALUES(?,?,?,?,?)")
      .run(launch.jobId, launch.sessionId, 10, 10, 1);
    const one = readPublicProofLedger(db);
    expect(one.fingerprint).not.toBe(before.fingerprint);
    assertPublicProofSettled(one);
    db.prepare("INSERT INTO remote_usage_observations VALUES(?,?,?,?,?)")
      .run(launch.jobId, randomUUID(), 10, 10, 1);
    const two = readPublicProofLedger(db);
    expect(two.fingerprint).not.toBe(one.fingerprint);
    const provider = { sessions: { retrieve: vi.fn() }, extensions: { retrieve: vi.fn() } };
    expect(() => assertPublicProofSettled(two)).toThrow("recovered_sessions_unreconciled");
    await expect(verifyPublicProofClosure(provider, randomUUID(), two)).rejects.toThrow("recovered_sessions_unreconciled");
    expect(provider.sessions.retrieve).not.toHaveBeenCalled();
    expect(provider.extensions.retrieve).not.toHaveBeenCalled();
  });

  it.each([3, 8])("keeps proof concurrency below product maximum (%s rejected)", (globalConcurrency) => {
    expect(publicProofPolicySchema.safeParse({ ...policy, globalConcurrency }).success).toBe(false);
  });

  it("permits at most two proof assignments even when the product allows eight", () => {
    expect(publicProofRequestSchema.safeParse({ ...request, assignments: Array.from({ length: 3 }, (_, index) =>
      ({ ...request.assignments[0], personaId: `person-${index}` })) }).success).toBe(false);
    expect(publicProofRequestSchema.safeParse({ ...request, executionPolicy: undefined, assetPolicy: undefined }).success).toBe(false);
    expect(publicProofRequestSchema.safeParse({ ...request, assignments: [{
      ...request.assignments[0], criteria: [{ id: "model-only", kind: "semantic",
        description: "Model thinks the goal is complete", semantics: "current" }],
    }] }).success).toBe(false);
  });

  it("requires fresh approval bound to exact plan, target, ledger and artifact digests", () => {
    const now = Date.now();
    const plan = publicProofPlanSchema.parse({
      version: 1, dataDir: directory, packageDir: "/private/package", projectId: randomUUID(),
      request, policy, createdAt: now - 1000, sourceDigest: "a".repeat(64), packageDigest: "b".repeat(64),
      harnessDigest: "c".repeat(64), archiveDigest: "d".repeat(64), ledgerDigest: "e".repeat(64),
      harnessPackageDigest: "1".repeat(64),
      reservedBefore: 0, plannedReservations: 300,
    });
    const approval = {
      version: 1, planDigest: publicProofHash(plan), approvedAt: now - 500, expiresAt: now + 1000,
      explicitUserApproval: true, authorizedTarget: true, authoritativeLedgerConfirmed: true,
      providerReadsUploadsAllocationsAndInference: true, privateEvidenceCapture: true,
    };
    expect(() => assertPublicProofApproval(approval, plan, now)).not.toThrow();
    for (const change of [
      { expiresAt: now }, { approvedAt: now + 1 }, { expiresAt: now + 900001 },
      { explicitUserApproval: false }, { planDigest: "f".repeat(64) },
    ]) expect(() => assertPublicProofApproval({ ...approval, ...change }, plan, now)).toThrow();
    for (const key of ["sourceDigest", "packageDigest", "harnessDigest", "harnessPackageDigest", "archiveDigest", "ledgerDigest"] as const) {
      expect(() => assertPublicProofApproval(approval, { ...plan, [key]: "f".repeat(64) }, now)).toThrow();
    }
  });

  it("keeps a disabled source gate closed even with files and environment flags supplied", async () => {
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider_access_forbidden"));
    await expect(runPublicGoal("not-read.json", "not-read.json", new AbortController().signal)).rejects.toThrow("public_checkpoint_disabled");
    expect(outbound).not.toHaveBeenCalled();
  });

  it("uses Browserbase-only, public-only packaged worker config with exact ledger policy and no unrelated credentials", () => {
    const env = releaseRuntimeEnvironment({
      dataDir: directory, accessCode: "a".repeat(64), paid: true,
      provider: { apiKey: "offline-key", projectId: randomUUID(), replayOrigins: "" },
    }, policy, true);
    expect(env).toMatchObject({
      ENABLE_DEMO_RUNS: "false", ENABLE_PUBLIC_RUNS: "true", DEPLOYMENT_CONFIRM_PAID: "true",
      MAX_CONCURRENT_SESSIONS: "1", MAX_OWNER_SESSIONS: "1", SESSION_TIMEOUT_SECONDS: "300",
      LIFETIME_RESERVATION_LIMIT_SECONDS: "1800", BROWSERBASE_API_KEY: "offline-key",
      EXTERNAL_BASELINE_SECONDS: "1346",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe("independent Browserbase acceptance reads", () => {
  it("requires exact remote COMPLETED and exact authenticated extension 404 without mutations or retries", async () => {
    const launch = insertSettled();
    const projectId = randomUUID(), endedAt = new Date(Date.now() - 1000).toISOString();
    const startedAt = new Date(Date.parse(endedAt) - 10000).toISOString();
    const remote = { id: launch.sessionId, projectId, status: "COMPLETED" as const, startedAt, endedAt,
      userMetadata: { correlationToken: launch.correlationToken } };
    const retrieve = vi.fn(async () => remote);
    const extension = vi.fn(async () => { throw new Browserbase.NotFoundError(404, {}, "", {}); });
    const provider = { sessions: { retrieve }, extensions: { retrieve: extension } };
    const ledger = readPublicProofLedger(db);
    expect(await verifyPublicProofClosure(provider, projectId, ledger)).toEqual([{
      sessionId: launch.sessionId, actualBrowserSeconds: 10, startedAt, endedAt,
    }]);
    expect(retrieve).toHaveBeenCalledExactlyOnceWith(launch.sessionId);
    expect(extension).toHaveBeenCalledExactlyOnceWith(launch.extensionId);
    retrieve.mockResolvedValueOnce({ ...remote, projectId: randomUUID() });
    await expect(verifyPublicProofClosure(provider, projectId, ledger)).rejects.toThrow("independent_closure_unconfirmed");
    extension.mockImplementationOnce(async () => { throw new Error("timeout"); });
    await expect(verifyPublicProofClosure(provider, projectId, ledger)).rejects.toThrow("extension_readback_failed");
    const controller = new AbortController();
    retrieve.mockImplementationOnce(async () => { controller.abort(); return remote; });
    extension.mockClear();
    await expect(verifyPublicProofClosure(provider, projectId, ledger, controller.signal)).rejects.toThrow();
    expect(extension).not.toHaveBeenCalled();
  });
});
