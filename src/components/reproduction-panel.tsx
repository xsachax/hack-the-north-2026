"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client-api";
import { reproductionViewSchema, type ReproductionView } from "@/lib/reproduction-contracts";
import { useOwnerSession } from "./owner-session";
import "./reproduction-panel.css";

export function ReproductionPanel({ runId, attemptId, sourceReady = false }: {
  runId: string; attemptId: string; sourceReady?: boolean;
}) {
  const { csrfToken } = useOwnerSession();
  const [job, setJob] = useState<ReproductionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [authorizationAcknowledged, setAuthorizationAcknowledged] = useState(false);
  const pending = useRef(false);
  const active = job?.status === "queued" || job?.status === "running";
  const jobId = job?.id;
  useEffect(() => {
    if (!active || !jobId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reads = 0;
    async function poll() {
      try {
        const next = reproductionViewSchema.parse(await api(`/reproductions/${encodeURIComponent(jobId!)}`, { signal: controller.signal }));
        if (next.runId !== runId || next.attemptId !== attemptId) throw new Error("Mismatched reproduction");
        if (controller.signal.aborted) return;
        setJob(next);
        setError("");
        if (["queued", "running"].includes(next.status) && ++reads < 60) timer = setTimeout(poll, 2000);
        else if (reads >= 60) setError("Automatic checks paused. Refresh status to continue; the durable worker may still be running.");
      } catch {
        if (!controller.signal.aborted) setError("Status unavailable. No reproduction or cleanup outcome can be inferred.");
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, jobId, runId, attemptId, refresh]);

  async function command(cancel = false) {
    if (!csrfToken || pending.current || (!cancel && (!authorizationAcknowledged || !sourceReady))) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const next = reproductionViewSchema.parse(await api(cancel && job
        ? `/reproductions/${encodeURIComponent(job.id)}/cancel`
        : `/runs/${encodeURIComponent(runId)}/reproductions`, {
        method: "POST", csrfToken, body: cancel ? {} : { attemptId, authorizationAcknowledged: true },
      }));
      if (next.runId !== runId || next.attemptId !== attemptId) throw new Error("Mismatched reproduction");
      setJob(next);
      setRefresh((value) => value + 1);
    } catch {
      setError("Reproduction workflow unavailable. No browser was confirmed started or stopped by this response.");
    } finally { pending.current = false; setBusy(false); }
  }
  return <section className="reproduction-panel" aria-label="Bounded reproduction">
    <h3>Reproduce &amp; reduce</h3>
    <p>Controlled-store second-coupon failures only. Recorded safe actions, a fresh seeded cart per candidate,
      and an exact failure predicate. No credentials, purchases, public targets, or model calls.</p>
    {!job && !sourceReady && <p>Available after this attempt finishes as a target failure and browser cleanup is confirmed.</p>}
    {!job && sourceReady && <>
      <p>Production maximum: 3 candidate browsers, each reserving the operator&apos;s session limit
        (at most 300 seconds), for at most 900 reserved browser-seconds. Early closure does not replenish
        this lifetime allowance. Model calls: zero. The worker may stop earlier under its other limits.</p>
      <label className="reproduction-consent">
        <input type="checkbox" checked={authorizationAcknowledged} disabled={busy}
          onChange={(event) => setAuthorizationAcknowledged(event.target.checked)} />
        I authorize these bounded paid browser sessions against the trusted controlled fixture.
      </label>
      <button type="button" disabled={busy || !csrfToken || !authorizationAcknowledged} onClick={() => void command()}>
        {busy ? "Preparing…" : "Start or resume bounded reproduction"}
      </button>
    </>}
    {job && <>
      <p role="status"><strong>{job.status.replaceAll("_", " ")}</strong> · {job.reason.replaceAll("_", " ")}</p>
      <dl>
        <div><dt>Candidates attempted</dt><dd>{job.candidatesAttempted} / {job.limits.candidates}</dd></div>
        <div><dt>Cumulative charged steps</dt><dd>{job.stepsCharged} / {job.limits.steps}</dd></div>
        <div><dt>Lifetime reserved seconds</dt><dd>{job.reservedSecondsCharged} / {job.limits.reservedSeconds}</dd></div>
        <div><dt>Cumulative time budget</dt><dd>{job.durationMsCharged} / {job.limits.durationMs} ms</dd></div>
        <div><dt>Shortest path found</dt><dd>{job.shortestSteps === null ? "Not established" : `${job.shortestSteps} actions (original ${job.originalSteps})`}</dd></div>
      </dl>
      <p>{job.notice}</p>
      {job.status === "setup_required" && <p>Secret or unavailable typed values are nonreplayable. Supply a separate safe fixture setup; no passing placeholder test is generated.</p>}
      {active && <div className="reproduction-actions">
        <button type="button" onClick={() => setRefresh((value) => value + 1)}>Refresh status</button>
        <button type="button" disabled={busy || job.cancelRequested || !csrfToken} onClick={() => void command(true)}>
          {job.cancelRequested ? "Cancellation requested; awaiting cleanup" : "Cancel reduction"}
        </button>
      </div>}
      {job.exportAvailable && <a href={`/api/v1/reproductions/${encodeURIComponent(job.id)}/export`} download="coupon-regression.spec.ts">
        Download ready-to-run Playwright regression
      </a>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
