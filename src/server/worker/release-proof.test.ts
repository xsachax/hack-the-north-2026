import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerRepository } from "./repository";
import { DurableWorker } from "./runtime";
import type { ExecutionResult } from "../execution/types";
import { runReportSchema } from "../../lib/report-contracts";
import { runComparisonSchema } from "../../lib/rerun-contracts";
import { releaseAssignments, releaseCleanup, withReleaseLock, main } from "../../../scripts/release-integration";
import {
  approvedRelease, assertReleasePolicy, canReserveRelease, exactReleaseClosure, exactReleaseInspection,
  inventoryReleaseAsset, parseReleaseArgs, readReleaseLedger, releaseLedgerDigest, releaseLedgerSchema,
  releasePlan, releasePolicy, sealReleaseAsset, sha256, confirmedReleaseDefect, confirmedReleaseComparison, type ReleaseLedger,
} from "../../../scripts/release-proof";

let directory: string;
let repository: WorkerRepository;
let db: DatabaseSync;
let owner: string;
beforeEach(async () => {
  directory = resolve("data", `release-test-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  repository = new WorkerRepository(directory, releasePolicy);
  db = new DatabaseSync(join(directory, "flash-flood.sqlite"));
  owner = repository.createSession().ownerId;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  db.close(); repository.close();
  await rm(directory, { recursive: true, force: true });
});
const admit = (count = 1) => repository.createDemoRun(owner, randomUUID(), {
  authorizationAcknowledged: true, scenario: "second-coupon", assignments: releaseAssignments.slice(0, count),
}).run;
const failed: ExecutionResult = {
  status: "infrastructure_failed", reason: "offline fault injection", checks: [], steps: 0,
  modelCalls: 0, durationMs: 0, cleanup: { status: "closed", errors: [] }, errors: [],
  originalTerminal: { status: "infrastructure_failed", reason: "offline fault injection" },
};

describe("release allocation boundaries (offline, never live acceptance)", () => {
  it("requires explicit modes and package selection before loading credentials; never supports resume", async () => {
    vi.stubEnv("RELEASE_PACKAGE_DIR", undefined);
    expect(parseReleaseArgs(["--offline-preflight"])).toBe("offline");
    for (const args of [[], ["--resume", randomUUID()], ["--confirm-paid", "--offline-preflight"]]) {
      expect(() => parseReleaseArgs(args)).toThrow();
    }
    await expect(main(["--confirm-paid"])).rejects.toThrow("release_packaged_runner");
    expect(releasePlan.reduce((sum, phase) => sum + phase.attempts, 0)).toBe(4);
  });

  it("uses baseline1092, cap3600, max3, TTL300 and denies policy drift", () => {
    expect(() => assertReleasePolicy(db)).not.toThrow();
    expect(releasePolicy).toMatchObject({ baselineSeconds: 1092, lifetimeReservationLimitSeconds: 3600,
      sessionSeconds: 300, globalConcurrency: 3, ownerConcurrency: 3 });
    db.prepare("UPDATE worker_policy SET configuration=?").run(JSON.stringify({ ...releasePolicy, sessionSeconds: 301 }));
    expect(() => assertReleasePolicy(db)).toThrow();
    expect(canReserveRelease(2400, 4)).toBe(true);
    expect(canReserveRelease(2700, 4)).toBe(false);
    for (const value of [-300, 1, 3600, Infinity, NaN]) expect(canReserveRelease(value)).toBe(false);
  });

  it("queues/cancels through the normal repository without allocating or reserving", () => {
    const run = admit(2);
    expect(readReleaseLedger(db).reservedSeconds).toBe(0);
    repository.cancelRun(owner, run.id);
    expect(repository.claim("offline-boundary")).toBeNull();
    expect(readReleaseLedger(db).launches).toEqual([]);
  });

  it("the actual normal worker sees a durable reservation before its launch boundary", async () => {
    admit();
    const claim = repository.claim("offline-boundary")!;
    let invoked = 0;
    const worker = new DurableWorker(repository, {
      launch: async (options) => {
        invoked++;
        const ledger = readReleaseLedger(db);
        expect(ledger.reservedSeconds).toBe(300);
        expect(ledger.launches).toHaveLength(1);
        expect(ledger.launches[0]).toMatchObject({ correlationToken: options.correlationToken, state: "intent" });
        throw new Error("offline allocator fault; no network");
      },
      recover: async () => ({ confirmed: false, sessions: [] }),
      artifacts: () => ({
        screenshot: async () => { throw new Error("unexpected"); },
        json: async () => { throw new Error("unexpected"); },
        telemetry: async () => { throw new Error("unexpected"); },
      }),
      diagnostic: () => {},
    }, 1);
    await worker.executeClaim(claim, new AbortController().signal);
    expect(invoked).toBe(1);
    expect(readReleaseLedger(db).reservedSeconds).toBe(300);
    expect(repository.claim("offline-boundary")).toBeNull();
  });

  it("counts all twelve failed/refunded attempts forever and denies a thirteenth", () => {
    for (let index = 0; index < 12; index++) {
      admit();
      const claim = repository.claim("offline-boundary")!;
      expect(claim).not.toBeNull();
      repository.finish(claim, failed, { reservedSeconds: 300, elapsedSeconds: 0, allocationAttempted: false });
    }
    const ledger = readReleaseLedger(db);
    expect(ledger.reservedSeconds).toBe(3600);
    expect(ledger.launches).toHaveLength(12);
    expect(ledger.launches.every((item) => item.releasedSeconds === 300)).toBe(true);
    admit();
    expect(repository.claim("offline-boundary")).toBeNull();
    expect(readReleaseLedger(db).reservedSeconds).toBe(3600);
  });

  it("shares the cap and concurrent slots across independent owners and connections", () => {
    admit(2);
    const otherOwner = repository.createSession().ownerId;
    repository.createDemoRun(otherOwner, randomUUID(), {
      authorizationAcknowledged: true, scenario: "fixed", assignments: releaseAssignments,
    });
    const second = new WorkerRepository(directory, releasePolicy);
    try {
      expect(repository.claim("one")).not.toBeNull();
      expect(second.claim("two")).not.toBeNull();
      expect(repository.claim("three")).not.toBeNull();
      expect(second.claim("four")).toBeNull();
      expect(readReleaseLedger(db).reservedSeconds).toBe(900);
    } finally { second.close(); }
  });

  it("detects an unjoined reservation rather than hiding it from the cumulative ledger", () => {
    admit();
    db.exec("UPDATE usage_reservations SET reserved_seconds=300");
    expect(() => readReleaseLedger(db)).toThrow();
  });
});

function closedFixture(): { ledger: ReleaseLedger; sessions: {
  correlationToken: string; sessionId: string; status: string; startedAt: number; endedAt: number; actualBrowserSeconds: number;
}[] } {
  const ledger = releaseLedgerSchema.parse({ version: 1, baselineSeconds: 1092, reservedSeconds: 300, launches: [{
    jobId: randomUUID(), runId: randomUUID(), attemptId: randomUUID(), ownerId: randomUUID(), correlationToken: randomUUID(),
    sessionId: randomUUID(), reservedSeconds: 300, consumedSeconds: 10, releasedSeconds: 290, state: "settled",
    jobStatus: "completed", attemptStatus: "target_failed", createdAt: new Date().toISOString(), usage: null,
  }] });
  return { ledger, sessions: [{ correlationToken: ledger.launches[0].correlationToken, sessionId: ledger.launches[0].sessionId!,
    status: "COMPLETED", startedAt: 0, endedAt: 10000, actualBrowserSeconds: 10 }] };
}

describe("release independent closure and private approval", () => {
  it("does not confuse unmet criteria, group disappearance or parent mutation with a confirmed fix", () => {
    const ids = Array.from({ length: 6 }, () => randomUUID());
    const agent = (index: number) => ({
      attemptId: ids[index], persona: { id: `persona-${index}`, name: "Offline test", device: "desktop" },
      goal: "Offline predicate fixture; not paid acceptance", status: "target_failed", finality: "final",
      launchState: "settled", cleanup: "closed", steps: 8, modelCalls: 8, criteria: [], timeline: [],
      evidence: [{ id: ids[5], attemptId: ids[index], kind: "observation",
        createdAt: new Date().toISOString(), state: "available", sensitivity: "redacted_text" }],
      groupSignatures: ["coupon"],
    });
    const report = runReportSchema.parse({
      version: "report-v1", signatureVersion: "finding-v2", runId: ids[2], revision: "parent-revision",
      status: "target_failed", finality: "final", target: "https://fixture.flash-flood.invalid/demo/cart",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), agents: [agent(0), agent(1)], notices: [],
      groups: [{ signature: "coupon", signatureVersion: "finding-v2", category: "functional_defect",
        title: "Second coupon application throws the verified fixture exception", explanation: "offline predicate fixture",
        page: "https://fixture.flash-flood.invalid/demo/cart", element: "Apply coupon", criterionSignature: null,
        occurrences: [{ attemptId: ids[0], personaId: "persona-0", evidenceIds: [ids[5]], step: 8 }],
        counts: { occurrences: 1, affectedAttempts: 1, affectedPersonas: 1, assignedAttempts: 2, assignedPersonas: 2,
          eligibleAttempts: 2, eligiblePersonas: 2, testedAttempts: 2, testedPersonas: 2, notTestedAttempts: 0,
          notTestedPersonas: 0, outOfCohortAttempts: 0 },
      }],
    });
    expect(confirmedReleaseDefect(report)).toBe(ids[0]);
    expect(confirmedReleaseDefect({ ...report, groups: [] })).toBeUndefined();
    expect(confirmedReleaseDefect({ ...report, groups: [{ ...report.groups[0], category: "criterion_unmet" }] })).toBeUndefined();
    const child = runReportSchema.parse({ ...report, runId: ids[3], revision: "child-revision", status: "succeeded",
      agents: [{ ...agent(4), status: "succeeded" }], groups: [] });
    const comparison = runComparisonSchema.parse({
      version: "comparison-v1", reportVersion: "report-v1", signatureVersion: "finding-v2", criterionVersion: "criterion-v1",
      parentRunId: report.runId, childRunId: child.runId, parentRevision: report.revision, childRevision: child.revision,
      parentFinality: "final", childFinality: "final", context: "fresh", comparable: true, notices: [],
      pairs: [{ parentAttemptId: ids[0], childAttemptId: ids[4], comparable: true,
        parentHumanAssisted: false, childHumanAssisted: false,
        criteria: [{ definitionSignature: "coupon-criterion", semantics: "current", before: "not_met", after: "met",
          comparable: true, tested: true, confirmedMet: true }],
      }],
      groups: [{ signature: "coupon", category: "functional_defect", title: "coupon", state: "confirmed_fixed",
        before: { assigned: 1, eligible: 1, tested: 1, notTested: 0, affected: 1, confirmed: 0 },
        after: { assigned: 1, eligible: 1, tested: 1, notTested: 0, affected: 0, confirmed: 1 },
        explanation: "offline predicate fixture",
      }],
    });
    expect(confirmedReleaseComparison(report, child, comparison, ids[0], report)).toBe(true);
    expect(confirmedReleaseComparison(report, child, { ...comparison, groups: [] }, ids[0], report)).toBe(false);
    expect(confirmedReleaseComparison(report, child, { ...comparison, groups: [
      { ...comparison.groups[0], state: "not_observed" },
    ] }, ids[0], report)).toBe(false);
    expect(confirmedReleaseComparison(report, child, comparison, ids[0], { ...report, revision: "changed" })).toBe(false);
  });

  it("requires the exact cumulative set with persisted references and COMPLETED only", () => {
    const { ledger, sessions } = closedFixture();
    expect(exactReleaseClosure(ledger, sessions)).toBe(true);
    expect(exactReleaseClosure({ version: 1, baselineSeconds: 1092, reservedSeconds: 0, launches: [] }, [])).toBe(false);
    for (const status of ["RUNNING", "ERROR", "TIMED_OUT"]) {
      expect(exactReleaseClosure(ledger, [{ ...sessions[0], status }])).toBe(false);
    }
    expect(exactReleaseClosure(ledger, [])).toBe(false);
    expect(exactReleaseClosure(ledger, [...sessions, ...sessions])).toBe(false);
    expect(exactReleaseClosure(ledger, [{ ...sessions[0], sessionId: randomUUID() }])).toBe(false);
    expect(exactReleaseClosure(ledger, [{ ...sessions[0], correlationToken: randomUUID() }])).toBe(false);
    expect(exactReleaseClosure(ledger, [{ ...sessions[0], endedAt: 301000, actualBrowserSeconds: 301 }])).toBe(false);
    expect(exactReleaseClosure({ ...ledger, launches: [{ ...ledger.launches[0], sessionId: null }] }, sessions)).toBe(false);
  });

  it("requires source, package, cumulative ledger and recent explicit parent paid approval", () => {
    const { ledger } = closedFixture();
    const digest = releaseLedgerDigest(ledger);
    const approval = { version: 1, sourceDigest: "a".repeat(64), packageDigest: "b".repeat(64), ledgerDigest: digest,
      offlinePassed: true, lintPassed: true, typecheckPassed: true, testsPassed: true, buildPassed: true,
      reviewPassed: true, paidAuthorized: true, privateMediaReadbackAuthorized: true, plannedSessions: 4, reviewedAt: 1000 };
    expect(approvedRelease(approval, approval.sourceDigest, approval.packageDigest, digest, 1001)).toBe(true);
    for (const change of [{ paidAuthorized: false }, { plannedSessions: 5 }, { sourceDigest: "c".repeat(64) },
      { packageDigest: "c".repeat(64) }, { ledgerDigest: "c".repeat(64) }, { reviewedAt: 1002 }]) {
      expect(approvedRelease({ ...approval, ...change }, approval.sourceDigest, approval.packageDigest, digest, 1001)).toBe(false);
    }
    expect(approvedRelease(approval, approval.sourceDigest, approval.packageDigest, digest, 901000)).toBe(false);
  });

  it("hashes only private regular files and rejects symlinks or public video permissions", async () => {
    const bytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048)]);
    await writeFile(join(directory, "backup.webm"), bytes, { mode: 0o600 });
    const inventory = await inventoryReleaseAsset(directory, "backup.webm");
    expect(inventory).toMatchObject({ sha256: sha256(bytes), kind: "video", bytes: bytes.length });
    await symlink("backup.webm", join(directory, "linked.webm"));
    await expect(inventoryReleaseAsset(directory, "linked.webm")).rejects.toThrow();
    await chmod(join(directory, "backup.webm"), 0o644);
    await expect(inventoryReleaseAsset(directory, "backup.webm")).rejects.toThrow();
    await expect(sealReleaseAsset(directory, "linked.webm")).rejects.toThrow();
    expect((await stat(join(directory, "backup.webm"))).mode & 0o777).toBe(0o644);
    await sealReleaseAsset(directory, "backup.webm");
    expect((await stat(join(directory, "backup.webm"))).mode & 0o777).toBe(0o600);
    await expect(inventoryReleaseAsset(directory, "../backup.webm")).rejects.toThrow();
  });

  it("never manufactures parent image/video consent from inventory or offline results", () => {
    const invocationId = randomUUID(), sourceDigest = "a".repeat(64);
    const inventory = [{ file: "backup.webm", sha256: "b".repeat(64), bytes: 2048, kind: "video" as const }];
    const receipt = { version: 1, invocationId, sourceDigest, inspectedAt: 1100, privatePixelsConsented: true,
      assets: [{ file: "backup.webm", sha256: "b".repeat(64), inspected: true }] };
    expect(exactReleaseInspection(receipt, inventory, invocationId, sourceDigest, 1000, 1200)).toBe(true);
    for (const change of [{ privatePixelsConsented: false }, { inspectedAt: 999 }, { assets: [] },
      { assets: [...receipt.assets, ...receipt.assets] }]) {
      expect(exactReleaseInspection({ ...receipt, ...change }, inventory, invocationId, sourceDigest, 1000, 1200)).toBe(false);
    }
  });
});

describe("release cleanup ownership", () => {
  it("runs every cleanup step after a failure, including worker stop before browser close", async () => {
    const order: string[] = [];
    await expect(releaseCleanup([
      async () => { order.push("cancel"); throw new Error("fault"); },
      async () => { order.push("worker"); },
      async () => { order.push("closure"); throw new Error("fault"); },
      async () => { order.push("browser"); },
      async () => { order.push("owned-processes"); },
    ])).rejects.toThrow("release_owned_cleanup_failed");
    expect(order).toEqual(["cancel", "worker", "closure", "browser", "owned-processes"]);
  });

  it("exclusively owns/removes its lock even on error and never removes somebody else's lock", async () => {
    await expect(withReleaseLock(directory, async () => {
      await expect(withReleaseLock(directory, async () => {})).rejects.toThrow();
      throw new Error("fault");
    })).rejects.toThrow("fault");
    await expect(readFile(join(directory, "integration.lock"))).rejects.toThrow();
    await writeFile(join(directory, "integration.lock"), "other owner", { mode: 0o600 });
    await expect(withReleaseLock(directory, async () => {})).rejects.toThrow();
    expect(await readFile(join(directory, "integration.lock"), "utf8")).toBe("other owner");
  });
});
