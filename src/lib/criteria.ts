import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max).refine(
  (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
  "Control characters are not allowed",
);
const path = text(500).refine((value) => {
  if (!value.startsWith("/") || value.startsWith("//") || /[?#\\]/.test(value)) return false;
  try { return new URL(value, "https://criterion.invalid").pathname === value; } catch { return false; }
}, "Use an exact canonical URL pathname");
const common = {
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  description: text(500),
  semantics: z.enum(["milestone", "current"]),
  paths: z.array(path).min(1).max(12).optional(),
};
/**
 * Strings retain the original API; only the two exact demo strings are oracle
 * criteria, all other strings require semantic evaluation on the current page.
 * `paths` restricts relevance to exact pathnames. Milestones survive unrelated
 * pages, but a relevant contradiction or inconclusive result invalidates them.
 */
export const criterionSchema = z.union([
  text(500),
  z.discriminatedUnion("kind", [
    z.strictObject({ ...common, kind: z.literal("url"), path }),
    z.strictObject({ ...common, kind: z.literal("visible_text"), text: text(500), match: z.enum(["exact", "contains"]) }),
    z.strictObject({
      ...common, kind: z.literal("control"), label: text(200), match: z.enum(["exact", "contains"]),
      controlKind: z.enum(["link", "button", "input", "select"]).optional(),
      value: z.string().max(200).optional(),
      checked: z.boolean().optional(),
      disabled: z.boolean().optional(),
      selected: z.array(z.string().max(200)).max(12)
        .refine((values) => new Set(values).size === values.length, "Selected values must be unique").optional(),
    }),
    z.strictObject({ ...common, kind: z.literal("semantic") }),
  ]),
]);
export type Criterion = z.infer<typeof criterionSchema>;
export const criterionKey = (criterion: Criterion): string => typeof criterion === "string" ? criterion : criterion.id;
export const criterionDescription = (criterion: Criterion): string => typeof criterion === "string" ? criterion : criterion.description;
export const legacyDemoCriteria = [
  "Both advertised coupons apply and the mug total is CA$21.60.",
  "The demo order is visibly complete.",
] as const;
export function isLegacyCriterion(criterion: Criterion): boolean {
  return typeof criterion === "string" && legacyDemoCriteria.some((known) => known === criterion);
}
export const citationSchema = z.strictObject({
  observationId: z.string().min(1).max(200), pageUrl: z.url().max(4096), step: z.int().min(0).max(30),
  excerpt: z.string().min(1).max(1000), screenshotKey: z.string().min(1).max(1000).optional(),
});
export const criterionCheckSchema = z.strictObject({
  criterion: z.string().min(1).max(500), passed: z.boolean(), evidence: z.string().max(4096),
  status: z.enum(["met", "not_met", "not_observed", "inconclusive", "unsupported"]).optional(),
  method: z.enum(["legacy", "deterministic", "semantic"]).optional(),
  citations: z.array(citationSchema).max(12).optional(),
  confidence: z.number().min(0).max(1).optional(),
  confidenceMeaning: z.literal("heuristic").optional(),
  uncertainty: z.string().max(1000).optional(),
}).refine((check) => check.status === undefined || check.passed === (check.status === "met"),
  "Canonical status must agree with passed");
export type CriterionCheck = z.infer<typeof criterionCheckSchema>;
