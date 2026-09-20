import { z } from "zod";
import { targetScopeSchema } from "./target-scope";
import { citationSchema, criterionCheckSchema, criterionKey, criterionSchema } from "./criteria";
import { browserStateSchema } from "./context-contracts";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "./public-execution";
import { hasRunCapacity, HISTORICAL_MAX_ASSIGNMENTS_PER_RUN, MAX_ASSIGNMENTS_PER_RUN } from "./execution-capacity";

const text = (max: number) => z.string().trim().min(1).max(max).refine(
  (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
  "Control characters are not allowed",
);
export const idSchema = z.uuid();
export const personaIdSchema = z.union([idSchema, z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)]);
export const timestampSchema = z.iso.datetime();
export const personaProfileSchema = z.strictObject({
  name: text(80),
  character: text(1000),
  device: z.enum(["phone", "desktop"]),
  techComfort: z.enum(["low", "medium", "high"]),
  patienceSteps: z.int().min(1).max(30),
  readingStyle: z.enum(["skim", "careful"]),
  quirks: z.array(text(200)).min(1).max(12),
  worries: z.array(text(200)).min(1).max(12),
});
export const personaSchema = personaProfileSchema.extend({ id: personaIdSchema });
export type PersonaProfile = z.infer<typeof personaProfileSchema>;
export type Persona = z.infer<typeof personaSchema>;

export const statusSchema = z.enum([
  "queued", "running", "succeeded", "gave_up", "cancelled", "blocked",
  "limit_reached", "infrastructure_failed", "target_failed",
]);
export const terminalStatusSchema = statusSchema.exclude(["queued", "running"]);
export type Status = z.infer<typeof statusSchema>;
export type TerminalStatus = z.infer<typeof terminalStatusSchema>;
const criteriaSchema = z.array(criterionSchema).min(1).max(12).refine(
  (criteria) => new Set(criteria.map(criterionKey)).size === criteria.length,
  "Criteria must have unique identities",
);
export const executionLimitsSchema = z.strictObject({
  maxSteps: z.int().min(1).max(30).optional(),
  maxModelCalls: z.int().min(1).max(30).optional(),
  maxDurationMs: z.int().min(1000).max(240_000).optional(),
});
export type ExecutionLimits = z.infer<typeof executionLimitsSchema>;
export const assignmentSchema = z.strictObject({
  personaId: personaIdSchema,
  goal: text(2000),
  criteria: criteriaSchema,
  limits: executionLimitsSchema.optional(),
  browserState: browserStateSchema.optional(),
});
export const createRunSchema = z.strictObject({
  authorizationAcknowledged: z.literal(true),
  executionPolicy: z.literal(PUBLIC_EXECUTION_POLICY).optional(),
  assetPolicy: z.literal(PUBLIC_ASSET_POLICY).optional(),
  scope: targetScopeSchema,
  assignments: z.array(assignmentSchema).min(1).max(HISTORICAL_MAX_ASSIGNMENTS_PER_RUN),
}).refine((value) => new Set(value.assignments.map((entry) => entry.personaId)).size === value.assignments.length,
  "Each persona may appear only once")
  .refine((value) => !!value.executionPolicy === !!value.assetPolicy, "Public execution requires both explicit policies")
  .refine((value) => !value.executionPolicy || value.assignments.every((assignment) =>
    !assignment.browserState || assignment.browserState.mode === "fresh"), "Public runs require fresh profiles");
export type CreateRun = z.infer<typeof createRunSchema>;
// Apply only after exact-idempotency lookup; never use this schema to rehash a saved request.
export const newCreateRunSchema = createRunSchema.refine((request) => hasRunCapacity(request.assignments), {
  path: ["assignments"], message: `Select at most ${MAX_ASSIGNMENTS_PER_RUN} personas per run`,
});
export const runSchema = z.strictObject({
  id: idSchema,
  cursor: z.int().positive(),
  status: statusSchema,
  authorizationAcknowledged: z.literal(true),
  scope: targetScopeSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  cancelRequestedAt: timestampSchema.nullable(),
  executionMode: z.enum(["website", "controlled-fixture", "public-readonly"]).default("website"),
  executionPolicy: z.literal(PUBLIC_EXECUTION_POLICY).optional(),
  assetPolicy: z.literal(PUBLIC_ASSET_POLICY).optional(),
  controlledSiteId: z.enum(["store", "project-board"]).optional(),
}).refine((value) => value.executionMode === "public-readonly"
  ? !!value.executionPolicy && !!value.assetPolicy && !value.controlledSiteId
  : !value.executionPolicy && !value.assetPolicy, "Execution policies must match the canonical mode");
export type Run = z.infer<typeof runSchema>;
export const attemptSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  persona: personaSchema,
  goal: text(2000),
  // Historical website snapshots may contain duplicates; uniqueness belongs to admission.
  criteria: z.array(criterionSchema).min(1).max(12),
  limits: executionLimitsSchema.optional(),
  browserState: browserStateSchema.optional(),
  status: statusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Attempt = z.infer<typeof attemptSchema>;
export const eventSchema = z.strictObject({
  runId: idSchema,
  sequence: z.int().positive(),
  attemptId: idSchema.nullable(),
  timestamp: timestampSchema,
  kind: z.enum([
    "run.created", "run.cancel_requested", "run.finished", "attempt.started",
    "attempt.finished", "evidence.recorded", "finding.recorded",
    "attempt.observation", "attempt.decision", "attempt.action", "attempt.recovering",
    "attempt.control",
  ]),
  data: z.strictObject({
    status: statusSchema.optional(),
    evidenceId: idSchema.optional(),
    findingId: idSchema.optional(),
    actor: z.enum(["agent", "human", "system"]).optional(),
    controlPhase: z.enum(["agent", "requested", "quiescing", "human", "handback", "resuming", "closed"]).optional(),
    controlVersion: z.int().nonnegative().optional(),
    step: z.int().min(0).max(30).optional(),
    modelCalls: z.int().min(0).max(30).optional(),
    action: z.enum(["click", "type", "select", "navigate", "back", "scroll", "key", "wait", "done", "give_up"]).optional(),
    commentary: z.string().max(240).optional(),
    pageUrl: z.url().max(4096).refine((value) => {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) &&
        !url.username && !url.password && !url.search && !url.hash;
    }).optional(),
    reason: z.enum(["blocked_unsupported", "unsupported_criteria", "budget_exhausted", "worker_recovery", "cleanup_unconfirmed", "execution_complete", "context_unavailable", "reproduction_candidate", "reproduction_stopped"]).optional(),
  }),
});
export type RunEvent = z.infer<typeof eventSchema>;
export const jobSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  attemptId: idSchema,
  status: z.enum(["queued", "leased", "completed", "cancelled"]),
  leaseOwner: z.string().max(128).nullable(),
  leaseExpiresAt: timestampSchema.nullable(),
  leaseGeneration: z.int().nonnegative(),
  cancelRequestedAt: timestampSchema.nullable(),
});
export type Job = z.infer<typeof jobSchema>;
export const usageReservationSchema = z.strictObject({
  jobId: idSchema,
  reservedSeconds: z.int().nonnegative(),
  consumedSeconds: z.int().nonnegative(),
  releasedSeconds: z.int().nonnegative(),
}).refine((value) => value.releasedSeconds <= value.reservedSeconds, "Released seconds cannot exceed the reservation");
export type UsageReservation = z.infer<typeof usageReservationSchema>;
export const evidenceSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  attemptId: idSchema,
  kind: z.enum(["screenshot", "console", "network", "recording", "observation"]),
  createdAt: timestampSchema,
  summary: text(1000),
});
export type Evidence = z.infer<typeof evidenceSchema>;
export const findingSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  attemptId: idSchema,
  createdAt: timestampSchema,
  title: text(200),
  description: text(2000),
  evidenceIds: z.array(idSchema).min(1).max(32),
});
export type Finding = z.infer<typeof findingSchema>;
export const paginationSchema = z.strictObject({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type Pagination = z.infer<typeof paginationSchema>;
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);

export const publicAttemptSummarySchema = z.strictObject({
  steps: z.int().min(0).max(30),
  modelCalls: z.int().min(0).max(30),
  modelOperations: z.strictObject({
    decision: z.int().min(0).max(30), evaluation: z.int().min(0).max(30),
    retry: z.int().min(0).max(30), total: z.int().min(0).max(30),
  }).optional(),
  durationMs: z.number().nonnegative(),
  cleanup: z.strictObject({ status: z.enum(["closed", "failed"]) }),
  checks: z.array(criterionCheckSchema.safeExtend({
    citations: z.array(citationSchema.omit({ screenshotKey: true }).extend({
      evidenceId: idSchema.optional(),
    })).max(12).optional(),
  })).max(12),
});

const gatewayCounter = z.number().finite().nonnegative().optional();
export const gatewayMetricsSchema = z.strictObject({
  actPromptTokens: gatewayCounter, actCompletionTokens: gatewayCounter,
  actReasoningTokens: gatewayCounter, actCachedInputTokens: gatewayCounter, actInferenceTimeMs: gatewayCounter,
  extractPromptTokens: gatewayCounter, extractCompletionTokens: gatewayCounter,
  extractReasoningTokens: gatewayCounter, extractCachedInputTokens: gatewayCounter, extractInferenceTimeMs: gatewayCounter,
  observePromptTokens: gatewayCounter, observeCompletionTokens: gatewayCounter,
  observeReasoningTokens: gatewayCounter, observeCachedInputTokens: gatewayCounter, observeInferenceTimeMs: gatewayCounter,
  agentPromptTokens: gatewayCounter, agentCompletionTokens: gatewayCounter,
  agentReasoningTokens: gatewayCounter, agentCachedInputTokens: gatewayCounter, agentInferenceTimeMs: gatewayCounter,
  totalPromptTokens: gatewayCounter, totalCompletionTokens: gatewayCounter,
  totalReasoningTokens: gatewayCounter, totalCachedInputTokens: gatewayCounter, totalInferenceTimeMs: gatewayCounter,
});
