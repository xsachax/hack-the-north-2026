import { z } from "zod";
import {
  executionLimitsSchema, gatewayMetricsSchema, idSchema, publicAttemptSummarySchema, statusSchema,
} from "./contracts";

export const capabilitiesSchema = z.strictObject({
  controlledRunsEnabled: z.boolean(),
  websiteExecutionEnabled: z.literal(false),
  maxActiveViews: z.literal(3),
  accessCodeConfigured: z.boolean(),
  browserbaseKeyConfigured: z.boolean(),
  executionLimits: executionLimitsSchema.required(),
  executionLimitsSource: z.enum(["persisted-worker-policy", "configuration", "defaults"]),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

export const sessionViewSchema = z.strictObject({
  attemptId: idSchema,
  available: z.boolean(),
  liveViewUrl: z.url().nullable(),
});
export type SessionView = z.infer<typeof sessionViewSchema>;
export const sessionsResponseSchema = z.strictObject({ items: z.array(sessionViewSchema) });
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;

export const attemptSummarySchema = z.strictObject({
  attemptId: idSchema,
  status: statusSchema,
  launchState: z.enum(["not_launched", "intent", "active", "recovering", "quarantined", "settled"]),
  summary: publicAttemptSummarySchema.nullable(),
  usage: z.strictObject({
    actualBrowserSeconds: z.number().nonnegative().optional(),
    elapsedSeconds: z.number().nonnegative(),
    remoteStatus: z.enum(["PENDING", "RUNNING", "COMPLETED", "ERROR", "TIMED_OUT"]).optional(),
    modelMetrics: gatewayMetricsSchema.optional(),
  }).nullable(),
  reservedSeconds: z.int().nonnegative(),
  consumedSeconds: z.int().nonnegative(),
  releasedSeconds: z.int().nonnegative(),
});
export type AttemptSummary = z.infer<typeof attemptSummarySchema>;
export const attemptSummariesResponseSchema = z.strictObject({ items: z.array(attemptSummarySchema) });
export type AttemptSummariesResponse = z.infer<typeof attemptSummariesResponseSchema>;
