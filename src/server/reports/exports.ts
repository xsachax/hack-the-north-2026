import type { RunReport } from "../../lib/report-contracts";

const markdownText = (value: string) => value.replace(/[\r\n]+/g, " ")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/([\\`*_{}[\]()#+\-.!|~])/g, "\\$1");

export function exportReport(report: RunReport, format: "json" | "markdown"): Response {
  const headers = {
    "Cache-Control": "no-store",
    "Vary": "Cookie, Origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Content-Disposition": `attachment; filename="flash-flood-${report.runId}.${format === "json" ? "json" : "md"}"`,
    "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
  };
  const exported = {
    ...report,
    exportPolicy: {
      version: "export-v1",
      redacted: true,
      redactionMeaning: "Best-effort text redaction, not a guarantee that arbitrary user prose contains no sensitive information.",
      omitted: ["screenshot pixels", "recording events", "provider session identifiers", "provider URLs", "raw artifacts", "typed values"],
      evidenceReferences: "Owner-only stable evidence IDs; no public download links or embedded private media.",
    },
  };
  if (format === "json") return new Response(JSON.stringify(exported, null, 2), { headers });
  const lines = [
    "# Flash Flood evidence report",
    `Run: ${report.runId}`, `Report: ${report.version}; revision ${report.revision}`,
    `Status: ${markdownText(report.status)}; finality: ${markdownText(report.finality)}`,
    "", "## Limits and redaction", ...report.notices.map((notice) => `- ${markdownText(notice)}`),
    "- Screenshot pixels, recording events, provider IDs/URLs, raw artifacts and typed values are omitted.",
    "- Stable evidence references require the original owner session. No ready-to-run reproduction is generated.",
    "", "## Grouped findings",
  ];
  if (!report.groups.length) lines.push("No evidence-backed groups were established. This is not proof the target is defect-free.");
  for (const group of report.groups) {
    lines.push("", `### ${markdownText(group.title)}`, `Category: ${markdownText(group.category)}`,
      `Signature: ${group.signatureVersion}:${group.signature}`, markdownText(group.explanation),
      `Occurrences: ${group.counts.occurrences}; affected attempts: ${group.counts.affectedAttempts}; affected personas: ${group.counts.affectedPersonas}.`,
      `Assigned attempts/personas: ${group.counts.assignedAttempts}/${group.counts.assignedPersonas}; eligible: ${group.counts.eligibleAttempts}/${group.counts.eligiblePersonas}; tested: ${group.counts.testedAttempts}/${group.counts.testedPersonas}; not tested: ${group.counts.notTestedAttempts}/${group.counts.notTestedPersonas}; outside cohort: ${group.counts.outOfCohortAttempts}.`);
    for (const occurrence of group.occurrences) lines.push(
      `- Attempt ${occurrence.attemptId}; evidence: ${occurrence.evidenceIds.join(", ") || "missing"}.`);
  }
  lines.push("", "## Per-agent reports");
  for (const agent of report.agents) {
    lines.push("", `### ${markdownText(agent.persona.name)}`, `Attempt: ${agent.attemptId}`,
      `Outcome: ${markdownText(agent.status)}; finality: ${agent.finality}; cleanup: ${agent.cleanup}.`,
      `Goal: ${markdownText(agent.goal)}`);
    for (const criterion of agent.criteria) {
      lines.push("", `#### ${markdownText(criterion.description)}`,
        `Definition: ${criterion.definitionSignature}; status: ${markdownText(criterion.status)}; method: ${criterion.method}; semantics: ${criterion.semantics}.`,
        `Heuristic confidence: ${criterion.confidence ?? "not recorded"} (not calibrated probability).`,
        markdownText(criterion.explanation));
      if (criterion.uncertainty) lines.push(`Uncertainty: ${markdownText(criterion.uncertainty)}`);
      if (!criterion.citations.length) lines.push("Citations: missing / not observed.");
      for (const citation of criterion.citations) lines.push(
        `- Step ${citation.step}; ${citation.state}; evidence: ${citation.evidenceIds.join(", ") || "missing"}; excerpt: ${markdownText(citation.excerpt)}`);
    }
    lines.push("", "Evidence inventory:");
    for (const evidence of agent.evidence) lines.push(`- ${evidence.id}: ${evidence.kind}; ${evidence.state}; ${evidence.sensitivity === "private_pixels" ? "pixels omitted, not redacted" : evidence.sensitivity}.`);
    lines.push("", "Timeline:");
    for (const event of agent.timeline) lines.push(
      `- ${event.timestamp}; ${markdownText(event.kind)}; actor: ${event.actor ?? "system"}; action: ${markdownText(event.action ?? "none")}; evidence: ${event.evidenceId ?? "none"} (${event.evidenceState ?? "not applicable"}); ${markdownText(event.commentary ?? "")}`);
  }
  return new Response(`${lines.join("\n")}\n`, { headers });
}
