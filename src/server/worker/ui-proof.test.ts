import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../lib/contracts";
import type { AttemptSummary } from "../../lib/ui-contracts";
import {
  boardJourneyProof, canReserveUiRun, exactCompletedClosure, exactWallProof, renderedViewer, type ExpectedLaunch,
  type PersistedStep, type RemoteProof, type ViewerProof, type WallEvent,
} from "../../../scripts/ui-proof";

describe("UI rehearsal lifetime reservation gate", () => {
  it("counts failed and released historical reservations without resetting the ledger", () => {
    for (const total of [0, 600, 1200]) expect(canReserveUiRun(total)).toBe(true);
    for (const total of [1201, 1800, -1, NaN, Infinity, 1.5]) expect(canReserveUiRun(total)).toBe(false);
  });
});

describe("exact cumulative UI remote closure", () => {
  const launches: ExpectedLaunch[] = [0, 1, 2].map((i) => ({
    correlationToken: `correlation-${i}`, sessionId: `session-${i}`, attemptId: `attempt-${i}`,
    runId: i === 0 ? "previous-failed-attempt-run" : "current-run",
  }));
  const proof: RemoteProof[] = launches.map((launch) => ({
    correlationToken: launch.correlationToken,
    result: { confirmed: true, sessions: [{ sessionId: launch.sessionId!, status: "COMPLETED", actualBrowserSeconds: 42 }] },
  }));
  it("independently matches each saved launch including earlier invocations", () => {
    expect(exactCompletedClosure(launches, proof.toReversed())).toBe(true);
    expect(exactCompletedClosure(launches, proof.slice(1))).toBe(false);
  });
  it("rejects ERROR and TIMED_OUT, missing durations, overflow and unconfirmed closure", () => {
    for (const status of ["ERROR", "TIMED_OUT", "RUNNING"]) {
      expect(exactCompletedClosure(launches, proof.map((item) => ({
        ...item, result: { confirmed: true, sessions: [{ ...item.result.sessions[0], status }] },
      })))).toBe(false);
    }
    for (const seconds of [undefined, NaN, -1, 301]) {
      expect(exactCompletedClosure(launches, proof.map((item) => ({
        ...item, result: { confirmed: true, sessions: [{ ...item.result.sessions[0], actualBrowserSeconds: seconds }] },
      })))).toBe(false);
    }
    expect(exactCompletedClosure(launches, proof.map((item) => ({
      ...item, result: { ...item.result, confirmed: false },
    })))).toBe(false);
  });
  it("rejects duplicate, missing, extra and cross-correlated identities", () => {
    expect(exactCompletedClosure([], [])).toBe(false);
    expect(exactCompletedClosure(launches, [proof[0], proof[0], proof[2]])).toBe(false);
    expect(exactCompletedClosure([launches[0], launches[0], launches[2]], proof)).toBe(false);
    expect(exactCompletedClosure(launches.map((item) => ({ ...item, sessionId: undefined })), proof)).toBe(false);
    expect(exactCompletedClosure(launches, proof.map((item, i) => ({
      ...item, result: proof[(i + 1) % proof.length].result,
    })))).toBe(false);
    expect(exactCompletedClosure(launches, proof.map((item) => ({
      ...item, result: { ...item.result, sessions: [...item.result.sessions, item.result.sessions[0]] },
    })))).toBe(false);
  });
});

describe("real viewer pixel acceptance", () => {
  const proof: ViewerProof = {
    attemptId: "actor", authenticatedUrl: "https://viewer.example/private", iframeUrl: "https://viewer.example/private",
    documentReady: true, screenshotBytes: 4000,
    samples: [{ kind: "canvas", width: 1280, height: 720, visible: true, pixelSamples: 1024, opaqueSamples: 1024, distinctColors: 30 }],
  };
  it("requires actual visible nonblank browser pixels, not iframe src or load alone", () => {
    expect(renderedViewer(proof)).toBe(true);
    expect(renderedViewer({ ...proof, samples: [] })).toBe(false);
    expect(renderedViewer({ ...proof, documentReady: false })).toBe(false);
    expect(renderedViewer({ ...proof, screenshotBytes: 0 })).toBe(false);
    expect(renderedViewer({ ...proof, iframeUrl: "https://other.example/private" })).toBe(false);
    for (const patch of [{ visible: false }, { distinctColors: 1 }, { opaqueSamples: 0 }, { width: 1 }]) {
      expect(renderedViewer({ ...proof, samples: [{ ...proof.samples[0], ...patch }] })).toBe(false);
    }
  });
  it("rejects a video without decoded content", () => {
    const sample = { ...proof.samples[0], kind: "video" as const, readyState: 1, currentTime: 0, decodedFrames: 0 };
    expect(renderedViewer({ ...proof, samples: [sample] })).toBe(false);
    expect(renderedViewer({ ...proof, samples: [{ ...sample, readyState: 2, decodedFrames: 1 }] })).toBe(true);
  });
});

describe("independent controlled board truth", () => {
  const empty = { textBlocks: ["No projects yet. Start with New project.", "0 of 12 synthetic projects in this tab."] };
  const saved = { textBlocks: ["Garden planning", "Category: Design", "1 of 12 synthetic projects in this tab."] };
  it("requires an empty board followed by an exact final name/category/single saved project", () => {
    expect(boardJourneyProof([empty, saved])).toBe(true);
    expect(boardJourneyProof([saved])).toBe(false);
    expect(boardJourneyProof([saved, empty])).toBe(false);
    expect(boardJourneyProof([empty, { textBlocks: ["Garden planning", "Category: Research", saved.textBlocks[2]] }])).toBe(false);
    expect(boardJourneyProof([empty, { textBlocks: ["Other Garden planning", ...saved.textBlocks.slice(1)] }])).toBe(false);
  });
});

describe("wall versus independent persisted action records", () => {
  const summaries: AttemptSummary[] = ["alex", "custom"].map((attemptId) => ({
    attemptId, status: "succeeded", launchState: "settled", reservedSeconds: 300, consumedSeconds: 40, releasedSeconds: 260,
    usage: { elapsedSeconds: 40, remoteStatus: "COMPLETED", modelMetrics: { totalPromptTokens: 120 } },
    summary: {
      steps: 1, modelCalls: 1, modelOperations: { decision: 1, evaluation: 0, retry: 0, total: 1 },
      durationMs: 40000, cleanup: { status: "closed" },
      checks: [{ criterion: "saved-project", passed: true, evidence: "Garden planning" }],
    },
  }));
  const events: RunEvent[] = summaries.flatMap((summary, i) => (["observation", "decision", "action"] as const).map((kind, k) => ({
    runId: "run", attemptId: summary.attemptId, sequence: 1 + i * 3 + k, timestamp: "2026-09-19T10:00:00.000Z",
    kind: `attempt.${kind}` as const,
    data: { actor: "agent" as const, evidenceId: `${i}-${k}`, commentary: `actual ${i}-${k}`,
      pageUrl: "https://controlled.example/project-board/projects",
      ...(kind === "action" ? { step: 1, action: "click" } : {}),
    },
  })));
  const steps: PersistedStep[] = events.map((event, i) => ({
    attemptId: event.attemptId!, ordinal: i % 3 + 1, kind: event.kind.replace("attempt.", ""), evidenceId: event.data.evidenceId!,
  }));
  const wall: WallEvent[] = events.map((event) => ({
    sequence: event.sequence, timestamp: event.timestamp,
    text: `${event.kind.replace(".", " · ")} ${event.data.action ?? ""} ${event.data.commentary} ${event.data.pageUrl}`,
  }));
  it("matches complete events, action ordinals, evidence joins, summary counts and model metrics", () => {
    expect(exactWallProof(summaries, events, steps, wall)).toBe(true);
  });
  it("rejects absent, duplicate, reordered, stale or fabricated UI rows", () => {
    for (const bad of [
      wall.slice(1), [...wall, wall[0]], wall.toReversed(),
      wall.map((item) => ({ ...item, timestamp: "wrong" })),
      wall.map((item) => ({ ...item, text: item.text.replace("actual", "fabricated") })),
    ]) expect(exactWallProof(summaries, events, steps, bad)).toBe(false);
  });
  it("rejects incorrect persisted counts, evidence associations, actions and cleanup", () => {
    expect(exactWallProof(summaries, events, steps.slice(1), wall)).toBe(false);
    expect(exactWallProof(summaries, events, steps.map((item) => ({ ...item, evidenceId: "wrong" })), wall)).toBe(false);
    expect(exactWallProof(summaries, events.map((item) => ({
      ...item, data: { ...item.data, step: 2 },
    })), steps, wall)).toBe(false);
    for (const patch of [
      { steps: 0 }, { steps: 2 }, { modelCalls: 0 }, { modelCalls: 25 }, { cleanup: { status: "failed" as const } },
      { modelOperations: { decision: 1, evaluation: 1, retry: 0, total: 1 } },
    ]) expect(exactWallProof(summaries.map((item) => ({ ...item, summary: { ...item.summary!, ...patch } })), events, steps, wall)).toBe(false);
    expect(exactWallProof(summaries.map((item) => ({ ...item, usage: null })), events, steps, wall)).toBe(false);
    expect(exactWallProof([summaries[0], summaries[0]], events, steps, wall)).toBe(false);
  });
});
