import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactWriter } from "../execution/artifacts";
import type { ExecutionResult } from "../execution/types";
import { demoCriteria } from "../../lib/demo-run";
import { sampleCouponEvents } from "../workflows/reproduction-test-support";
import { REPRODUCTION_SIGNATURE, type CandidateResult } from "../workflows/reproduction-runner";
import { WorkerRepository, type Claim } from "./repository";

let directory: string, now: number, repository: WorkerRepository, owner: string;
let connections: WorkerRepository[];
const policy = { sessionSeconds: 120, lifetimeReservationLimitSeconds: 480 };
const result: ExecutionResult = {
  status: "target_failed", reason: "Trusted fixture failure", originalTerminal: { status: "target_failed", reason: "Trusted fixture failure" },
  checks: [], steps: 5, modelCalls: 0, durationMs: 100,
  cleanup: { status: "closed", errors: [] }, errors: [],
};
function bind(claim: Claim) {
  const id = randomUUID();
  repository.sessionReference(claim, {
    sessionId: id, liveViewUrl: "https://www.browserbase.com/offline",
    replayUrl: "https://www.browserbase.com/offline-recording", timeoutSeconds: policy.sessionSeconds,
  });
  return id;
}
function settle(claim: Claim, candidate?: CandidateResult) {
  repository.finish(claim, result, {
    allocationAttempted: true, reservedSeconds: policy.sessionSeconds, elapsedSeconds: 1,
    remoteStatus: "COMPLETED", actualBrowserSeconds: 1,
  }, candidate);
}
async function prepare(maxSteps?: number, narrowScope = false) {
  const input = {
    authorizationAcknowledged: true as const,
    assignments: [{
      personaId: "careful-first-timer", goal: "Apply both coupons", criteria: [demoCriteria[0]],
      ...(maxSteps === undefined ? {} : { limits: { maxSteps } }),
    }],
  };
  const run = narrowScope ? repository.createControlledRun(owner, randomUUID(), {
    ...input, controlledSiteId: "store", scope: { targetPath: "/demo/cart", pathPrefixes: ["/demo/cart"] },
  }).run : repository.createDemoRun(owner, randomUUID(), { ...input, scenario: "second-coupon" }).run;
  const claim = repository.claim("source-worker")!;
  bind(claim);
  const writer = new ArtifactWriter({ dataDir: directory });
  const sinks = writer.createSinks(claim.runId, claim.attempt.id);
  for (const event of sampleCouponEvents()) {
    if (event.kind !== "action" && event.kind !== "observation") continue;
    const artifact = await sinks.json(event);
    const evidenceId = repository.recordArtifact(claim, artifact, "observation");
    repository.recordStep(claim, event.kind, evidenceId, {
      pageUrl: "https://fixture.flash-flood.invalid/demo/cart",
      ...(event.kind === "action" ? { step: event.steps, action: event.action.action } : {}),
    });
  }
  settle(claim);
  const reproduction = repository.reproductionService().prepare(owner, run.id, claim.attempt.id);
  expect(reproduction.status).toBe(narrowScope ? "unsupported" : "queued");
  return { run, claim, reproduction };
}
beforeEach(() => {
  directory = mkdtempSync(join(process.cwd(), ".advanced-worker-test-"));
  now = Date.now();
  repository = new WorkerRepository(directory, policy, () => now);
  connections = [repository];
  owner = repository.createSession().ownerId;
});
afterEach(() => {
  for (const connection of connections) connection.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("production reproduction outbox and worker accounting", () => {
  it("rejects scopes excluding deterministic setup before browser reservation or allocation", async () => {
    const { reproduction } = await prepare(undefined, true);
    repository.pumpReproductions();
    expect(repository.claim("scoped-worker")).toBeNull();
    expect(repository.accounting().reservedSeconds).toBe(120);
    expect(repository.reproductionService().status(owner, reproduction.id)).toMatchObject({
      status: "unsupported", reason: "unsupported_target", candidatesAttempted: 0, reservedSecondsCharged: 0,
    });
  });

  it("rejects setup plus replay beyond inherited step limits before browser reservation or allocation", async () => {
    const { reproduction } = await prepare(5);
    repository.pumpReproductions();
    expect(repository.claim("bounded-worker")).toBeNull();
    expect(repository.accounting().reservedSeconds).toBe(120);
    expect(repository.reproductionService().status(owner, reproduction.id)).toMatchObject({
      status: "limit_reached", reason: "budget_exhausted", candidatesAttempted: 1, reservedSecondsCharged: 120,
    });
    repository.pumpReproductions();
    expect(repository.claim("no-replacement")).toBeNull();
    expect(repository.reproductionService().status(owner, reproduction.id).candidatesAttempted).toBe(1);
  });

  it("enqueues exactly one immutable fresh child across connections and reserves before claim", async () => {
    const { run, claim: source, reproduction } = await prepare();
    const second = new WorkerRepository(directory, policy, () => now);
    connections.push(second);
    repository.pumpReproductions();
    second.pumpReproductions();
    expect(repository.listRuns(owner, { after: 0, limit: 100 }).items).toHaveLength(2);
    expect(repository.accounting().reservedSeconds).toBe(120);
    const candidate = repository.claim("candidate-worker")!;
    expect(candidate.reproductionCandidateId).toBeDefined();
    expect(second.claim("other-worker")).toBeNull();
    expect(repository.accounting().reservedSeconds).toBe(240);
    expect(candidate.scope).toEqual(run.scope);
    expect(candidate.attempt).toMatchObject({ persona: source.attempt.persona, goal: source.attempt.goal, criteria: source.attempt.criteria });
    expect(candidate.attempt.browserState).toBeUndefined();
    expect(repository.contexts.list(owner)).toEqual([]);
    expect(repository.reproductionDispatch(candidate)).toMatchObject({
      reservationSeconds: 120, signature: REPRODUCTION_SIGNATURE,
    });
    expect(repository.reproductionService().status(owner, reproduction.id)).toMatchObject({
      candidatesAttempted: 1, reservedSecondsCharged: 120, modelCalls: 0,
    });
    bind(candidate);
    expect(() => repository.takeovers.command(owner, candidate.attempt.id, randomUUID(), {
      action: "request", expectedVersion: 0, controllerId: randomUUID(),
    })).toThrow("conflict");
    expect(repository.takeovers.status(owner, candidate.attempt.id).phase).toBe("closed");
  });

  it("persists exact candidate outcome with settlement and resumes completion without replaying a browser", async () => {
    const { reproduction } = await prepare();
    repository.pumpReproductions();
    const candidate = repository.claim("candidate-worker")!;
    const sessionIdentity = bind(candidate);
    settle(candidate, {
      outcome: "reproduced", signature: REPRODUCTION_SIGNATURE,
      cleanup: "confirmed", environment: "trusted_fixture", sessionIdentity,
    });
    const second = new WorkerRepository(directory, policy, () => now);
    connections.push(second);
    second.pumpReproductions();
    second.pumpReproductions();
    expect(second.reproductionService().status(owner, reproduction.id)).toMatchObject({
      shortestSteps: 5, candidatesAttempted: 2, reservedSecondsCharged: 240,
    });
    expect(second.accounting().reservedSeconds).toBe(240);
    const next = second.claim("next-candidate")!;
    expect(next.jobId).not.toBe(candidate.jobId);
    expect(next.reproductionCandidateId).not.toBe(candidate.reproductionCandidateId);
  });

  it("cancellation fences dispatch and heartbeat, wins settlement, and stops new candidates", async () => {
    const { reproduction } = await prepare();
    repository.pumpReproductions();
    const candidate = repository.claim("candidate-worker")!;
    const sessionIdentity = bind(candidate);
    repository.reproductionService().cancel(owner, reproduction.id);
    expect(() => repository.assertLease(candidate)).toThrow("reproduction_stopped");
    expect(repository.heartbeat(candidate)).toBe(true);
    settle(candidate, {
      outcome: "reproduced", signature: REPRODUCTION_SIGNATURE,
      cleanup: "confirmed", environment: "trusted_fixture", sessionIdentity,
    });
    repository.pumpReproductions();
    expect(repository.getRun(owner, candidate.runId).status).toBe("cancelled");
    expect(repository.reproductionService().status(owner, reproduction.id)).toMatchObject({ status: "cancelled", candidatesAttempted: 1 });
    expect(repository.claim("no-more")).toBeNull();
  });

  it("unknown cleanup retains the real worker slot and stops reduction despite an exact failure", async () => {
    const { reproduction } = await prepare();
    repository.pumpReproductions();
    const candidate = repository.claim("candidate-worker")!;
    const sessionIdentity = bind(candidate);
    repository.finish(candidate, result, {
      allocationAttempted: true, reservedSeconds: 120, elapsedSeconds: 1, remoteStatus: "RUNNING",
    }, {
      outcome: "reproduced", signature: REPRODUCTION_SIGNATURE,
      cleanup: "confirmed", environment: "trusted_fixture", sessionIdentity,
    });
    repository.pumpReproductions();
    expect(repository.reproductionService().status(owner, reproduction.id)).toMatchObject({
      status: "unknown_cleanup", candidatesAttempted: 1, reservedSecondsCharged: 120, exportAvailable: false,
    });
    expect(repository.accounting()).toMatchObject({ reservedSeconds: 240, releasedSeconds: 119 });
  });

  it("expired outbox is never replayed and has no refund or silent replacement", async () => {
    const { reproduction } = await prepare();
    repository.pumpReproductions();
    const pending = repository.reproductionService().pendingCandidates()[0];
    expect(pending.deadline - now).toBe(repository.policy.sessionSeconds * 1000 + 5000);
    expect(pending.maxDurationMs).toBe(60_000);
    now = pending.deadline + 1;
    repository.pumpReproductions();
    expect(repository.claim("late-worker")).toBeNull();
    expect(repository.reproductionService().status(owner, reproduction.id)).toMatchObject({
      status: "unknown_cleanup", candidatesAttempted: 1, reservedSecondsCharged: 120,
    });
    expect(repository.accounting().reservedSeconds).toBe(120);
  });

  it("worker lifetime exhaustion stops visibly without allocating or refunding candidate allowance", async () => {
    const { reproduction } = await prepare();
    repository.pumpReproductions();
    // Spend the remaining policy ceiling on other ordinary durable launches.
    for (let i = 0; i < 2; i++) {
      repository.createDemoRun(owner, randomUUID(), {
        authorizationAcknowledged: true, scenario: "fixed",
        assignments: [{ personaId: "careful-first-timer", goal: "Inspect", criteria: [demoCriteria[0]] }],
      });
    }
    const candidate = repository.claim("first-candidate")!;
    const sessionIdentity = bind(candidate);
    settle(candidate, { outcome: "reproduced", signature: REPRODUCTION_SIGNATURE, cleanup: "confirmed", environment: "trusted_fixture", sessionIdentity });
    for (let i = 0; i < 2; i++) {
      const ordinary = repository.claim(`ordinary-${i}`)!;
      bind(ordinary); settle(ordinary);
    }
    repository.pumpReproductions();
    expect(repository.claim("over-cap")).toBeNull();
    expect(repository.reproductionService().status(owner, reproduction.id)).toMatchObject({
      status: "limit_reached", reason: "budget_exhausted", candidatesAttempted: 2,
      reservedSecondsCharged: 240, shortestSteps: 5, exportAvailable: true,
    });
    expect(repository.accounting().reservedSeconds).toBe(480);
  });
});
