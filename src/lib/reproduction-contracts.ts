import { z } from "zod";

export const couponStepSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fill_coupon"), coupon: z.enum(["SAVE10", "COZY5"]) }),
  z.strictObject({ kind: z.literal("apply_coupon") }),
  z.strictObject({ kind: z.literal("wait") }),
]);
export type CouponStep = z.infer<typeof couponStepSchema>;
export const fixtureNavigationMarkerSchema = z.enum([
  "store-home", "store-home-category", "store-mug", "store-cart",
]);
export type FixtureNavigationMarker = z.infer<typeof fixtureNavigationMarkerSchema>;
export const couponRecipeSchema = z.strictObject({
  version: z.literal("coupon-reproduction-v1"),
  fixture: z.literal("store"),
  predicate: z.literal("second-coupon-error-and-missing-discount-v1"),
  steps: z.array(couponStepSchema).min(1).max(27),
});
export type CouponRecipe = z.infer<typeof couponRecipeSchema>;
export const reproductionLimitsSchema = z.strictObject({
  candidates: z.int().min(1).max(32),
  steps: z.int().min(1).max(300),
  modelCalls: z.literal(0),
  durationMs: z.int().min(1000).max(600_000),
  candidateMs: z.int().min(1000).max(60_000),
  reservedSeconds: z.int().min(1).max(1800),
});
export type ReproductionLimits = z.infer<typeof reproductionLimitsSchema>;
export const DEFAULT_REPRODUCTION_LIMITS: ReproductionLimits = Object.freeze({
  candidates: 16, steps: 160, modelCalls: 0, durationMs: 180_000,
  candidateMs: 15_000, reservedSeconds: 240,
});
export const reproductionStatusSchema = z.enum([
  "queued", "running", "found", "not_reproduced", "limit_reached", "cancelled",
  "unsupported", "setup_required", "uncertain_environment", "unknown_cleanup",
]);
export type ReproductionStatus = z.infer<typeof reproductionStatusSchema>;
export const reproductionViewSchema = z.strictObject({
  id: z.uuid(), runId: z.uuid(), attemptId: z.uuid(),
  status: reproductionStatusSchema,
  reason: z.enum([
    "ready", "reducing", "shortest_path_found", "baseline_not_reproduced", "budget_exhausted",
    "cancelled", "unsupported_target", "unavailable_evidence", "ambiguous_evidence",
    "human_actions", "secret_setup_required", "unsupported_action", "destructive_action",
    "missing_failure_predicate", "uncertain_environment", "unknown_cleanup",
  ]),
  originalSteps: z.int().min(0).max(30),
  shortestSteps: z.int().min(0).max(30).nullable(),
  candidatesAttempted: z.int().min(0),
  stepsCharged: z.int().min(0),
  modelCalls: z.literal(0),
  reservedSecondsCharged: z.int().min(0),
  durationMsCharged: z.int().min(0),
  limits: reproductionLimitsSchema,
  exportAvailable: z.boolean(),
  cancelRequested: z.boolean(),
  createdAt: z.string(), updatedAt: z.string(),
  notice: z.string(),
});
export type ReproductionView = z.infer<typeof reproductionViewSchema>;
export type ReproductionReason = ReproductionView["reason"];
export const reproductionCreateSchema = z.strictObject({
  attemptId: z.uuid(),
  authorizationAcknowledged: z.literal(true),
});
