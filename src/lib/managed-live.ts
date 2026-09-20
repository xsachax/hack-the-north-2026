import type { ManagedAttempt } from "./managed-contracts";

export function managedLiveSummary(attempt: ManagedAttempt, now: number) {
  const active = ["running", "cleanup_required"].includes(attempt.status);
  const start = attempt.startedAt ? Date.parse(attempt.startedAt) : NaN;
  const end = attempt.finishedAt ? Date.parse(attempt.finishedAt) : active ? now : NaN;
  const elapsedSeconds = Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? Math.floor((end - start) / 1000) : null;
  const providerStatus = attempt.providerStatus?.toUpperCase();
  const status = attempt.status === "running"
    ? providerStatus === "RUNNING" ? "Agent running"
      : providerStatus === "PENDING" ? "Provider pending"
        : providerStatus ? `Provider ${providerStatus.toLowerCase()}` : "Starting"
    : attempt.status.replaceAll("_", " ");
  const latest = attempt.progress.at(-1);
  const action = [...attempt.progress].reverse().find((event) => event.kind === "tool");
  const observation = [...attempt.progress].reverse().find((event) => event.kind === "text");
  return {
    elapsedSeconds, status, latest, action, observation,
    result: attempt.result
      ? `${attempt.result.criteria.filter((criterion) => criterion.status === "met").length} met / ${attempt.result.criteria.length} reported`
      : attempt.error ? "See recorded error" : "Awaiting report",
  };
}
