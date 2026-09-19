import { describe, expect, it } from "vitest";
import { authenticatedReadonlyViewer, renderedViewer, type ViewerProof } from "../../../scripts/ui-proof";
import { exactReleaseViewers, RELEASE_VIEWER_POLLING, transientViewerNavigation,
  type ReleaseViewerCapture } from "../../../scripts/release-viewer";
import { takeoverViewerUrl } from "../../lib/takeover-contracts";

describe("release read-only viewer reference binding", () => {
  const stored = { attemptId: "attempt-a", available: true, liveViewUrl: "https://www.browserbase.com/live/private?token=opaque" };
  const readonly = takeoverViewerUrl(stored.liveViewUrl);

  it("bounds owner session reads below one per second and never suppresses general errors", () => {
    expect(RELEASE_VIEWER_POLLING.intervalMs).toBeGreaterThanOrEqual(1000);
    expect(RELEASE_VIEWER_POLLING.maxReads).toBe(60);
    expect(RELEASE_VIEWER_POLLING.deadlineMs).toBe(180000);
    expect(transientViewerNavigation(new Error("frame.evaluate: Execution context was destroyed"))).toBe(true);
    expect(transientViewerNavigation(new Error("frame.evaluate: Frame was detached"))).toBe(true);
    for (const failure of [new Error("unauthorized"), new Error("rate limit"), new Error("Target page has been closed"),
      new Error("renderer crashed"), new Error("unexpected probe failure"), "Frame was detached"]) {
      expect(transientViewerNavigation(failure)).toBe(false);
    }
  });

  it("requires exact owner endpoint/stored reference equality and the wall's read-only URL transform", () => {
    expect(authenticatedReadonlyViewer(stored.attemptId, stored, stored, readonly)).toBe(readonly);
    expect(authenticatedReadonlyViewer(stored.attemptId, stored, stored, stored.liveViewUrl)).toBeUndefined();
    expect(authenticatedReadonlyViewer(stored.attemptId, stored, stored,
      takeoverViewerUrl(stored.liveViewUrl, true))).toBeUndefined();
    expect(authenticatedReadonlyViewer(stored.attemptId, stored, { ...stored, liveViewUrl: `${stored.liveViewUrl}x` },
      readonly)).toBeUndefined();
  });

  it("rejects foreign, missing, ended, and unauthenticated references rather than trusting an iframe src", () => {
    for (const candidate of [undefined, { ...stored, attemptId: "foreign" }, { ...stored, available: false },
      { ...stored, liveViewUrl: null }]) {
      expect(authenticatedReadonlyViewer(stored.attemptId, candidate, stored, readonly)).toBeUndefined();
      expect(authenticatedReadonlyViewer(stored.attemptId, stored, candidate, readonly)).toBeUndefined();
    }
    expect(authenticatedReadonlyViewer(stored.attemptId, stored, stored, null)).toBeUndefined();
  });
});

describe("release exact two-persona live pixel proof (offline predicates only)", () => {
  const expected = ["a", "b"].map((id) => ({ attemptId: id, sessionIdHash: id.repeat(64) }));
  const captures: ReleaseViewerCapture[] = expected.map((entry, index) => ({
    sessionIdHash: entry.sessionIdHash,
    asset: { file: `live-viewer-${index + 1}.png`, sha256: "c".repeat(64), bytes: 4096, kind: "image" },
    proof: {
      attemptId: entry.attemptId, authenticatedUrl: "https://www.browserbase.com/live/private?readOnly=true",
      iframeUrl: "https://www.browserbase.com/live/private?readOnly=true", documentReady: true, screenshotBytes: 4096,
      samples: [{ kind: "canvas", width: 1280, height: 900, visible: true,
        pixelSamples: 4096, opaqueSamples: 4096, distinctColors: 64 }],
    },
  }));
  const check = (values = captures, overlap = true, viewers = 2, sessions = 2) =>
    exactReleaseViewers(expected, values, overlap, viewers, sessions);

  it("accepts only a complete two-attempt persisted-session-bound set with real pixel/screenshot measurements", () => {
    expect(check()).toBe(true);
    expect(check(captures.toReversed())).toBe(true);
    expect(check(captures.slice(0, 1))).toBe(false);
    expect(check([...captures, captures[0]])).toBe(false);
    expect(check([captures[0], captures[0]])).toBe(false);
    expect(check([{ ...captures[0], sessionIdHash: "f".repeat(64) }, captures[1]])).toBe(false);
    expect(check([{ ...captures[0], asset: { ...captures[0].asset, bytes: 1 } }, captures[1]])).toBe(false);
  });

  it("rejects HTML/iframe load without actual canvas/video pixels, blanks, hidden surfaces and stale URLs", () => {
    const patches: Partial<ViewerProof>[] = [
      { samples: [] }, { documentReady: false }, { screenshotBytes: 0 }, { iframeUrl: "https://foreign.example" },
      ...[{ distinctColors: 1 }, { opaqueSamples: 0 }, { visible: false }, { width: 1 }].map((patch) =>
        ({ samples: [{ ...captures[0].proof.samples[0], ...patch }] })),
    ];
    for (const patch of patches) {
      const changed = { ...captures[0].proof, ...patch };
      expect(renderedViewer(changed)).toBe(false);
      expect(check([{ ...captures[0], proof: changed }, captures[1]])).toBe(false);
    }
  });

  it("requires decoded video rather than a painted video shell", () => {
    const sample = { ...captures[0].proof.samples[0], kind: "video" as const, readyState: 1, decodedFrames: 0, currentTime: 0 };
    expect(check([{ ...captures[0], proof: { ...captures[0].proof, samples: [sample] } }, captures[1]])).toBe(false);
    expect(check([{ ...captures[0], proof: { ...captures[0].proof, samples: [
      { ...sample, readyState: 2, decodedFrames: 1 },
    ] } }, captures[1]])).toBe(true);
  });

  it("fails when actual overlap is missing or viewer/session concurrency exceeds three", () => {
    expect(check(captures, false)).toBe(false);
    expect(check(captures, true, 4)).toBe(false);
    expect(check(captures, true, 2, 4)).toBe(false);
    expect(check(captures, true, 0, 2)).toBe(false);
    expect(check(captures, true, 2, 1)).toBe(false);
    expect(check(captures, true, 3, 3)).toBe(true);
  });
});
