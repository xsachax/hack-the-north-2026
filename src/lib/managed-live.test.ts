import { describe, expect, it } from "vitest";
import { managedAttemptSchema } from "./managed-contracts";
import { managedLiveSummary } from "./managed-live";
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
});
