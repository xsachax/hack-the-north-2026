import { afterEach, describe, expect, it, vi } from "vitest";
import { attemptSchema, runSchema, type RunEvent } from "./contracts";
import type { AttemptSummary } from "./ui-contracts";
import { createWallController, emptyWall, mergeEvents, needsCleanup, projectWall, selectViewers, type WallSnapshot } from "./live-wall";

const runId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-09-19T09:00:00.000Z";
const run = runSchema.parse({
  id: runId, cursor: 1, status: "running", authorizationAcknowledged: true,
  scope: { targetUrl: "https://example.com/", allowedSubdomains: [], pathPrefixes: ["/"] },
  createdAt: timestamp, updatedAt: timestamp, cancelRequestedAt: null,
});
const attempt = attemptSchema.parse({
  id: attemptId, runId, status: "running", createdAt: timestamp, updatedAt: timestamp,
  persona: { id: "reader", name: "Reader", character: "Careful", device: "desktop", techComfort: "low",
    patienceSteps: 8, readingStyle: "careful", quirks: ["Reads"], worries: ["Losing work"] },
  goal: "Read the page", criteria: ["Page is clear"],
});
const event = (sequence: number, kind: RunEvent["kind"] = "attempt.action", data: RunEvent["data"] = {}): RunEvent => ({
  sequence, kind, data, runId, attemptId: kind.startsWith("run.") ? null : attemptId, timestamp,
});
const summary = (launchState: AttemptSummary["launchState"]): AttemptSummary => ({
  attemptId, status: "running", launchState, summary: null, usage: null, reservedSeconds: 10, consumedSeconds: 0, releasedSeconds: 0,
});
const session = { attemptId, available: true, liveViewUrl: "https://www.browserbase.com/live/private" };

class FakeStream {
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  onopen: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  close = vi.fn();
  addEventListener(kind: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(kind, listener); }
  emit(value: RunEvent) { this.listeners.get(value.kind)?.(new MessageEvent(value.kind, { data: JSON.stringify(value), lastEventId: String(value.sequence) })); }
}

function setup() {
  let currentRun = run;
  let history = [event(1, "run.created")];
  let summaries = [summary("active")];
  let latest = emptyWall();
  let override: ((path: string) => Promise<unknown> | undefined) | undefined;
  const sources: FakeStream[] = [];
  const paths: string[] = [];
  const read = vi.fn(async <T>(path: string): Promise<T> => {
    const replacement = override?.(path);
    if (replacement) return await replacement as T;
    const suffix = path.replace(`/runs/${runId}`, "");
    return (suffix === "" ? currentRun
      : suffix === "/attempts" ? { items: [attempt] }
        : suffix === "/summaries" ? { items: summaries }
          : suffix === "/sessions" ? { items: [session] }
            : { items: history.filter((entry) => entry.sequence > Number(new URL(path, "https://local").searchParams.get("after"))), nextCursor: null }) as T;
  });
  const unauthorized = vi.fn();
  const controller = createWallController(runId, {
    read: <T>(path: string) => read(path) as Promise<T>,
    stream: (path) => { const stream = new FakeStream(); paths.push(path); sources.push(stream); return stream; },
    publish: (state) => { latest = state; }, unauthorized,
  });
  return { controller, read, sources, paths, unauthorized, get state() { return latest; },
    setRun: (value: typeof run) => { currentRun = value; },
    setHistory: (value: RunEvent[]) => { history = value; },
    setSummaries: (value: AttemptSummary[]) => { summaries = value; },
    override: (value: typeof override) => { override = value; },
  };
}
afterEach(() => vi.useRealTimers());

describe("wall ordering and private viewers", () => {
  it("deduplicates, sorts and retains a gap without advancing the exclusive cursor", () => {
    const first = event(1);
    const result = mergeEvents([first], [event(3), first, { ...event(2), runId: attemptId }], runId);
    expect(result.cursor).toBe(1);
    expect(result.gap).toBe(true);
    expect(mergeEvents(result.events, [event(2)], runId)).toMatchObject({ cursor: 3, gap: false });
  });
  it("keeps selection stable and capped at three with an explicit opt-in", () => {
    expect(selectViewers([], ["a", "b"])).toEqual([]);
    expect(selectViewers(["b", "a"], ["a", "b", "c"], "c")).toEqual(["b", "a", "c"]);
    expect(selectViewers(["b", "a", "c"], ["a", "b", "c", "d"], "d")).toEqual(["b", "a", "c"]);
    expect(selectViewers(["a", "b"], ["b"])).toEqual(["b"]);
  });
  it.each(["attempt.recovering", "attempt.finished", "run.cancel_requested", "run.finished"] as const)(
    "immediately withholds private URLs for %s even beyond a gap", (kind) => {
      const state: WallSnapshot = { ...emptyWall(), run, attempts: [attempt], sessions: [session], events: [event(4, kind)], cursor: 0 };
      expect(projectWall(state).sessions[0]).toMatchObject({ available: false, liveViewUrl: null });
    },
  );
  it("does not call a quarantined terminal launch remotely closed", () => {
    expect(needsCleanup([summary("quarantined")])).toBe(true);
    expect(needsCleanup([summary("settled"), summary("not_launched")])).toBe(false);
  });
  it("hides viewers from persisted recovery summaries even before their event arrives", () => {
    expect(projectWall({
      ...emptyWall(), run, attempts: [attempt], sessions: [session], summaries: [summary("recovering")],
    }).sessions[0].liveViewUrl).toBeNull();
  });
});

describe("wall reconciliation", () => {
  it("loads all owner views and history before streaming from the durable cursor", async () => {
    const test = setup();
    await test.controller.refresh();
    expect(test.read).toHaveBeenCalledTimes(5);
    expect(test.paths).toEqual([`/api/v1/runs/${runId}/events/stream?after=1`]);
    expect(test.state.attempts[0].id).toBe(attemptId);
    test.controller.stop();
    expect(test.sources[0].close).toHaveBeenCalledOnce();
  });
  it("does not lose a terminal transition recorded during initial history", async () => {
    const test = setup();
    test.setHistory([event(1, "run.created"), event(2, "run.finished", { status: "cancelled" })]);
    await test.controller.refresh();
    expect(test.state.run?.status).toBe("cancelled");
    expect(test.sources).toHaveLength(0);
    test.controller.stop();
  });
  it("repairs gaps via history and ignores duplicate stream events", async () => {
    const test = setup();
    await test.controller.refresh();
    test.setHistory([event(1), event(2), event(3)]);
    test.sources[0].emit(event(3));
    await test.controller.refresh();
    test.sources[0].emit(event(2));
    expect(test.state.cursor).toBe(3);
    expect(test.state.events.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    test.controller.stop();
  });
  it("a stale snapshot cannot overwrite a terminal event received during a refresh", async () => {
    const test = setup();
    await test.controller.refresh();
    let release!: (value: unknown) => void;
    test.override((path) => path === `/runs/${runId}` ? new Promise((resolve) => { release = resolve; }) : undefined);
    const pending = test.controller.refresh();
    test.sources[0].emit(event(2, "run.finished", { status: "succeeded" }));
    expect(test.state.run?.status).toBe("succeeded");
    test.override(undefined);
    release(run);
    await pending;
    expect(test.state.run?.status).toBe("succeeded");
    expect(test.state.sessions[0].available).toBe(false);
    test.controller.stop();
  });
  it("reconnects with backoff and the last deduplicated cursor, but not after stop", async () => {
    vi.useFakeTimers();
    const test = setup();
    await test.controller.refresh();
    test.sources[0].emit(event(2));
    test.sources[0].onerror?.(new Event("error"));
    expect(test.sources[0].close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(test.paths.at(-1)).toContain("after=2");
    test.controller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.sources).toHaveLength(2);
  });
  it("continues paced terminal summary refreshes until quarantine is settled", async () => {
    vi.useFakeTimers();
    const test = setup();
    test.setRun({ ...run, status: "infrastructure_failed" });
    test.setSummaries([summary("quarantined")]);
    await test.controller.refresh();
    expect(test.sources).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(test.read).toHaveBeenCalledTimes(10);
    test.setSummaries([summary("settled")]);
    await vi.advanceTimersByTimeAsync(5000);
    const reads = test.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(test.read).toHaveBeenCalledTimes(reads);
    test.controller.stop();
  });
  it("refreshes stale pre-terminal snapshots before deciding cleanup is settled", async () => {
    vi.useFakeTimers();
    const test = setup();
    test.setRun({ ...run, status: "queued" });
    test.setSummaries([summary("not_launched")]);
    const history = [event(1, "run.created"), event(2, "attempt.finished", { status: "infrastructure_failed" }),
      event(3, "run.finished", { status: "infrastructure_failed" })];
    let historyReads = 0;
    test.override((path) => {
      if (!path.includes("/events?")) return;
      historyReads++;
      if (historyReads === 1) {
        test.setRun({ ...run, status: "infrastructure_failed" });
        test.setSummaries([{ ...summary("quarantined"), status: "infrastructure_failed", consumedSeconds: 9 }]);
        return Promise.resolve({ items: history, nextCursor: null });
      }
      return Promise.resolve({ items: [], nextCursor: null });
    });
    await test.controller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.state.run?.status).toBe("infrastructure_failed");
    expect(test.state.finalizing).toBe(false);
    expect(test.state.summaries[0]).toMatchObject({ launchState: "quarantined", consumedSeconds: 9 });
    expect(test.sources).toHaveLength(0);
    const reads = test.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(test.read.mock.calls.length).toBeGreaterThan(reads);
    test.setSummaries([{ ...summary("settled"), status: "infrastructure_failed", consumedSeconds: 9, releasedSeconds: 1 }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(test.state.summaries[0]).toMatchObject({ launchState: "settled", consumedSeconds: 9, releasedSeconds: 1 });
    const settledReads = test.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(test.read).toHaveBeenCalledTimes(settledReads);
    test.controller.stop();
  });
  it("clears viewers and requests owner recovery on expiry", async () => {
    const test = setup();
    await test.controller.refresh();
    test.override(() => Promise.reject({ status: 401 }));
    await test.controller.refresh();
    expect(test.unauthorized).toHaveBeenCalledOnce();
    expect(test.state.sessions).toEqual([]);
    expect(test.sources[0].close).toHaveBeenCalledOnce();
  });
  it("respects the documented 60-second read limit pause", async () => {
    vi.useFakeTimers();
    const test = setup();
    test.override(() => Promise.reject({ status: 429 }));
    await test.controller.refresh();
    const calls = test.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(test.read).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(1000);
    expect(test.read.mock.calls.length).toBeGreaterThan(calls);
    test.controller.stop();
  });
  it("shows unavailable without perpetual loading or background retries after a 404", async () => {
    vi.useFakeTimers();
    const test = setup();
    test.override(() => Promise.reject({ status: 404 }));
    await test.controller.refresh();
    expect(test.state.connection).toBe("unavailable");
    expect(test.state.error).toBe("This run is unavailable to this owner.");
    expect(test.state.run).toBeNull();
    const reads = test.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(test.read).toHaveBeenCalledTimes(reads);
    test.override(undefined);
    await test.controller.refresh();
    expect(test.state.error).toBeNull();
    expect(test.state.run?.id).toBe(runId);
    test.controller.stop();
  });
  it("does not publish a delayed response after teardown", async () => {
    const test = setup();
    let release!: (value: unknown) => void;
    test.override((path) => path === `/runs/${runId}` ? new Promise((resolve) => { release = resolve; }) : undefined);
    const pending = test.controller.refresh();
    test.controller.stop();
    release(run);
    await pending;
    expect(test.state.run).toBeNull();
    expect(test.sources).toHaveLength(0);
  });
});
