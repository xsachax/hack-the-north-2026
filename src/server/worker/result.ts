import { z } from "zod";
import { terminalStatusSchema } from "../../lib/contracts";

const outcome = z.strictObject({
  status: terminalStatusSchema,
  reason: z.string().max(2000),
});
export const resultSchema = outcome.extend({
  originalTerminal: outcome,
  checks: z.array(z.strictObject({
    criterion: z.string().max(500), passed: z.boolean(), evidence: z.string().max(4096),
  })).max(12),
  steps: z.int().min(0).max(30),
  modelCalls: z.int().min(0).max(30),
  durationMs: z.number().min(0),
  cleanup: z.strictObject({ status: z.enum(["closed", "failed"]), errors: z.array(z.string().max(2000)).max(100) }),
  errors: z.array(z.string().max(2000)).max(100),
});
