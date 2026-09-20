import type { ManagedAttempt, ManagedRun } from "./managed-contracts";
import { managedLiveSummary } from "./managed-live";
import { managedSpecialistForAssignment } from "./managed-specialists";

const verdicts = { met: "MET", not_met: "NOT MET", inconclusive: "INCONCLUSIVE" } as const;
const line = (value: string) => value.replace(/\s+/g, " ").trim();
const cell = (value: string) => line(value).replaceAll("|", "\\|");
const labelFor = (attempt: ManagedAttempt) => managedSpecialistForAssignment({
  personaId: attempt.persona.id, goal: attempt.goal, criteria: attempt.criteria,
})?.label ?? attempt.persona.name;
const count = (attempt: ManagedAttempt, status: keyof typeof verdicts) =>
  attempt.result?.criteria.filter((criterion) => criterion.status === status).length ?? 0;

export function managedRunFilename(run: ManagedRun): string {
  return `flash-flood-findings-${run.id.slice(0, 8)}.md`;
}

/** Organises what the agents reported; it adds no verdicts and keeps every claim labelled as agent-reported. */
export function managedRunMarkdown(run: ManagedRun, exportedAt: Date): string {
  const at = exportedAt.getTime();
  const out: string[] = [
    `# Flash Flood findings: ${line(run.scope.targetUrl)}`, "",
    `- Run: ${run.id}`,
    `- Run status: ${run.status.replaceAll("_", " ")}`,
    `- Started: ${run.createdAt}`,
    `- Exported: ${exportedAt.toISOString()}`,
    `- Agents: ${run.attempts.length}`,
    `- Requested scope: ${line(run.scope.targetUrl)} (paths: ${run.scope.pathPrefixes.map(line).join(", ")})`, "",
    "> Agent-reported, not independently verified. Verdicts are model-authored reports from read-only browsing.",
    "> Scope and read-only behaviour were instructions, not enforced restrictions. Completion is not a success verdict.", "",
    "## Verdicts at a glance", "",
    "| Agent | Status | Met | Not met | Inconclusive | Work elapsed | Browser time |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...run.attempts.map((attempt) => {
      const live = managedLiveSummary(attempt, at);
      return `| ${cell(labelFor(attempt))} | ${attempt.status.replaceAll("_", " ")} | ${attempt.result ? count(attempt, "met") : "-"} | ${
        attempt.result ? count(attempt, "not_met") : "-"} | ${attempt.result ? count(attempt, "inconclusive") : "-"} | ${
        live.elapsedSeconds === null ? "not recorded" : `${live.elapsedSeconds} s`} | ${
        attempt.actualBrowserSeconds === null ? "unavailable" : `${attempt.actualBrowserSeconds.toFixed(2)} s`} |`;
    }), "",
    "## Problems reported (criteria marked not met)", "",
  ];
  const problems = run.attempts.flatMap((attempt) => (attempt.result?.criteria ?? [])
    .filter((criterion) => criterion.status === "not_met")
    .map((criterion) => `- **${line(labelFor(attempt))}**: ${line(criterion.observation)}\n  - Criterion: ${line(criterion.criterion)}`));
  out.push(...(problems.length ? problems : ["No criterion was reported not met."]), "");
  for (const attempt of run.attempts) {
    const live = managedLiveSummary(attempt, at);
    const label = labelFor(attempt);
    out.push(`## ${line(label)}${label === attempt.persona.name ? "" : ` (persona: ${line(attempt.persona.name)})`}`, "",
      `- Status: ${attempt.status.replaceAll("_", " ")} (provider: ${attempt.providerStatus ?? "not reported"})`,
      `- Work elapsed: ${live.elapsedSeconds === null ? "not recorded" : `${live.elapsedSeconds} s`} (includes startup and cleanup)`,
      `- Browser time: ${attempt.actualBrowserSeconds === null ? "unavailable" : `${attempt.actualBrowserSeconds.toFixed(2)} s`}`,
      `- Browser cleanup: ${attempt.cleanup.replaceAll("_", " ")}`,
      "- Model calls: unknown (not reported)", "",
      `**Mission:** ${line(attempt.goal)}`, "");
    if (attempt.error) out.push(`**Recorded error:** ${line(attempt.error)}`, "");
    if (attempt.result) {
      out.push(`**Agent-reported summary:** ${line(attempt.result.summary)}`, "", "### Criteria", "");
      attempt.result.criteria.forEach((criterion, index) => out.push(
        `${index + 1}. **${verdicts[criterion.status]}**: ${line(criterion.criterion)}`,
        `   - Observation: ${line(criterion.observation)}`));
      if (attempt.result.finalUrl) out.push("", `Agent-reported final URL (not opened): ${line(attempt.result.finalUrl)}`);
      if (attempt.result.limitations.length) {
        out.push("", "### Reported limitations", "", ...attempt.result.limitations.map((item) => `- ${line(item)}`));
      }
    } else {
      out.push("No agent-reported result is available. Provider completion alone does not mean a criterion was met.", "",
        "### Requested criteria", "", ...attempt.criteria.map((criterion, index) => `${index + 1}. ${line(criterion)}`));
    }
    out.push("", "### Activity log", "");
    out.push(...(attempt.progress.length
      ? attempt.progress.map((event) => `- ${event.timestamp} [${event.kind}] ${line(event.text)}`)
      : ["No provider progress was recorded."]), "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}
