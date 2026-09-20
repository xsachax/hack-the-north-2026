"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "@/lib/client-api";
import { idSchema, idempotencyKeySchema, runSchema } from "@/lib/contracts";
import { evidenceDetailSchema, runReportSchema, type AgentReport, type EvidenceDetail, type ReportGroup, type RunReport } from "@/lib/report-contracts";
import { newRerunRequestSchema, rerunRequestSchema, rerunResponseSchema, runComparisonSchema, type RerunRequest, type RunComparison } from "@/lib/rerun-contracts";
import { MAX_ASSIGNMENTS_PER_RUN, selectRunAssignment } from "@/lib/execution-capacity";
import { useOwnerSession } from "./owner-session";
import { PersonaAvatar } from "./persona-avatar";
import { RecordingEvidence } from "./recording-evidence";
import { ReproductionPanel } from "./reproduction-panel";
import { PUBLIC_EXECUTION_LIMITS } from "@/lib/public-execution";
import "./run-report.css";

const REFRESH_MS = 5000;
const MAX_REFRESHES = 24;
type Selection = { attempt?: string; group?: string; evidence?: string };
function reportHref(runId: string, selection: Selection = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(selection)) if (value) query.set(key, value);
  return `/runs/${encodeURIComponent(runId)}/reports${query.size ? `?${query}` : ""}`;
}
function failureMessage(error: unknown, subject: string) {
  if (error instanceof ApiError && error.status === 404) return `${subject} is missing or not accessible to this owner.`;
  return `${subject} could not be loaded. No outcome can be inferred from this error.`;
}
const finalityText = {
  in_progress: "Partial results: the run is still in progress.",
  settling: "Settling: results or remote cleanup are still being reconciled.",
  uncertain: "Finality is uncertain. Unknown cleanup is not confirmation that a browser is closed.",
  final: "Persisted reporting is final. Review each agent’s cleanup status separately.",
};

type PendingRerun = { key: string; request: RerunRequest };
function savedRerun(storageKey: string): PendingRerun | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as PendingRerun | null;
    return value ? { key: idempotencyKeySchema.parse(value.key), request: rerunRequestSchema.parse(value.request) } : null;
  } catch { return null; }
}
function RerunControls({ report }: { report: RunReport }) {
  const { ownerId, csrfToken, retry: retryOwner } = useOwnerSession();
  const storageKey = `ff:rerun:${ownerId}:${report.runId}`;
  const [pending, setPending] = useState<PendingRerun | null>(() => savedRerun(storageKey));
  const [selected, setSelected] = useState<string[]>(() => pending?.request.attemptIds ?? []);
  const [acknowledged, setAcknowledged] = useState(() => !!pending);
  const [scenario, setScenario] = useState<"" | "fixed" | "second-coupon">(() => pending?.request.scenario ?? "");
  const [isControlledStore, setIsControlledStore] = useState(false);
  const [publicReadonly, setPublicReadonly] = useState(false);
  const [rerunSupported, setRerunSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [createdId, setCreatedId] = useState("");
  const [childInput, setChildInput] = useState(() => {
    try { return sessionStorage.getItem(`${storageKey}:child`) ?? ""; } catch { return ""; }
  });
  const [childId, setChildId] = useState(() => idSchema.safeParse(childInput).success ? childInput : "");
  const [comparison, setComparison] = useState<RunComparison | null>(null);
  const [comparisonError, setComparisonError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const inFlight = useRef(false);
  const ownerRetry = useRef(retryOwner);
  useEffect(() => { ownerRetry.current = retryOwner; }, [retryOwner]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const run = runSchema.parse(await api(`/runs/${encodeURIComponent(report.runId)}`, { signal: controller.signal }));
        if (!controller.signal.aborted && run.id === report.runId) {
          setIsControlledStore(run.executionMode === "controlled-fixture" && (!run.controlledSiteId || run.controlledSiteId === "store"));
          setPublicReadonly(run.executionMode === "public-readonly");
          setRerunSupported(run.executionMode === "controlled-fixture");
        }
      } catch {
        // Unavailable metadata cannot authorize a rerun.
      }
    })();
    return () => controller.abort();
  }, [report.runId]);
  useEffect(() => {
    if (!childId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reads = 0;
    async function read() {
      reads++;
      try {
        const next = runComparisonSchema.parse(await api(
          `/runs/${encodeURIComponent(report.runId)}/comparisons/${encodeURIComponent(childId)}`, { signal: controller.signal },
        ));
        if (next.parentRunId !== report.runId || next.childRunId !== childId) throw new ApiError(404, "not_found");
        if (controller.signal.aborted) return;
        setComparison(next);
        setComparisonError("");
        if ((next.childFinality !== "final" || next.parentFinality !== "final") && reads < MAX_REFRESHES) {
          timer = setTimeout(() => void read(), REFRESH_MS);
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        setComparison(null);
        setComparisonError(failureMessage(failure, "Comparison"));
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) ownerRetry.current();
      }
    }
    void read();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [childId, refresh, report.runId]);
  async function rerun() {
    if (!rerunSupported || inFlight.current || !csrfToken) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const next = pending ?? {
        key: crypto.randomUUID(),
        request: newRerunRequestSchema.parse({
          authorizationAcknowledged: acknowledged, attemptIds: selected, ...(isControlledStore && scenario ? { scenario } : {}),
        }),
      };
      // Persist before POST so an interrupted reply or refresh retries the same durable admission.
      sessionStorage.setItem(storageKey, JSON.stringify(next));
      setPending(next);
      const result = rerunResponseSchema.parse(await api(`/runs/${encodeURIComponent(report.runId)}/reruns`, {
        method: "POST", body: next.request, csrfToken, idempotencyKey: next.key,
      }));
      setCreatedId(result.run.id);
      setChildInput(result.run.id);
      setChildId(result.run.id);
      sessionStorage.setItem(`${storageKey}:child`, result.run.id);
    } catch (failure) {
      setError(errorMessage(failure));
      if (failure instanceof ApiError && [400, 404].includes(failure.status)) {
        try {
          sessionStorage.removeItem(storageKey);
          setPending(null);
          setScenario("");
          setAcknowledged(false);
        } catch {
          setError("The selection was rejected, but its saved request could not be cleared. Enable browser storage before correcting it.");
        }
      }
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) retryOwner();
    } finally { inFlight.current = false; setBusy(false); }
  }
  if (publicReadonly) return <section className="report-panel report-rerun" aria-label="Rerun unsupported">
    <p>{PUBLIC_EXECUTION_LIMITS.rerun}</p>
    <p>{PUBLIC_EXECUTION_LIMITS.comparison}</p>
  </section>;
  return <section className="report-panel report-rerun" aria-labelledby="rerun-title">
    <p className="report-kicker">IMMUTABLE SCOPED RERUN</p>
    <h2 id="rerun-title">Rerun selected attempts</h2>
    <p>Controlled runs only. Copies the original persona snapshots, goals, criteria, limits and navigation scope.
      Starts fresh browser state; no live session, cookies or provider references are copied. The parent stays unchanged.</p>
    <p id="rerun-selection-limit">Select up to {MAX_ASSIGNMENTS_PER_RUN} original assignments for a new rerun.</p>
    {!rerunSupported && <p>Reruns require verified controlled-run metadata.</p>}
    <fieldset disabled={!rerunSupported || busy || !!pending}>
      <legend>Select original assignments</legend>
      {report.agents.map((agent) => <label key={agent.attemptId} className="report-rerun-choice">
        <input type="checkbox" checked={selected.includes(agent.attemptId)}
          disabled={!selected.includes(agent.attemptId) && selected.length >= MAX_ASSIGNMENTS_PER_RUN}
          aria-describedby="rerun-selection-limit"
          onChange={(event) => setSelected((ids) => selectRunAssignment(ids, agent.attemptId, event.target.checked))} />
        {agent.persona.name} · {agent.goal}
      </label>)}
      {isControlledStore ? <>
        <label htmlFor="rerun-scenario">Controlled store scenario</label>
        <select id="rerun-scenario" value={scenario} onChange={(event) => setScenario(event.target.value as typeof scenario)}>
          <option value="">Keep the parent scenario</option>
          <option value="fixed">Explicitly test the fixed store variant</option>
          <option value="second-coupon">Explicitly test the second-coupon failure variant</option>
        </select>
        <p>Scenario changes are supported only for the controlled store, never another site or a wider scope.</p>
      </> : <p>The parent scenario will be kept unchanged. Store variants are offered only for a verified controlled store.</p>}
      <label className="report-rerun-choice"><input type="checkbox" checked={acknowledged}
        onChange={(event) => setAcknowledged(event.target.checked)} />I authorize this fresh scoped rerun.</label>
    </fieldset>
    <button disabled={!rerunSupported || busy || !!createdId || !selected.length ||
      (!pending && selected.length > MAX_ASSIGNMENTS_PER_RUN) || !acknowledged || !csrfToken} onClick={() => void rerun()}>
      {busy ? "Creating scoped rerun…" : pending ? "Retry same rerun" : "Rerun selected attempts"}
    </button>
    {error && <p role="alert">{error} {pending
      ? "Retry keeps the same request key; it does not intentionally create a duplicate."
      : "Correct the selection and authorize a new request. The rejected request key will not be reused."}</p>}
    {pending && !createdId && <p>The pending selection is locked so retries use the exact same request, including after refresh.</p>}
    {createdId && <p role="status">Scoped rerun created. <Link href={`/runs/${createdId}`}>Open rerun live wall</Link>
      {" · "}<Link href={reportHref(createdId)}>Open rerun report</Link></p>}
    {createdId && <button onClick={() => {
      sessionStorage.removeItem(storageKey); setPending(null); setCreatedId(""); setAcknowledged(false);
    }}>Start another rerun selection</button>}
    <form className="report-comparison-form" onSubmit={(event) => {
      event.preventDefault();
      if (!idSchema.safeParse(childInput).success) { setComparisonError("Enter a valid rerun ID."); return; }
      setComparison(null); setComparisonError(""); setChildId(childInput); setRefresh((value) => value + 1);
      try { sessionStorage.setItem(`${storageKey}:child`, childInput); } catch { /* Comparison reads need no durable mutation key. */ }
    }}>
      <label>Compare a scoped rerun ID<input value={childInput} onChange={(event) => setChildInput(event.target.value)} maxLength={36} /></label>
      <button type="submit">Refresh comparison</button>
    </form>
    {comparisonError && <p role="alert">{comparisonError}</p>}
    {childId && !comparison && !comparisonError && <p role="status">Loading scoped comparison…</p>}
    {comparison && !comparisonError && comparison.childRunId === childId && <section aria-labelledby="comparison-title">
      <h3 id="comparison-title">Selected cohort comparison</h3>
      <p>Fresh context · parent {comparison.parentFinality} · rerun {comparison.childFinality} · {comparison.comparable ? "Exact immutable assignments and scope" : "Not comparable"}</p>
      <p>Comparison checks ongoing runs every 5 seconds for up to two minutes. Refresh comparison to check again.</p>
      {comparison.notices.map((notice) => <p className="report-muted" key={notice}>{notice}</p>)}
      {!comparison.groups.length && <p>No grouped findings in this selected comparison. This is not proof of a fix.</p>}
      <ul className="report-comparison-groups">{comparison.groups.map((group) => <li key={group.signature}>
        <strong>{group.title}</strong><p>{group.category} · {group.state}</p><p>{group.explanation}</p>
        <p>Parent: {group.before.affected} affected / {group.before.tested} tested / {group.before.eligible} eligible · {group.before.notTested} not tested</p>
        <p>Rerun: {group.after.affected} affected / {group.after.tested} tested / {group.after.eligible} eligible · {group.after.notTested} not tested · {group.after.confirmed} positively confirmed</p>
      </li>)}</ul>
      {comparison.pairs.map((pair) => <div key={pair.childAttemptId}>
        <p><Link href={reportHref(report.runId, { attempt: pair.parentAttemptId })}>Original attempt</Link>
          {" → "}<Link href={reportHref(childId, { attempt: pair.childAttemptId })}>Rerun attempt</Link></p>
        {(pair.parentHumanAssisted || pair.childHumanAssisted) && <p className="report-warning">
          Human-assisted: {pair.parentHumanAssisted ? "original attempt" : ""}{pair.parentHumanAssisted && pair.childHumanAssisted ? " and " : ""}
          {pair.childHumanAssisted ? "rerun attempt" : ""}. Not an agent-only improvement or reproducibility claim.
        </p>}
        <ul>{pair.criteria.map((criterion) => <li key={criterion.definitionSignature}>
          {criterion.semantics}: {criterion.before} → {criterion.after ?? "definition mismatch"} ·
          {" "}{!criterion.comparable ? "not comparable" : criterion.tested ? "tested" : "not tested"}
          {criterion.confirmedMet ? " · positively confirmed met" : ""}
        </li>)}</ul>
      </div>)}
    </section>}
  </section>;
}

function EvidenceRef({ runId, id, attemptId, state }: { runId: string; id: string; attemptId?: string; state?: string | null }) {
  return <Link className="report-evidence-link" href={reportHref(runId, { attempt: attemptId, evidence: id })}>
    Evidence {id.slice(0, 8)}{state ? ` · ${state}` : ""}
  </Link>;
}

function EvidencePanel({ runId, evidenceId, attemptScope, selectedAttempt, retryOwner }: {
  runId: string; evidenceId: string; attemptScope: string; selectedAttempt?: string; retryOwner: () => void;
}) {
  const [detail, setDetail] = useState<EvidenceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [image, setImage] = useState<string | null>(null);
  const [imageState, setImageState] = useState<"hidden" | "loading" | "error" | "shown">("hidden");
  const imageRequest = useRef<AbortController | null>(null);
  const imageUrl = useRef<string | null>(null);
  const ownerRetry = useRef(retryOwner);
  useEffect(() => { ownerRetry.current = retryOwner; }, [retryOwner]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        if (!idSchema.safeParse(evidenceId).success) throw new ApiError(404, "not_found");
        const attempts = attemptScope.split(",");
        if (selectedAttempt && !attempts.includes(selectedAttempt)) throw new ApiError(404, "not_found");
        const next = evidenceDetailSchema.parse(await api(`/evidence/${encodeURIComponent(evidenceId)}/detail`, { signal: controller.signal }));
        if (next.runId !== runId || next.evidence.id !== evidenceId ||
          !attempts.includes(next.evidence.attemptId) || (selectedAttempt && next.evidence.attemptId !== selectedAttempt)) {
          throw new ApiError(404, "not_found");
        }
        if (!controller.signal.aborted) { setDetail(next); setError(null); }
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) ownerRetry.current();
        setError(failureMessage(failure, "Evidence"));
      }
    })();
    return () => controller.abort();
  }, [runId, evidenceId, attemptScope, selectedAttempt, retry]);
  useEffect(() => () => {
    imageRequest.current?.abort();
    if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
  }, []);
  function hideImage() {
    imageRequest.current?.abort();
    if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    imageUrl.current = null;
    setImage(null);
    setImageState("hidden");
  }
  async function showImage() {
    imageRequest.current?.abort();
    const controller = new AbortController();
    imageRequest.current = controller;
    setImageState("loading");
    try {
      const response = await fetch(`/api/v1/evidence/${encodeURIComponent(evidenceId)}/content`, {
        credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      });
      if (!response.ok) throw new ApiError(response.status, "unavailable");
      if (response.headers.get("content-type")?.split(";")[0].trim() !== "image/png") throw new Error("unsupported_content");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      imageUrl.current = URL.createObjectURL(blob);
      setImage(imageUrl.current);
      setImageState("shown");
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) ownerRetry.current();
      setImageState("error");
    }
  }
  return <section className="report-panel report-private" aria-labelledby="report-evidence-title" aria-live="polite">
    <p className="report-kicker">OWNER-ONLY EVIDENCE</p>
    <h2 id="report-evidence-title">Private evidence</h2>
    <code>{evidenceId}</code>
    {!detail && !error && <p role="status">Loading private evidence…</p>}
    {error && <div role="alert"><p>{error}</p><button onClick={() => { setError(null); setRetry((value) => value + 1); }}>Retry evidence</button></div>}
    {detail && <>
      <p>{detail.evidence.kind} · {detail.evidence.state} · {detail.evidence.sensitivity}</p>
      <p>{detail.notice}</p>
      {detail.text !== null && <pre className="report-text">{detail.text}</pre>}
      {detail.evidence.state !== "available" && <p>This artifact is {detail.evidence.state}. No content or playback is implied.</p>}
      {detail.evidence.kind === "screenshot" && detail.evidence.state === "available" && <>
        <p className="report-warning"><strong>Private screenshot — NOT redacted.</strong> Pixels may contain personal or sensitive information. Only reveal them in a private setting.</p>
        {imageState === "hidden" || imageState === "error"
          ? <button onClick={() => void showImage()}>Show private screenshot</button>
          : <button onClick={hideImage}>Hide private screenshot</button>}
        {imageState === "loading" && <p role="status">Loading protected screenshot…</p>}
        {imageState === "error" && <p role="alert">Screenshot is unavailable. It may be missing or your access may have expired. Retry only if you still want to reveal private pixels.</p>}
        {/* Protected pixels are fetched only after acknowledgement, never through the image optimizer. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {image && <img className="report-screenshot" src={image} alt="Private, unredacted evidence screenshot" />}
      </>}
      {detail.evidence.state === "available" && detail.evidence.kind !== "screenshot" && detail.evidence.kind !== "recording" &&
        <a href={`/api/v1/evidence/${encodeURIComponent(evidenceId)}/content`} download>Download sanitized JSON attachment</a>}
      {detail.evidence.kind === "recording" && <p>Recording availability and supported playback are shown in the agent&apos;s recording section.</p>}
      {detail.references.length > 0 && <ul>{detail.references.map((reference, index) => <li key={index}>
        {reference.evidenceId ? <EvidenceRef runId={runId} id={reference.evidenceId} state={reference.state} /> : `Reference ${reference.state}; no evidence ID persisted.`}
      </li>)}</ul>}
    </>}
  </section>;
}

function GroupDetail({ group, runId }: { group: ReportGroup; runId: string }) {
  const counts = group.counts;
  return <section className="report-panel" aria-labelledby="group-detail-title">
    <p className="report-kicker">GROUP DETAIL · {group.category}</p>
    <h2 id="group-detail-title">{group.title}</h2>
    <p>{group.explanation}</p>
    <p>Page: {group.page ?? "unknown"} · Element: {group.element ?? "unknown"}</p>
    <dl className="report-counts">
      <div><dt>Occurrences</dt><dd>{counts.occurrences}</dd></div>
      <div><dt>Affected / tested attempts</dt><dd>{counts.affectedAttempts} / {counts.testedAttempts}</dd></div>
      <div><dt>Affected / tested personas</dt><dd>{counts.affectedPersonas} / {counts.testedPersonas}</dd></div>
      <div><dt>Assigned attempts / personas</dt><dd>{counts.assignedAttempts} / {counts.assignedPersonas}</dd></div>
      <div><dt>Eligible attempts / personas</dt><dd>{counts.eligibleAttempts} / {counts.eligiblePersonas}</dd></div>
      <div><dt>Not tested attempts / personas</dt><dd>{counts.notTestedAttempts} / {counts.notTestedPersonas}</dd></div>
      <div><dt>Out-of-cohort attempts</dt><dd>{counts.outOfCohortAttempts}</dd></div>
    </dl>
    <p className="report-muted">These are persisted counts, not a conversion rate. Untested agents are not successes or failures. Repeated occurrences do not imply distinct defects.</p>
    <ul className="report-occurrences">{group.occurrences.map((occurrence, index) => <li key={index}>
      <Link href={reportHref(runId, { attempt: occurrence.attemptId, group: group.signature })}>Agent {occurrence.personaId} · attempt {occurrence.attemptId.slice(0, 8)}</Link>
      <p>Step: {occurrence.step ?? "unknown"}</p>
      {occurrence.evidenceIds.length ? occurrence.evidenceIds.map((id) => <EvidenceRef key={id} runId={runId} id={id} attemptId={occurrence.attemptId} />) : <p>No evidence reference persisted for this occurrence.</p>}
    </li>)}</ul>
  </section>;
}

function AgentDetail({ agent, runId, slot }: { agent: AgentReport; runId: string; slot: number }) {
  return <section className="report-agent" aria-labelledby="agent-report-title">
    <header className="report-agent-heading"><PersonaAvatar id={agent.persona.id} slot={slot} /><div>
      <p className="report-kicker">PER-AGENT REPORT · {agent.persona.device}</p><h2 id="agent-report-title">{agent.persona.name}</h2>
    </div></header>
    <p>{agent.goal}</p>
    <dl className="report-counts">
      <div><dt>Exact status</dt><dd>{agent.status}</dd></div><div><dt>Data finality</dt><dd>{agent.finality}</dd></div>
      <div><dt>Launch state</dt><dd>{agent.launchState}</dd></div><div><dt>Remote cleanup</dt><dd>{agent.cleanup}</dd></div>
      <div><dt>Steps recorded</dt><dd>{agent.steps}</dd></div><div><dt>Model calls</dt><dd>{agent.modelCalls}</dd></div>
    </dl>
    <p className="report-muted">{finalityText[agent.finality]} Infrastructure failure is not a target defect.</p>
    <h3>Criteria & citations</h3>
    {!agent.criteria.length && <p>No criteria were persisted for this agent.</p>}
    <ul className="report-criteria">{agent.criteria.map((criterion, index) => <li className="report-panel" key={`${criterion.key}-${index}`}>
      <span className={`report-state report-state-${criterion.status}`}>{criterion.status}</span>
      <h4>{criterion.description}</h4>
      <p>Method: <strong>{criterion.method}</strong> · Semantics: {criterion.semantics}</p>
      <p>{criterion.explanation}</p>
      {criterion.confidence !== null && <p>Heuristic confidence: {Math.round(criterion.confidence * 100)}% — not a calibrated probability.</p>}
      {criterion.uncertainty && <p>Uncertainty: {criterion.uncertainty}</p>}
      {!criterion.citations.length && <p>No citations persisted. Missing observations are not proof of success.</p>}
      {criterion.citations.map((citation, citationIndex) => <blockquote key={citationIndex}>
        <p>Step {citation.step} · Citation {citation.state} · Page: {citation.page ?? "unknown"}</p>
        <p>{citation.excerpt}</p>
        {citation.evidenceIds.map((id) => <EvidenceRef key={id} runId={runId} id={id} attemptId={agent.attemptId} />)}
        {!citation.evidenceIds.length && <p>No artifact reference persisted.</p>}
      </blockquote>)}
    </li>)}</ul>
    <section className="report-panel report-timeline" aria-labelledby="report-timeline-title">
      <h3 id="report-timeline-title">Persisted timeline</h3>
      <p className="report-muted">Page, action and commentary are recorded observations, not reconstructed playback.</p>
      {!agent.timeline.length && <p>No timeline events persisted.</p>}
      <ol>{agent.timeline.map((event) => <li key={event.sequence}>
        <p><time dateTime={event.timestamp}>{event.timestamp}</time> · #{event.sequence} · {event.kind}</p>
        <p>Step {event.step ?? "unknown"} · Actor: {event.actor ?? "unknown"} · Action: {event.action ?? "not recorded"}</p>
        {event.page && <p>Page: {event.page}</p>}{event.commentary && <p>{event.commentary}</p>}
        {event.evidenceId && <EvidenceRef runId={runId} id={event.evidenceId} attemptId={agent.attemptId} state={event.evidenceState} />}
      </li>)}</ol>
    </section>
    <section className="report-panel" aria-labelledby="report-artifacts-title"><h3 id="report-artifacts-title">Evidence inventory</h3>
      {!agent.evidence.length && <p>No evidence artifacts persisted.</p>}
      <ul>{agent.evidence.map((item) => <li key={item.id}><EvidenceRef runId={runId} id={item.id} attemptId={agent.attemptId} state={item.state} /> · {item.kind} · {item.sensitivity}</li>)}</ul>
    </section>
    <RecordingEvidence runId={runId} attemptId={agent.attemptId} />
    <ReproductionPanel key={`${runId}:${agent.attemptId}`} runId={runId} attemptId={agent.attemptId}
      sourceReady={agent.status === "target_failed" && agent.finality === "final" && agent.cleanup === "closed"} />
  </section>;
}

export function RunReportView({ runId, selection }: { runId: string; selection: Selection }) {
  const { authorized, revision, retry: retryOwner } = useOwnerSession();
  const ownerScope = `${runId}:${revision}:${authorized}`;
  const [snapshot, setSnapshot] = useState<{ scope: string; report: RunReport | null; error: string | null; paused: boolean } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const ownerRetry = useRef(retryOwner);
  useEffect(() => { ownerRetry.current = retryOwner; }, [retryOwner]);
  useEffect(() => {
    if (!authorized) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reads = 0;
    let lastReport: RunReport | null = null;
    async function read() {
      reads++;
      try {
        if (!idSchema.safeParse(runId).success) throw new ApiError(404, "not_found");
        const report = runReportSchema.parse(await api(`/runs/${encodeURIComponent(runId)}/reports`, { signal: controller.signal }));
        if (report.runId !== runId) throw new ApiError(404, "not_found");
        if (controller.signal.aborted) return;
        lastReport = report;
        const ongoing = report.finality !== "final" || report.agents.some((agent) => agent.finality !== "final");
        setSnapshot({ scope: ownerScope, report, error: null, paused: ongoing && reads >= MAX_REFRESHES });
        if (ongoing && reads < MAX_REFRESHES) timer = setTimeout(() => void read(), REFRESH_MS);
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) { ownerRetry.current(); return; }
        const retryable = !(failure instanceof ApiError && failure.status === 404);
        setSnapshot({ scope: ownerScope, report: lastReport, error: failureMessage(failure, "Report"), paused: reads >= MAX_REFRESHES });
        if (retryable && reads < MAX_REFRESHES) timer = setTimeout(() => void read(), REFRESH_MS);
      }
    }
    void read();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [authorized, ownerScope, runId, refresh]);
  if (!authorized) return null;
  const current = snapshot?.scope === ownerScope ? snapshot : null;
  const report = current?.report;
  const agent = selection.attempt ? report?.agents.find((item) => item.attemptId === selection.attempt) : report?.agents[0];
  const group = report?.groups.find((item) => item.signature === selection.group);
  return <main className="run-report">
    <header className="report-topbar"><Link className="report-brand" href="/"><span aria-hidden="true">↗</span> flash flood</Link>
      <nav aria-label="Report navigation"><Link href={`/runs/${encodeURIComponent(runId)}`}>Live wall</Link><Link href="/">New run</Link></nav>
    </header>
    <section className="report-intro"><div><p className="report-kicker">REAL OBSERVATIONS. TRACEABLE OUTCOMES.</p>
      <h1>The evidence,<br /><span>not the guesswork.</span></h1>
      <p>What each agent observed, what remains unknown, and the artifacts behind it.</p></div>
      <div className="report-run-meta"><span className="report-kicker">RUN {runId.slice(0, 8)}</span>
        <strong>{report?.status ?? (current?.error ? "Report unavailable" : "Loading report…")}</strong>
        <span>Data finality: {report?.finality ?? "unknown"}</span>
        <button onClick={() => setRefresh((value) => value + 1)}>Refresh report</button>
      </div>
    </section>
    {!report && !current?.error && <p role="status" className="report-notice">Loading the owner&apos;s persisted report…</p>}
    {current?.error && <div role="alert" className="report-notice"><p>{current.error}</p>
      {report && <p>Last persisted data shown. Refresh failed; these results may be stale.</p>}
      {current.paused && <p>Automatic retries paused. Use Retry report to check again.</p>}
      <button onClick={() => setRefresh((value) => value + 1)}>Retry report</button></div>}
    {report && <>
      <div className="report-notice" role="status"><p>{finalityText[report.finality]}</p>
        {(report.finality !== "final" || report.agents.some((item) => item.finality !== "final")) && <p>{current?.paused
          ? "Automatic refresh paused after two minutes. Refresh report to check again."
          : "Checking persisted results every 5 seconds, for up to two minutes."}</p>}
      </div>
      <p className="report-target">Target: {report.target}</p>
      <p className="report-muted">Updated <time dateTime={report.updatedAt}>{report.updatedAt}</time> · Report {report.version}</p>
      {report.notices.map((notice, index) => <p className="report-notice" key={index}>{notice}</p>)}
      <div className="report-export"><span>Owner-only, sanitized report attachments</span>
        <a href={`/api/v1/runs/${encodeURIComponent(runId)}/exports/json`} download>Download JSON</a>
        <a href={`/api/v1/runs/${encodeURIComponent(runId)}/exports/markdown`} download>Download Markdown</a>
      </div>
      <RerunControls key={ownerScope} report={report} />
      {selection.evidence && <EvidencePanel key={`${ownerScope}:${report.revision}:${selection.attempt ?? ""}:${selection.evidence}`}
        runId={runId} evidenceId={selection.evidence} selectedAttempt={selection.attempt}
        attemptScope={report.agents.map((item) => item.attemptId).join(",")} retryOwner={retryOwner} />}
      <section aria-labelledby="report-groups-title"><div className="report-section-heading"><h2 id="report-groups-title">Grouped findings</h2><span>{report.groups.length} groups · {report.agents.length} assigned agents</span></div>
        <p className="report-muted">Signals and friction are not automatically bugs. Group counts retain tested and untested denominators.</p>
        {!report.groups.length && <p className="report-panel">No grouped findings persisted. This does not establish that the target is defect-free.</p>}
        <ul className="report-groups">{report.groups.map((item) => <li key={item.signature}>
          <Link href={reportHref(runId, { attempt: selection.attempt, group: item.signature })} aria-current={selection.group === item.signature ? "true" : undefined}>
            <span className="report-kicker">{item.category}</span><strong>{item.title}</strong>
            <span>{item.counts.affectedAttempts} / {item.counts.testedAttempts} tested attempts affected · {item.counts.notTestedAttempts} not tested · {item.counts.occurrences} occurrences</span>
          </Link></li>)}</ul>
      </section>
      {selection.group && (group ? <GroupDetail group={group} runId={runId} /> : <p className="report-notice">This finding group is missing from the current report.</p>)}
      <section aria-labelledby="report-agents-title"><h2 id="report-agents-title">Agent reports</h2>
        <nav className="report-agent-nav" aria-label="Select agent">{report.agents.map((item) => <Link key={item.attemptId}
          href={reportHref(runId, { attempt: item.attemptId, group: selection.group })} aria-current={agent?.attemptId === item.attemptId ? "page" : undefined}>
          {item.persona.name}<small>{item.status}</small></Link>)}</nav>
        {!report.agents.length && <p className="report-panel">No agent reports persisted yet.</p>}
        {selection.attempt && !agent && <p className="report-notice">This attempt is missing from the current report.</p>}
        {agent && <AgentDetail agent={agent} runId={runId} slot={report.agents.findIndex((item) => item.attemptId === agent.attemptId)} />}
      </section>
    </>}
    <footer className="report-footer"><span>Private by default. Screenshots are never automatically revealed.</span><span>Unknown is not success.</span></footer>
  </main>;
}
