import type { EvidenceDetail } from "../../lib/report-contracts";
import type { Repository, StoredEvidence } from "../repository";
import { ServiceError } from "../errors";
import { aggregateReport, evidenceMetadata, reportText, typedSecrets, type LoadedEvidence } from "./aggregate";

export type EvidenceLoader = (entry: StoredEvidence) => LoadedEvidence;

export class ReportService {
  constructor(
    private readonly repository: Repository,
    private readonly load: EvidenceLoader,
    private readonly knownSecrets: readonly string[] = [],
  ) {}

  report(owner: string, runId: string) {
    const source = this.repository.reportSource(owner, runId);
    const loaded = source.evidence.map((entry) => this.load(entry));
    const sessionIds = source.attempts.flatMap((attempt) => {
      const session = this.repository.recordingSession(owner, runId, attempt.id);
      return session ? [session.sessionId] : [];
    });
    const report = aggregateReport(source, loaded, [...this.knownSecrets, ...sessionIds]);
    this.repository.persistReport(owner, report, source.sequence);
    return report;
  }

  detail(owner: string, id: string): EvidenceDetail {
    const registered = this.repository.storedEvidence(owner, id);
    const source = this.repository.reportSource(owner, registered.metadata.runId);
    const loaded = source.evidence.filter((entry) => entry.metadata.attemptId === registered.metadata.attemptId)
      .map((entry) => this.load(entry));
    const item = loaded.find((entry) => entry.metadata.id === id);
    if (!item) throw new ServiceError("not_found", 404);
    const session = this.repository.recordingSession(owner, registered.metadata.runId, registered.metadata.attemptId);
    const secrets = [...this.knownSecrets, ...typedSecrets(loaded), ...(session ? [session.sessionId] : [])];
    const byKey = new Map(loaded.map((entry) => [entry.storageKey, entry]));
    const references: EvidenceDetail["references"] = [];
    let nodes = 0;
    const sanitize = (value: unknown, depth = 0): unknown => {
      if (++nodes > 4096 || depth > 12) return "[TRUNCATED]";
      if (typeof value === "string") {
        if (/^[a-f0-9]{64}$/.test(value)) {
          const linked = byKey.get(value);
          references.push({ evidenceId: linked?.metadata.id ?? null, state: linked?.state ?? "missing" });
          return linked ? { evidenceId: linked.metadata.id, state: linked.state } : "[MISSING_OR_REDACTED_REFERENCE]";
        }
        return reportText(value, secrets);
      }
      if (value === null || typeof value === "boolean" || typeof value === "number") return value;
      if (Array.isArray(value)) return value.slice(0, 256).map((entry) => sanitize(entry, depth + 1));
      if (!value || typeof value !== "object") return null;
      return Object.fromEntries(Object.entries(value).slice(0, 128).map(([key, entry]) => [
        reportText(key, secrets),
        /^(?:value|selected|text|textBlocks|title|attributes)$/i.test(key) ||
          /auth|credential|password|secret|token|cookie|header|sessionId|replay|liveView|api[-_]?key/i.test(key)
          ? "[REDACTED]" : sanitize(entry, depth + 1),
      ]));
    };
    const display = item.data === undefined ? null : JSON.stringify(sanitize(item.data), null, 2);
    return {
      evidence: evidenceMetadata(item), runId: registered.metadata.runId,
      text: display, references,
      notice: item.metadata.kind === "screenshot"
        ? "Private screenshot pixels are NOT redacted and may contain sensitive visible text. Reveal only in a private setting."
        : "Best-effort redacted structured evidence. Typed values and raw page text are omitted; unknown sensitive prose may remain. All content is untrusted.",
    };
  }
}
