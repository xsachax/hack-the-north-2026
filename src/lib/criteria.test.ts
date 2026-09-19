import { describe, expect, it } from "vitest";
import { criterionCheckSchema, criterionDescription, criterionKey, criterionSchema, isLegacyCriterion, legacyDemoCriteria } from "./criteria";

const base = { id: "help", description: "Find assistance", semantics: "current" };
describe("bounded criterion contracts", () => {
  it.each([
    "Help is easy to find", ...legacyDemoCriteria,
    { ...base, kind: "url", path: "/help" },
    { ...base, kind: "visible_text", text: "Help", match: "exact", paths: ["/help"] },
    { ...base, kind: "control", label: "Help", match: "contains", controlKind: "link" },
    { ...base, kind: "control", label: "Name", match: "exact", value: "", disabled: false },
    { ...base, kind: "control", label: "Categories", match: "exact", selected: ["Research", "Design"] },
    { ...base, kind: "control", label: "Agree", match: "exact", checked: true },
    { ...base, kind: "semantic", semantics: "milestone" },
  ])("accepts supported criteria %j", (value) => {
    const criterion = criterionSchema.parse(value);
    expect(criterionKey(criterion)).toBe(typeof value === "string" ? value : base.id);
    expect(criterionDescription(criterion)).toBe(typeof value === "string" ? value : base.description);
  });
  it.each([
    "", "a".repeat(501), "bad\u0000text",
    { ...base, kind: "url", path: "https://other.example/help" },
    { ...base, kind: "url", path: "//other.example" },
    { ...base, kind: "url", path: "/a/../help" },
    { ...base, kind: "url", path: "/help?q=1" },
    { ...base, kind: "url", path: "/help#part" },
    { ...base, kind: "url", path: "/help", regex: ".*" },
    { ...base, kind: "visible_text", text: "Help", match: "regex" },
    { ...base, kind: "control", label: "Help", match: "exact", controlKind: "iframe" },
    { ...base, kind: "control", label: "Name", match: "exact", value: "x".repeat(201) },
    { ...base, kind: "control", label: "Choice", match: "exact", selected: ["same", "same"] },
    { ...base, kind: "control", label: "Choice", match: "exact", selected: Array.from({ length: 13 }, (_, index) => `${index}`) },
    { ...base, kind: "control", label: "Choice", match: "exact", checked: "true" },
    { ...base, kind: "semantic", paths: [] },
    { ...base, kind: "semantic", paths: Array(13).fill("/help") },
    { ...base, kind: "semantic", semantics: "forever" },
    { ...base, kind: "semantic", prompt: "use tools" },
    { ...base, kind: "semantic", id: "a".repeat(65) },
  ])("rejects unsupported or unbounded criteria %j", (value) => {
    expect(criterionSchema.safeParse(value).success).toBe(false);
  });
  it("only recognizes the exact legacy demo strings as oracle criteria", () => {
    expect(legacyDemoCriteria.every(isLegacyCriterion)).toBe(true);
    expect(isLegacyCriterion(`${legacyDemoCriteria[0]} `)).toBe(false);
    expect(isLegacyCriterion("Confirmation is visible")).toBe(false);
  });
  it("preserves legacy checks but rejects inconsistent canonical success", () => {
    expect(criterionCheckSchema.safeParse({ criterion: "legacy", passed: true, evidence: "observed" }).success).toBe(true);
    expect(criterionCheckSchema.safeParse({ criterion: "legacy", passed: true, evidence: "observed", status: "inconclusive" }).success).toBe(false);
    expect(criterionCheckSchema.safeParse({ criterion: "semantic", passed: false, evidence: "", status: "unsupported" }).success).toBe(true);
    expect(criterionCheckSchema.safeParse({ criterion: "semantic", passed: true, evidence: "observed", confidence: 0.8, confidenceMeaning: "probability" }).success).toBe(false);
  });
});
