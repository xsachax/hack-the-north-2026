import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { personas } from "../../lib/personas";
import { personaSchema, type Status } from "../../lib/contracts";
import { criterionKey, legacyDemoCriteria, type Criterion, type CriterionCheck } from "../../lib/criteria";
import type { ReportSource } from "../repository";
import { aggregateReport, type LoadedEvidence } from "../reports/aggregate";
import { resultSchema } from "../worker/result";
import { compareReports, type ComparisonSource } from "./comparison";

const time = "2026-09-19T12:00:00.000Z";
const cart = "https://fixture.flash-flood.invalid/demo/cart";
const definition: Criterion = {
  kind: "control", id: "apply", label: "Apply coupon", description: "Apply is enabled",
  match: "exact", disabled: false, semantics: "current", paths: ["/demo/cart"],
};
type CheckStatus = NonNullable<CriterionCheck["status"]>;
function fixture(options: {
  status?: Status; check?: CheckStatus; criterion?: Criterion; page?: string | null;
  signal?: string; signalKind?: string; finality?: "settled" | "quarantined" | "recovering" | "active";
  cleanup?: "closed" | "failed"; missing?: boolean;
} = {}): ComparisonSource {
  const runId = randomUUID(), attemptId = randomUUID(), evidenceId = randomUUID();
  const criterion = options.criterion ?? definition;
  const checkStatus = options.check ?? "not_met";
  const status = options.status ?? (checkStatus === "met" ? "succeeded" : "target_failed");
  const check: CriterionCheck = {
    criterion: criterionKey(criterion), passed: checkStatus === "met", status: checkStatus,
    method: typeof criterion === "string" ? "legacy" : "deterministic",
    evidence: `${criterionKey(criterion)} ${checkStatus}`,
  };
  const source: ReportSource = {
    run: { id: runId, cursor: 1, status, authorizationAcknowledged: true, executionMode: "controlled-fixture", controlledSiteId: "store",
      scope: { targetUrl: "https://fixture.flash-flood.invalid/demo", allowedSubdomains: [], pathPrefixes: ["/demo"] },
      createdAt: time, updatedAt: time, cancelRequestedAt: null },
    attempts: [{ id: attemptId, runId, persona: personaSchema.parse(personas[0]), goal: "Apply both coupons",
      criteria: [criterion], status, createdAt: time, updatedAt: time }],
    summaries: [{
      attemptId, status, launchState: options.finality ?? "settled",
      summary: { steps: 2, modelCalls: 2, durationMs: 10, checks: [check], cleanup: { status: options.cleanup ?? "closed" } },
      usage: null, reservedSeconds: 300, consumedSeconds: 1, releasedSeconds: 299,
    }],
    results: [{ attemptId, result: resultSchema.parse({
      status: status === "running" || status === "queued" ? "cancelled" : status, reason: "Persisted result",
      originalTerminal: { status: "target_failed", reason: "Persisted result" },
      checks: [check], steps: 2, modelCalls: 2, durationMs: 10, cleanup: { status: options.cleanup ?? "closed", errors: [] }, errors: [],
    }) }],
    events: [
      { runId, attemptId, sequence: 1, timestamp: time, kind: "attempt.action", data: { actor: "agent", action: "click", step: 2 } },
      { runId, attemptId, sequence: 2, timestamp: time, kind: "attempt.observation",
        data: { actor: "agent", evidenceId, ...(options.page === null ? {} : { pageUrl: options.page ?? cart }) } },
    ],
    evidence: [], sequence: 3,
  };
  const loaded: LoadedEvidence[] = [{
    metadata: { id: evidenceId, runId, attemptId, kind: "observation", createdAt: time, summary: "Persisted observation" },
    storageKey: "a".repeat(64), state: options.missing ? "missing" : "available",
    data: { observation: { id: "observation-2", checks: [check],
      signals: options.signal ? [{ kind: options.signalKind ?? "functional_failure", message: options.signal }] : [] } },
  }];
  source.evidence = loaded.map(({ metadata, storageKey }) => ({ metadata, storageKey }));
  return { source, loaded, report: aggregateReport(source, loaded) };
}
function rebuild(f: ComparisonSource, secrets: string[] = []) {
  f.report = aggregateReport(f.source, f.loaded, secrets);
  return f;
}
function compare(parent: ComparisonSource, child: ComparisonSource) {
  return compareReports(parent, child, [{
    parentAttemptId: parent.source.attempts[0].id, childAttemptId: child.source.attempts[0].id,
  }]);
}
function merge(first: ComparisonSource, second: ComparisonSource): ComparisonSource {
  const runId = first.source.run.id;
  for (const attempt of second.source.attempts) { attempt.runId = runId; attempt.persona = personaSchema.parse(personas[1]); }
  for (const event of second.source.events) { event.runId = runId; event.sequence += first.source.events.length; }
  for (const entry of second.loaded) entry.metadata.runId = runId;
  first.source.attempts.push(...second.source.attempts);
  first.source.summaries.push(...second.source.summaries);
  first.source.results.push(...second.source.results);
  first.source.events.push(...second.source.events);
  first.source.evidence.push(...second.source.evidence);
  first.loaded.push(...second.loaded);
  return rebuild(first);
}

describe("conservative immutable rerun comparison", () => {
  it("requires positive exact-definition/current-page evidence to confirm an unmet criterion", () => {
    const parent = fixture(), child = fixture({ check: "met" });
    const result = compare(parent, child);
    expect(result.comparable).toBe(true);
    expect(result.groups).toEqual([expect.objectContaining({
      category: "criterion_unmet", state: "confirmed_fixed",
      before: { assigned: 1, eligible: 1, tested: 1, notTested: 0, affected: 1, confirmed: 0 },
      after: { assigned: 1, eligible: 1, tested: 1, notTested: 0, affected: 0, confirmed: 1 },
    })]);
    expect(result.pairs[0].criteria[0]).toMatchObject({
      before: "not_met", after: "met", semantics: "current", comparable: true, tested: true, confirmedMet: true,
    });
  });

  it.each(["met", "not_met", "not_observed", "inconclusive", "unsupported"] as const)("preserves criterion status %s", (check) => {
    const result = compare(fixture(), fixture({ check }));
    expect(result.pairs[0].criteria[0].after).toBe(check);
    expect(result.pairs[0].criteria[0].tested).toBe(check === "met" || check === "not_met");
    expect(result.groups[0].state).toBe(check === "met" ? "confirmed_fixed" : check === "not_met" ? "persists" : "not_observed");
  });

  it.each(["cancelled", "infrastructure_failed", "blocked", "running", "queued"] as const)(
    "does not claim fixes from a %s attempt even if a stored criterion says met", (status) => {
      const result = compare(fixture(), fixture({ check: "met", status }));
      expect(result.groups[0]).toMatchObject({ state: "not_observed", after: { tested: 0, notTested: 1, confirmed: 0 } });
      expect(result.pairs[0].criteria[0].confirmedMet).toBe(false);
    },
  );

  it.each(["quarantined", "recovering", "active"] as const)("does not claim fixes while %s", (finality) => {
    expect(compare(fixture(), fixture({ check: "met", finality })).groups[0])
      .toMatchObject({ state: "not_observed", after: { tested: 0, confirmed: 0 } });
  });

  it("does not claim a fix after failed cleanup or missing artifacts", () => {
    for (const child of [fixture({ check: "met", cleanup: "failed" }), fixture({ check: "met", missing: true })]) {
      expect(compare(fixture(), child).groups[0]).toMatchObject({ state: "not_observed", after: { tested: 0, confirmed: 0 } });
    }
  });

  it("does not treat a same-description different assertion, semantics or observation path as the same definition", () => {
    const changes: Criterion[] = [
      { ...definition, disabled: true }, { ...definition, label: "Other coupon" },
      { ...definition, semantics: "milestone" }, { ...definition, paths: ["/demo/checkout"] },
      { ...definition, id: "different" }, { ...definition, description: "Other description" },
    ];
    for (const criterion of changes) {
      const result = compare(fixture(), fixture({ criterion, check: "met" }));
      expect(result.comparable).toBe(false);
      expect(result.groups[0].state).toBe("not_comparable");
      expect(result.pairs[0].criteria[0]).toMatchObject({ after: null, comparable: false, confirmedMet: false });
    }
  });

  it("rejects navigation-scope, goal, persona and limit mismatches", () => {
    const changes = [
      (f: ComparisonSource) => { f.source.run.scope.pathPrefixes.push("/other"); },
      (f: ComparisonSource) => { f.source.run.scope.allowedSubdomains.push("other"); },
      (f: ComparisonSource) => { f.source.run.scope.targetUrl = `${cart}/other`; },
      (f: ComparisonSource) => { f.source.attempts[0].goal = "Different objective"; },
      (f: ComparisonSource) => { f.source.attempts[0].persona.character = "Different persona"; },
      (f: ComparisonSource) => { f.source.attempts[0].limits = { maxSteps: 1 }; },
    ];
    for (const change of changes) {
      const child = fixture({ check: "met" });
      change(child);
      const result = compare(fixture(), rebuild(child));
      expect(result.comparable).toBe(false);
      expect(result.groups[0].state).toBe("not_comparable");
    }
  });

  it("does not confuse known redacted private pages or unknown attempt-specific pages", () => {
    const parent = rebuild(fixture(), ["cart"]);
    const child = rebuild(fixture({ check: "met" }), ["demo"]);
    expect(parent.report.agents[0].criteria[0].citations[0].page).not.toBe(child.report.agents[0].criteria[0].citations[0].page);
    expect(compare(parent, child).groups[0].state).toBe("confirmed_fixed");
    const wrongPage = rebuild(fixture({ check: "met", page: "https://fixture.flash-flood.invalid/demo/checkout" }), ["demo"]);
    expect(compare(parent, wrongPage).groups[0].state).toBe("not_observed");
    const unknownParent = fixture({ page: null }), unknownChild = fixture({ page: null });
    expect(unknownParent.report.groups[0].signature).not.toBe(unknownChild.report.groups[0].signature);
    expect(compare(unknownParent, unknownChild).groups.every((group) => group.state === "not_comparable")).toBe(true);
  });

  it("preserves milestone evidence from earlier pages but does not invent current observations", () => {
    const criterion: Criterion = { ...definition, semantics: "milestone" };
    const parent = fixture({ criterion }), child = fixture({ criterion, check: "met" });
    child.source.events.push({
      runId: child.source.run.id, attemptId: child.source.attempts[0].id, sequence: 3, timestamp: time,
      kind: "attempt.action", data: { actor: "agent", action: "navigate", step: 3, pageUrl: "https://fixture.flash-flood.invalid/demo/complete" },
    });
    const result = compare(parent, rebuild(child));
    expect(result.pairs[0].criteria[0]).toMatchObject({ semantics: "milestone", confirmedMet: true });
    expect(result.groups[0].state).toBe("confirmed_fixed");
  });

  it("uses the trusted exact store coupon oracle, never mere group disappearance, to confirm the functional fix", () => {
    const parent = fixture({ criterion: legacyDemoCriteria[0], signal: "FF_DEMO_SECOND_COUPON" });
    const child = fixture({ criterion: legacyDemoCriteria[0], check: "met" });
    expect(compare(parent, child).groups.find((group) => group.category === "functional_defect"))
      .toMatchObject({ state: "confirmed_fixed", after: { confirmed: 1 } });
    expect(compare(parent, fixture({ criterion: legacyDemoCriteria[0], check: "not_observed" })).groups.find((group) => group.category === "functional_defect"))
      .toMatchObject({ state: "not_observed", after: { tested: 1, confirmed: 0 } });
    const withoutOracle = compare(fixture({ signal: "FF_DEMO_SECOND_COUPON" }), fixture({ check: "met" }));
    expect(withoutOracle.groups.find((group) => group.category === "criterion_unmet")?.state).toBe("confirmed_fixed");
    expect(withoutOracle.groups.find((group) => group.category === "functional_defect")?.state).toBe("not_observed");
  });

  it("does not relabel absent diagnostic or subjective signals as repaired defects", () => {
    const parent = fixture({ signal: "HTTP_500", signalKind: "http" });
    const result = compare(parent, fixture({ check: "met" }));
    expect(result.groups.find((group) => group.category === "diagnostic_signal"))
      .toMatchObject({ state: "not_observed", after: { confirmed: 0 } });
  });

  it("compares known performance/subjective identities without turning absent telemetry or changed preferences into fixes", () => {
    const performance = () => {
      const f = fixture({ check: "met" });
      f.loaded.push({
        ...f.loaded[0], metadata: { ...f.loaded[0].metadata, id: randomUUID() },
        data: { telemetry: [{ kind: "slow_request", code: "SLOW_REQUEST", durationMs: 1500,
          url: "https://fixture.flash-flood.invalid/private-request", actionId: "action-2", timestamp: time }] },
      });
      return rebuild(f);
    };
    expect(compare(performance(), performance()).groups.find((group) => group.category === "performance_signal"))
      .toMatchObject({ state: "persists", before: { tested: 1 }, after: { tested: 1, confirmed: 0 } });
    expect(compare(performance(), fixture({ check: "met" })).groups.find((group) => group.category === "performance_signal"))
      .toMatchObject({ state: "not_observed", after: { tested: 0, confirmed: 0 } });
    const subjective = () => {
      const f = fixture({ status: "gave_up" });
      f.source.events.push({
        runId: f.source.run.id, attemptId: f.source.attempts[0].id, sequence: 3, timestamp: time,
        kind: "attempt.decision", data: { actor: "agent", action: "give_up", evidenceId: f.loaded[0].metadata.id,
          pageUrl: "https://fixture.flash-flood.invalid/demo/checkout" },
      });
      return rebuild(f);
    };
    expect(compare(subjective(), subjective()).groups.find((group) => group.category === "subjective_friction")?.state).toBe("persists");
    expect(compare(subjective(), fixture({ check: "met" })).groups.find((group) => group.category === "subjective_friction")?.state).toBe("not_observed");
  });

  it("keeps eligible/tested/not-tested denominators and never generalizes one confirmation over an untested cohort", () => {
    const parent = merge(fixture(), fixture());
    const child = merge(fixture({ check: "met" }), fixture({ check: "unsupported" }));
    const lineage = parent.source.attempts.map((attempt, index) => ({
      parentAttemptId: attempt.id, childAttemptId: child.source.attempts[index].id,
    }));
    const result = compareReports(parent, child, lineage);
    expect(result.groups[0]).toMatchObject({
      state: "not_observed",
      before: { assigned: 2, eligible: 2, tested: 2, notTested: 0, affected: 2 },
      after: { assigned: 2, eligible: 2, tested: 1, notTested: 1, affected: 0, confirmed: 1 },
    });
    const subset = compareReports(parent, child, lineage.slice(0, 1));
    expect(subset.groups[0]).toMatchObject({
      state: "confirmed_fixed", before: { assigned: 1, eligible: 1, affected: 1 },
      after: { assigned: 1, eligible: 1, tested: 1, confirmed: 1 },
    });
  });

  it("does not silently compare legacy finding versions", () => {
    const parent = fixture(), child = fixture({ check: "met" });
    Object.assign(parent.report, { signatureVersion: "finding-v1" });
    expect(compare(parent, child)).toMatchObject({ comparable: false, groups: [{ state: "not_comparable" }] });
  });

  it.each(["parent", "child"] as const)("labels %s human intervention and never claims an agent-only fix", (side) => {
    const parent = fixture(), child = fixture({ check: "met" });
    const assisted = side === "parent" ? parent : child;
    assisted.source.humanAssistedAttemptIds = [assisted.source.attempts[0].id];
    const result = compare(parent, child);
    expect(result.comparable).toBe(false);
    expect(result.pairs[0]).toMatchObject({
      parentHumanAssisted: side === "parent", childHumanAssisted: side === "child",
      comparable: false, criteria: [{ confirmedMet: false, tested: false }],
    });
    expect(result.groups[0]).toMatchObject({
      state: "not_comparable", after: { eligible: 1, tested: 0, notTested: 1, confirmed: 0 },
    });
    expect(result.groups[0].explanation).toContain("human intervention");
  });

  it("returns signatures, statuses and redacted presentation only, never original page context or artifact keys", () => {
    const parent = rebuild(fixture(), ["Apply coupon", "demo"]), child = rebuild(fixture({ check: "met" }), ["Apply coupon", "demo"]);
    const serialized = JSON.stringify(compare(parent, child));
    expect(serialized).not.toContain(cart);
    expect(serialized).not.toContain("a".repeat(64));
    expect(serialized).not.toContain("Apply coupon");
    expect(serialized).toContain("criterion-v1");
  });
});
