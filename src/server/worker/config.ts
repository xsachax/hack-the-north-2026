import { z } from "zod";
import type { ExecutionLimits } from "../../lib/contracts";

export const workerPolicySchema = z.strictObject({
  globalConcurrency: z.int().min(1).max(12).default(3),
  ownerConcurrency: z.int().min(1).max(12).default(3),
  developmentBudgetSeconds: z.int().min(363).max(90 * 3600).default(90 * 3600),
  ownerBudgetSeconds: z.int().min(1).max(90 * 3600).default(3600),
  baselineSeconds: z.int().min(363).max(90 * 3600).default(363),
  sessionSeconds: z.int().min(60).max(300).default(240),
  maxSteps: z.int().min(1).max(30).default(14),
  maxModelCalls: z.int().min(1).max(30).default(14),
  leaseMs: z.int().min(5000).max(120000).default(30000),
  recoveryLimit: z.int().min(1).max(10).default(6),
  lifetimeReservationLimitSeconds: z.int().min(60).max(90 * 3600).default(90 * 3600),
});
export type WorkerPolicy = z.infer<typeof workerPolicySchema>;
export function workerExecutionLimits(policy: WorkerPolicy, requested: ExecutionLimits = {}): Required<ExecutionLimits> {
  return {
    maxSteps: Math.min(policy.maxSteps, requested.maxSteps ?? policy.maxSteps),
    maxModelCalls: Math.min(policy.maxModelCalls, requested.maxModelCalls ?? policy.maxModelCalls),
    maxDurationMs: Math.min(
      Math.max(1000, (policy.sessionSeconds - 60) * 1000),
      requested.maxDurationMs ?? 240_000,
    ),
  };
}
export function readWorkerPolicy(env: NodeJS.ProcessEnv): WorkerPolicy {
  const integer = (name: string) => env[name] === undefined ? undefined : Number(env[name]);
  return workerPolicySchema.parse({
    globalConcurrency: integer("MAX_CONCURRENT_SESSIONS"),
    ownerConcurrency: integer("MAX_OWNER_SESSIONS"),
    developmentBudgetSeconds: integer("DEVELOPMENT_BUDGET_SECONDS"),
    ownerBudgetSeconds: integer("OWNER_BUDGET_SECONDS"),
    baselineSeconds: integer("EXTERNAL_BASELINE_SECONDS"),
    sessionSeconds: integer("SESSION_TIMEOUT_SECONDS"),
    maxSteps: integer("MAX_STEPS_PER_PERSONA"),
    maxModelCalls: integer("MAX_MODEL_CALLS_PER_PERSONA"),
    leaseMs: integer("WORKER_LEASE_MS"),
    recoveryLimit: integer("WORKER_RECOVERY_LIMIT"),
    lifetimeReservationLimitSeconds: integer("LIFETIME_RESERVATION_LIMIT_SECONDS"),
  });
}
