import { describe, expect, it } from "vitest";
import { publicResultSchema, resultSchema } from "./result";

const terminal = { status: "succeeded", reason: "All criteria verified" };
const result = {
  ...terminal, originalTerminal: terminal,
  checks: [{ criterion: "legacy criterion", passed: true, evidence: "observed" }],
  steps: 0, modelCalls: 0, durationMs: 1, cleanup: { status: "closed", errors: [] }, errors: [],
};

describe("strict persisted execution results", () => {
  it("exports an allowlisted public result with evidence IDs, never private screenshot keys", () => {
    const citation = {
      observationId: "state", pageUrl: "https://site.example/help", step: 0, excerpt: "Support",
      evidenceId: "8605aa49-a3c4-42ca-9f9c-a430a52a05c3",
    };
    const summary = {
      steps: 0, modelCalls: 1, modelOperations: { decision: 0, evaluation: 1, retry: 0, total: 1 },
      durationMs: 10, cleanup: { status: "closed" },
      checks: [{ criterion: "support", passed: true, evidence: "Support", status: "met", method: "semantic", citations: [citation] }],
    };
    expect(publicResultSchema.parse(summary)).toEqual(summary);
    expect(publicResultSchema.safeParse({ ...summary, originalTerminal: result.originalTerminal }).success).toBe(false);
    expect(publicResultSchema.safeParse({ ...summary, checks: [{
      ...summary.checks[0], citations: [{ ...citation, screenshotKey: "private-storage-key" }],
    }] }).success).toBe(false);
  });
  it("retains backward compatibility with legacy checks and results", () => {
    expect(resultSchema.parse(result)).toEqual(result);
  });
  it("retains canonical grounded checks and per-operation usage", () => {
    const canonical = {
      ...result, modelCalls: 3,
      modelOperations: { decision: 1, evaluation: 1, retry: 1, total: 3 },
      checks: [{
        criterion: "help", passed: true, evidence: "Contact support", status: "met", method: "semantic",
        citations: [{ observationId: "state", pageUrl: "https://site.example/help", step: 1, excerpt: "Contact support", screenshotKey: "shot" }],
        confidence: 0.8, uncertainty: "",
      }],
    };
    expect(resultSchema.parse(canonical)).toEqual(canonical);
  });
  it.each([
    { decision: 1, evaluation: 1, retry: 0, total: 1 },
    { decision: 0, evaluation: 0, retry: 0, total: 1 },
    { decision: -1, evaluation: 1, retry: 0, total: 0 },
    { decision: 0, evaluation: 0, retry: 0, total: 0, unknown: 1 },
  ])("rejects inconsistent or malformed operation counts %j", (modelOperations) => {
    expect(resultSchema.safeParse({ ...result, modelOperations }).success).toBe(false);
  });
  it.each([
    { status: "inconclusive" }, { method: "regex" }, { confidence: 1.1 }, { hiddenReasoning: "untrusted" },
    { citations: [{ observationId: "state", pageUrl: "javascript:alert(1)", step: -1, excerpt: "text" }] },
  ])("rejects contradictory or malformed canonical checks %j", (extra) => {
    expect(resultSchema.safeParse({ ...result, checks: [{ ...result.checks[0], ...extra }] }).success).toBe(false);
  });
});
