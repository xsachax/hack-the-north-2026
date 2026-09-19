"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { api, ApiError, errorMessage } from "@/lib/client-api";
import { REPLAY_POLLING, type ReplayReport } from "@/lib/replay-contracts";
import { useOwnerSession } from "./owner-session";
import "./recording-evidence.css";

const replaySchema = z.strictObject({
  status: z.enum(["processing", "unavailable", "expired", "unsupported", "ready"]),
  format: z.literal("hls"), sensitive: z.literal(true), fallback: z.literal("operator-dashboard"),
  pages: z.array(z.strictObject({
    index: z.int().min(0).max(99), startTimeMs: z.int().nonnegative(), endTimeMs: z.int().nonnegative(),
    playlistPath: z.string().max(256),
  })).max(100),
  retryAfterSeconds: z.int().min(1).max(300).optional(),
});
const messages: Record<ReplayReport["status"], string> = {
  processing: "The recording is processing, the session is still active, or the readback limit was reached. No playable video is confirmed yet.",
  unavailable: "No recording is available through the protected provider API. It may be disabled, missing, or temporarily unreachable.",
  expired: "The provider reported that the recording expired.",
  unsupported: "This recording format or media destination is not supported by the deployment's verified playback policy.",
  ready: "The protected HLS playlist is ready. Press Play to watch the private recording; readiness alone is not proof of playback.",
};

function HlsVideo({ playlistPath, basePath }: { playlistPath: string; basePath: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let stopped = false;
    let dispose: (() => void) | undefined;
    const fail = () => { if (!stopped) setError("Playback failed or access expired. Hide the recording and check availability again. No successful playback is implied."); };
    void import("hls.js").then(({ default: Hls }) => {
      if (stopped) return;
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: false, maxBufferLength: 10, maxMaxBufferLength: 30, backBufferLength: 10,
          fragLoadingMaxRetry: 0, manifestLoadingMaxRetry: 0, levelLoadingMaxRetry: 0,
          xhrSetup: (_xhr, value) => {
            const url = new URL(value, location.origin);
            const suffix = url.pathname.slice(basePath.length);
            if (url.origin !== location.origin || url.search || url.hash || !url.pathname.startsWith(basePath) ||
              !/^\/pages\/\d{1,3}\/(?:playlist|segments\/\d{1,4})$/.test(suffix)) {
              throw new Error("untrusted_recording_path");
            }
          },
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) { fail(); hls.destroy(); }
        });
        hls.attachMedia(element);
        hls.loadSource(playlistPath);
        dispose = () => hls.destroy();
      } else if (element.canPlayType("application/vnd.apple.mpegurl")) {
        element.src = playlistPath;
      } else {
        setError("This browser has no supported HLS playback capability. Use the operator dashboard fallback.");
      }
    }).catch(fail);
    return () => {
      stopped = true;
      dispose?.();
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [playlistPath, basePath]);
  return <div>
    <video ref={video} controls playsInline preload="none" aria-label="Private unredacted session recording"
      onError={() => setError("The recording could not be decoded or loaded. Availability is not proof of successful playback.")}
      onPlaying={() => setPlaying(true)} onPause={() => setPlaying(false)} />
    {error ? <p role="alert">{error}</p> : <p role="status">{playing ? "Playing recorded video." : "Playback paused or not started. No autoplay."}</p>}
  </div>;
}

function Recording({ runId, attemptId }: { runId: string; attemptId: string }) {
  const { csrfToken, retry: retryOwner } = useOwnerSession();
  const [acknowledged, setAcknowledged] = useState(false);
  const [report, setReport] = useState<ReplayReport | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [checks, setChecks] = useState(0);
  const [retryAt, setRetryAt] = useState(0);
  const pending = useRef<AbortController | null>(null);
  const base = `/api/v1/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(attemptId)}/replay`;
  useEffect(() => () => pending.current?.abort(), []);
  async function inspect() {
    if (!acknowledged || !csrfToken || busy || checks >= REPLAY_POLLING.maxAttempts) return;
    if (Date.now() < retryAt) {
      setError(`Wait at least ${REPLAY_POLLING.intervalSeconds} seconds between recording checks.`);
      return;
    }
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    setReport(null);
    setChecks((value) => value + 1);
    try {
      await api(`${base.slice("/api/v1".length)}/authorize`, {
        method: "POST", body: { acknowledgeSensitiveVideo: true }, csrfToken, signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setApproved(true);
      const parsed = replaySchema.parse(await api<unknown>(base.slice("/api/v1".length), { signal: controller.signal }));
      if (parsed.pages.some((page) => page.playlistPath !== `${base}/pages/${page.index}/playlist` ||
        page.endTimeMs < page.startTimeMs) || new Set(parsed.pages.map((page) => page.index)).size !== parsed.pages.length ||
        (parsed.status === "ready" && !parsed.pages.length)) throw new Error("invalid_replay_response");
      if (!controller.signal.aborted) { setReport(parsed); setSelected(parsed.pages[0]?.index ?? 0); }
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) retryOwner();
      setError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        setRetryAt(Date.now() + REPLAY_POLLING.intervalSeconds * 1000);
      }
    }
  }
  function hide() {
    pending.current?.abort();
    setBusy(false); setReport(null); setAcknowledged(false); setError(""); setApproved(false);
  }
  const page = report?.pages.find((item) => item.index === selected);
  return <section className="recording-evidence" aria-label="Session recording">
    <h3>Session recording</h3>
    <p>Recorded video is private and <strong>not redacted</strong>. It can include typed values, credentials and visible page content.
      Checking availability does not launch a browser or call a model.</p>
    <label><input type="checkbox" checked={acknowledged} onChange={(event) => {
      if (!event.target.checked) hide(); else setAcknowledged(true);
    }} /> I understand that this recording may contain sensitive information.</label>
    <div className="recording-actions">
      <button type="button" disabled={!acknowledged || busy || checks >= REPLAY_POLLING.maxAttempts}
        onClick={() => void inspect()}>{busy ? "Checking recording..." : "Load private recording"}</button>
      {(report || busy || approved) && <button type="button" onClick={hide}>Hide recording</button>}
    </div>
    <p>Manual readback only, at least {REPLAY_POLLING.intervalSeconds} seconds apart; {checks} / {REPLAY_POLLING.maxAttempts} checks used.</p>
    {error && <p role="alert">{error}</p>}
    {report && <p role="status"><strong>{report.status}</strong> · {messages[report.status]}</p>}
    {report?.status === "ready" && page && <>
      {report.pages.length > 1 && <label>Recorded page<select value={selected} onChange={(event) => setSelected(Number(event.target.value))}>
        {report.pages.map((item) => <option key={item.index} value={item.index}>Page {item.index + 1} · {item.startTimeMs / 1000}s to {item.endTimeMs / 1000}s</option>)}
      </select></label>}
      <HlsVideo key={page.playlistPath} playlistPath={page.playlistPath} basePath={base} />
    </>}
    {approved && <p><a href={`${base}/dashboard`} target="_blank" rel="noopener noreferrer">Open the authorized Browserbase dashboard</a>
      {" "}— requires a separate provider/operator account with access to this session. The dashboard is a fallback, not proof the recording is ready.</p>}
  </section>;
}

export function RecordingEvidence(props: { runId: string; attemptId: string }) {
  const { authorized, ownerId, revision } = useOwnerSession();
  return authorized ? <Recording key={`${ownerId}:${revision}:${props.runId}:${props.attemptId}`} {...props} /> : null;
}
