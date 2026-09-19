import { z } from "zod";
import { idSchema, statusSchema, timestampSchema } from "./contracts";

export const REPORT_VERSION = "report-v1" as const;
export const SIGNATURE_VERSION = "finding-v2" as const;
export const evidenceStateSchema = z.enum(["available", "missing", "unavailable", "unsupported"]);
export const reportEvidenceSchema = z.strictObject({
  id: idSchema,
  attemptId: idSchema,
  kind: z.enum(["screenshot", "console", "network", "recording", "observation"]),
  createdAt: timestampSchema,
  state: evidenceStateSchema,
  sensitivity: z.enum(["private_pixels", "redacted_text", "unavailable"]),
});
export type ReportEvidence = z.infer<typeof reportEvidenceSchema>;
export const reportCitationSchema = z.strictObject({
  step: z.int().nonnegative(),
  observationId: z.string(),
  page: z.string().nullable(),
  excerpt: z.string(),
  evidenceIds: z.array(idSchema),
  state: z.enum(["available", "partial", "missing"]),
});
export const reportCriterionSchema = z.strictObject({
  key: z.string(),
  definitionSignature: z.string(),
  description: z.string(),
  semantics: z.enum(["milestone", "current"]),
  status: z.enum(["met", "not_met", "not_observed", "inconclusive", "unsupported"]),
  method: z.enum(["structural", "semantic", "legacy"]),
  confidence: z.number().min(0).max(1).nullable(),
  confidenceMeaning: z.literal("heuristic"),
  explanation: z.string(),
  uncertainty: z.string().nullable(),
  citations: z.array(reportCitationSchema),
});
export type ReportCriterion = z.infer<typeof reportCriterionSchema>;
export const findingCategorySchema = z.enum([
  "functional_defect", "performance_signal", "accessibility_observation",
  "subjective_friction", "diagnostic_signal", "criterion_unmet",
]);
export const reportOccurrenceSchema = z.strictObject({
  attemptId: idSchema,
  personaId: z.string(),
  evidenceIds: z.array(idSchema),
  step: z.int().nonnegative().nullable(),
});
export const reportGroupSchema = z.strictObject({
  signature: z.string(),
  signatureVersion: z.literal(SIGNATURE_VERSION),
  category: findingCategorySchema,
  title: z.string(),
  explanation: z.string(),
  page: z.string().nullable(),
  element: z.string().nullable(),
  criterionSignature: z.string().nullable(),
  occurrences: z.array(reportOccurrenceSchema),
  counts: z.strictObject({
    occurrences: z.int().nonnegative(),
    affectedAttempts: z.int().nonnegative(),
    affectedPersonas: z.int().nonnegative(),
    assignedAttempts: z.int().nonnegative(),
    assignedPersonas: z.int().nonnegative(),
    eligibleAttempts: z.int().nonnegative(),
    eligiblePersonas: z.int().nonnegative(),
    testedAttempts: z.int().nonnegative(),
    testedPersonas: z.int().nonnegative(),
    notTestedAttempts: z.int().nonnegative(),
    notTestedPersonas: z.int().nonnegative(),
    outOfCohortAttempts: z.int().nonnegative(),
  }),
});
export type ReportGroup = z.infer<typeof reportGroupSchema>;
export const reportTimelineSchema = z.strictObject({
  sequence: z.int().positive(),
  timestamp: timestampSchema,
  kind: z.string(),
  actor: z.enum(["agent", "human", "system"]).nullable(),
  step: z.int().nonnegative().nullable(),
  action: z.string().nullable(),
  commentary: z.string().nullable(),
  page: z.string().nullable(),
  evidenceId: idSchema.nullable(),
  evidenceState: z.enum(["available", "missing", "unavailable", "unsupported"]).nullable(),
});
export const agentReportSchema = z.strictObject({
  attemptId: idSchema,
  persona: z.strictObject({ id: z.string(), name: z.string(), device: z.enum(["phone", "desktop"]) }),
  goal: z.string(),
  status: statusSchema,
  finality: z.enum(["in_progress", "settling", "final", "uncertain"]),
  launchState: z.string(),
  cleanup: z.enum(["closed", "failed", "unknown"]),
  steps: z.int().nonnegative(),
  modelCalls: z.int().nonnegative(),
  criteria: z.array(reportCriterionSchema),
  timeline: z.array(reportTimelineSchema),
  evidence: z.array(reportEvidenceSchema),
  groupSignatures: z.array(z.string()),
});
export type AgentReport = z.infer<typeof agentReportSchema>;
export const runReportSchema = z.strictObject({
  version: z.literal(REPORT_VERSION),
  signatureVersion: z.literal(SIGNATURE_VERSION),
  runId: idSchema,
  revision: z.string(),
  status: statusSchema,
  finality: z.enum(["in_progress", "settling", "final", "uncertain"]),
  target: z.string(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  agents: z.array(agentReportSchema),
  groups: z.array(reportGroupSchema),
  notices: z.array(z.string()),
});
export type RunReport = z.infer<typeof runReportSchema>;
export const evidenceDetailSchema = z.strictObject({
  evidence: reportEvidenceSchema,
  runId: idSchema,
  text: z.string().nullable(),
  references: z.array(z.strictObject({
    evidenceId: idSchema.nullable(),
    state: z.enum(["available", "missing", "unavailable", "unsupported"]),
  })),
  notice: z.string(),
});
export type EvidenceDetail = z.infer<typeof evidenceDetailSchema>;
