import { describe, expect, it } from "vitest";
import { z } from "zod";
import { legacyDemoCriteria, type Criterion, type CriterionCheck } from "../../lib/criteria";
import {
  boundedObservation, deterministicCheck, evaluationCacheKey, mergeCriterionCheck, parseSemanticResponse, semanticResponseSchema, validateSemanticChecks,
} from "./evaluator";
import type { EvaluationInput, Observation } from "./types";

const observation: Observation = {
  id: "state-1", url: "https://site.example/help", title: "Support", text: "Need help?\nContact support anytime.",
  candidates: [{ id: "support", kind: "link", label: "Contact support" }], checks: [], signals: [],
  screenshotKey: "screenshots/current.png",
};
const semantic: Criterion = { id: "support", kind: "semantic", description: "Support is available", semantics: "current", paths: ["/help"] };
const input: EvaluationInput = { criteria: [semantic], observation, step: 2 };
const citation = { observationId: observation.id, pageUrl: observation.url, step: 2, excerpt: "Contact support anytime.", screenshotKey: observation.screenshotKey };
const passed: CriterionCheck = { criterion: "support", passed: true, status: "met", evidence: "", method: "semantic", citations: [citation], confidence: 0.8, uncertainty: "" };
const text: Criterion = { id: "text", description: "Help heading", semantics: "current", kind: "visible_text", text: "Need help?", match: "exact" };

describe("deterministic criteria and temporal semantics", () => {
  it("matches exact lines or literal substrings without regex interpretation", () => {
    expect(deterministicCheck(text, observation)?.passed).toBe(true);
    expect(deterministicCheck({ ...text, text: "help?" }, observation)?.passed).toBe(false);
    expect(deterministicCheck({ ...text, text: "help?", match: "contains" }, observation)?.passed).toBe(true);
    expect(deterministicCheck({ ...text, text: ".*", match: "contains" }, observation)?.passed).toBe(false);
  });
  it("checks exact paths and control kind/label", () => {
    expect(deterministicCheck({ id: "url", description: "Help page", kind: "url", path: "/help", semantics: "current" }, observation)?.passed).toBe(true);
    expect(deterministicCheck({ id: "url", description: "Help page", kind: "url", path: "/hel", semantics: "current" }, observation)?.passed).toBe(false);
    const control: Criterion = { id: "control", description: "Support link", kind: "control", label: "Contact support", match: "exact", semantics: "current" };
    expect(deterministicCheck(control, observation)?.passed).toBe(true);
    expect(deterministicCheck({ ...control, controlKind: "button" }, observation)?.passed).toBe(false);
    expect(deterministicCheck({ ...control, label: "support", match: "contains" }, observation)?.passed).toBe(true);
  });
  it("never treats arbitrary string checks from the driver as a semantic oracle", () => {
    expect(deterministicCheck("Support is available", { ...observation, checks: [{ criterion: "Support is available", passed: true, evidence: "fake" }] })).toBeUndefined();
    expect(deterministicCheck(legacyDemoCriteria[0], { ...observation, checks: [{ criterion: legacyDemoCriteria[0], passed: true, evidence: "oracle" }] })).toMatchObject({ passed: true, method: "legacy" });
  });
  it.each([
    { value: "Research" }, { checked: true }, { disabled: false }, { selected: ["Research", "Design"] },
  ])("checks observed structural control state %j", (state) => {
    const control: Criterion = { id: "control", description: "State", kind: "control", label: "Choice", match: "exact", semantics: "current", ...state };
    const observed = { ...observation, candidates: [{ id: "choice", kind: "select" as const, label: "Choice", ...state }] };
    expect(deterministicCheck(control, observed)?.status).toBe("met");
    expect(deterministicCheck(control, { ...observed, candidates: [{ id: "choice", kind: "select", label: "Choice" }] })?.status).toBe("inconclusive");
  });
  it("distinguishes observed state contradictions from absence of observed state", () => {
    const control: Criterion = { id: "control", description: "Agreed", kind: "control", label: "Agree", match: "exact", semantics: "current", checked: true };
    expect(deterministicCheck(control, { ...observation, candidates: [{ id: "agree", kind: "input", label: "Agree", checked: false }] })?.status).toBe("not_met");
    expect(deterministicCheck(control, { ...observation, candidates: [] })?.status).toBe("not_met");
  });
  it("matches selected values as an exact set, including empty selection", () => {
    const control: Criterion = { id: "control", description: "Categories", kind: "control", label: "Category", match: "exact", semantics: "current", selected: ["Research", "Design"] };
    const observed = { ...observation, candidates: [{ id: "category", kind: "select" as const, label: "Category", selected: ["Design", "Research"] }] };
    expect(deterministicCheck(control, observed)?.passed).toBe(true);
    expect(deterministicCheck({ ...control, selected: ["Research"] }, observed)?.passed).toBe(false);
    expect(deterministicCheck({ ...control, selected: [] }, { ...observed, candidates: [{ ...observed.candidates[0], selected: [] }] })?.passed).toBe(true);
  });
  it("retains observed form state in the bounded cache identity", () => {
    const observed = { ...observation, candidates: [{
      id: "choice", kind: "select" as const, label: "Choice", selected: ["Research"], disabled: false, value: "Research", checked: false,
    }] };
    expect(boundedObservation(observed).candidates).toEqual(observed.candidates);
    expect(evaluationCacheKey({ ...input, observation: observed })).not.toBe(evaluationCacheKey({
      ...input, observation: { ...observed, candidates: [{ ...observed.candidates[0], checked: true }] },
    }));
  });
  it("retains milestones only while unobservable; contradictions and ambiguity invalidate", () => {
    const milestone: Criterion = { ...semantic, semantics: "milestone" };
    const unrelated = deterministicCheck(milestone, { ...observation, url: "https://site.example/other" })!;
    expect(unrelated.status).toBe("not_observed");
    expect(mergeCriterionCheck(milestone, passed, unrelated)).toEqual(passed);
    expect(mergeCriterionCheck(semantic, passed, unrelated).passed).toBe(false);
    for (const status of ["not_met", "inconclusive"] as const) {
      expect(mergeCriterionCheck(milestone, passed, { ...passed, passed: false, status }).passed).toBe(false);
    }
  });
  it("bounds visible evidence and controls", () => {
    const large = { ...observation, text: "x".repeat(16000) + "hidden proof", candidates: Array(100).fill(observation.candidates[0]) };
    expect(boundedObservation(large).text).toHaveLength(16000);
    expect(boundedObservation(large).candidates).toHaveLength(80);
    expect(deterministicCheck({ ...text, match: "contains", text: "hidden proof" }, large)?.passed).toBe(false);
  });
  it("uses measured blocks rather than synthetic focus/input annotations for contains assertions", () => {
    const state = {
      ...observation, text: "Focused control: none Your projects Input c1: synthetic value",
      textBlocks: ["Your projects"],
    };
    expect(deterministicCheck({ ...text, match: "contains", text: "projects" }, state)?.passed).toBe(true);
    for (const value of ["Focused control: none", "synthetic value"]) {
      expect(deterministicCheck({ ...text, match: "contains", text: value }, state)?.passed).toBe(false);
    }
  });
});

describe("grounded semantic evidence", () => {
  it("keeps provenance URLs literal across the SDK JSON-schema round trip", () => {
    const wire = z.toJSONSchema(semanticResponseSchema);
    expect(JSON.stringify(wire)).not.toContain('"format":"uri"');
    const response = { checks: [{
      criterion: "support", status: "met", citations: [citation], confidence: 0.8, uncertainty: "",
    }] };
    expect(z.fromJSONSchema(wire).parse(response)).toEqual(response);
    expect(parseSemanticResponse(response, input)[0].status).toBe("met");
  });
  it("still rejects non-URLs after accepting a bounded string from the SDK", () => {
    const response = { checks: [{
      criterion: "support", status: "met", citations: [{ ...citation, pageUrl: "not a URL" }],
      confidence: 0.8, uncertainty: "",
    }] };
    expect(semanticResponseSchema.safeParse(response).success).toBe(true);
    expect(parseSemanticResponse(response, input)[0].status).toBe("inconclusive");
  });
  it("accepts valid citations and derives evidence only from validated excerpts", () => {
    expect(validateSemanticChecks([{ ...passed, evidence: "arbitrary invented prose" }], input)[0]).toMatchObject({
      passed: true, evidence: citation.excerpt, status: "met", confidenceMeaning: "heuristic",
    });
  });
  it("attaches the current observed screenshot reference when the model omits it", () => {
    const { screenshotKey: _key, ...textCitation } = citation;
    void _key;
    expect(validateSemanticChecks([{ ...passed, citations: [textCitation] }], input)[0].citations)
      .toEqual([citation]);
  });
  it.each([
    { observationId: "forged" }, { pageUrl: "https://other.example/help" }, { step: 1 },
    { excerpt: "invented proof" }, { excerpt: " " }, { screenshotKey: "old-screenshot" },
    { observationId: `${observation.id} ` }, { screenshotKey: `${observation.screenshotKey} ` },
  ])("rejects forged citation fields %j", (override) => {
    expect(validateSemanticChecks([{ ...passed, citations: [{ ...citation, ...override }] }], input)[0]).toMatchObject({
      passed: false, status: "inconclusive",
    });
  });
  it("validates every citation, including additional false proof", () => {
    expect(validateSemanticChecks([{ ...passed, citations: [citation, { ...citation, observationId: "other" }] }], input)[0].status).toBe("inconclusive");
  });
  it.each([
    [], [passed, passed],
    [{ ...passed, citations: [] }],
    [{ ...passed, uncertainty: "Maybe this is unrelated" }],
    [{ ...passed, criterion: "new objective" }],
    [{ ...passed, criterion: "support " }],
    [{ ...passed, method: "legacy" }],
    [{ ...passed, passed: false }],
    [{ ...passed, actor: "user" }],
    [{ ...passed, status: undefined }],
    [{ ...passed, confidence: 2 }],
  ])("makes malformed/ambiguous response explicitly inconclusive %j", (...raw) => {
    expect(validateSemanticChecks(raw, input)[0]).toMatchObject({ passed: false, status: "inconclusive" });
  });
  it("rejects proof outside the bounded text and proof from titles/candidate labels only", () => {
    expect(validateSemanticChecks([{ ...passed, citations: [{ ...citation, excerpt: "Support" }] }], input)[0].passed).toBe(false);
    expect(validateSemanticChecks([passed], { ...input, observation: { ...observation, text: "x".repeat(16000) + citation.excerpt } })[0].passed).toBe(false);
  });
  it("allows grounded low-confidence judgments, never uses confidence to override missing proof", () => {
    expect(validateSemanticChecks([{ ...passed, confidence: 0.01 }], input)[0].passed).toBe(true);
    expect(validateSemanticChecks([{ ...passed, citations: [], confidence: 1 }], input)[0].passed).toBe(false);
  });
  it("does not let model unobservability retain a milestone on a relevant page", () => {
    const check = validateSemanticChecks([{ ...passed, passed: false, status: "not_observed", citations: [] }], input)[0];
    expect(check.status).toBe("inconclusive");
  });
  it("parses model statuses without trusting model-provided passed/evidence fields", () => {
    const response = { checks: [{ criterion: "support", status: "met", citations: [citation], confidence: 0.7, uncertainty: "" }] };
    expect(parseSemanticResponse(response, input)[0].passed).toBe(true);
    expect(parseSemanticResponse({ checks: [{ ...response.checks[0], passed: true }] }, input)[0].status).toBe("inconclusive");
  });
  it("keys cache by bounded state and criteria, not URL or unique artifact IDs", () => {
    const key = evaluationCacheKey(input);
    expect(evaluationCacheKey({ ...input, step: 3, observation: { ...observation, id: "new-id", screenshotKey: "new-key" } })).toBe(key);
    expect(evaluationCacheKey({ ...input, observation: { ...observation, text: "Changed" } })).not.toBe(key);
    expect(evaluationCacheKey({ ...input, observation: { ...observation, title: "Changed" } })).not.toBe(key);
    expect(evaluationCacheKey({ ...input, observation: { ...observation, candidates: [] } })).not.toBe(key);
    expect(evaluationCacheKey({ ...input, criteria: ["Different criterion"] })).not.toBe(key);
  });
});
