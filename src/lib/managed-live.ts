import type { ManagedAttempt, ManagedSessionView } from "./managed-contracts";

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

export type ManagedWindowState = "queued" | "starting" | "live" | "live-unavailable" | "hidden" | "finished";
/** Pure window state: a live view needs a RUNNING provider and an available, owner-served session link. */
export function managedWindowState(
  attempt: ManagedAttempt, session: ManagedSessionView | undefined, hidden: boolean,
): ManagedWindowState {
  if (["completed", "failed", "cancelled", "cleanup_required"].includes(attempt.status)) return "finished";
  if (hidden || attempt.cancelRequested) return "hidden";
  if (attempt.status === "queued") return "queued";
  if (attempt.providerStatus?.toUpperCase() !== "RUNNING") return "starting";
  return session?.available && session.liveViewUrl ? "live" : "live-unavailable";
}
