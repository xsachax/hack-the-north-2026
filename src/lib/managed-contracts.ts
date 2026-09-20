import { z } from "zod";
import { idSchema, personaIdSchema, personaSchema } from "./contracts";
import { targetScopeSchema } from "./target-scope";

export const MANAGED_EXECUTION_POLICY = "browserbase-managed-v1";
export const MANAGED_POLICY_NOTICE = "Browserbase runs the agent and its built-in tools, which cannot be disabled. Scope and read-only behavior are instructions, not Flash Flood network enforcement. Browserbase's API does not expose a hard per-run model-call or browser-time limit. Use only explicitly approved public sites without credentials or sensitive data.";
const text = (max: number) => z.string().trim().min(1).max(max);
export const managedAssignmentSchema = z.strictObject({
  personaId: personaIdSchema,
  goal: text(2000),
  criteria: z.array(text(500)).min(1).max(6),
});
export const managedCreateSchema = z.strictObject({
  executionPolicy: z.literal(MANAGED_EXECUTION_POLICY),
  authorizationAcknowledged: z.literal(true),
  managedPolicyAcknowledged: z.literal(true),
  scope: targetScopeSchema,
  assignments: z.array(managedAssignmentSchema).min(1).max(8),
}).refine((value) => new Set(value.assignments.map((item) => item.personaId)).size === value.assignments.length,
  "Select distinct personas");
export type ManagedCreate = z.infer<typeof managedCreateSchema>;

export const managedResultSchema = z.strictObject({
  summary: text(4000),
  finalUrl: z.string().max(4096),
  criteria: z.array(z.strictObject({
    criterion: text(500), status: z.enum(["met", "not_met", "inconclusive"]),
    observation: text(1500),
  })).max(6),
  limitations: z.array(text(500)).max(12),
});
export type ManagedResult = z.infer<typeof managedResultSchema>;
export const managedProgressSchema = z.strictObject({
  sequence: z.int().positive(), timestamp: z.string(),
  kind: z.enum(["status", "text", "tool", "error"]),
  text: z.string().max(2000),
});
export type ManagedProgress = z.infer<typeof managedProgressSchema>;
export const managedAttemptSchema = z.strictObject({
  id: idSchema, persona: personaSchema, goal: text(2000), criteria: z.array(text(500)).min(1).max(6),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled", "cleanup_required"]),
  providerStatus: z.string().max(64).nullable(),
  cleanup: z.enum(["not_started", "unconfirmed", "closed"]),
  cancelRequested: z.boolean(),
  progress: z.array(managedProgressSchema).max(500),
  result: managedResultSchema.nullable(),
  error: z.string().max(2000).nullable(),
  reservedSeconds: z.number().nonnegative(),
  startedAt: z.iso.datetime().nullable().optional(),
  finishedAt: z.iso.datetime().nullable().optional(),
  actualBrowserSeconds: z.number().nonnegative().nullable(),
  modelCalls: z.null(),
});
export type ManagedAttempt = z.infer<typeof managedAttemptSchema>;
export const managedRunSchema = z.strictObject({
  id: idSchema, executionPolicy: z.literal(MANAGED_EXECUTION_POLICY),
  scope: targetScopeSchema, createdAt: z.string(), updatedAt: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled", "cleanup_required"]),
  attempts: z.array(managedAttemptSchema).min(1).max(8),
});
export type ManagedRun = z.infer<typeof managedRunSchema>;
export const managedCapabilitiesSchema = z.strictObject({
  enabled: z.boolean(), allowedOrigins: z.array(z.string()), maxAgents: z.literal(8),
  policy: z.literal(MANAGED_EXECUTION_POLICY), notice: z.string(),
});
export type ManagedCapabilities = z.infer<typeof managedCapabilitiesSchema>;

/** Access-bearing provider link: HTTPS on browserbase.com (or a subdomain), no credentials, no explicit port. */
export const browserbaseUrlSchema = z.string().max(8192).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && (url.hostname === "browserbase.com" || url.hostname.endsWith(".browserbase.com"));
  } catch { return false; }
}, "The provider viewer URL is not allowed.");
export const managedSessionsSchema = z.strictObject({
  items: z.array(z.strictObject({
    attemptId: idSchema, available: z.boolean(), liveViewUrl: browserbaseUrlSchema.nullable(),
  })).max(8),
});
export type ManagedSessions = z.infer<typeof managedSessionsSchema>;
export type ManagedSessionView = ManagedSessions["items"][number];
