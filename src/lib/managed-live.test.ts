import { describe, expect, it } from "vitest";
import { managedAttemptSchema } from "./managed-contracts";
import { managedLiveSummary, managedWindowState } from "./managed-live";
import { personas } from "./personas";

const base = managedAttemptSchema.parse({
  id: "11111111-1111-4111-8111-111111111111", persona: personas[0], goal: "Read", criteria: ["Visible"],
  status: "running", providerStatus: null, cleanup: "unconfirmed", cancelRequested: false,
  progress: [], result: null, error: null, reservedSeconds: 60, actualBrowserSeconds: null, modelCalls: null,
  startedAt: "2026-09-20T06:00:00.000Z", finishedAt: null,
});
describe("honest live managed summaries", () => {
  it("does not equate a worker claim with a running provider", () => {
    const now = Date.parse("2026-09-20T06:00:12.000Z");
    expect(managedLiveSummary(base, now)).toMatchObject({ status: "Starting", elapsedSeconds: 12, result: "Awaiting report" });
    expect(managedLiveSummary({ ...base, providerStatus: "PENDING" }, now).status).toBe("Provider pending");
    expect(managedLiveSummary({ ...base, providerStatus: "RUNNING" }, now).status).toBe("Agent running");
  });
  it("freezes terminal elapsed time and does not fabricate historical timing", () => {
    const now = Date.parse("2026-09-20T07:00:00.000Z");
    expect(managedLiveSummary({ ...base, status: "completed", finishedAt: "2026-09-20T06:00:20.000Z" }, now).elapsedSeconds).toBe(20);
    expect(managedLiveSummary({ ...base, status: "completed" }, now).elapsedSeconds).toBeNull();
    expect(managedLiveSummary({ ...base, startedAt: null }, now).elapsedSeconds).toBeNull();
  });
  it("uses only recorded events and separates reported results from cleanup", () => {
    const timestamp = "2026-09-20T06:00:12.000Z";
    const progress = [
      { sequence: 1, timestamp, kind: "tool" as const, text: "goto" },
      { sequence: 2, timestamp, kind: "text" as const, text: "Heading observed." },
    ];
    expect(managedLiveSummary({ ...base, progress }, Date.parse(timestamp))).toMatchObject({
      action: progress[0], observation: progress[1], latest: progress[1], result: "Awaiting report",
    });
  });
  it("derives window states without treating a claim, a hidden toggle or a cancel as a live browser", () => {
    const url = "https://www.browserbase.com/devtools-fullscreen/inspector.html";
    const session = { attemptId: base.id, available: true, liveViewUrl: url };
    const running = { ...base, providerStatus: "RUNNING" };
    expect(managedWindowState({ ...base, status: "queued" }, session, false)).toBe("queued");
    expect(managedWindowState(base, session, false)).toBe("starting");
    expect(managedWindowState({ ...base, providerStatus: "PENDING" }, session, false)).toBe("starting");
    expect(managedWindowState(running, session, false)).toBe("live");
    expect(managedWindowState(running, undefined, false)).toBe("live-unavailable");
    expect(managedWindowState(running, { ...session, available: false, liveViewUrl: null }, false)).toBe("live-unavailable");
    expect(managedWindowState(running, session, true)).toBe("hidden");
    expect(managedWindowState({ ...running, cancelRequested: true }, session, false)).toBe("hidden");
    for (const status of ["completed", "failed", "cancelled", "cleanup_required"] as const) {
      expect(managedWindowState({ ...running, status }, session, true)).toBe("finished");
    }
  });
});
