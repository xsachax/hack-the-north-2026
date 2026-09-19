import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Criterion } from "../../lib/criteria";
import type { Status } from "../../lib/contracts";
import { personas } from "../../lib/personas";
import type { ReportSource } from "../repository";
import { aggregateReport, criterionSignature, type LoadedEvidence } from "./aggregate";
import { exportReport } from "./exports";
import { executePersona } from "../execution/loop";
import { deterministicCheck } from "../execution/evaluator";
import { sanitizeEvidence } from "../execution/artifacts";
import { resultSchema } from "../worker/result";
import type { Observation } from "../execution/types";

const timestamp = "2026-09-19T12:00:00.000Z";
const criterion: Criterion = {
  id: "coupon", kind: "visible_text", description: "Both coupons appear", semantics: "current",
  text: "COZY5", match: "contains", paths: ["/demo/cart"],
};
function fixture(statuses: Status[] = ["target_failed", "succeeded", "blocked"]) {
  const runId = randomUUID();
  const source: ReportSource = {
    run: { id: runId, cursor: 1, status: "target_failed", authorizationAcknowledged: true,
      executionMode: "controlled-fixture", controlledSiteId: "store",
      scope: { targetUrl: "https://fixture.flash-flood.invalid/demo", allowedSubdomains: [], pathPrefixes: ["/demo"] },
      createdAt: timestamp, updatedAt: timestamp, cancelRequestedAt: null },
    attempts: [], summaries: [], results: [], events: [], evidence: [], sequence: 1,
  };
  const loaded: LoadedEvidence[] = [];
  statuses.forEach((status, index) => {
    const attemptId = randomUUID();
    const tested = !["blocked", "cancelled", "infrastructure_failed", "queued", "running"].includes(status);
    source.attempts.push({
      id: attemptId, runId, persona: { ...personas[index], quirks: [...personas[index].quirks], worries: [...personas[index].worries] },
      goal: "Try both coupons", criteria: [criterion], status,
      createdAt: timestamp, updatedAt: timestamp,
    });
    if (!tested) return;
    const evidenceId = randomUUID();
    const screenshotId = randomUUID();
    const screenshotKey = String(index + 1).repeat(64);
    const check = { criterion: "coupon", passed: status === "succeeded",
      status: status === "succeeded" ? "met" as const : "not_met" as const, method: "deterministic" as const,
      evidence: status === "succeeded" ? "COZY5" : "Requested text was not present in the bounded observation" };
    const result = { status, reason: "Bounded test result", originalTerminal: { status, reason: "Bounded test result" },
      checks: [check], steps: 2, modelCalls: 2, durationMs: 10, cleanup: { status: "closed" as const, errors: [] }, errors: [] };
    source.results.push({ attemptId, result: { ...result, status: "target_failed", originalTerminal: { ...result.originalTerminal, status: "target_failed" } } });
    source.summaries.push({
      attemptId, status, launchState: "settled", summary: {
        steps: 2, modelCalls: 2, durationMs: 10, checks: [check], cleanup: { status: "closed" },
      }, usage: null, reservedSeconds: 300, consumedSeconds: 1, releasedSeconds: 299,
    });
    for (const [id, key, kind] of [[screenshotId, screenshotKey, "screenshot"], [evidenceId, String(index + 5).repeat(64), "observation"]] as const) {
      const item: LoadedEvidence = {
        metadata: { id, runId, attemptId, kind, createdAt: timestamp, summary: "Agent evidence" },
        storageKey: key, state: "available",
        ...(kind === "observation" ? { data: { kind: "observation", actor: "agent", observation: {
          id: `observation-${index}`, screenshotKey, checks: [check],
          signals: status === "target_failed" ? [{ kind: "functional_failure", message: "FF_DEMO_SECOND_COUPON", evidence: "page-main/action-2" }] : [],
        } } } : {}),
      };
      loaded.push(item);
      source.evidence.push({ metadata: item.metadata, storageKey: item.storageKey });
    }
    source.events.push({
      runId, attemptId, sequence: source.events.length + 1, timestamp,
      kind: "attempt.action", data: { actor: "agent", action: "click", step: 2 },
    }, {
      runId, attemptId, sequence: source.events.length + 2, timestamp,
      kind: "attempt.observation", data: { actor: "agent", evidenceId, pageUrl: "https://fixture.flash-flood.invalid/demo/cart" },
    });
  });
  source.sequence = source.events.length + 1;
  return { source, loaded };
}

function typedAction(f: ReturnType<typeof fixture>, value: string, attemptIndex = 0): LoadedEvidence {
  const item: LoadedEvidence = {
    metadata: { id: randomUUID(), runId: f.source.run.id, attemptId: f.source.attempts[attemptIndex].id,
      kind: "observation", createdAt: timestamp, summary: "Persisted action" },
    storageKey: randomUUID().replaceAll("-", "").repeat(2), state: "available",
    data: { kind: "action", actor: "agent", action: { action: "type", value } },
  };
  f.loaded.push(item);
  f.source.evidence.push({ metadata: item.metadata, storageKey: item.storageKey });
  f.source.events.push({ runId: f.source.run.id, attemptId: item.metadata.attemptId,
    sequence: ++f.source.sequence, timestamp, kind: "attempt.action",
    data: { actor: "agent", action: "type", step: 3, evidenceId: item.metadata.id } });
  return item;
}

describe("evidence-backed report projection", () => {
  it("separates a verified defect from an unmet criterion, with explicit tested and assigned denominators", () => {
    const { source, loaded } = fixture();
    const report = aggregateReport(source, loaded);
    expect(report.groups.map(({ category }) => category).sort()).toEqual(["criterion_unmet", "functional_defect"]);
    for (const group of report.groups) expect(group.counts).toEqual({
      occurrences: 1, affectedAttempts: 1, affectedPersonas: 1,
      assignedAttempts: 3, assignedPersonas: 3, eligibleAttempts: 3, eligiblePersonas: 3,
      testedAttempts: 2, testedPersonas: 2, notTestedAttempts: 1, notTestedPersonas: 1, outOfCohortAttempts: 0,
    });
    expect(report.agents[0].criteria[0]).toMatchObject({
      status: "not_met", method: "structural", confidenceMeaning: "heuristic",
      citations: [{ step: 2, state: "available", evidenceIds: [loaded[1].metadata.id, loaded[0].metadata.id] }],
    });
    expect(report.agents[2].criteria[0]).toMatchObject({ status: "not_observed", citations: [] });
    expect(report.agents[0].evidence[0].sensitivity).toBe("private_pixels");
  });

  it("deduplicates repeated diagnostic signals without confusing occurrence and persona counts", () => {
    const { source, loaded } = fixture(["target_failed", "target_failed"]);
    const original = source.events[1];
    source.events.push({ ...original, sequence: 5 });
    const report = aggregateReport(source, loaded);
    expect(report.groups.find(({ category }) => category === "functional_defect")?.counts).toMatchObject({
      occurrences: 2, affectedAttempts: 2, affectedPersonas: 2, testedAttempts: 2,
    });
    expect(report.groups).toHaveLength(2);
  });

  it.each(["cancelled", "blocked", "infrastructure_failed", "running"] as const)(
    "never turns a %s outcome or its stale success summary into a target finding", (status) => {
      const { source, loaded } = fixture(["target_failed"]);
      source.attempts[0].status = status;
      source.summaries[0].status = status;
      expect(aggregateReport(source, loaded).groups).toEqual([]);
    });

  it("does not call HTTP errors or generic console diagnostics functional defects", () => {
    const { source, loaded } = fixture(["gave_up"]);
    loaded[1].data = { observation: {
      id: "generic", checks: [], signals: [
        { kind: "http", message: "HTTP_ERROR" }, { kind: "console", message: "PAGE_ERROR" },
      ],
    } };
    const report = aggregateReport(source, loaded);
    expect(report.groups).toHaveLength(2);
    expect(report.groups.every(({ category }) => category === "diagnostic_signal")).toBe(true);
  });

  it("keeps signatures stable across run/attempt IDs while separating page, target, element, definition and semantics", () => {
    const first = fixture(["target_failed"]);
    const second = fixture(["target_failed"]);
    const signatures = (f: ReturnType<typeof fixture>) => aggregateReport(f.source, f.loaded).groups.map(({ signature }) => signature);
    expect(signatures(first)).toEqual(signatures(second));
    second.source.run.scope.targetUrl = "https://fixture.flash-flood.invalid/demo/other";
    expect(signatures(first)).not.toEqual(signatures(second));
    const scope = first.source.run.scope;
    expect(criterionSignature(criterion, scope)).not.toBe(criterionSignature({ ...criterion, text: "SAVE10" }, scope));
    expect(criterionSignature(criterion, scope)).not.toBe(criterionSignature({ ...criterion, semantics: "milestone" }, scope));
    expect(criterionSignature(criterion, scope)).not.toBe(criterionSignature({ ...criterion, paths: ["/demo/checkout"] }, scope));
    const control = { id: "control", kind: "control", description: "Control enabled", semantics: "current", label: "Buy", match: "exact", disabled: false } as const;
    expect(criterionSignature(control, scope)).not.toBe(criterionSignature({ ...control, label: "Remove" }, scope));
    second.source.run.scope = scope;
    second.source.events[1].data.pageUrl = "https://fixture.flash-flood.invalid/demo/checkout";
    expect(signatures(first)).not.toEqual(signatures(second));
  });

  it("groups actual cross-attempt control findings identically despite unrelated typed-value redaction", () => {
    const f = fixture(["gave_up", "gave_up"]);
    for (const attempt of f.source.attempts) attempt.criteria = [{
      id: "coupon", kind: "control", description: "Control enabled", semantics: "current",
      label: "Search", match: "exact", disabled: false,
    }];
    const before = aggregateReport(f.source, f.loaded);
    expect(before.groups).toHaveLength(1);
    expect(before.groups[0]).toMatchObject({ element: "Search", counts: { affectedAttempts: 2, testedAttempts: 2 } });
    typedAction(f, "Search", 1);
    const after = aggregateReport(f.source, f.loaded);
    expect(after.signatureVersion).toBe("finding-v2");
    expect(after.groups).toHaveLength(1);
    expect(after.groups[0]).toMatchObject({
      signature: before.groups[0].signature, element: "[REDACTED]",
      counts: { occurrences: 2, affectedAttempts: 2, affectedPersonas: 2, testedAttempts: 2 },
    });
    for (const format of ["json", "markdown"] as const) expect(exportReport(after, format).body).not.toContain("Search");
  });

  it("does not change finding identity when an unrelated action artifact becomes missing", () => {
    const f = fixture(["gave_up"]);
    f.source.attempts[0].criteria = [{
      id: "coupon", kind: "control", description: "Control enabled", semantics: "current",
      label: "Search", match: "exact", disabled: false,
    }];
    const action = typedAction(f, "Search");
    const before = aggregateReport(f.source, f.loaded);
    action.state = "missing";
    delete action.data;
    const after = aggregateReport(f.source, f.loaded);
    expect(after.revision).not.toBe(before.revision);
    expect(after.groups[0].signature).toBe(before.groups[0].signature);
    expect(after.groups[0].counts).toEqual(before.groups[0].counts);
    expect(after.agents[0].evidence.find((item) => item.id === action.metadata.id)?.state).toBe("missing");
  });

  it("keeps page signatures and cohorts distinct when both display paths redact to the same value", () => {
    const f = fixture(["gave_up", "gave_up"]);
    f.source.events[3].data.pageUrl = "https://fixture.flash-flood.invalid/demo/checkout";
    for (const item of f.loaded.filter((entry) => entry.metadata.kind === "observation")) {
      item.data = { observation: { id: item.metadata.id, checks: [], signals: [{ kind: "http", message: "HTTP_ERROR" }] } };
    }
    const before = aggregateReport(f.source, f.loaded);
    typedAction(f, "cart");
    typedAction(f, "checkout", 1);
    const after = aggregateReport(f.source, f.loaded);
    expect(after.groups).toHaveLength(2);
    expect(new Set(after.groups.map((group) => group.page)).size).toBe(1);
    expect(after.groups.map((group) => group.signature)).toEqual(before.groups.map((group) => group.signature));
    for (const group of after.groups) expect(group.counts).toMatchObject({
      affectedAttempts: 1, testedAttempts: 1, notTestedAttempts: 1,
    });
  });

  it("does not turn a privately known page into unknown-attempt identity when its display is hidden", () => {
    const f = fixture(["gave_up", "gave_up"]);
    const before = aggregateReport(f.source, f.loaded);
    const after = aggregateReport(f.source, f.loaded, ["fixture"]);
    expect(after.groups).toHaveLength(1);
    expect(after.groups[0]).toMatchObject({
      signature: before.groups[0].signature, page: null, counts: { affectedAttempts: 2, testedAttempts: 2 },
    });
    expect(JSON.stringify(after)).not.toContain("fixture.flash-flood.invalid");
  });

  it("keeps genuinely unknown pages attempt-specific in both identity and tested denominators", () => {
    const f = fixture(["gave_up", "gave_up"]);
    for (const event of f.source.events) delete event.data.pageUrl;
    const report = aggregateReport(f.source, f.loaded);
    expect(report.groups).toHaveLength(2);
    expect(new Set(report.groups.map((group) => group.signature)).size).toBe(2);
    for (const group of report.groups) expect(group).toMatchObject({
      page: null, counts: { affectedAttempts: 1, testedAttempts: 1, notTestedAttempts: 1 },
    });
  });

  it("excludes different criterion definitions from a criterion cohort instead of inventing a shared denominator", () => {
    const { source, loaded } = fixture(["gave_up", "succeeded", "blocked"]);
    source.attempts[1].criteria = [{ ...criterion, text: "Different" }];
    const group = aggregateReport(source, loaded).groups[0];
    expect(group.counts).toMatchObject({
      assignedAttempts: 3, eligibleAttempts: 2, testedAttempts: 1, notTestedAttempts: 1, outOfCohortAttempts: 1,
    });
  });

  it("preserves exact inconclusive/unsupported statuses and distinguishes a settling summary from final results", () => {
    const { source, loaded } = fixture(["target_failed"]);
    source.results[0].result.checks[0] = {
      criterion: "coupon", passed: false, status: "inconclusive", method: "semantic",
      confidence: 0.6, evidence: "", uncertainty: "Could not determine",
    };
    source.summaries[0].launchState = "quarantined";
    const report = aggregateReport(source, loaded);
    expect(report.finality).toBe("uncertain");
    expect(report.groups).toEqual([]);
    expect(report.agents[0].criteria[0]).toMatchObject({ status: "inconclusive", confidence: 0.6, uncertainty: "Could not determine" });
    source.results[0].result.checks[0].status = "unsupported";
    expect(aggregateReport(source, loaded).agents[0].criteria[0].status).toBe("unsupported");
  });

  it("retains available observation citations while marking a missing screenshot partial", () => {
    const { source, loaded } = fixture(["target_failed"]);
    loaded[0].state = "missing";
    const report = aggregateReport(source, loaded);
    expect(report.agents[0].criteria[0].citations[0].state).toBe("partial");
    loaded[1].state = "missing";
    const missing = aggregateReport(source, loaded);
    expect(missing.agents[0].criteria[0].citations).toEqual([]);
    expect(missing.groups).toEqual([]);
  });

  it("never resolves a screenshot key from another attempt", () => {
    const { source, loaded } = fixture(["succeeded", "succeeded"]);
    source.results[0].result.checks[0].citations = [{
      observationId: "observation-0", pageUrl: "https://fixture.flash-flood.invalid/demo/cart", step: 2,
      excerpt: "COZY5", screenshotKey: loaded[2].storageKey,
    }];
    const report = aggregateReport(source, loaded);
    expect(report.agents[0].criteria[0].citations[0]).toMatchObject({
      state: "partial", evidenceIds: [loaded[1].metadata.id],
    });
    expect(JSON.stringify(report.agents[0])).not.toContain(loaded[2].metadata.id);
  });

  it("redacts typed values, secrets and signed URLs without hiding stable comparison IDs", async () => {
    const { source, loaded } = fixture(["target_failed"]);
    loaded.push({ ...loaded[1], metadata: { ...loaded[1].metadata, id: randomUUID() },
      data: { kind: "action", action: { action: "type", value: "sensitive-customer-value" } } });
    source.attempts[0].goal = "sensitive-customer-value password=hunter2 https://signed.example/video?token=bad <script>bad</script> [x](javascript:alert(1))";
    const report = aggregateReport(source, loaded);
    const exported = exportReport(report, "json");
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    expect(exported.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await exported.text();
    for (const secret of ["sensitive-customer-value", "hunter2", "signed.example", loaded[0].storageKey]) expect(body).not.toContain(secret);
    expect(body).toContain(report.groups[0].signature);
    const markdown = await exportReport(report, "markdown").text();
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("[x](javascript:");
    expect(markdown).toContain("&lt;script&gt;");
  });

  it("makes no accessibility judgments and produces repeatable revisions for immutable inputs", () => {
    const { source, loaded } = fixture();
    const report = aggregateReport(source, loaded);
    expect(aggregateReport(source, loaded)).toEqual(report);
    expect(report.groups.some(({ category }) => category === "accessibility_observation")).toBe(false);
    loaded[0].state = "missing";
    expect(aggregateReport(source, loaded).revision).not.toBe(report.revision);
  });

  it("keeps a semantic milestone's earlier grounded citation instead of relabelling the latest unrelated page", () => {
    const { source, loaded } = fixture(["succeeded"]);
    source.attempts[0].criteria = [{ id: "coupon", kind: "semantic", description: "Coupons are applied", semantics: "milestone" }];
    source.results[0].result.checks[0] = {
      criterion: "coupon", passed: true, status: "met", method: "semantic", confidence: 0.8, confidenceMeaning: "heuristic",
      evidence: "COZY5", citations: [{ observationId: "observation-0", pageUrl: "https://fixture.flash-flood.invalid/demo/cart",
        step: 2, excerpt: "COZY5", screenshotKey: loaded[0].storageKey }],
    };
    source.events.push({ runId: source.run.id, attemptId: source.attempts[0].id, sequence: 3, timestamp,
      kind: "attempt.action", data: { action: "navigate", step: 3, pageUrl: "https://fixture.flash-flood.invalid/demo/complete" } });
    const check = aggregateReport(source, loaded).agents[0].criteria[0];
    expect(check).toMatchObject({
      status: "met", method: "semantic", semantics: "milestone", confidence: 0.8,
      citations: [{ step: 2, page: "https://fixture.flash-flood.invalid/demo/cart", state: "available" }],
    });
  });

  it("reports genuine slow-request telemetry separately and ignores unmeasured speed claims", () => {
    const { source, loaded } = fixture(["succeeded"]);
    const id = randomUUID();
    loaded.push({ ...loaded[1], metadata: { ...loaded[1].metadata, id, kind: "console" }, storageKey: "e".repeat(64),
      data: { telemetry: [
        { kind: "slow_request", code: "SLOW_REQUEST", url: "https://fixture.flash-flood.invalid/demo/cart",
          actionId: "action-2", timestamp, durationMs: 1400 },
        { kind: "slow_request", code: "SLOW_REQUEST", url: "https://fixture.flash-flood.invalid/demo/cart",
          actionId: "action-2", timestamp, durationMs: 1400 },
        { kind: "slow_request", code: "SLOW_REQUEST", url: "https://fixture.flash-flood.invalid/demo/cart",
          actionId: "action-3", timestamp, durationMs: 999 },
        { kind: "slow_request", code: "SLOW_REQUEST", url: "https://fixture.flash-flood.invalid/demo/cart",
          actionId: "action-4", timestamp, durationMs: "slow" },
      ] } });
    const report = aggregateReport(source, loaded);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]).toMatchObject({ category: "performance_signal",
      counts: { occurrences: 1, affectedAttempts: 1 }, occurrences: [{ evidenceIds: [id] }] });
    typedAction({ source, loaded }, "cart");
    const redacted = aggregateReport(source, loaded);
    expect(redacted.groups[0].signature).toBe(report.groups[0].signature);
    expect(redacted.groups[0].page).not.toBe(report.groups[0].page);
  });

  it("labels a persona's recorded give-up as subjective, not a functional bug", () => {
    const { source, loaded } = fixture(["gave_up"]);
    const id = randomUUID();
    loaded.push({ ...loaded[1], metadata: { ...loaded[1].metadata, id }, data: { decision: { action: "give_up" } } });
    source.events.push({ runId: source.run.id, attemptId: source.attempts[0].id, timestamp, sequence: 3,
      kind: "attempt.decision", data: { actor: "agent", action: "give_up", evidenceId: id,
        commentary: "I am confused", pageUrl: "https://fixture.flash-flood.invalid/demo/cart" } });
    const report = aggregateReport(source, loaded);
    expect(report.groups.map(({ category }) => category).sort()).toEqual(["criterion_unmet", "subjective_friction"]);
    typedAction({ source, loaded }, "cart");
    const redacted = aggregateReport(source, loaded);
    expect(redacted.groups.map((group) => group.signature)).toEqual(report.groups.map((group) => group.signature));
    expect(redacted.groups.every((group) => group.page !== "https://fixture.flash-flood.invalid/demo/cart")).toBe(true);
  });

  it("retains actual loop semantic/structural citations after the writer's URL sanitization", async () => {
    const { source, loaded } = fixture(["succeeded"]);
    const semantic: Criterion = { id: "semantic-coupon", kind: "semantic", description: "Coupon appears", semantics: "current" };
    source.attempts[0].criteria = [criterion, semantic];
    const observation: Observation = {
      id: "d".repeat(64), url: "https://fixture.flash-flood.invalid/demo/cart", title: "Cart",
      text: "COZY5", textBlocks: ["COZY5"], candidates: [], screenshotKey: loaded[0].storageKey,
      checks: [], signals: [{ kind: "console", message: "PAGE_ERROR" }],
    };
    const result = await executePersona({
      persona: source.attempts[0].persona, goal: "Verify coupon", criteria: [criterion, semantic],
    }, {
      driver: { observe: async () => observation, act: async () => { throw new Error("unexpected action"); },
        close: async () => ({ status: "closed", errors: [] }) },
      brain: {
        decide: async () => { throw new Error("unexpected decision"); },
        evaluate: async () => [{
          criterion: "semantic-coupon", passed: true, status: "met", method: "semantic", evidence: "COZY5", confidence: 0.7,
          citations: [{ observationId: observation.id, pageUrl: observation.url, step: 0, excerpt: "COZY5", screenshotKey: observation.screenshotKey }],
        }],
      },
      onEvent: async (event) => {
        if (event.kind === "observation") loaded[1].data = sanitizeEvidence(event);
      },
    });
    expect(result.status).toBe("succeeded");
    expect(JSON.stringify(loaded[1].data)).toContain('"pageUrl":"[REDACTED_URL]"');
    source.results[0].result = resultSchema.parse(result);
    source.events = [{ ...source.events[1], sequence: 1 }];
    const report = aggregateReport(source, loaded);
    expect(report.agents[0].criteria.map((check) => ({ status: check.status, citations: check.citations.length }))).toEqual([
      { status: "met", citations: 1 }, { status: "met", citations: 1 },
    ]);
    for (const check of report.agents[0].criteria) expect(check.citations[0]).toMatchObject({
      state: "available", step: 0, observationId: observation.id, page: observation.url, evidenceIds: [loaded[1].metadata.id, loaded[0].metadata.id],
    });
    expect(report.groups[0]).toMatchObject({ category: "diagnostic_signal", counts: { testedAttempts: 1 } });
  });

  it("reports actual pre-observation loop placeholders as not_observed, not evaluated failures", async () => {
    const { source } = fixture(["succeeded"]);
    const result = await executePersona({
      persona: source.attempts[0].persona, goal: "Observe target", criteria: [criterion],
    }, {
      driver: { observe: async () => { throw new Error("observation infrastructure failure"); },
        act: async () => { throw new Error("unexpected action"); }, close: async () => ({ status: "closed", errors: [] }) },
      brain: { decide: async () => { throw new Error("unexpected decision"); } },
    });
    expect(result.status).toBe("infrastructure_failed");
    expect(result.checks[0]).toMatchObject({ passed: false, evidence: "" });
    source.attempts[0].status = result.status;
    source.results[0].result = resultSchema.parse(result);
    source.events = [];
    const report = aggregateReport(source, []);
    expect(report.agents[0].criteria[0]).toMatchObject({ status: "not_observed", citations: [] });
    expect(report.groups).toEqual([]);
    expect(JSON.parse(await exportReport(report, "json").text()).agents[0].criteria[0].status).toBe("not_observed");
  });

  it("redacts quoted/backslash typed values from actual structural JSON evidence before exporting", async () => {
    const { source, loaded } = fixture(["succeeded"]);
    const secret = 'Acme "Internal"\\Account';
    const control: Criterion = {
      id: "coupon", kind: "control", label: "Name", description: "Name matches", semantics: "current", value: secret, match: "exact",
    };
    const observation: Observation = {
      id: "observation-0", url: "https://fixture.flash-flood.invalid/demo/cart", title: "Cart", text: "Name",
      candidates: [{ id: "name", kind: "input", label: "Name", value: secret }], checks: [], signals: [], screenshotKey: loaded[0].storageKey,
    };
    const check = deterministicCheck(control, observation)!;
    expect(JSON.parse(check.evidence).value).toBe(secret);
    source.attempts[0].criteria = [control];
    source.results[0].result.checks = [check];
    loaded[1].data = sanitizeEvidence({ observation: { ...observation, checks: [check] } });
    loaded.push({ ...loaded[1], metadata: { ...loaded[1].metadata, id: randomUUID() },
      data: sanitizeEvidence({ action: { action: "type", value: secret } }) });
    const report = aggregateReport(source, loaded);
    const exported = JSON.parse(await exportReport(report, "json").text());
    expect(JSON.parse(exported.agents[0].criteria[0].explanation).value).toBe("[REDACTED]");
    expect(JSON.parse(exported.agents[0].criteria[0].citations[0].excerpt).value).toBe("[REDACTED]");
    expect(await exportReport(report, "markdown").text()).not.toContain("Internal");
  });
});
