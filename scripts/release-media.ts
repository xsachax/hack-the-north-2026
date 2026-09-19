import { open } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserContext, Page, Response } from "playwright-core";
import { z } from "zod";
import type { WorkerRepository } from "../src/server/worker/repository";
import { REPLAY_POLLING } from "../src/lib/replay-contracts";
import { decodedReportRecording, type RecordingPlaybackProof } from "./report-proof";
import { writePrivateJson } from "./advanced-proof";
import { readReleaseLedger, releaseLedgerDigest } from "./release-proof";

export const RELEASE_MEDIA_READBACK = Object.freeze({
  maxReads: 6, deadlineMs: 90000, playbackDeadlineMs: 30000,
  minimumIntervalMs: REPLAY_POLLING.intervalSeconds * 1000 + 500,
});

const replaySchema = z.strictObject({
  status: z.enum(["processing", "unavailable", "expired", "unsupported", "ready"]),
  format: z.literal("hls"), sensitive: z.literal(true), fallback: z.literal("operator-dashboard"),
  pages: z.array(z.strictObject({
    index: z.int().min(0).max(99), startTimeMs: z.int().nonnegative(), endTimeMs: z.int().nonnegative(),
    playlistPath: z.string().max(256),
  })).max(100),
  retryAfterSeconds: z.int().min(1).max(300).optional(),
});
type Replay = z.infer<typeof replaySchema>;

export function releaseReplayMetadata(value: unknown, basePath: string): Replay {
  const parsed = replaySchema.parse(value);
  if ((parsed.status === "ready" && !parsed.pages.length) ||
    new Set(parsed.pages.map((page) => page.index)).size !== parsed.pages.length ||
    parsed.pages.some((page) => page.endTimeMs < page.startTimeMs ||
      page.playlistPath !== `${basePath}/pages/${page.index}/playlist`)) throw new Error("release_media_wrong_association");
  return parsed;
}

/** Processing is a readback state, never an allocation/retry instruction. */
export async function boundedReleaseMediaPoll(input: {
  read(): Promise<Replay>; assertUnchanged(): Promise<void>;
  signal: AbortSignal; now?: () => number; sleep?: (milliseconds: number) => Promise<void>;
}): Promise<Replay[]> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms) => delay(ms, undefined, { signal: input.signal }));
  const deadline = now() + RELEASE_MEDIA_READBACK.deadlineMs;
  const results: Replay[] = [];
  for (let index = 0; index < RELEASE_MEDIA_READBACK.maxReads; index++) {
    input.signal.throwIfAborted();
    await input.assertUnchanged();
    if (now() >= deadline) break;
    const result = await input.read();
    results.push(result);
    await input.assertUnchanged();
    if (result.status !== "processing") break;
    const pause = Math.max(RELEASE_MEDIA_READBACK.minimumIntervalMs, (result.retryAfterSeconds ?? 0) * 1000);
    if (index + 1 >= RELEASE_MEDIA_READBACK.maxReads || now() + pause >= deadline) break;
    await sleep(pause);
  }
  if (!results.length) throw new Error("release_media_readback_deadline");
  return results;
}

/** This receives no worker, admission, cancellation, new-owner or provider-allocation capability. */
export async function readReleaseCurrentOwnerMedia(input: {
  page: Page; context: BrowserContext; origin: string; directory: string;
  ownerId: string; runId: string; attemptId: string; repository: WorkerRepository; db: DatabaseSync;
  signal: AbortSignal;
}): Promise<{ status: Replay["status"]; playbackVerified: boolean; reads: number }> {
  const { page, context, origin, directory, ownerId, runId, attemptId, repository, db, signal } = input;
  const before = readReleaseLedger(db);
  const originalCookie = (await context.cookies(origin)).find((cookie) => cookie.name === "__Host-ff_owner")?.value;
  const launch = before.launches.find((entry) => entry.runId === runId && entry.attemptId === attemptId);
  const assertUnchanged = async () => {
    signal.throwIfAborted();
    const currentCookie = (await context.cookies(origin)).find((cookie) => cookie.name === "__Host-ff_owner")?.value;
    const association = repository.recordingSession(ownerId, runId, attemptId);
    if (!originalCookie || currentCookie !== originalCookie || repository.session(originalCookie)?.ownerId !== ownerId ||
      !association || association.active || !launch?.sessionId || association.sessionId !== launch.sessionId ||
      releaseLedgerDigest(readReleaseLedger(db)) !== releaseLedgerDigest(before)) {
      throw new Error("release_media_owner_or_cumulative_ledger_changed");
    }
  };
  await assertUnchanged();
  const basePath = `/api/v1/runs/${runId}/attempts/${attemptId}/replay`;
  const responses: { sameOriginProtected: boolean; status: number; playlist: boolean; media: boolean }[] = [];
  const onResponse = (response: Response) => {
    const url = new URL(response.url());
    if (url.protocol === "blob:" && url.origin === origin) return;
    const contentType = response.headers()["content-type"] ?? "";
    const playlist = /mpegurl/i.test(contentType);
    const media = /^video\//i.test(contentType) || response.request().resourceType() === "media";
    if (!playlist && !media) return;
    responses.push({
      sameOriginProtected: url.origin === origin && !url.search && !url.hash &&
        url.pathname.startsWith(basePath) &&
        /^\/pages\/\d{1,3}\/(?:playlist|segments\/\d{1,4})$/.test(url.pathname.slice(basePath.length)),
      status: response.status(), playlist, media,
    });
  };
  page.on("response", onResponse);
  let results: Replay[] = [], proof: RecordingPlaybackProof | undefined;
  try {
    await page.goto(`${origin}/runs/${runId}/reports?attempt=${attemptId}`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await assertUnchanged();
    await page.getByLabel("I understand that this recording may contain sensitive information.").check();
    results = await boundedReleaseMediaPoll({
      signal, assertUnchanged,
      read: async () => {
        const [response] = await Promise.all([
          page.waitForResponse((entry) => entry.request().method() === "GET" &&
            entry.url() === `${origin}${basePath}`, { timeout: 15000 }),
          page.getByRole("button", { name: "Load private recording", exact: true }).click(),
        ]);
        if (!response.ok()) throw new Error("release_media_protected_read_failed");
        return releaseReplayMetadata(z.object({ data: z.unknown() }).parse(await response.json()).data, basePath);
      },
    });
    if (results.at(-1)!.status === "ready") {
      const video = page.getByLabel("Private unredacted session recording", { exact: true });
      await video.waitFor({ state: "visible", timeout: 10000 });
      await video.scrollIntoViewIfNeeded();
      const initialTime = await video.evaluate((element) => (element as HTMLVideoElement).currentTime);
      await video.focus();
      await video.press("Space");
      const deadline = Date.now() + RELEASE_MEDIA_READBACK.playbackDeadlineMs;
      while (Date.now() < deadline) {
        await assertUnchanged();
        const sample = await video.evaluate((element) => {
          const video = element as HTMLVideoElement;
          const sample = { currentTime: video.currentTime, decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames,
            readyState: video.readyState, width: video.videoWidth, height: video.videoHeight,
            pixelSamples: 0, opaqueSamples: 0, distinctColors: 0 };
          if (sample.readyState < 2 || !sample.width || !sample.height) return sample;
          try {
            const canvas = document.createElement("canvas");
            canvas.width = 64; canvas.height = 64;
            const context = canvas.getContext("2d")!;
            context.drawImage(video, 0, 0, 64, 64);
            const pixels = context.getImageData(0, 0, 64, 64).data;
            const colors = new Set<string>();
            for (let index = 0; index < pixels.length; index += 4) {
              if (pixels[index + 3] > 240) sample.opaqueSamples++;
              colors.add(`${pixels[index] >> 4},${pixels[index + 1] >> 4},${pixels[index + 2] >> 4}`);
            }
            sample.pixelSamples = pixels.length / 4; sample.distinctColors = colors.size;
          } catch { /* Undecodable or cross-origin pixels cannot pass. */ }
          return sample;
        });
        proof = { ...sample, initialTime, screenshotBytes: 0,
          protectedPlaylistRead: responses.some((entry) => entry.sameOriginProtected && entry.playlist && entry.status === 200),
          protectedMediaReads: responses.filter((entry) => entry.sameOriginProtected && entry.media && [200, 206].includes(entry.status)).length,
          onlySameOriginMedia: responses.length > 0 && responses.every((entry) => entry.sameOriginProtected),
        };
        if (decodedReportRecording({ ...proof, screenshotBytes: 1024 })) break;
        await delay(200, undefined, { signal });
      }
      const bytes = await video.screenshot({ timeout: 10000 });
      if (proof) proof.screenshotBytes = bytes.length;
      const file = await open(join(directory, "current-owner-decoded-frame.png"), "wx", 0o600);
      try { await file.writeFile(bytes); } finally { await file.close(); }
      if (!proof || !decodedReportRecording(proof)) throw new Error("release_media_ready_without_decoded_playback");
    }
    await assertUnchanged();
    return { status: results.at(-1)!.status, playbackVerified: !!proof && decodedReportRecording(proof), reads: results.length };
  } finally {
    page.off("response", onResponse);
    // Preserve an honest processing/fallback result; never allocate a replacement to obtain video.
    await writePrivateJson(join(directory, "media-readback.json"), {
      results, proof: proof ?? null, responses, reads: results.length,
      status: results.at(-1)?.status ?? "not_read",
      playbackVerified: !!proof && decodedReportRecording(proof),
      ownerContinuity: "Original current-invocation cookie; no prior owner credential, no owner bootstrap.",
      allocationDuringReadback: releaseLedgerDigest(readReleaseLedger(db)) !== releaseLedgerDigest(before),
    });
  }
}
