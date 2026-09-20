"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { api, errorMessage } from "@/lib/client-api";
import { managedRunSchema, type ManagedAttempt, type ManagedRun } from "@/lib/managed-contracts";
import { managedSpecialistForAssignment } from "@/lib/managed-specialists";
import { useOwnerSession } from "./owner-session";
import { PersonaAvatar } from "./persona-avatar";
import { WaveDivider } from "./wave-divider";

const viewerUrlSchema = z.string().max(8192).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && (url.hostname === "browserbase.com" || url.hostname.endsWith(".browserbase.com"));
  } catch { return false; }
}, "The provider viewer URL is not allowed.");
const viewerSchema = z.strictObject({ liveViewUrl: z.literal(""), replayUrl: viewerUrlSchema }).nullable();
type Viewer = z.infer<typeof viewerSchema>;
const cleanupLabels = {
  not_started: "Not started — no browser cleanup recorded.",
  unconfirmed: "Unconfirmed — browser closure has not been confirmed.",
  closed: "Closed — browser cleanup confirmed.",
};

function ManagedViewer({ runId, attemptId, closed }: { runId: string; attemptId: string; closed: boolean }) {
  const { authorized, ownerId, revision } = useOwnerSession();
  const [viewer, setViewer] = useState<Viewer>(null);
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); }, [authorized, ownerId, revision]);
  async function reveal() {
    if (!authorized || busy || !closed) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError("");
    try {
      const value = viewerSchema.parse(await api<unknown>(`/managed-runs/${encodeURIComponent(runId)}/attempts/${attemptId}/view`, { signal: request.signal }));
      if (request.signal.aborted) return;
      setViewer(value);
      setRequested(true);
    } catch (failure) {
      if (!request.signal.aborted) setError(failure instanceof z.ZodError
        ? "The provider viewer response failed validation. No links were opened."
        : errorMessage(failure));
    } finally { if (!request.signal.aborted) setBusy(false); }
  }
  return <section className="managed-viewer" aria-label="Owner-only browser replay">
    <p className="muted">Live control links are not exposed. Replay is available only after independently confirmed browser closure; no media is fetched from agent output.</p>
    <button type="button" disabled={!authorized || busy || !closed} onClick={() => void reveal()}>
      {busy ? "Fetching replay…" : requested ? "Refresh owner-only replay" : "Reveal owner-only replay"}
    </button>
    {error && <p className="error" role="alert">{error}</p>}
    {requested && !viewer && <p className="muted">No provider replay is available.</p>}
    {viewer && <div className="button-row">
      <a href={viewer.replayUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open Browserbase replay ↗</a>
      <p className="muted">Opens Browserbase. Replay availability and retention depend on the provider.</p>
    </div>}
  </section>;
}

function AttemptCard({ attempt, runId, slot }: { attempt: ManagedAttempt; runId: string; slot: number }) {
  const specialist = managedSpecialistForAssignment({ personaId: attempt.persona.id, goal: attempt.goal, criteria: attempt.criteria });
  const label = specialist?.label ?? attempt.persona.name;
  return <article className="managed-attempt" aria-label={`${label}'s managed attempt`}
    data-testid="managed-attempt" data-run-id={runId} data-attempt-id={attempt.id}
    data-managed-attempt-id={attempt.id}
    data-persona-id={attempt.persona.id} data-status={attempt.status} data-cleanup-status={attempt.cleanup}>
    <header className="managed-attempt-header">
      <PersonaAvatar id={attempt.persona.id} slot={slot} state={attempt.status === "running" && !attempt.cancelRequested ? "working" : "idle"} />
      <div><h2>{label}</h2><p>{specialist?.purpose ?? attempt.persona.character}</p></div>
      <span className="managed-status" data-status={attempt.status}>{attempt.status.replaceAll("_", " ")}</span>
    </header>
    <div className="managed-attempt-body">
      <p className="managed-goal">{attempt.goal}</p>
      <dl className="managed-metrics">
        <div><dt>Provider status</dt><dd>{attempt.providerStatus ?? "Not reported"}</dd></div>
        <div><dt>Browser duration</dt><dd>{attempt.actualBrowserSeconds === null ? "Unavailable" : `${attempt.actualBrowserSeconds.toLocaleString(undefined, { maximumFractionDigits: 2 })} seconds`}</dd></div>
        <div><dt>Model calls</dt><dd>Unknown — not reported</dd></div>
        <div><dt>Browser cleanup</dt><dd>{cleanupLabels[attempt.cleanup]}</dd></div>
      </dl>
      {attempt.cancelRequested && <p className="notice">Cancellation requested. This is not confirmation that the browser has closed.</p>}
      {attempt.error && <p className="error">{attempt.error}</p>}
      <details><summary>Persona snapshot and requested criteria</summary>
        <p><strong>{attempt.persona.name}</strong> · {attempt.persona.character}</p>
        <p className="muted">{attempt.persona.device} preference · {attempt.persona.techComfort} tech comfort · {attempt.persona.readingStyle} reading · {attempt.persona.patienceSteps} patience steps</p>
        <p className="muted">Persona instructions, not guarantees of device, behavior, or accessibility coverage.</p>
        <p><strong>Quirks:</strong> {attempt.persona.quirks.join("; ")}<br /><strong>Worries:</strong> {attempt.persona.worries.join("; ")}</p>
        <ul>{attempt.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
      </details>
      <section className="managed-progress" aria-label={`${label} provider progress`}
        data-testid="managed-progress" data-progress-count={attempt.progress.length}>
        <h3>Provider progress</h3>
        <p className="muted">Actual provider text and tool events, not a reconstruction of the agent&apos;s reasoning.</p>
        {!attempt.progress.length && <p className="muted">No provider progress received yet.</p>}
        <ol>{attempt.progress.map((event) => <li key={event.sequence} data-testid="managed-progress-event"
          data-managed-progress-sequence={event.sequence}
          data-event-sequence={event.sequence} data-event-kind={event.kind}>
          <div><span>{event.kind}</span><time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString()}</time></div>
          <p data-testid="managed-progress-text">{event.text}</p>
        </li>)}</ol>
      </section>
      <section className="managed-result" aria-label={`${label} agent-reported result`}
        data-testid="managed-result" data-has-result={!!attempt.result}>
        <h3>Agent-reported, not independently verified</h3>
        {attempt.result ? <>
          <p data-testid="managed-result-summary">{attempt.result.summary}</p>
          <ul>{attempt.result.criteria.map((criterion, index) => <li key={index} data-testid="managed-result-criterion"
            data-criterion-status={criterion.status}>
            <span className={`managed-verdict managed-verdict-${criterion.status}`}>Reported {criterion.status.replaceAll("_", " ")}</span>
            <strong data-testid="managed-result-criterion-text">{criterion.criterion}</strong>
            <p data-testid="managed-result-observation">{criterion.observation}</p>
          </li>)}</ul>
          {!attempt.result.criteria.length && <p className="muted">The provider reported no criterion assessments.</p>}
          {attempt.result.finalUrl && <p className="muted managed-wrap">Agent-reported final URL (not opened): <code data-testid="managed-result-final-url">{attempt.result.finalUrl}</code></p>}
          {!!attempt.result.limitations.length && <><h4>Reported limitations</h4><ul>{attempt.result.limitations.map((item, index) => <li key={index} data-testid="managed-result-limitation">{item}</li>)}</ul></>}
        </> : <p className="muted">No agent-reported result is available. Provider completion alone does not mean a criterion was met.</p>}
      </section>
      <ManagedViewer key={`${attempt.id}:${attempt.cleanup}`} runId={runId} attemptId={attempt.id} closed={attempt.cleanup === "closed"} />
    </div>
  </article>;
}

export function ManagedWall({ runId }: { runId: string }) {
  const { authorized, ownerId, csrfToken, revision, retry } = useOwnerSession();
  const [run, setRun] = useState<ManagedRun | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportLoaded, setReportLoaded] = useState(false);
  const actions = useRef(new Set<AbortController>());
  const acceptRun = useCallback((next: ManagedRun) => {
    if (next.id !== runId) throw new Error("Unexpected managed run");
    setRun((current) => !current || Date.parse(next.updatedAt) >= Date.parse(current.updatedAt) ? next : current);
  }, [runId]);

  useEffect(() => {
    if (!authorized || !ownerId) return;
    const controller = new AbortController();
    const activeActions = actions.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const next = managedRunSchema.parse(await api<unknown>(`/managed-runs/${encodeURIComponent(runId)}`, { signal: controller.signal }));
        if (controller.signal.aborted) return;
        acceptRun(next);
        setError("");
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof z.ZodError
          ? "The service returned an invalid managed run."
          : errorMessage(failure));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1500);
      }
    }
    void Promise.resolve().then(() => { if (!controller.signal.aborted) void poll(); });
    return () => {
      controller.abort();
      clearTimeout(timer);
      activeActions.forEach((action) => action.abort());
      activeActions.clear();
    };
  }, [ownerId, authorized, revision, runId, acceptRun]);

  async function request(action: "cancel" | "report") {
    if (!authorized || !csrfToken || cancelling || reportBusy) return;
    const controller = new AbortController();
    actions.current.add(controller);
    if (action === "cancel") setCancelling(true); else setReportBusy(true);
    setActionError("");
    try {
      const next = managedRunSchema.parse(await api<unknown>(`/managed-runs/${encodeURIComponent(runId)}/${action}`, {
        signal: controller.signal,
        ...(action === "cancel" ? { method: "POST", body: {}, csrfToken } : {}),
      }));
      if (controller.signal.aborted) return;
      acceptRun(next);
      if (action === "report") setReportLoaded(true);
    } catch (failure) {
      if (!controller.signal.aborted) setActionError(failure instanceof z.ZodError
        ? "The service returned an invalid managed response. No new outcome can be confirmed."
        : errorMessage(failure));
    } finally {
      actions.current.delete(controller);
      if (!controller.signal.aborted) {
        if (action === "cancel") setCancelling(false); else setReportBusy(false);
      }
    }
  }
  const canCancel = run?.attempts.some((attempt) => !attempt.cancelRequested
    && (["queued", "running", "cleanup_required"].includes(attempt.status) || attempt.cleanup === "unconfirmed"));
  return <section className="managed-wall" aria-label="Managed run wall" data-testid="managed-run-wall"
    data-run-id={runId} data-run-loaded={!!run} data-run-status={run?.status}>
    <div className="managed-wall-heading">
      <div><p className="eyebrow">BROWSERBASE-MANAGED · OWNER WORKSPACE</p><h1>Your crowd, in motion.</h1>
        <p className="muted managed-wrap">{run?.scope.targetUrl ?? "Loading saved run…"}</p></div>
      {run && <span className="managed-status" data-status={run.status}>{run.status.replaceAll("_", " ")}</span>}
      <WaveDivider />
    </div>
    <div className="managed-policy">
      <strong>Completion is not a success verdict.</strong>
      <p>Provider status, agent-reported criteria, and browser cleanup are separate. Tools cannot be disabled; scope and read-only behavior are prompts, not enforced boundaries. Hard model-call and browser-time caps are unavailable.</p>
    </div>
    {error && <div className="error" role="alert"><p>{error} Showing the last saved snapshot, if available.</p><button type="button" onClick={retry}>Refresh owner session</button></div>}
    {actionError && <p className="error" role="alert">{actionError}</p>}
    {run && <>
      <div className="managed-wall-actions">
        <button type="button" disabled={!canCancel || cancelling || reportBusy || !authorized} onClick={() => void request("cancel")}>{cancelling ? "Requesting cancellation…" : "Request cancellation"}</button>
        <button type="button" disabled={reportBusy || cancelling || !authorized} onClick={() => void request("report")}>{reportBusy ? "Loading provider report…" : "Refresh provider-reported report"}</button>
        <p className="muted" role="status">{reportLoaded ? "Provider-reported report loaded; criterion claims are not independently verified." : "Updates from the owner API approximately every 1.5 seconds."}</p>
      </div>
      <details className="managed-scope"><summary>Saved requested scope</summary>
        <p className="muted">Initial target admission was restricted to the operator&apos;s allowlist. Later browsing is not independently network-enforced.</p>
        <p className="managed-wrap"><strong>Initial URL:</strong> {run.scope.targetUrl}<br /><strong>Path prompts:</strong> {run.scope.pathPrefixes.join(", ")}<br />
          <strong>Additional subdomains:</strong> {run.scope.allowedSubdomains.length ? run.scope.allowedSubdomains.join(", ") : "None"}</p>
      </details>
      <div className="managed-attempt-grid">{run.attempts.map((attempt, slot) => <AttemptCard key={`${ownerId}:${revision}:${attempt.id}`} attempt={attempt} runId={run.id} slot={slot} />)}</div>
    </>}
  </section>;
}
