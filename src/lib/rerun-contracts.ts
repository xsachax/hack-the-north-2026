import { z } from "zod";
import { idSchema, runSchema } from "./contracts";
import { findingCategorySchema, reportCriterionSchema, runReportSchema } from "./report-contracts";

export const rerunRequestSchema = z.strictObject({
  authorizationAcknowledged: z.literal(true),
  attemptIds: z.array(idSchema).min(1).max(12).refine(
    (ids) => new Set(ids).size === ids.length, "Select each parent attempt only once",
  ),
  scenario: z.enum(["fixed", "second-coupon"]).optional(),
});
export type RerunRequest = z.infer<typeof rerunRequestSchema>;
export const rerunResponseSchema = z.strictObject({ run: runSchema, created: z.boolean() });
export const rerunPairSchema = z.strictObject({ parentAttemptId: idSchema, childAttemptId: idSchema });
export type RerunPair = z.infer<typeof rerunPairSchema>;
export const comparisonCohortSchema = z.strictObject({
  assigned: z.int().nonnegative(),
  eligible: z.int().nonnegative(),
  tested: z.int().nonnegative(),
  notTested: z.int().nonnegative(),
  affected: z.int().nonnegative(),
  confirmed: z.int().nonnegative(),
});
export const runComparisonSchema = z.strictObject({
  version: z.literal("comparison-v1"),
  reportVersion: z.literal("report-v1"),
  signatureVersion: z.literal("finding-v2"),
  criterionVersion: z.literal("criterion-v1"),
  parentRunId: idSchema,
  childRunId: idSchema,
  parentRevision: z.string(),
  childRevision: z.string(),
  parentFinality: runReportSchema.shape.finality,
  childFinality: runReportSchema.shape.finality,
  context: z.literal("fresh"),
  comparable: z.boolean(),
  pairs: z.array(rerunPairSchema.extend({
    comparable: z.boolean(),
    parentHumanAssisted: z.boolean(),
    childHumanAssisted: z.boolean(),
    criteria: z.array(z.strictObject({
      definitionSignature: z.string(),
      semantics: reportCriterionSchema.shape.semantics,
      before: reportCriterionSchema.shape.status,
      after: reportCriterionSchema.shape.status.nullable(),
      comparable: z.boolean(),
      tested: z.boolean(),
      confirmedMet: z.boolean(),
    })),
  })),
  groups: z.array(z.strictObject({
    signature: z.string(),
    category: findingCategorySchema,
    title: z.string(),
    state: z.enum(["persists", "confirmed_fixed", "not_observed", "not_comparable", "new"]),
    before: comparisonCohortSchema,
    after: comparisonCohortSchema,
    explanation: z.string(),
  })),
  notices: z.array(z.string()),
});
export type RunComparison = z.infer<typeof runComparisonSchema>;
