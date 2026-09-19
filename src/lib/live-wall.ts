import { eventSchema, type Attempt, type Run, type RunEvent, type Status } from "./contracts";
import type { AttemptSummary, SessionView } from "./ui-contracts";

export const MAX_VIEWERS = 3;
export const isTerminal = (status: Status) => status !== "queued" && status !== "running";
export const eventKinds = eventSchema.shape.kind.options;

export type WallSnapshot = {
  run: Run | null;
  attempts: Attempt[];
  summaries: AttemptSummary[];
  sessions: SessionView[];
  events: RunEvent[];
  cursor: number;
  connection: "loading" | "live" | "reconnecting" | "finished" | "unavailable";
  error: string | null;
  finalizing: boolean;
};
export const emptyWall = (): WallSnapshot => ({
  run: null, attempts: [], summaries: [], sessions: [], events: [], cursor: 0,
  connection: "loading", error: null, finalizing: false,
});

/** Only advance across a contiguous prefix; replay fills holes without losing buffered events. */
export function mergeEvents(current: RunEvent[], incoming: RunEvent[], runId: string) {
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  for (const event of incoming) {
    if (event.runId === runId && !bySequence.has(event.sequence)) bySequence.set(event.sequence, event);
  }
  const events = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  let cursor = 0;
  for (const event of events) {
    if (event.sequence !== cursor + 1) break;
    cursor = event.sequence;
  }
  return { events, cursor, gap: events.some((event) => event.sequence > cursor) };
}

export function projectWall(snapshot: WallSnapshot): WallSnapshot {
  let run = snapshot.run;
  const attempts = new Map(snapshot.attempts.map((attempt) => [attempt.id, attempt]));
  const hidden = new Set(snapshot.summaries.filter((summary) =>
    ["recovering", "quarantined", "settled"].includes(summary.launchState)).map((summary) => summary.attemptId));
  for (const event of snapshot.events) {
    // Safety signals hide access-bearing viewers even while a history gap is repaired.
    if (event.attemptId && ["attempt.recovering", "attempt.finished"].includes(event.kind)) hidden.add(event.attemptId);
    if (run && event.kind === "run.cancel_requested") run = { ...run, cancelRequestedAt: run.cancelRequestedAt ?? event.timestamp };
    if (event.sequence > snapshot.cursor) continue;
    if (run && event.kind === "run.finished" && event.data.status && isTerminal(event.data.status)) {
      run = { ...run, status: event.data.status };
    }
    if (run?.status === "queued" && event.kind === "attempt.started") run = { ...run, status: "running" };
    const attempt = event.attemptId ? attempts.get(event.attemptId) : null;
    if (attempt && event.kind === "attempt.finished" && event.data.status && isTerminal(event.data.status)) {
      attempts.set(attempt.id, { ...attempt, status: event.data.status });
    }
    if (attempt && event.kind === "attempt.started" && !isTerminal(attempt.status)) {
      attempts.set(attempt.id, { ...attempt, status: "running" });
    }
  }
  const terminalSignal = snapshot.events.some((event) => event.kind === "run.finished");
  const sessions = snapshot.sessions.map((session) => ({
    ...session,
    available: session.available && !!run && !isTerminal(run.status) && !run.cancelRequestedAt &&
      !terminalSignal && !hidden.has(session.attemptId) && attempts.get(session.attemptId)?.status === "running",
  })).map((session) => ({ ...session, liveViewUrl: session.available ? session.liveViewUrl : null }));
  return { ...snapshot, run, attempts: [...attempts.values()], sessions };
}

export function needsCleanup(summaries: AttemptSummary[]) {
  return summaries.some((summary) => !["not_launched", "settled"].includes(summary.launchState));
}

export function selectViewers(selected: string[], eligible: string[], requested?: string) {
  const next = selected.filter((id) => eligible.includes(id)).slice(0, MAX_VIEWERS);
  if (!requested) return next;
  if (next.includes(requested)) return next.filter((id) => id !== requested);
  return eligible.includes(requested) && next.length < MAX_VIEWERS ? [...next, requested] : next;
}

type Stream = {
  addEventListener: (kind: string, listener: (event: MessageEvent<string>) => void) => void;
  onopen: ((event: Event) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  close: () => void;
};
type Read = <T>(path: string, options?: { signal?: AbortSignal }) => Promise<T>;
type EventPage = { items: RunEvent[]; nextCursor: number | null };

/** One serialized reconciliation loop owns reads, SSE, retry timers, and teardown. */
export function createWallController(runId: string, dependencies: {
  read: Read;
  stream: (path: string) => Stream;
  publish: (state: WallSnapshot) => void;
  unauthorized: () => void;
}) {
  let state = emptyWall();
  let stopped = false;
  let stream: Stream | null = null;
  let refreshPromise: Promise<void> | null = null;
  let again = false;
  let failures = 0;
  let rateLimited = false;
  let unavailable = false;
  let reconnectFailures = 0;
  let terminalPolls = 0;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const path = `/runs/${encodeURIComponent(runId)}`;
  const read = <T>(suffix: string) => dependencies.read<T>(`${path}${suffix}`, { signal: abort.signal });
  const publish = () => {
    if (stopped) return;
    state = projectWall(state);
    dependencies.publish(state);
  };
  const closeStream = () => { stream?.close(); stream = null; };
  const fail = (error: unknown) => {
    const status = typeof error === "object" && error !== null && "status" in error ? error.status : null;
    if (status === 401 || status === 403) {
      state = { ...state, sessions: [], error: "Owner session expired. Unlock this workspace again." };
      publish();
      stop();
      dependencies.unauthorized();
      return;
    }
    unavailable = status === 404;
    state = unavailable
      ? { ...emptyWall(), connection: "unavailable", error: "This run is unavailable to this owner." }
      : { ...state, sessions: [], error: status === 429 ? "Read limit reached. Retrying at a slower pace."
        : "Could not refresh persisted run data. Retry or wait for reconnection." };
    failures++;
    rateLimited = status === 429;
    if (rateLimited || unavailable) {
      closeStream();
      clearTimeout(reconnect);
      reconnect = undefined;
    }
    publish();
  };
  const accept = (incoming: RunEvent[]) => {
    const newTerminal = incoming.some((event) =>
      (event.kind === "run.finished" || event.kind === "attempt.finished") &&
      !state.events.some((known) => known.sequence === event.sequence));
    const merged = mergeEvents(state.events, incoming, runId);
    state = { ...state, events: merged.events, cursor: merged.cursor, finalizing: state.finalizing || newTerminal };
    publish();
    return merged.gap;
  };
  const openStream = () => {
    if (stopped || stream || reconnect || !state.run || isTerminal(state.run.status)) return;
    const source = dependencies.stream(`/api/v1${path}/events/stream?after=${state.cursor}`);
    stream = source;
    source.onopen = () => {
      if (stopped || stream !== source) return;
      reconnectFailures = 0;
      state = { ...state, connection: "live" };
      publish();
    };
    for (const kind of eventKinds) source.addEventListener(kind, (message) => {
      if (stopped || stream !== source) return;
      const parsed = (() => { try { return eventSchema.safeParse(JSON.parse(message.data)); } catch { return null; } })();
      if (!parsed?.success || parsed.data.runId !== runId || String(parsed.data.sequence) !== message.lastEventId) {
        source.onerror?.(new Event("error"));
        return;
      }
      const gap = accept([parsed.data]);
      if (gap || ["run.finished", "attempt.finished", "attempt.recovering", "run.cancel_requested"].includes(kind)) void refresh();
      if (state.run && isTerminal(state.run.status)) {
        closeStream();
        state = { ...state, connection: "finished" };
        publish();
      }
    });
    source.onerror = () => {
      if (stopped || stream !== source) return;
      closeStream();
      state = { ...state, connection: "reconnecting", sessions: [] };
      publish();
      reconnect = setTimeout(() => {
        reconnect = undefined;
        void refresh();
      }, Math.min(30_000, 1000 * 2 ** Math.min(reconnectFailures++, 5)));
      void refresh();
    };
  };
  const reconcile = async () => {
    clearTimeout(poll);
    const terminalSequenceBeforeRead = state.events.reduce((latest, event) =>
      event.kind === "run.finished" || event.kind === "attempt.finished" ? Math.max(latest, event.sequence) : latest, 0);
    try {
      const [run, attempts, summaries, sessions] = await Promise.all([
        read<Run>(""), read<{ items: Attempt[] }>("/attempts"),
        read<{ items: AttemptSummary[] }>("/summaries"), read<{ items: SessionView[] }>("/sessions"),
      ]);
      if (stopped) return;
      // Event overlays remain authoritative when a slower GET started before a terminal event.
      state = { ...state, run, attempts: attempts.items, summaries: summaries.items, sessions: sessions.items };
      let after = state.cursor;
      for (let pages = 0; pages < 100; pages++) {
        const page = await read<EventPage>(`/events?after=${after}&limit=100`);
        if (stopped) return;
        const items = page.items.map((event) => eventSchema.parse(event));
        if (items.some((event) => event.runId !== runId)) throw new Error("Invalid event history");
        accept(items);
        if (page.nextCursor === null) break;
        if (page.nextCursor <= after || pages === 99) throw new Error("Invalid event pagination");
        after = page.nextCursor;
      }
      failures = 0;
      rateLimited = false;
      unavailable = false;
      const discoveredTerminal = state.events.some((event) => event.sequence > terminalSequenceBeforeRead &&
        (event.kind === "run.finished" || event.kind === "attempt.finished"));
      // History can be newer than the parallel summary reads. Re-read once after
      // each newly seen terminal transition before considering cleanup settled.
      if (discoveredTerminal) again = true;
      state = { ...state, error: null, finalizing: discoveredTerminal };
      publish();
      if (state.run && isTerminal(state.run.status)) {
        closeStream();
        clearTimeout(reconnect);
        reconnect = undefined;
        state = { ...state, connection: "finished" };
        publish();
      } else openStream();
    } catch (error) {
      if (!stopped) fail(error);
    }
    if (stopped) return;
    const terminal = state.run && isTerminal(state.run.status);
    if (!unavailable && (failures || state.finalizing || !terminal || needsCleanup(state.summaries))) {
      const delay = rateLimited ? 60_000 : failures ? Math.min(60_000, 5000 * 2 ** Math.min(failures, 4))
        : terminal && ++terminalPolls > 12 ? 30_000 : 5000;
      poll = setTimeout(() => void refresh(), delay);
    }
  };
  function refresh(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (refreshPromise) { again = true; return refreshPromise; }
    refreshPromise = reconcile().finally(() => {
      refreshPromise = null;
      if (again && !stopped) { again = false; void refresh(); }
    });
    return refreshPromise;
  }
  function stop() {
    stopped = true;
    abort.abort();
    closeStream();
    clearTimeout(poll);
    clearTimeout(reconnect);
  }
  return { refresh, stop };
}
