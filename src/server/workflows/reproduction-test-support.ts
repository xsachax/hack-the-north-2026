import { randomUUID } from "node:crypto";
import { personas } from "../../lib/personas";
import type { CouponStep } from "../../lib/reproduction-contracts";
import { FixtureDriver } from "../execution/driver";
import type { BrowserAction, ExecutionEvent, Observation } from "../execution/types";
import type { ReportSource } from "../repository";
import type { LoadedEvidence } from "../reports/aggregate";
import type { ReproductionSource } from "./reproduction-grounding";
import type { prepareCouponFixture } from "./reproduction-runner";

export const couponSteps: CouponStep[] = [
  { kind: "fill_coupon", coupon: "SAVE10" }, { kind: "apply_coupon" },
  { kind: "wait" }, { kind: "fill_coupon", coupon: "COZY5" }, { kind: "apply_coupon" },
];
const timestamp = "2026-09-19T12:00:00.000Z";
const origin = "https://fixture.flash-flood.invalid";

export function sampleCouponEvents(): ExecutionEvent[] {
  const events: ExecutionEvent[] = [];
  const observation: Observation = {
    id: "observation", url: origin + "/demo/cart", title: "Fixture cart", text: "Fixture cart",
    candidates: [
      { id: "c0", kind: "input", label: "Coupon code", inputType: "text" },
      { id: "c1", kind: "button", label: "Apply coupon" },
    ], signals: [], checks: [],
  };
  for (const [index, step] of couponSteps.entries()) {
    events.push({ kind: "observation", actor: "agent", observation: structuredClone(observation) });
    events.push({ kind: "action", actor: "agent", steps: index + 1, action: {
      actor: "agent", action: step.kind === "fill_coupon" ? "type" : step.kind === "apply_coupon" ? "click" : "wait",
      candidateId: step.kind === "fill_coupon" ? "c0" : step.kind === "apply_coupon" ? "c1" : null,
      value: step.kind === "fill_coupon" ? step.coupon : null, commentary: "Recorded fixture action",
    } });
  }
  events.push({ kind: "observation", actor: "agent", observation: {
    ...observation, signals: [{ kind: "functional_failure", message: "FF_DEMO_SECOND_COUPON" }],
  } });
  return events;
}

export function makeReproductionSource(events = sampleCouponEvents()): ReproductionSource {
  const runId = randomUUID(), attemptId = randomUUID();
  const source: ReportSource = {
    run: { id: runId, cursor: 1, status: "target_failed", authorizationAcknowledged: true,
      executionMode: "controlled-fixture", controlledSiteId: "store",
      scope: { targetUrl: origin + "/demo", allowedSubdomains: [], pathPrefixes: ["/demo"] },
      createdAt: timestamp, updatedAt: timestamp, cancelRequestedAt: null },
    attempts: [{ id: attemptId, runId,
      persona: { ...personas[4], quirks: [...personas[4].quirks], worries: [...personas[4].worries] },
      goal: "Apply both fixture coupons", criteria: ["Both advertised coupons apply and the mug total is CA$21.60."],
      status: "target_failed", createdAt: timestamp, updatedAt: timestamp }],
    summaries: [{ attemptId, status: "target_failed", launchState: "settled",
      summary: { steps: couponSteps.length, modelCalls: 0, durationMs: 1000, checks: [], cleanup: { status: "closed" } }, usage: null,
      reservedSeconds: 15, consumedSeconds: 5, releasedSeconds: 10 }],
    results: [], events: [], evidence: [], sequence: 1,
  };
  const evidence: LoadedEvidence[] = [];
  for (const event of events) {
    if (event.kind !== "action" && event.kind !== "observation") continue;
    const item: LoadedEvidence = {
      metadata: { id: randomUUID(), runId, attemptId, kind: "observation", createdAt: timestamp, summary: "Fixture evidence" },
      storageKey: randomUUID().replaceAll("-", "").repeat(2), state: "available", data: event,
    };
    evidence.push(item);
    source.evidence.push({ metadata: item.metadata, storageKey: item.storageKey });
    source.events.push({ runId, attemptId, sequence: source.events.length + 1, timestamp,
      kind: event.kind === "action" ? "attempt.action" : "attempt.observation",
      data: { actor: "agent", evidenceId: item.metadata.id, pageUrl: origin + "/demo/cart",
        ...(event.kind === "action" ? { action: event.action.action, step: event.steps } : {}) },
    });
  }
  source.sequence = source.events.length + 1;
  return { source, evidence, humanActions: false };
}

/** Real driver observations/actions, used by browser acceptance; not a mock replay. */
export async function recordCouponSource(fixture: Awaited<ReturnType<typeof prepareCouponFixture>>): Promise<ReproductionSource> {
  const reference = () => ({ key: randomUUID().replaceAll("-", "").repeat(2), kind: "json" as const, bytes: 1, sha256: "a".repeat(64) });
  const driver = new FixtureDriver({
    page: fixture.page, artifacts: { screenshot: async () => reference(), json: async () => reference(), telemetry: async () => reference() },
    close: async () => ({ status: "closed", errors: [] }), networkErrors: [],
  });
  const signal = AbortSignal.timeout(20_000);
  const events: ExecutionEvent[] = [];
  for (const [index, step] of couponSteps.entries()) {
    const observation = await driver.observe(signal);
    events.push({ kind: "observation", actor: "agent", observation });
    const candidate = observation.candidates.find((candidate) => candidate.label ===
      (step.kind === "fill_coupon" ? "Coupon code" : "Apply coupon"));
    const action: BrowserAction = {
      actor: "agent", action: step.kind === "fill_coupon" ? "type" : step.kind === "apply_coupon" ? "click" : "wait",
      candidateId: step.kind === "wait" ? null : candidate?.id ?? null,
      value: step.kind === "fill_coupon" ? step.coupon : null, commentary: "Recorded fixture action",
    };
    await driver.act(action, signal);
    events.push({ kind: "action", actor: "agent", action, steps: index + 1 });
  }
  const final = await driver.observe(signal);
  events.push({ kind: "observation", actor: "agent", observation: final });
  await driver.close();
  if (!final.signals.some((signal) => signal.kind === "functional_failure" && signal.message === "FF_DEMO_SECOND_COUPON")) {
    throw new Error("Actual driver did not capture the required failure");
  }
  return makeReproductionSource(events);
}
