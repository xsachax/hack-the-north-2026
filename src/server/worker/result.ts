import { z } from "zod";
import { terminalStatusSchema } from "../../lib/contracts";
import { criterionCheckSchema } from "../../lib/criteria";
export { publicAttemptSummarySchema as publicResultSchema } from "../../lib/contracts";

const outcome = z.strictObject({
  status: terminalStatusSchema,
  reason: z.string().max(2000),
});
export const resultSchema = outcome.extend({
  originalTerminal: outcome,
  checks: z.array(criterionCheckSchema).max(12),
  steps: z.int().min(0).max(30),
  modelCalls: z.int().min(0).max(30),
  modelOperations: z.strictObject({
    decision: z.int().min(0).max(30), evaluation: z.int().min(0).max(30),
    retry: z.int().min(0).max(30), total: z.int().min(0).max(30),
  }).optional(),
  durationMs: z.number().min(0),
  cleanup: z.strictObject({ status: z.enum(["closed", "failed"]), errors: z.array(z.string().max(2000)).max(100) }),
  errors: z.array(z.string().max(2000)).max(100),
}).refine((result) => !result.modelOperations ||
  result.modelOperations.total === result.modelCalls &&
  result.modelOperations.total === result.modelOperations.decision + result.modelOperations.evaluation + result.modelOperations.retry,
"Model operation counts must sum to modelCalls");
