"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Attempt, Evidence, RunEvent } from "@/lib/contracts";
import { criterionDescription, criterionKey, criterionStatus } from "@/lib/criteria";
import { api, ApiError } from "@/lib/client-api";
import type { AttemptSummary } from "@/lib/ui-contracts";
import {
  createWallController, emptyWall, isTerminal, MAX_VIEWERS, needsCleanup, selectViewers, type WallSnapshot,
} from "@/lib/live-wall";
import { useOwnerSession } from "./owner-session";
import { PersonaAvatar } from "./persona-avatar";
import "./run-wall.css";

const label = (value: string) => value.replaceAll("_", " ").replaceAll(".", " · ");
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function EvidenceLink({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  return <button className="wall-evidence-link" onClick={() => onOpen(id)}>Evidence {id.slice(0, 8)}</button>;
}

function AttemptCard({ attempt, events, summary, viewer, canView, atCapacity, stopping, finalizing, toggle, onEvidence }: {
  attempt: Attempt; events: RunEvent[]; summary?: AttemptSummary;
  viewer: string | null; canView: boolean; atCapacity: boolean; stopping: boolean;
  finalizing: boolean; toggle: () => void; onEvidence: (id: string) => void;
}) {
  const latest = events.at(-1);
  const commentary = events.findLast((event) => event.data.commentary)?.data.commentary;
  const action = events.findLast((event) => event.data.action)?.data.action;
  const step = summary?.summary?.steps ?? events.findLast((event) => event.data.step !== undefined)?.data.step ?? 0;
  const calls = summary?.summary?.modelCalls ?? events.findLast((event) => event.data.modelCalls !== undefined)?.data.modelCalls ?? 0;
  const recovering = (summary?.launchState !== "settled" && events.some((event) => event.kind === "attempt.recovering")) ||
    (summary && ["recovering", "quarantined"].includes(summary.launchState));
  const quiet = stopping || recovering || isTerminal(attempt.status);
  return <article className="wall-card" aria-labelledby={`attempt-${attempt.id}`}>
    <header className="wall-card-header">
      <PersonaAvatar id={attempt.persona.id} />
      <div><h2 id={`attempt-${attempt.id}`}>{attempt.persona.name}</h2><p>{attempt.persona.device} · {attempt.persona.techComfort} tech comfort</p></div>
      <span className={`wall-badge wall-status-${attempt.status}`}>{label(attempt.status)}</span>
    </header>
    <p className="wall-goal">{attempt.goal}</p>
    <Link className="wall-evidence-link" href={`/runs/${encodeURIComponent(attempt.runId)}/reports?attempt=${encodeURIComponent(attempt.id)}`}>View agent report & evidence</Link>
    <div className="wall-now">
      <span className="wall-kicker">CURRENT ACTIVITY</span>
      <strong>{quiet ? recovering ? "Recovery / cleanup" : stopping && !isTerminal(attempt.status) ? "Cancellation requested" : label(attempt.status)
        : attempt.status === "queued" ? "Queued · waiting for a worker" : action ? label(action) : "Starting · awaiting the first observation"}</strong>
      <p>{commentary ?? "No agent commentary recorded yet."}</p>
      {latest && <small>Last persisted event <time dateTime={latest.timestamp}>{time(latest.timestamp)}</time></small>}
    </div>
    {finalizing && isTerminal(attempt.status) ? <p className="wall-muted">Refreshing final counters and cleanup accounting…</p> : <dl className="wall-counters">
      <div><dt>Steps recorded</dt><dd>{step} / {attempt.limits?.maxSteps ?? "≤30"}</dd></div>
      <div><dt>Model calls</dt><dd>{calls} / {attempt.limits?.maxModelCalls ?? "≤30"}</dd></div>
      <div><dt>Patience remaining</dt><dd>{Math.max(0, attempt.persona.patienceSteps - step)} / {attempt.persona.patienceSteps} steps</dd></div>
    </dl>}
    <p className="wall-muted">Counters are persisted activity, not a completion estimate. Server budgets may end an attempt earlier.</p>
    {attempt.limits?.maxDurationMs !== undefined && <p className="wall-muted">Duration limit: {attempt.limits.maxDurationMs / 1000}s</p>}
    <div className="wall-viewer-bar">
      <span>{canView ? "Private browser available" : recovering ? "Viewer hidden during recovery" : stopping ? "Viewer hidden after cancellation request"
        : isTerminal(attempt.status) ? "Session no longer available" : "No live browser available yet"}</span>
      <button onClick={toggle} disabled={!canView || (!viewer && atCapacity)} aria-pressed={!!viewer}>
        {viewer ? "Hide viewer" : `Show viewer for ${attempt.persona.name}`}
      </button>
    </div>
    {viewer && <iframe className={`wall-browser wall-browser-${attempt.persona.device}`} src={viewer}
      title={`Live browser for ${attempt.persona.name}`} loading="lazy" referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-forms" />}
    <details className="wall-results" open={isTerminal(attempt.status)}>
      <summary>Criteria & evidence · {attempt.criteria.length}</summary>
      <ul>{attempt.criteria.map((criterion) => {
        const check = summary?.summary?.checks.find((item) => item.criterion === criterionKey(criterion) || item.criterion === criterionDescription(criterion));
        const status = criterionStatus(check);
        return <li key={criterionKey(criterion)}>
          <span className={`wall-check wall-check-${status}`}>{label(status)}</span>
          <strong>{criterionDescription(criterion)}</strong>
          {check && <p>{check.evidence}</p>}
          {check?.method && <small>Evaluation: {check.method}{check.method === "semantic" && check.confidence !== undefined
            ? ` · Heuristic confidence ${Math.round(check.confidence * 100)}% (not a calibrated probability)` : ""}</small>}
          {check?.uncertainty && <p>Uncertainty: {check.uncertainty}</p>}
          {check?.citations?.map((citation, citationIndex) => <div className="wall-citation" key={`${citation.observationId}-${citationIndex}`}>
            <span>Step {citation.step} · Page: {citation.pageUrl}</span>
            <q>{citation.excerpt}</q>
            {citation.evidenceId && <EvidenceLink id={citation.evidenceId} onOpen={onEvidence} />}
          </div>)}
        </li>;
      })}</ul>
    </details>
    <details className="wall-accounting">
      <summary>Session accounting & cleanup</summary>
      <p>Launch: {label(summary?.launchState ?? "not_launched")} · Cleanup: {summary?.summary?.cleanup.status ?? "not confirmed"}</p>
      <p>Reserved {summary?.reservedSeconds ?? 0}s · Consumed {summary?.consumedSeconds ?? 0}s · Released {summary?.releasedSeconds ?? 0}s</p>
      {summary?.usage && <p>Remote: {summary.usage.remoteStatus ?? "unknown"} · Actual browser duration: {summary.usage.actualBrowserSeconds === undefined ? "unavailable" : `${summary.usage.actualBrowserSeconds}s`}</p>}
      {recovering && <p>Recovery may retain a slot and reservation until remote cleanup is confirmed. A terminal result does not prove the browser is closed.</p>}
    </details>
  </article>;
}

export function RunWall({ runId }: { runId: string }) {
  const { authorized, csrfToken, revision, retry: retryOwner } = useOwnerSession();
  const [wall, setWall] = useState<WallSnapshot>(emptyWall);
  const [selected, setSelected] = useState<string[]>([]);
  const [cancelIntent, setCancelIntent] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [evidenceMessage, setEvidenceMessage] = useState<string | null>(null);
  const evidenceRequest = useRef(0);
  const controller = useRef<ReturnType<typeof createWallController> | null>(null);
  const ownerRetry = useRef(retryOwner);
  useEffect(() => { ownerRetry.current = retryOwner; }, [retryOwner]);
  useEffect(() => {
    if (!authorized) return;
    const active = createWallController(runId, {
      read: api, stream: (path) => new EventSource(path),
      publish: setWall, unauthorized: () => ownerRetry.current(),
    });
    controller.current = active;
    void active.refresh();
    return () => { active.stop(); controller.current = null; };
  }, [runId, authorized, revision]);
  const stopping = cancelIntent || !!wall.run?.cancelRequestedAt;
  const eligible = !stopping && !wall.error && wall.run && !isTerminal(wall.run.status)
    ? wall.sessions.filter((session) => session.available && session.liveViewUrl).map((session) => session.attemptId) : [];
  const visible = selectViewers(selected, eligible);
  const terminal = wall.run && isTerminal(wall.run.status);
  async function cancel() {
    if (!csrfToken || cancelling) return;
    setCancelIntent(true);
    setSelected([]);
    setCancelling(true);
    setMutationError(null);
    try {
      await api(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: {}, csrfToken });
      void controller.current?.refresh();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) ownerRetry.current();
      else setMutationError("Cancellation was not confirmed. Viewers remain hidden. Retry the cancellation request.");
    } finally { setCancelling(false); }
  }
  async function openEvidence(id: string) {
    const request = ++evidenceRequest.current;
    setEvidence(null);
    setEvidenceMessage("Loading private evidence metadata…");
    try {
      const result = await api<Evidence>(`/evidence/${id}`);
      if (request !== evidenceRequest.current) return;
      setEvidence(result);
      setEvidenceMessage(null);
    } catch (error) {
      if (request !== evidenceRequest.current) return;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) ownerRetry.current();
      else setEvidenceMessage("Evidence metadata could not be loaded. Select its evidence link to retry.");
    }
  }
  if (!authorized) return null;
  return <main className="run-wall">
    <header className="wall-topbar">
      <Link href="/" className="wall-brand"><span aria-hidden="true">↗</span> flash flood</Link>
      <nav aria-label="Run navigation"><Link href={`/runs/${encodeURIComponent(runId)}/reports`}>Reports</Link><Link href="/">New run</Link><span>OWNER-ONLY WALL</span></nav>
    </header>
    <section className="wall-intro">
      <div><p className="wall-kicker">REAL BROWSERS. PERSISTED EVIDENCE.</p><h1>Your users,<br /><span>in the wild.</span></h1>
        <p className="wall-subtitle">Watch each persona work toward their goal. Outcomes come from evidence, not a progress animation.</p></div>
      <div className="wall-run-meta">
        <span className="wall-kicker">RUN {runId.slice(0, 8)}</span>
        <strong>{wall.run ? label(wall.run.status) : wall.error ? "Run data unavailable" : "Loading run…"}</strong>
        <span role="status">{wall.error ? wall.run ? "Refresh failed · last persisted data shown" : "Run unavailable · retry available"
          : wall.connection === "live" ? "Live event connection" : wall.connection === "reconnecting" ? "Connection interrupted · reconnecting"
          : wall.connection === "finished" ? "Run finished · live stream closed" : "Loading persisted history"}</span>
        <button onClick={() => void controller.current?.refresh()}>Refresh persisted data</button>
      </div>
    </section>
    {wall.error && <div className="wall-alert" role="alert">{wall.error} <button onClick={() => void controller.current?.refresh()}>Retry run data</button></div>}
    {mutationError && <div className="wall-alert" role="alert">{mutationError} <button onClick={() => void cancel()}>Retry cancellation</button></div>}
    {stopping && <div className="wall-notice" role="status">Cancellation requested. Live viewers are hidden. This is intent to stop, not confirmation that remote browsers are closed.</div>}
    {wall.finalizing && <div className="wall-notice" role="status">Terminal event received. Refreshing final results and cleanup accounting…</div>}
    {terminal && needsCleanup(wall.summaries) && <div className="wall-notice">The run has ended, but recovery / remote cleanup is unresolved. Persisted summaries continue refreshing at a paced interval.</div>}
    <section className="wall-toolbar" aria-label="Wall controls">
      <div><h2>The live wall <span>{wall.attempts.length} personas</span></h2><p>{visible.length} / {MAX_VIEWERS} viewers open · Open only the browsers you want to watch.</p></div>
      <button className="wall-cancel" onClick={() => void cancel()} disabled={!wall.run || !!terminal || stopping || cancelling || !csrfToken}>
        {cancelling ? "Requesting cancellation…" : "Cancel run"}
      </button>
    </section>
    {!wall.run && !wall.error && <p className="wall-placeholder">Loading the owner&apos;s run, attempts, sessions and event history…</p>}
    {wall.run && wall.attempts.length === 0 && <p className="wall-placeholder">No persisted attempts are available yet.</p>}
    <section className="wall-grid" aria-label="Persona attempts">
      {wall.attempts.map((attempt) => {
        const session = wall.sessions.find((item) => item.attemptId === attempt.id);
        return <AttemptCard key={attempt.id} attempt={attempt}
          events={wall.events.filter((event) => event.attemptId === attempt.id && event.sequence <= wall.cursor)}
          summary={wall.summaries.find((item) => item.attemptId === attempt.id)}
          viewer={visible.includes(attempt.id) ? session?.liveViewUrl ?? null : null}
          canView={eligible.includes(attempt.id)} atCapacity={visible.length >= MAX_VIEWERS} stopping={stopping} finalizing={wall.finalizing}
          toggle={() => setSelected(selectViewers(visible, eligible, attempt.id))} onEvidence={(id) => void openEvidence(id)} />;
      })}
    </section>
    <section className="wall-log" aria-labelledby="event-log-heading">
      <div className="wall-log-heading"><h2 id="event-log-heading">The paper trail</h2><span>Persisted events · cursor {wall.cursor}</span></div>
      <p>Timestamp, page, action and commentary come from persisted events. Latest 200 events shown.</p>
      <ol>{wall.events.filter((event) => event.sequence <= wall.cursor).slice(-200).map((event) => <li key={event.sequence} data-event-sequence={event.sequence}>
        <time dateTime={event.timestamp}>{time(event.timestamp)}</time>
        <span>#{event.sequence} · {label(event.kind)}{event.data.action ? ` · ${event.data.action}` : ""}{event.data.status ? ` · ${label(event.data.status)}` : ""}</span>
        {event.data.pageUrl && <p>Page: {event.data.pageUrl}</p>}
        {event.data.commentary && <p>{event.data.commentary}</p>}
        {event.data.evidenceId && <EvidenceLink id={event.data.evidenceId} onOpen={(id) => void openEvidence(id)} />}
      </li>)}</ol>
      {!wall.events.length && <p>No persisted events yet.</p>}
    </section>
    {(evidence || evidenceMessage) && <section className="wall-evidence" aria-label="Private evidence metadata" aria-live="polite">
      <h2>Evidence metadata</h2>{evidenceMessage && <p>{evidenceMessage}</p>}
      {evidence && <><p>{evidence.kind} · <time dateTime={evidence.createdAt}>{time(evidence.createdAt)}</time></p><code>{evidence.id}</code><p>{evidence.summary}</p>
        <Link href={`/runs/${encodeURIComponent(runId)}/reports?attempt=${encodeURIComponent(evidence.attemptId)}&evidence=${encodeURIComponent(evidence.id)}`}>Open this evidence in reports</Link></>}
      <p>Metadata only here. Open reports to inspect protected artifacts and recording availability.</p>
      <button onClick={() => { evidenceRequest.current++; setEvidence(null); setEvidenceMessage(null); }}>Close evidence</button>
    </section>}
    <footer className="wall-footer"><span>Private by default. No viewer links are saved locally.</span><span>Infrastructure failure is not a target bug.</span></footer>
  </main>;
}
