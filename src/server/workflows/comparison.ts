import type { Attempt } from "../../lib/contracts";
import { legacyDemoCriteria } from "../../lib/criteria";
import type { AgentReport, ReportCriterion, ReportGroup, RunReport } from "../../lib/report-contracts";
import { runComparisonSchema, type RerunPair, type RunComparison } from "../../lib/rerun-contracts";
import type { Repository, ReportSource } from "../repository";
import { ServiceError } from "../errors";
import { aggregateReport, canonical, criterionSignature, signature, type LoadedEvidence } from "../reports/aggregate";
import type { EvidenceLoader } from "../reports/service";

export type ComparisonSource = { source: ReportSource; loaded: LoadedEvidence[]; report: RunReport };
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function pageIdentity(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? `${url.origin}${url.pathname}` : null;
  } catch { return null; }
}
function scopeIdentity(source: ReportSource): string {
  const { scope, executionMode, controlledSiteId, executionPolicy, assetPolicy } = source.run;
  return canonical({
    executionMode, controlledSiteId: executionMode === "controlled-fixture" ? controlledSiteId ?? "store" : null,
    executionPolicy: executionPolicy ?? null, assetPolicy: assetPolicy ?? null,
    scope: { ...scope, allowedSubdomains: [...scope.allowedSubdomains].sort(), pathPrefixes: [...scope.pathPrefixes].sort() },
  });
}
function assignmentIdentity(attempt: Attempt): string {
  return canonical({ persona: attempt.persona, goal: attempt.goal, criteria: attempt.criteria, limits: attempt.limits ?? null });
}
function settled(agent: AgentReport): boolean {
  return agent.finality === "final" && agent.cleanup === "closed" &&
    !["cancelled", "blocked", "infrastructure_failed", "queued", "running"].includes(agent.status);
}
function observedPages(bundle: ComparisonSource, attemptId: string, evidenceIds?: readonly string[]): Set<string> {
  const pages = new Set<string>();
  for (const event of bundle.source.events) {
    if (event.attemptId !== attemptId || event.kind !== "attempt.observation" || !event.data.evidenceId ||
      (evidenceIds && !evidenceIds.includes(event.data.evidenceId))) continue;
    const evidence = bundle.loaded.find((entry) => entry.metadata.id === event.data.evidenceId &&
      entry.metadata.runId === bundle.source.run.id && entry.metadata.attemptId === attemptId && entry.state === "available");
    if (!record(record(evidence?.data)?.observation)) continue;
    const page = pageIdentity(event.data.pageUrl);
    if (page) pages.add(page);
  }
  return pages;
}
function citedPages(bundle: ComparisonSource, attemptId: string, criterion: ReportCriterion): Set<string> {
  return observedPages(bundle, attemptId, criterion.citations.filter((citation) => citation.state !== "missing")
    .flatMap((citation) => citation.evidenceIds));
}
function intersects(left: Set<string>, right: Set<string>): boolean {
  return [...left].some((page) => right.has(page));
}
function groupPages(bundle: ComparisonSource, group: ReportGroup): Set<string> {
  if (!["performance_signal", "subjective_friction"].includes(group.category)) {
    return new Set(group.occurrences.flatMap((occurrence) =>
      [...observedPages(bundle, occurrence.attemptId, occurrence.evidenceIds)]));
  }
  const pages = new Set<string>();
  const { scope } = bundle.source.run;
  const add = (raw?: string) => {
    const page = pageIdentity(raw);
    if (!page) return;
    const sig = signature({
      version: "finding-v2", scope: { ...scope, allowedSubdomains: [...scope.allowedSubdomains].sort(), pathPrefixes: [...scope.pathPrefixes].sort() },
      category: group.category, page, element: null, criterion: null,
      failure: group.category === "performance_signal" ? "slow_request" : "persona_give_up",
    });
    if (sig === group.signature) pages.add(page);
  };
  for (const occurrence of group.occurrences) {
    if (group.category === "subjective_friction") {
      for (const event of bundle.source.events) {
        if (event.attemptId === occurrence.attemptId && event.data.evidenceId && occurrence.evidenceIds.includes(event.data.evidenceId)) add(event.data.pageUrl);
      }
    } else for (const item of bundle.loaded) {
      if (item.metadata.attemptId !== occurrence.attemptId || item.state !== "available" || !occurrence.evidenceIds.includes(item.metadata.id)) continue;
      const telemetry = record(item.data)?.telemetry;
      if (Array.isArray(telemetry)) for (const entry of telemetry) {
        const value = record(entry);
        if (typeof value?.url === "string") add(value.url);
      }
    }
  }
  return pages;
}
type Pair = {
  ids: RerunPair; comparable: boolean; parent: AgentReport; child: AgentReport;
  parentAttempt: Attempt; childAttempt: Attempt;
  parentHumanAssisted: boolean; childHumanAssisted: boolean;
};

/** All page matching uses persisted private context; browser display strings are never identities. */
export function compareReports(before: ComparisonSource, after: ComparisonSource, lineage: readonly RerunPair[]): RunComparison {
  const versionsMatch = [before.report, after.report].every((report) =>
    report.version === "report-v1" && report.signatureVersion === "finding-v2");
  const scopeMatches = versionsMatch &&
    before.source.run.executionMode !== "public-readonly" && after.source.run.executionMode !== "public-readonly" &&
    scopeIdentity(before.source) === scopeIdentity(after.source);
  const pairs: Pair[] = lineage.map((ids) => {
    const parent = before.report.agents.find((agent) => agent.attemptId === ids.parentAttemptId);
    const child = after.report.agents.find((agent) => agent.attemptId === ids.childAttemptId);
    const parentAttempt = before.source.attempts.find((attempt) => attempt.id === ids.parentAttemptId);
    const childAttempt = after.source.attempts.find((attempt) => attempt.id === ids.childAttemptId);
    if (!parent || !child || !parentAttempt || !childAttempt) throw new ServiceError("not_found", 404);
    return { ids, parent, child, parentAttempt, childAttempt,
      parentHumanAssisted: before.source.humanAssistedAttemptIds?.includes(parent.attemptId) ?? false,
      childHumanAssisted: after.source.humanAssistedAttemptIds?.includes(child.attemptId) ?? false,
      comparable: scopeMatches && assignmentIdentity(parentAttempt) === assignmentIdentity(childAttempt) };
  });
  const criteria = pairs.map((pair) => ({
    ...pair.ids, comparable: pair.comparable && !pair.parentHumanAssisted && !pair.childHumanAssisted,
    parentHumanAssisted: pair.parentHumanAssisted, childHumanAssisted: pair.childHumanAssisted,
    criteria: pair.parent.criteria.map((criterion) => {
      const other = pair.child.criteria.find((entry) => entry.definitionSignature === criterion.definitionSignature &&
        entry.semantics === criterion.semantics);
      const comparable = pair.comparable && !!other && !pair.parentHumanAssisted && !pair.childHumanAssisted;
      const tested = comparable && settled(pair.child) && !!other && ["met", "not_met"].includes(other.status) &&
        intersects(citedPages(before, pair.parent.attemptId, criterion), citedPages(after, pair.child.attemptId, other));
      return {
        definitionSignature: criterion.definitionSignature, semantics: criterion.semantics,
        before: criterion.status, after: other?.status ?? null, comparable, tested,
        confirmedMet: tested && other?.status === "met",
      };
    }),
  }));
  const groups: RunComparison["groups"] = [];
  const groupSignatures = new Set([...before.report.groups, ...after.report.groups].map((group) => group.signature));
  for (const sig of groupSignatures) {
    const previous = before.report.groups.find((group) => group.signature === sig);
    const next = after.report.groups.find((group) => group.signature === sig);
    const group = previous ?? next!;
    const context = previous ? groupPages(before, previous) : groupPages(after, next!);
    const eligible = pairs.filter((pair) => pair.comparable &&
      (!group.criterionSignature || pair.parent.criteria.some((criterion) => criterion.definitionSignature === group.criterionSignature)));
    const measure = (bundle: ComparisonSource, side: "parent" | "child", found: ReportGroup | undefined) => {
      let tested = 0, confirmed = 0;
      for (const pair of eligible) {
        const agent = pair[side];
        if (pair.parentHumanAssisted || pair.childHumanAssisted) continue;
        if (!settled(agent) || !context.size) continue;
        if (group.criterionSignature) {
          const criterion = agent.criteria.find((entry) => entry.definitionSignature === group.criterionSignature);
          if (!criterion || !["met", "not_met"].includes(criterion.status) ||
            !intersects(context, citedPages(bundle, agent.attemptId, criterion))) continue;
          tested++;
          if (criterion.status === "met") confirmed++;
        } else {
          const occurred = found?.occurrences.some((occurrence) => occurrence.attemptId === agent.attemptId);
          if (!occurred && !intersects(context, observedPages(bundle, agent.attemptId))) continue;
          tested++;
          // Only the trusted store oracle can positively confirm this known functional defect's repair.
          if (group.category !== "functional_defect" || bundle.source.run.executionMode !== "controlled-fixture" ||
            (bundle.source.run.controlledSiteId && bundle.source.run.controlledSiteId !== "store") ||
            !context.has("https://fixture.flash-flood.invalid/demo/cart")) continue;
          const definition = criterionSignature(legacyDemoCriteria[0], bundle.source.run.scope);
          const coupon = agent.criteria.find((entry) => entry.definitionSignature === definition &&
            entry.status === "met" && entry.method === "legacy");
          if (coupon && intersects(context, citedPages(bundle, agent.attemptId, coupon))) confirmed++;
        }
      }
      return {
        assigned: pairs.length, eligible: eligible.length, tested, notTested: eligible.length - tested,
        affected: new Set(found?.occurrences.filter((occurrence) =>
          pairs.some((pair) => pair[side].attemptId === occurrence.attemptId)).map((occurrence) => occurrence.attemptId) ?? []).size,
        confirmed,
      };
    };
    const parentCounts = measure(before, "parent", previous);
    const childCounts = measure(after, "child", next);
    const humanAssisted = eligible.some((pair) => pair.parentHumanAssisted || pair.childHumanAssisted);
    const comparable = scopeMatches && context.size > 0 && eligible.length > 0 && !humanAssisted;
    let state: RunComparison["groups"][number]["state"] = "not_observed";
    let explanation = "No matching finding was observed. Absence alone is not a fix; diagnostic, performance and subjective signals have no repair oracle.";
    if (!comparable) {
      state = "not_comparable";
      explanation = humanAssisted
        ? "This selected cohort includes durable human intervention. Its observations are not evidence of an agent-only fix or pure persona improvement."
        : "Definition, assignment, execution policy, navigation scope or known page coverage is incompatible or unsupported. Unknown pages are attempt-specific, not cross-run identities.";
    } else if (childCounts.affected) {
      state = parentCounts.affected ? "persists" : "new";
      explanation = state === "persists" ? "The same versioned finding was observed in the selected immutable cohort." :
        "Newly observed in this cohort; this alone is not proof of a regression.";
    } else if (parentCounts.affected && childCounts.confirmed === eligible.length &&
      ["criterion_unmet", "functional_defect"].includes(group.category)) {
      state = "confirmed_fixed";
      explanation = group.category === "functional_defect"
        ? "The trusted store coupon oracle positively confirmed the affected behavior in every eligible selected rerun attempt."
        : "The exact criterion was positively met with comparable persisted page coverage in every eligible selected rerun attempt. This is not a general defect verdict.";
    }
    groups.push({ signature: sig, category: group.category, title: group.title, state, before: parentCounts, after: childCounts, explanation });
  }
  return runComparisonSchema.parse({
    version: "comparison-v1", reportVersion: "report-v1", signatureVersion: "finding-v2", criterionVersion: "criterion-v1",
    parentRunId: before.source.run.id, childRunId: after.source.run.id,
    parentRevision: before.report.revision, childRevision: after.report.revision, context: "fresh",
    parentFinality: before.report.finality, childFinality: after.report.finality,
    comparable: scopeMatches && pairs.length > 0 && pairs.every((pair) => pair.comparable && !pair.parentHumanAssisted && !pair.childHumanAssisted),
    pairs: criteria, groups,
    notices: [
      "Only selected immutable parent assignments are compared. Other parent attempts are outside this rerun cohort.",
      "All five criterion statuses and milestone/current semantics are preserved. Unknown, cancelled, infrastructure-failed or unsettled outcomes never establish a fix.",
      "A missing finding is not a fix. Confirmation requires actual comparable persisted observations, not only a completed run.",
      "Diagnostics, performance signals and subjective friction remain separate from trusted functional defects and unmet criteria.",
      "Known-page identities use original private source context. Only opaque versioned signatures leave the server.",
      "Human-assisted attempts are explicitly marked and excluded from agent-only confirmation, even after control returns to the agent.",
    ],
  });
}

export class ComparisonService {
  constructor(
    private readonly repository: Repository,
    private readonly load: EvidenceLoader,
    private readonly knownSecrets: readonly string[] = [],
  ) {}

  compare(owner: string, parentRunId: string, childRunId: string): RunComparison {
    const parent = this.repository.getRun(owner, parentRunId);
    const child = this.repository.getRun(owner, childRunId);
    if (parent.executionMode === "public-readonly" || child.executionMode === "public-readonly") {
      throw new ServiceError("public_comparison_unsupported", 400);
    }
    const lineage = this.repository.rerunLineage(owner, parentRunId, childRunId);
    const read = (runId: string): ComparisonSource => {
      const source = this.repository.reportSource(owner, runId);
      const loaded = source.evidence.map((entry) => this.load(entry));
      const sessionIds = source.attempts.flatMap((attempt) => {
        const session = this.repository.recordingSession(owner, runId, attempt.id);
        return session ? [session.sessionId] : [];
      });
      const report = aggregateReport(source, loaded, [...this.knownSecrets, ...sessionIds]);
      return { source, loaded, report };
    };
    return compareReports(read(parentRunId), read(childRunId), lineage);
  }
}
