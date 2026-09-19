import { z } from "zod";
import { targetScopeSchema } from "./target-scope";

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
export const assignmentSchema = z.strictObject({
  personaId: personaIdSchema,
  goal: text(2000),
  criteria: z.array(text(500)).min(1).max(12),
});
export const createRunSchema = z.strictObject({
  authorizationAcknowledged: z.literal(true),
  scope: targetScopeSchema,
  assignments: z.array(assignmentSchema).min(1).max(12),
}).refine((value) => new Set(value.assignments.map((entry) => entry.personaId)).size === value.assignments.length,
  "Each persona may appear only once");
export type CreateRun = z.infer<typeof createRunSchema>;
export const runSchema = z.strictObject({
  id: idSchema,
  cursor: z.int().positive(),
  status: statusSchema,
  authorizationAcknowledged: z.literal(true),
  scope: targetScopeSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  cancelRequestedAt: timestampSchema.nullable(),
});
export type Run = z.infer<typeof runSchema>;
export const attemptSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  persona: personaSchema,
  goal: text(2000),
  criteria: z.array(text(500)).min(1).max(12),
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
  ]),
  data: z.strictObject({
    status: statusSchema.optional(),
    evidenceId: idSchema.optional(),
    findingId: idSchema.optional(),
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
