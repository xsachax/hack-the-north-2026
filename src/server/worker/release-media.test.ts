import { describe, expect, it } from "vitest";
import { boundedReleaseMediaPoll, RELEASE_MEDIA_READBACK, releaseReplayMetadata } from "../../../scripts/release-media";
import { decodedReportRecording, type RecordingPlaybackProof } from "../../../scripts/report-proof";

const processing = {
  status: "processing" as const, format: "hls" as const, sensitive: true as const,
  fallback: "operator-dashboard" as const, pages: [],
};
const base = "/api/v1/runs/run/attempts/attempt/replay";

describe("release current-owner media boundaries (offline predicates, no provider calls)", () => {
  it("bounds processing checks without any allocation or worker capability", async () => {
    let reads = 0, now = 0, guards = 0;
    const sleeps: number[] = [];
    const results = await boundedReleaseMediaPoll({
      read: async () => { reads++; return processing; },
      assertUnchanged: async () => { guards++; },
      signal: new AbortController().signal, now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
    });
    expect(reads).toBe(RELEASE_MEDIA_READBACK.maxReads);
    expect(results.every((entry) => entry.status === "processing")).toBe(true);
    expect(sleeps).toEqual(Array(5).fill(5500));
    expect(guards).toBe(12);
  });

  it("honors provider retry-after and deadline instead of renewing or allocating", async () => {
    let reads = 0;
    const results = await boundedReleaseMediaPoll({
      read: async () => { reads++; return { ...processing, retryAfterSeconds: 300 }; },
      assertUnchanged: async () => {}, signal: new AbortController().signal, now: () => 0,
      sleep: async () => { throw new Error("must not sleep beyond deadline"); },
    });
    expect(reads).toBe(1);
    expect(results).toHaveLength(1);
  });

  it.each(["unavailable", "expired", "unsupported", "ready"] as const)("stops at %s, not a browser retry", async (status) => {
    let reads = 0;
    const results = await boundedReleaseMediaPoll({
      read: async () => { reads++; return { ...processing, status }; },
      assertUnchanged: async () => {}, signal: new AbortController().signal,
      sleep: async () => { throw new Error("must not retry"); },
    });
    expect(reads).toBe(1);
    expect(results[0].status).toBe(status);
  });

  it("stops before any metadata read if owner/ledger changes or signal is aborted", async () => {
    let reads = 0;
    const read = async () => { reads++; return processing; };
    await expect(boundedReleaseMediaPoll({
      read, assertUnchanged: async () => { throw new Error("owner changed"); }, signal: new AbortController().signal,
    })).rejects.toThrow("owner changed");
    const controller = new AbortController(); controller.abort();
    await expect(boundedReleaseMediaPoll({
      read, assertUnchanged: async () => {}, signal: controller.signal,
    })).rejects.toThrow();
    expect(reads).toBe(0);
  });

  it("rejects stale/foreign page associations and readiness with no pages", () => {
    const ready = { ...processing, status: "ready", pages: [
      { index: 0, startTimeMs: 0, endTimeMs: 1000, playlistPath: `${base}/pages/0/playlist` },
    ] };
    expect(releaseReplayMetadata(ready, base).status).toBe("ready");
    expect(() => releaseReplayMetadata({ ...ready, pages: [] }, base)).toThrow();
    expect(() => releaseReplayMetadata({ ...ready, pages: [...ready.pages, ...ready.pages] }, base)).toThrow();
    expect(() => releaseReplayMetadata({ ...ready, pages: [
      { ...ready.pages[0], playlistPath: "/api/v1/runs/prior-owner/attempts/attempt/replay/pages/0/playlist" },
    ] }, base)).toThrow();
  });

  it("reuses real report playback predicate; readiness or prior decoded counters alone cannot pass", () => {
    const proof: RecordingPlaybackProof = {
      initialTime: 0, currentTime: 1, decodedFrames: 119, readyState: 2, width: 1280, height: 900,
      pixelSamples: 4096, opaqueSamples: 4096, distinctColors: 100, screenshotBytes: 2048,
      protectedPlaylistRead: true, protectedMediaReads: 1, onlySameOriginMedia: true,
    };
    expect(decodedReportRecording(proof)).toBe(true);
    for (const changes of [{ decodedFrames: 0 }, { currentTime: 0 }, { distinctColors: 0 },
      { protectedMediaReads: 0 }, { onlySameOriginMedia: false }, { protectedPlaylistRead: false }]) {
      expect(decodedReportRecording({ ...proof, ...changes })).toBe(false);
    }
  });
});
