import { createHash } from "node:crypto";
import { z } from "zod";
import type { Attempt, RunEvent } from "../../lib/contracts";
import { citationSchema, criterionKey, criterionDescription, criterionStatus, isLegacyCriterion, criterionCheckSchema, type Criterion } from "../../lib/criteria";
import {
  REPORT_VERSION, SIGNATURE_VERSION, runReportSchema, type AgentReport, type ReportCriterion,
  type ReportEvidence, type ReportGroup, type RunReport,
} from "../../lib/report-contracts";
import type { ReportSource, StoredEvidence } from "../repository";
import { sanitizeEvidence } from "../execution/artifacts";
import { publicPageUrl } from "../public-page-url";

export type LoadedEvidence = StoredEvidence & {
  state: ReportEvidence["state"];
  data?: unknown;
};
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const signature = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function criterionSignature(criterion: Criterion, scope: ReportSource["run"]["scope"]): string {
  return signature({ version: "criterion-v1", definition: criterion, scope: {
    ...scope, allowedSubdomains: [...scope.allowedSubdomains].sort(), pathPrefixes: [...scope.pathPrefixes].sort(),
  } });
}
export function reportText(value: string, secrets: readonly string[] = []): string {
  const encodedSecrets = secrets.flatMap((secret) => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    return [secret, escaped, JSON.stringify(escaped).slice(1, -1)];
  });
  return String(sanitizeEvidence(value, encodedSecrets))
    .replace(/[a-f0-9]{64}/gi, "[PRIVATE_REFERENCE]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\beyJ[A-Za-z0-9_.-]{16,}/g, "[REDACTED]");
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function identityPage(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? `${url.origin}${url.pathname}` : null;
  } catch {
    return null;
  }
}
const observationSchema = z.object({
  id: z.string(), screenshotKey: z.string().optional(),
  checks: z.array(criterionCheckSchema.safeExtend({
    citations: z.array(citationSchema.extend({
      pageUrl: z.union([z.url().max(4096), z.literal("[REDACTED_URL]")]),
    })).max(12).optional(),
  })).max(12),
  signals: z.array(z.object({ kind: z.string(), message: z.string(), evidence: z.string().optional() })).max(64),
});
type ObservationRecord = {
  event: RunEvent;
  evidence: LoadedEvidence;
  observation: z.infer<typeof observationSchema>;
  step: number;
};
export function typedSecrets(evidence: readonly LoadedEvidence[]): string[] {
  const values: string[] = [];
  for (const item of evidence) {
    const data = record(item.data);
    for (const field of ["action", "decision"]) {
      const action = record(data?.[field]);
      if (action && ["type", "select"].includes(String(action.action)) &&
        typeof action.value === "string" && action.value && !action.value.startsWith("[REDACTED")) values.push(action.value);
    }
  }
  return [...new Set(values)];
}
export function evidenceMetadata(item: LoadedEvidence): ReportEvidence {
  return {
    id: item.metadata.id, attemptId: item.metadata.attemptId, kind: item.metadata.kind,
    createdAt: item.metadata.createdAt, state: item.state,
    sensitivity: item.state !== "available" ? "unavailable" :
      item.metadata.kind === "screenshot" ? "private_pixels" : "redacted_text",
  };
}
function finality(attempt: Attempt, summary: ReportSource["summaries"][number] | undefined): AgentReport["finality"] {
  if (summary && ["recovering", "quarantined"].includes(summary.launchState)) return "uncertain";
  if (attempt.status === "queued" || attempt.status === "running") return "in_progress";
  if (summary && !["settled", "not_launched"].includes(summary.launchState)) return "settling";
  return "final";
}
function observations(attempt: Attempt, source: ReportSource, evidence: LoadedEvidence[]): ObservationRecord[] {
  const byId = new Map(evidence.map((entry) => [entry.metadata.id, entry]));
  let step = 0;
  const result: ObservationRecord[] = [];
  for (const event of source.events.filter((entry) => entry.attemptId === attempt.id)) {
    if (event.kind === "attempt.action" && event.data.step !== undefined) step = event.data.step;
    if (event.kind !== "attempt.observation" || !event.data.evidenceId) continue;
    const stored = byId.get(event.data.evidenceId);
    if (!stored || stored.state !== "available" || stored.metadata.attemptId !== attempt.id) continue;
    const parsed = observationSchema.safeParse(record(stored.data)?.observation);
    if (parsed.success) result.push({ event, evidence: stored, observation: parsed.data, step });
  }
  return result;
}
export function aggregateReport(source: ReportSource, loaded: LoadedEvidence[], knownSecrets: readonly string[] = []): RunReport {
  const secrets = [...knownSecrets, ...typedSecrets(loaded)];
  const text = (value: string) => reportText(value, secrets);
  const observationId = (value: string) => /^[a-f0-9]{64}$/.test(value) ? value : text(value);
  const page = (value?: string) => value ? publicPageUrl(value, secrets) ?? null : null;
  const byId = new Map(loaded.map((entry) => [entry.metadata.id, entry]));
  const groups = new Map<string, ReportGroup>();
  // Identity/cohort context stays private; display redaction must not influence comparison keys.
  const groupPages = new Map<string, { page: string | null; attemptId: string }>();
  type Citation = ReportCriterion["citations"][number];
  const citationPages = new Map<Citation, string | null>();
  const cite = (citation: Citation, originalPage?: string): Citation => {
    citationPages.set(citation, identityPage(originalPage));
    return citation;
  };
  const observedByAttempt = new Map<string, ObservationRecord[]>();
  const agents: AgentReport[] = source.attempts.map((attempt) => {
    const summary = source.summaries.find((entry) => entry.attemptId === attempt.id);
    const result = source.results.find((entry) => entry.attemptId === attempt.id)?.result;
    const evidence = loaded.filter((entry) => entry.metadata.attemptId === attempt.id);
    const observed = observations(attempt, source, evidence);
    observedByAttempt.set(attempt.id, observed);
    const byKey = new Map(evidence.map((entry) => [entry.storageKey, entry]));
    const criteria: ReportCriterion[] = attempt.criteria.map((criterion) => {
      const key = criterionKey(criterion);
      const matches = result?.checks.filter((check) => check.criterion === key) ?? [];
      const check = matches.length === 1 ? matches[0] : undefined;
      const expectedMethod = isLegacyCriterion(criterion) ? "legacy" :
        typeof criterion === "string" || criterion.kind === "semantic" ? "semantic" : "structural";
      const method = check?.method === "deterministic" ? "structural" : check?.method ?? expectedMethod;
      const status = criterionStatus(check);
      const semantics = typeof criterion === "string" ? isLegacyCriterion(criterion) ? "milestone" : "current" : criterion.semantics;
      const matching = observed.filter(({ observation }) => observation.checks.some((entry) =>
        entry.criterion === key && check && criterionStatus(entry) === status &&
        entry.evidence === String(sanitizeEvidence(check.evidence, knownSecrets))));
      const explicit = check?.citations ?? [];
      const citations: ReportCriterion["citations"] = explicit.length ? explicit.map((citation) => {
        const observation = observed.find((entry) => entry.observation.id === citation.observationId &&
          entry.step === citation.step && entry.event.data.pageUrl === publicPageUrl(citation.pageUrl));
        const screenshot = citation.screenshotKey ? byKey.get(citation.screenshotKey) : undefined;
        const validScreenshot = screenshot?.metadata.kind === "screenshot" &&
          observation?.observation.screenshotKey === screenshot.storageKey ? screenshot : undefined;
        const refs = [observation?.evidence, validScreenshot].filter((entry): entry is LoadedEvidence => !!entry);
        return cite({
          step: citation.step, observationId: observationId(citation.observationId), page: page(observation?.event.data.pageUrl),
          excerpt: text(citation.excerpt), evidenceIds: refs.map((entry) => entry.metadata.id),
          state: !observation ? "missing" : refs.some((entry) => entry.state !== "available") ||
            (!!citation.screenshotKey && !validScreenshot) ? "partial" : "available",
        }, observation?.event.data.pageUrl);
      }) : matching.slice(-1).map((entry) => {
        const screenshot = entry.observation.screenshotKey ? byKey.get(entry.observation.screenshotKey) : undefined;
        const refs = [entry.evidence, ...(screenshot?.metadata.kind === "screenshot" ? [screenshot] : [])];
        return cite({
          step: entry.step, observationId: observationId(entry.observation.id), page: page(entry.event.data.pageUrl),
          excerpt: text(check?.evidence ?? ""), evidenceIds: refs.map((ref) => ref.metadata.id),
          state: entry.observation.screenshotKey && !screenshot || refs.some((ref) => ref.state !== "available") ? "partial" : "available",
        }, entry.event.data.pageUrl);
      });
      return {
        key: text(key), definitionSignature: criterionSignature(criterion, source.run.scope),
        description: text(criterionDescription(criterion)), semantics, status, method,
        confidence: check?.confidence ?? null, confidenceMeaning: "heuristic",
        explanation: check?.evidence ? text(check.evidence) : "No persisted observed evaluation for this criterion.",
        uncertainty: check?.uncertainty ? text(check.uncertainty) : null, citations,
      };
    });
    return {
      attemptId: attempt.id, persona: { id: attempt.persona.id, name: text(attempt.persona.name), device: attempt.persona.device },
      goal: text(attempt.goal), status: attempt.status, finality: finality(attempt, summary),
      launchState: summary?.launchState ?? "not_launched", cleanup: summary?.summary?.cleanup.status ?? "unknown",
      steps: result?.steps ?? 0, modelCalls: result?.modelCalls ?? 0, criteria,
      timeline: source.events.filter((event) => event.attemptId === attempt.id).map((event) => {
        const linked = event.data.evidenceId ? byId.get(event.data.evidenceId) : undefined;
        const valid = linked?.metadata.attemptId === attempt.id ? linked : undefined;
        return {
          sequence: event.sequence, timestamp: event.timestamp, kind: event.kind, actor: event.data.actor ?? null,
          step: event.data.step ?? null, action: event.data.action ?? null,
          commentary: event.data.commentary ? text(event.data.commentary) : null, page: page(event.data.pageUrl),
          evidenceId: valid?.metadata.id ?? null,
          evidenceState: valid?.state ?? (event.kind.startsWith("attempt.") && ["attempt.observation", "attempt.action", "attempt.decision"].includes(event.kind) ? "missing" : null),
        };
      }),
      evidence: evidence.map(evidenceMetadata), groupSignatures: [],
    };
  });
  function add(agent: AgentReport, input: {
    category: ReportGroup["category"]; title: string; explanation: string; page: string | null;
    element?: string; criterionSignature?: string; failure: string; evidenceIds: string[]; step: number | null; occurrenceKey: string;
  }) {
    const originalPage = identityPage(input.page);
    const sig = signature({ version: SIGNATURE_VERSION, scope: {
      ...source.run.scope, allowedSubdomains: [...source.run.scope.allowedSubdomains].sort(), pathPrefixes: [...source.run.scope.pathPrefixes].sort(),
    }, category: input.category, page: originalPage ?? { unknownAttempt: agent.attemptId },
    element: input.element ?? null, criterion: input.criterionSignature ?? null, failure: input.failure });
    let group = groups.get(sig);
    if (!group) {
      group = {
        signature: sig, signatureVersion: SIGNATURE_VERSION, category: input.category, title: input.title,
        explanation: input.explanation, page: page(originalPage ?? undefined),
        element: input.element === undefined ? null : text(input.element),
        criterionSignature: input.criterionSignature ?? null, occurrences: [],
        counts: { occurrences: 0, affectedAttempts: 0, affectedPersonas: 0, assignedAttempts: 0, assignedPersonas: 0,
          eligibleAttempts: 0, eligiblePersonas: 0, testedAttempts: 0, testedPersonas: 0, notTestedAttempts: 0, notTestedPersonas: 0, outOfCohortAttempts: 0 },
      };
      groups.set(sig, group);
      groupPages.set(sig, { page: originalPage, attemptId: agent.attemptId });
    }
    const identity = `${sig}:${agent.attemptId}:${input.occurrenceKey}`;
    if (occurrenceKeys.has(identity)) return;
    occurrenceKeys.add(identity);
    group.occurrences.push({ attemptId: agent.attemptId, personaId: agent.persona.id, evidenceIds: input.evidenceIds, step: input.step });
    if (!agent.groupSignatures.includes(sig)) agent.groupSignatures.push(sig);
  }
  const occurrenceKeys = new Set<string>();
  for (const agent of agents) {
    if (agent.finality !== "final" || ["cancelled", "blocked", "infrastructure_failed", "queued", "running"].includes(agent.status)) continue;
    const observed = observedByAttempt.get(agent.attemptId)!;
    for (const criterion of agent.criteria) {
      if (criterion.status !== "not_met") continue;
      const cited = criterion.citations.filter((citation) => citation.state !== "missing");
      if (!cited.length) continue;
      const definition = source.attempts.find((entry) => entry.id === agent.attemptId)!.criteria.find((item) =>
        criterionSignature(item, source.run.scope) === criterion.definitionSignature);
      add(agent, {
        category: "criterion_unmet", title: criterion.description,
        explanation: "The criterion was not met in the cited observation. An incomplete task is not proof of a target defect.",
        page: citationPages.get(cited.at(-1)!) ?? null,
        element: typeof definition === "object" && definition.kind === "control" ? definition.label : undefined,
        criterionSignature: criterion.definitionSignature, failure: "not_met",
        evidenceIds: [...new Set(cited.flatMap((citation) => citation.evidenceIds))], step: cited.at(-1)!.step, occurrenceKey: criterion.definitionSignature,
      });
    }
    for (const entry of observed) {
      for (const signal of entry.observation.signals) {
        const confirmed = agent.status === "target_failed" && signal.kind === "functional_failure" &&
          signal.message === "FF_DEMO_SECOND_COUPON" && source.run.executionMode === "controlled-fixture" &&
          (!source.run.controlledSiteId || source.run.controlledSiteId === "store") &&
          entry.event.data.pageUrl === "https://fixture.flash-flood.invalid/demo/cart";
        if (!confirmed && !["http", "console", "network"].includes(signal.kind)) continue;
        add(agent, {
          category: confirmed ? "functional_defect" : "diagnostic_signal",
          title: confirmed ? "Second coupon application throws the verified fixture exception" : "Browser diagnostic signal",
          explanation: confirmed ? "The trusted fixture verifier recorded its exact functional-failure code; the durable outcome is target_failed." :
            "An HTTP, console or network diagnostic is not independently proof of a functional defect.",
          page: entry.event.data.pageUrl ?? null, element: confirmed ? "Apply coupon" : undefined,
          failure: `${signal.kind}:${signal.message}`, evidenceIds: [entry.evidence.metadata.id], step: entry.step,
          occurrenceKey: `${entry.observation.id}:${signal.evidence ?? signal.message}`,
        });
      }
    }
    for (const item of loaded.filter((entry) => entry.metadata.attemptId === agent.attemptId && entry.state === "available")) {
      const telemetry = record(item.data)?.telemetry;
      if (!Array.isArray(telemetry)) continue;
      for (const raw of telemetry) {
        const entry = record(raw);
        if (entry?.kind !== "slow_request" || entry.code !== "SLOW_REQUEST" ||
          typeof entry.durationMs !== "number" || !Number.isFinite(entry.durationMs) || entry.durationMs < 1000 ||
          typeof entry.url !== "string" || typeof entry.actionId !== "string" || typeof entry.timestamp !== "string") continue;
        add(agent, {
          category: "performance_signal", title: "Request duration reached the driver's 1,000 ms signal threshold",
          explanation: "A measured request duration is a performance signal, not a user conversion rate or a confirmed functional defect.",
          page: entry.url, failure: "slow_request", evidenceIds: [item.metadata.id], step: null,
          occurrenceKey: `${entry.actionId}:${entry.timestamp}:${entry.url}`,
        });
      }
    }
    if (agent.status === "gave_up") {
      const decision = agent.timeline.findLast((entry) => entry.action === "give_up" && entry.evidenceId);
      if (decision?.evidenceId) add(agent, {
        category: "subjective_friction", title: "Persona chose to stop",
        explanation: "This is the recorded simulated persona's choice, not a judgment about real users or a confirmed defect.",
        page: source.events.find((event) => event.attemptId === agent.attemptId && event.sequence === decision.sequence)?.data.pageUrl ?? null,
        failure: "persona_give_up", evidenceIds: [decision.evidenceId], step: decision.step, occurrenceKey: "give_up",
      });
    }
  }
  for (const group of groups.values()) {
    const context = groupPages.get(group.signature)!;
    const samePage = (agent: AgentReport, originalPage: string | null) =>
      originalPage === context.page && (context.page !== null || context.attemptId === agent.attemptId);
    const eligible = agents.filter((agent) => !group.criterionSignature ||
      agent.criteria.some((criterion) => criterion.definitionSignature === group.criterionSignature));
    const tested = eligible.filter((agent) => {
      if (["cancelled", "blocked", "infrastructure_failed", "queued", "running"].includes(agent.status) || agent.finality !== "final") return false;
      return group.criterionSignature ? agent.criteria.some((criterion) =>
        criterion.definitionSignature === group.criterionSignature && ["met", "not_met"].includes(criterion.status) &&
        criterion.citations.some((citation) => citation.state !== "missing" && samePage(agent, citationPages.get(citation) ?? null))) :
        (observedByAttempt.get(agent.attemptId) ?? []).some((entry) => samePage(agent, identityPage(entry.event.data.pageUrl))) ||
          group.occurrences.some((occurrence) => occurrence.attemptId === agent.attemptId);
    });
    const notTested = eligible.filter((agent) => !tested.includes(agent));
    group.counts = {
      occurrences: group.occurrences.length,
      affectedAttempts: new Set(group.occurrences.map(({ attemptId }) => attemptId)).size,
      affectedPersonas: new Set(group.occurrences.map(({ personaId }) => personaId)).size,
      assignedAttempts: agents.length, assignedPersonas: new Set(agents.map(({ persona }) => persona.id)).size,
      eligibleAttempts: eligible.length, eligiblePersonas: new Set(eligible.map(({ persona }) => persona.id)).size,
      testedAttempts: tested.length, testedPersonas: new Set(tested.map(({ persona }) => persona.id)).size,
      notTestedAttempts: notTested.length, notTestedPersonas: new Set(notTested.map(({ persona }) => persona.id)).size,
      outOfCohortAttempts: agents.length - eligible.length,
    };
  }
  const finalities = agents.map((agent) => agent.finality);
  const report = {
    version: REPORT_VERSION, signatureVersion: SIGNATURE_VERSION, runId: source.run.id, revision: "",
    status: source.run.status,
    finality: finalities.includes("uncertain") ? "uncertain" : finalities.includes("in_progress") ? "in_progress" :
      finalities.includes("settling") ? "settling" : "final",
    target: page(source.run.scope.targetUrl) ?? "[REDACTED_TARGET]", createdAt: source.run.createdAt, updatedAt: source.run.updatedAt,
    agents, groups: [...groups.values()].sort((a, b) => a.signature.localeCompare(b.signature)),
    notices: [
      "Reports are deterministic projections of persisted evidence. No extra model inference is used.",
      "Criterion not_met can mean an incomplete task, not a confirmed bug. Missing evidence never proves success.",
      "Confidence is heuristic, not calibrated probability. Counts describe attempts and assigned simulated personas, not affected real users.",
      "Private screenshots and recordings can contain sensitive visible text; they are not fully redacted.",
      "Text redaction is best effort. Exports omit screenshot pixels, provider URLs and raw browser payloads.",
      "Accessibility checks are not implemented; no automated accessibility findings are inferred.",
    ],
  };
  report.revision = signature(report);
  return runReportSchema.parse(report);
}
