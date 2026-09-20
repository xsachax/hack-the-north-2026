"use client";

import { browserbaseUrlSchema, type ManagedAttempt, type ManagedRun, type ManagedSessionView } from "@/lib/managed-contracts";
import { managedRunFilename, managedRunMarkdown } from "@/lib/managed-export";
import { managedLiveSummary, managedWindowState } from "@/lib/managed-live";
import { managedSpecialistForAssignment } from "@/lib/managed-specialists";
import { takeoverViewerUrl } from "@/lib/takeover-contracts";
import { PersonaAvatar } from "./persona-avatar";

function AgentWindow({ attempt, session, hidden, now, slot }: {
  attempt: ManagedAttempt; session: ManagedSessionView | undefined; hidden: boolean; now: number; slot: number;
}) {
  const live = managedLiveSummary(attempt, now);
  const label = managedSpecialistForAssignment({ personaId: attempt.persona.id, goal: attempt.goal, criteria: attempt.criteria })?.label
    ?? attempt.persona.name;
  const requested = managedWindowState(attempt, session, hidden);
  // The link is access-bearing: frame it only after the same host check the replay viewer uses.
  const url = requested === "live" && browserbaseUrlSchema.safeParse(session?.liveViewUrl).success ? session!.liveViewUrl! : null;
  const state = requested === "live" && !url ? "live-unavailable" : requested;
  const text = live.action?.text ?? live.latest?.text ?? "No provider event yet";
  return <article className="managed-window" data-testid="managed-live-agent" data-attempt-id={attempt.id}
    data-provider-status={attempt.providerStatus ?? ""} data-elapsed-seconds={live.elapsedSeconds ?? ""}
    data-status={attempt.status} data-window-state={state}>
    <div className="managed-window-bar">
      <span className="managed-window-dots" aria-hidden="true"><i /><i /><i /></span>
      <a href={`#managed-attempt-${attempt.id}`}>{label}</a>
      <span className="managed-status" data-status={attempt.status}>{live.status}</span>
    </div>
    <div className="managed-window-viewport">
      {url ? <div inert className="managed-window-readonly">
        <iframe key={`${attempt.id}:${url}`} src={takeoverViewerUrl(url)} title={`${label}'s live browser (view only)`}
          sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" tabIndex={-1} />
      </div> : state === "finished" ? <p className="managed-window-placeholder">
        <strong>{live.status}</strong><span>{live.result}</span>
        <a href={`#managed-attempt-${attempt.id}`}>View details</a>
      </p> : <p className="managed-window-placeholder">{
        state === "queued" ? "Waiting for worker capacity."
          : state === "starting" ? "Starting — not proof a browser is allocated."
            : state === "hidden" ? attempt.cancelRequested
              ? "Hidden after cancellation request — not confirmation the browser closed." : "Live views hidden."
              : "Live view unavailable. Progress below is real provider output."}</p>}
    </div>
    <div className="managed-window-footer">
      <PersonaAvatar id={attempt.persona.id} slot={slot} state={attempt.providerStatus === "RUNNING"
        && attempt.status === "running" && !attempt.cancelRequested ? "working" : "idle"} />
      <p className="managed-window-bubble" aria-live="polite" title={text}>Latest action: {text}</p>
      <div className="managed-window-meta">
        <small>{live.elapsedSeconds === null ? attempt.startedAt ? "Elapsed unavailable" : "Not started" : `${live.elapsedSeconds}s elapsed`}</small>
        <small>Cleanup: {attempt.cleanup.replaceAll("_", " ")}</small>
        {attempt.actualBrowserSeconds !== null && <small>{attempt.actualBrowserSeconds.toFixed(3)}s browser use</small>}
      </div>
    </div>
  </article>;
}

export function ManagedWindows({ run, sessions, hidden, now }: {
  run: ManagedRun; sessions: readonly ManagedSessionView[]; hidden: boolean; now: number;
}) {
  // Built in the browser from the run already on screen; nothing new is fetched and no provider link is included.
  function download() {
    const url = URL.createObjectURL(new Blob([managedRunMarkdown(run, new Date())], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = managedRunFilename(run);
    link.click();
    URL.revokeObjectURL(url);
  }
  return <section className="managed-overview" aria-label="All agents live overview" data-testid="managed-live-overview">
    <div className="section-heading"><h2>All {run.attempts.length} agents</h2>
      <span className="muted">{run.attempts.filter((attempt) => attempt.providerStatus === "RUNNING"
        && attempt.status === "running").length} provider runs reporting RUNNING</span>
      <button type="button" onClick={download}>Download findings (.md)</button></div>
    <p className="muted">Starting is not browser-allocation proof. Elapsed includes startup; results and cleanup remain separate. No simulated progress.</p>
    <div className="managed-window-grid">
      {run.attempts.map((attempt, slot) => <AgentWindow key={attempt.id} attempt={attempt} slot={slot} hidden={hidden} now={now}
        session={sessions.find((item) => item.attemptId === attempt.id)} />)}
    </div>
  </section>;
}
