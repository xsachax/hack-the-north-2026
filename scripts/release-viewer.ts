import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserContext, Frame, Page } from "playwright-core";
import { z } from "zod";
import { eventSchema, type RunEvent } from "../src/lib/contracts";
import { sessionsResponseSchema } from "../src/lib/ui-contracts";
import type { WorkerRepository } from "../src/server/worker/repository";
import { assertPrivateDirectory, writePrivateJson } from "./advanced-proof";
import { inventoryReleaseAsset, readReleaseLedger, sha256, type PrivateAsset } from "./release-proof";
import { authenticatedReadonlyViewer, probeFrame, renderedViewer, type ViewerProof, type VisualSample } from "./ui-proof";

export type ReleaseViewerCapture = { proof: ViewerProof; sessionIdHash: string; asset: PrivateAsset };
export const RELEASE_VIEWER_POLLING = Object.freeze({ intervalMs: 2000, maxReads: 60, deadlineMs: 180000 });
export function transientViewerNavigation(error: unknown): boolean {
  return error instanceof Error && ["Execution context was destroyed", "Frame was detached", "Frame has been detached"]
    .some((text) => error.message.includes(text));
}

async function privateArtifact(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size <= 0 || info.size > 16 * 1024 * 1024) {
      throw new Error("release_live_artifact_invalid");
    }
    const bytes = await handle.readFile();
    if (bytes.length !== info.size || (await handle.stat()).mtimeMs !== info.mtimeMs) {
      throw new Error("release_live_artifact_changed");
    }
    return bytes;
  } finally { await handle.close(); }
}

async function preserveLivePayloads(input: {
  repository: WorkerRepository; ownerId: string; runId: string; attemptId: string;
  dataDir: string; directory: string; index: number; events: RunEvent[];
}): Promise<void> {
  const { repository, ownerId, runId, attemptId, dataDir, directory, index, events } = input;
  const action = events.findLast((event) => event.kind === "attempt.action" && event.data.actor === "agent");
  const observation = events.findLast((event) => event.kind === "attempt.observation" &&
    event.data.actor === "agent" && !!action && event.sequence < action.sequence);
  if (!action?.data.evidenceId || !observation?.data.evidenceId) throw new Error("release_live_action_observation_missing");
  const artifact = async (id: string) => {
    const entry = repository.storedEvidence(ownerId, id);
    if (entry.metadata.runId !== runId || entry.metadata.attemptId !== attemptId) throw new Error("release_live_cross_attempt_artifact");
    return { entry, bytes: await privateArtifact(join(dataDir, "execution", runId, attemptId,
      z.string().regex(/^[a-f0-9]{64}$/).parse(entry.storageKey))) };
  };
  const actionFile = await artifact(action.data.evidenceId);
  const observationFile = await artifact(observation.data.evidenceId);
  const actionPayload: unknown = JSON.parse(actionFile.bytes.toString("utf8"));
  const observationPayload: unknown = JSON.parse(observationFile.bytes.toString("utf8"));
  if (z.object({ action: z.object({ action: z.string() }) }).parse(actionPayload).action.action !== action.data.action) {
    throw new Error("release_live_action_payload_mismatch");
  }
  const screenshotKey = z.object({ observation: z.object({ screenshotKey: z.string().regex(/^[a-f0-9]{64}$/) }) })
    .parse(observationPayload).observation.screenshotKey;
  const screenshot = repository.reportSource(ownerId, runId).evidence.find((entry) =>
    entry.storageKey === screenshotKey && entry.metadata.attemptId === attemptId && entry.metadata.kind === "screenshot");
  if (!screenshot) throw new Error("release_live_observation_screenshot_missing");
  const pixels = (await artifact(screenshot.metadata.id)).bytes;
  const file = `live-agent-${index + 1}-observation.png`;
  const output = await open(join(directory, file), "wx", 0o600);
  try { await output.writeFile(pixels); } finally { await output.close(); }
  const image = await inventoryReleaseAsset(directory, file);
  await writePrivateJson(join(directory, `live-agent-${index + 1}-payload.json`), {
    actionEvent: action, observationEvent: observation, actionPayload, observationPayload,
    actionSha256: sha256(actionFile.bytes), observationSha256: sha256(observationFile.bytes),
    screenshotEvidenceId: screenshot.metadata.id, image,
  });
}

export function exactReleaseViewers(
  expected: readonly { attemptId: string; sessionIdHash: string }[], captures: readonly ReleaseViewerCapture[],
  overlap: boolean, maxViewers: number, maxSessions: number,
): boolean {
  return expected.length === 2 && captures.length === 2 && overlap &&
    Number.isInteger(maxViewers) && maxViewers >= 1 && maxViewers <= 3 &&
    Number.isInteger(maxSessions) && maxSessions >= 2 && maxSessions <= 3 &&
    new Set(expected.map((entry) => entry.attemptId)).size === 2 &&
    new Set(expected.map((entry) => entry.sessionIdHash)).size === 2 &&
    new Set(captures.map((entry) => entry.proof.attemptId)).size === 2 &&
    new Set(captures.map((entry) => entry.asset.file)).size === 2 &&
    expected.every((entry) => {
      const captured = captures.find((item) => item.proof.attemptId === entry.attemptId);
      return !!captured && /^[a-f0-9]{64}$/.test(entry.sessionIdHash) && captured.sessionIdHash === entry.sessionIdHash &&
        captured.asset.kind === "image" && /^[a-f0-9]{64}$/.test(captured.asset.sha256) &&
        captured.asset.bytes === captured.proof.screenshotBytes && renderedViewer(captured.proof);
    });
}

/** Observe existing read-only viewers only; this helper has no allocator or human-control attachment. */
export async function captureReleaseLiveViewers(input: {
  page: Page; context: BrowserContext; origin: string; directory: string; dataDir: string; ownerId: string; runId: string;
  repository: WorkerRepository; db: DatabaseSync; signal: AbortSignal;
}): Promise<void> {
  const { page, context, origin, directory, dataDir, ownerId, runId, repository, db, signal } = input;
  await assertPrivateDirectory(directory);
  const attempts = repository.attempts(ownerId, runId);
  if (attempts.length !== 2 || new Set(attempts.map((attempt) => attempt.persona.id)).size !== 2) {
    throw new Error("release_viewer_exact_two_personas_required");
  }
  const captures: ReleaseViewerCapture[] = [];
  let overlap = false, maxViewers = 0, maxSessions = 0, sessionReads = 0;
  const deadline = Date.now() + RELEASE_VIEWER_POLLING.deadlineMs;
  const descendants = (frame: Frame): Frame[] => [frame, ...frame.childFrames().flatMap(descendants)];
  try {
    while (Date.now() < deadline && captures.length < 2 && sessionReads < RELEASE_VIEWER_POLLING.maxReads) {
      signal.throwIfAborted();
      const ledger = readReleaseLedger(db);
      maxSessions = Math.max(maxSessions, ledger.launches.filter((launch) => launch.state !== "settled").length);
      maxViewers = Math.max(maxViewers, await page.locator("iframe").count());
      if (maxViewers > 3 || maxSessions > 3) throw new Error("release_viewer_concurrency_cap");
      sessionReads++;
      const response = await context.request.get(`${origin}/api/v1/runs/${runId}/sessions`, {
        timeout: 10000, maxRedirects: 0, maxRetries: 0,
      });
      if (!response.ok()) throw new Error("release_viewer_owner_sessions_failed");
      const sessions = sessionsResponseSchema.parse((await response.json()).data).items;
      if (sessions.length > 2 || new Set(sessions.map((entry) => entry.attemptId)).size !== sessions.length ||
        sessions.some((entry) => !attempts.some((attempt) => attempt.id === entry.attemptId))) {
        throw new Error("release_viewer_session_set_mismatch");
      }
      const stored = repository.sessionViews(ownerId, runId);
      const active = attempts.filter((attempt) => {
        const launch = ledger.launches.find((entry) => entry.runId === runId && entry.attemptId === attempt.id);
        return launch?.state === "active" && !!launch.sessionId &&
          sessions.some((entry) => entry.attemptId === attempt.id && entry.available) &&
          stored.some((entry) => entry.attemptId === attempt.id && entry.available);
      });
      overlap ||= active.length === 2;
      for (const [index, attempt] of attempts.entries()) {
        if (captures.some((entry) => entry.proof.attemptId === attempt.id) || !active.some((entry) => entry.id === attempt.id)) continue;
        const card = page.locator(`article[aria-labelledby="attempt-${attempt.id}"]`);
        const show = card.getByRole("button", { name: `Show viewer for ${attempt.persona.name}`, exact: true });
        if (await show.count() && await show.isEnabled()) await show.click({ timeout: 5000 });
        const iframe = card.locator("iframe");
        if (!await iframe.count()) continue;
        maxViewers = Math.max(maxViewers, await page.locator("iframe").count());
        if (maxViewers > 3) throw new Error("release_viewer_concurrency_cap");
        await iframe.scrollIntoViewIfNeeded({ timeout: 5000 });
        const iframeUrl = await iframe.getAttribute("src");
        const authenticatedUrl = authenticatedReadonlyViewer(attempt.id,
          sessions.find((entry) => entry.attemptId === attempt.id),
          stored.find((entry) => entry.attemptId === attempt.id), iframeUrl);
        if (!authenticatedUrl) throw new Error("release_viewer_not_readonly_authenticated_reference");
        const element = await iframe.elementHandle();
        const root = await element?.contentFrame();
        if (!root) continue;
        const samples: VisualSample[] = [];
        let documentReady = false;
        for (const frame of descendants(root)) {
          try {
            const probe = await probeFrame(frame);
            documentReady ||= probe.ready && probe.samples.length > 0;
            if (probe.ready) samples.push(...probe.samples);
          } catch (error) {
            if (!transientViewerNavigation(error)) throw error;
          }
        }
        const proof: ViewerProof = { attemptId: attempt.id, authenticatedUrl, iframeUrl: iframeUrl!,
          documentReady, screenshotBytes: 0, samples };
        if (!renderedViewer({ ...proof, screenshotBytes: 1024 })) continue;
        const events = db.prepare("SELECT event FROM events WHERE run_id=? ORDER BY sequence").all(runId)
          .map((row) => eventSchema.parse(JSON.parse(z.string().parse(row.event))))
          .filter((event) => event.attemptId === attempt.id);
        if (!events.some((event) => event.kind === "attempt.action" && event.data.actor === "agent")) continue;
        const bytes = await iframe.screenshot({ timeout: 5000 });
        proof.screenshotBytes = bytes.length;
        // Recheck after pixel capture: do not count stale pixels from a finished or swapped session.
        const current = readReleaseLedger(db).launches.find((entry) => entry.runId === runId && entry.attemptId === attempt.id);
        const original = ledger.launches.find((entry) => entry.runId === runId && entry.attemptId === attempt.id);
        const currentStored = repository.sessionViews(ownerId, runId).find((entry) => entry.attemptId === attempt.id);
        if (!current?.sessionId || current.state !== "active" || current.sessionId !== original?.sessionId ||
          !authenticatedReadonlyViewer(attempt.id, sessions.find((entry) => entry.attemptId === attempt.id),
            currentStored, await iframe.getAttribute("src")) || !renderedViewer(proof)) continue;
        const file = `live-viewer-${index + 1}.png`;
        const handle = await open(join(directory, file), "wx", 0o600);
        try { await handle.writeFile(bytes); } finally { await handle.close(); }
        await preserveLivePayloads({ repository, ownerId, runId, attemptId: attempt.id, dataDir, directory, index, events });
        captures.push({ proof, sessionIdHash: sha256(current.sessionId), asset: await inventoryReleaseAsset(directory, file) });
      }
      if (captures.length === 2) break;
      if (!["queued", "running"].includes(repository.getRun(ownerId, runId).status)) {
        throw new Error("release_viewer_run_ended_before_pixels_no_retry");
      }
      await delay(RELEASE_VIEWER_POLLING.intervalMs, undefined, { signal });
    }
    const ledger = readReleaseLedger(db);
    const expected = attempts.map((attempt) => ({
      attemptId: attempt.id,
      sessionIdHash: sha256(ledger.launches.find((entry) => entry.runId === runId && entry.attemptId === attempt.id)?.sessionId ?? ""),
    }));
    if (!exactReleaseViewers(expected, captures, overlap, maxViewers, maxSessions)) {
      throw new Error("release_two_actual_live_viewers_unproved");
    }
  } finally {
    // Dispose wall/session/takeover pollers before the subsequent evidence-detail sweep.
    try { await page.goto("about:blank", { waitUntil: "load", timeout: 10000 }); } finally {
      await writePrivateJson(join(directory, "live-viewers.json"), {
        overlap, maxViewers, maxSessions, sessionReads, polling: RELEASE_VIEWER_POLLING,
        captures: captures.map(({ proof: { authenticatedUrl, iframeUrl, ...proof }, ...rest }) => ({
          ...rest, proof, authenticatedUrlHash: sha256(authenticatedUrl), iframeUrlHash: sha256(iframeUrl),
        })),
        note: "Actual read-only iframe canvas/video pixels plus persisted agent action/observation payloads and screenshot bytes; no CDP or new allocations.",
      });
    }
  }
}
