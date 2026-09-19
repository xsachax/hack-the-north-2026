import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run, RunEvent } from "../lib/contracts";
import { createApi } from "./api";
import { createEventStreamHandler } from "./event-stream";
import { ServiceError } from "./errors";
import { Repository, type OwnerSession } from "./repository";

const origin = "http://127.0.0.1:3000";
const runId = "d6aa9a4e-a75c-48d0-bc44-ed3e9ac9d178";
const run: Run = {
  id: runId, cursor: 1, status: "running", authorizationAcknowledged: true,
  executionMode: "website",
  scope: { targetUrl: "https://example.com/", allowedSubdomains: [], pathPrefixes: ["/"] },
  createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z",
  cancelRequestedAt: null,
};
const event = (sequence: number): RunEvent => ({
  runId, sequence, attemptId: null, timestamp: run.createdAt,
  kind: "run.created", data: { status: "queued" },
});
const decode = (value?: Uint8Array) => new TextDecoder().decode(value);
const ids = (text: string) => [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
const session = (): OwnerSession => ({ ownerId: "owner", csrf: "csrf", expiresAt: Date.now() + 120_000 });
const request = (query = "", headers: HeadersInit = {}, signal?: AbortSignal) =>
  new Request(`${origin}/api/v1/runs/${runId}/events/stream${query}`, { headers, signal });
const baseHeaders = new Headers({ "X-Content-Type-Options": "nosniff", Vary: "Cookie, Origin" });

function fixture(events: RunEvent[] = [], status: Run["status"] = "running") {
  const repository = {
    getRun: vi.fn<Repository["getRun"]>(() => ({ ...run, status })),
    events: vi.fn<Repository["events"]>((_owner, _runId, { after, limit }) => {
      const remaining = events.filter((item) => item.sequence > after);
      const items = remaining.slice(0, limit);
      return { items, nextCursor: remaining.length > limit ? items.at(-1)!.sequence : null };
    }),
  };
  const handler = createEventStreamHandler(repository);
  const open = (req = request(), owner = session()) => handler(req, owner, runId, baseHeaders);
  return { repository, handler, open, events };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-19T00:00:00.000Z"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Offline tests must not use the network"); }));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  const pendingTimers = vi.getTimerCount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(pendingTimers).toBe(0);
});

describe("resumable owner-scoped event streams", () => {
  it("sends complete event frames and preserves security headers", async () => {
    const { open, repository } = fixture([event(1), event(2)], "succeeded");
    const response = open();
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("vary")).toBe("Cookie, Origin");
    const body = await response.text();
    expect(body).toBe([1, 2].map((id) =>
      `id: ${id}\nevent: run.created\ndata: ${JSON.stringify(event(id))}\n\n`).join(""));
    expect(repository.events).toHaveBeenCalledExactlyOnceWith("owner", runId, { after: 0, limit: 50 });
  });

  it.each(["query", "header"])("resumes exclusively from the %s cursor", async (source) => {
    const { open, repository } = fixture([1, 2, 3].map(event), "cancelled");
    const response = open(source === "query" ? request("?after=2") : request("", { "Last-Event-ID": "2" }));
    expect(ids(await response.text())).toEqual([3]);
    expect(repository.events).toHaveBeenCalledWith("owner", runId, { after: 2, limit: 50 });
  });

  it.each([
    "?after=", "?after=-1", "?after=1.5", "?after=1e2", "?after=01", "?after=%201",
    "?after=%2B1", "?after=9007199254740992", "?after=Infinity", "?after=NaN",
    "?after=1&after=1", "?limit=2&limit=2", "?unknown=1", "?limit=0",
    "?limit=101", "?limit=", "?limit=1.5", "?limit=1e2",
  ])("rejects invalid or duplicate query %s before stream creation", (query) => {
    const { open, repository } = fixture();
    expect(() => open(request(query))).toThrow(new ServiceError("invalid_request", 400));
    expect(repository.getRun).not.toHaveBeenCalled();
  });

  it.each(["", "-1", "01", "1.2", "1, 2", "9007199254740992", "null"])(
    "rejects invalid Last-Event-ID %s", (id) => {
      expect(() => fixture().open(request("", { "Last-Event-ID": id }))).toThrow("invalid_request");
    },
  );

  it.each(["1", "2", "0"])("prefers a valid Last-Event-ID over a valid initial query cursor (%s)", async (id) => {
    const { open, repository } = fixture([1, 2, 3].map(event), "succeeded");
    expect(ids(await open(request("?after=1", { "Last-Event-ID": id })).text()))
      .toEqual([1, 2, 3].filter((sequence) => sequence > Number(id)));
    expect(repository.events).toHaveBeenCalledExactlyOnceWith("owner", runId, { after: Number(id), limit: 50 });
  });

  it.each([
    ["?after=", "1"], ["?after=-1", "1"], ["?after=01", "1"], ["?after=1e2", "1"],
    ["?after=9007199254740992", "1"], ["?after=1&after=2", "3"],
    ["?after=1", ""], ["?after=1", "-1"], ["?after=1", "01"], ["?after=1", "1, 2"],
  ])("validates both cursor sources even when the header takes precedence (%s, %s)", (query, id) => {
    const { open, repository } = fixture();
    expect(() => open(request(query, { "Last-Event-ID": id }))).toThrow("invalid_request");
    expect(repository.getRun).not.toHaveBeenCalled();
  });

  it.each([1, 50, 100])("drains all terminal pages with a bounded page size of %i", async (limit) => {
    const { open, repository } = fixture(Array.from({ length: 225 }, (_, i) => event(i + 1)), "succeeded");
    const text = await open(request(`?limit=${limit}`)).text();
    expect(ids(text)).toEqual(Array.from({ length: 225 }, (_, i) => i + 1));
    expect(repository.events).toHaveBeenCalledTimes(Math.ceil(225 / limit));
    expect(repository.events.mock.calls.every((call) => call[2].limit === limit)).toBe(true);
  });

  it("closes an already-drained terminal stream without generating lifecycle events", async () => {
    const { open } = fixture([event(1)], "succeeded");
    expect(await open(request("?after=1")).text()).toBe("");
  });

  it("reads terminal status before each event page so final events cannot be missed", async () => {
    const { open, repository, events } = fixture();
    let polled = false;
    repository.getRun.mockImplementation(() => ({ ...run, status: polled ? "succeeded" : "running" }));
    repository.events.mockImplementationOnce(() => {
      polled = true;
      events.push(event(1));
      return { items: [], nextCursor: null };
    });
    const text = open().text();
    await vi.advanceTimersByTimeAsync(500);
    expect(ids(await text)).toEqual([1]);
  });

  it("reconnects without replaying previously received logical IDs", async () => {
    const { open, events } = fixture([event(1), event(2)]);
    const first = open().body!.getReader();
    expect(ids(decode((await first.read()).value))).toEqual([1, 2]);
    await first.cancel();
    events.push(event(3));
    const second = open(request("", { "Last-Event-ID": "2" })).body!.getReader();
    expect(ids(decode((await second.read()).value))).toEqual([3]);
    await second.cancel();
  });

  it("does not read or poll until demanded, and does not prefetch while backpressured", async () => {
    const { open, repository } = fixture(Array.from({ length: 225 }, (_, i) => event(i + 1)));
    const reader = open().body!.getReader();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(repository.events).not.toHaveBeenCalled();
    expect(ids(decode((await reader.read()).value))).toHaveLength(50);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(repository.events).toHaveBeenCalledTimes(1);
    expect(ids(decode((await reader.read()).value))[0]).toBe(51);
    await reader.cancel();
  });

  it("polls at the configured interval only while waiting for a read", async () => {
    const { repository, events } = fixture();
    const handler = createEventStreamHandler(repository, { pollMs: 10 });
    const reader = handler(request(), session(), runId, baseHeaders).body!.getReader();
    const reading = reader.read();
    await vi.advanceTimersByTimeAsync(9);
    expect(repository.events).toHaveBeenCalledTimes(1);
    events.push(event(1));
    await vi.advanceTimersByTimeAsync(1);
    expect(ids(decode((await reading).value))).toEqual([1]);
    expect(repository.events).toHaveBeenCalledTimes(2);
    await reader.cancel();
  });

  it("emits keepalive comments without logical IDs or duplicate events", async () => {
    const { open, repository } = fixture();
    const reader = open().body!.getReader();
    const reading = reader.read();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(decode((await reading).value)).toBe(": keepalive\n\n");
    const calls = repository.events.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(repository.events).toHaveBeenCalledTimes(calls);
    await reader.cancel();
  });

  it.each(["cancel", "abort"])("cleans pending polling and listeners on %s", async (action) => {
    const { open, repository } = fixture();
    const abort = new AbortController();
    const req = request("", {}, abort.signal);
    const removeListener = vi.spyOn(req.signal, "removeEventListener");
    const reader = open(req).body!.getReader();
    const reading = reader.read();
    await vi.advanceTimersByTimeAsync(500);
    const calls = repository.events.mock.calls.length;
    if (action === "cancel") await reader.cancel();
    else abort.abort();
    expect(await reading).toEqual({ done: true, value: undefined });
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(repository.events).toHaveBeenCalledTimes(calls);
  });

  it("handles an already aborted request without polling or retaining resources", async () => {
    const { open, repository } = fixture();
    const abort = new AbortController();
    abort.abort();
    expect(await open(request("", {}, abort.signal)).text()).toBe("");
    expect(repository.events).not.toHaveBeenCalled();
  });

  it.each(["pending", "unread"])("closes at session expiry while %s", async (mode) => {
    const { open, repository } = fixture();
    const reader = open(request(), { ...session(), expiresAt: Date.now() + 750 }).body!.getReader();
    const reading = mode === "pending" ? reader.read() : undefined;
    await vi.advanceTimersByTimeAsync(750);
    expect(await (reading ?? reader.read())).toEqual({ done: true, value: undefined });
    const calls = repository.events.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(repository.events).toHaveBeenCalledTimes(calls);
  });

  it("rejects an expired session before headers", () => {
    expect(() => fixture().open(request(), { ...session(), expiresAt: Date.now() })).toThrow("unauthorized");
  });

  it("bounds lifetime even if nobody consumes the body", async () => {
    const { open, repository } = fixture();
    const response = open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await response.text()).toBe("");
    expect(repository.events).not.toHaveBeenCalled();
  });

  it("sanitizes failures after headers and closes", async () => {
    const { open, repository } = fixture([event(1)]);
    const reader = open().body!.getReader();
    expect(ids(decode((await reader.read()).value))).toEqual([1]);
    repository.events.mockImplementation(() => { throw new Error("secret sqlite path and credentials"); });
    expect(decode((await reader.read()).value)).toBe('event: error\ndata: {"code":"unavailable"}\n\n');
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it.each(["duplicate", "out-of-order", "wrong-run", "oversized"])(
    "never emits invalid %s event pages", async (kind) => {
      const { open, repository } = fixture();
      const items = kind === "duplicate" ? [event(1), event(1)]
        : kind === "out-of-order" ? [event(2), event(1)]
        : kind === "wrong-run" ? [{ ...event(1), runId: randomUUID() }]
        : Array.from({ length: 51 }, (_, i) => event(i + 1));
      repository.events.mockReturnValue({ items, nextCursor: null });
      expect(await open().text()).toBe('event: error\ndata: {"code":"unavailable"}\n\n');
    },
  );

  it("caps per-owner connections and releases slots exactly once on close", async () => {
    const { open } = fixture();
    const abort = new AbortController();
    const streams = [open(request("", {}, abort.signal)), ...Array.from({ length: 4 }, () => open())];
    expect(() => open()).toThrow("rate_limited");
    const otherOwner = open(request(), { ...session(), ownerId: "other-owner" });
    abort.abort();
    await streams[0].body!.cancel();
    const replacement = open();
    expect(() => open()).toThrow("rate_limited");
    await Promise.all([...streams.slice(1), otherOwner, replacement].map((response) => response.body!.cancel()));
  });

  it("caps total connections across owners and releases slots at the deadline", async () => {
    const { open } = fixture();
    for (let i = 0; i < 100; i++) open(request(), { ...session(), ownerId: `owner-${i}` });
    expect(() => open()).toThrow("rate_limited");
    await vi.advanceTimersByTimeAsync(60_000);
    await open().body!.cancel();
  });
});

describe("stream API admission and durable replay", () => {
  let directory: string;
  let repository: Repository;
  let handler: ReturnType<typeof createApi>;
  let owner: ReturnType<Repository["createSession"]>;
  let id: string;

  beforeEach(() => {
    directory = resolve(`.event-stream-test-${randomUUID()}`);
    repository = new Repository(directory);
    owner = repository.createSession();
    handler = createApi({ repository, configuration: { origin, production: false } });
    id = repository.createRun(owner.ownerId, randomUUID(), {
      authorizationAcknowledged: true, scope: run.scope,
      assignments: [{ personaId: "careful-first-timer", goal: "Explore", criteria: ["Navigation works"] }],
    }).run.id;
  });

  afterEach(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function apiRequest(path = `runs/${id}/events/stream`, headers: HeadersInit = {}) {
    return new Request(`${origin}/api/v1/${path}`, {
      headers: { cookie: `ff_owner=${owner.token}`, ...headers },
    });
  }

  it("retains events pagination and replays the same persisted events without adding any", async () => {
    repository.cancelRun(owner.ownerId, id);
    const persisted = repository.events(owner.ownerId, id, { after: 0, limit: 100 });
    const response = await handler(apiRequest());
    expect(response.status).toBe(200);
    expect(ids(await response.text())).toEqual(persisted.items.map((item) => item.sequence));
    const paginated = await handler(apiRequest(`runs/${id}/events?after=0&limit=1`));
    expect(paginated.headers.get("content-type")).toBe("application/json");
    expect(await paginated.json()).toEqual({
      data: repository.events(owner.ownerId, id, { after: 0, limit: 1 }),
    });
    expect(repository.events(owner.ownerId, id, { after: 0, limit: 100 })).toEqual(persisted);
  });

  it("denies another owner's run before headers and reveals no events", async () => {
    const other = repository.createSession();
    const response = await handler(apiRequest(undefined, { cookie: `ff_owner=${other.token}` }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "not found" } });
  });

  it.each([
    [{ cookie: "" }, 401],
    [{ origin: "https://attacker.example" }, 403],
    [{ "sec-fetch-site": "cross-site" }, 403],
    [{ host: "attacker.example" }, 403],
  ] as const)("applies existing API admission guards %j", async (headers, status) => {
    const response = await handler(apiRequest(undefined, headers));
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("uses the existing owner read rate limit for stream admission", async () => {
    repository.consumeRate(`read:${owner.ownerId}`, 300);
    for (let i = 1; i < 300; i++) repository.consumeRate(`read:${owner.ownerId}`, 300);
    const response = await handler(apiRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
  });

  it("returns invalid cursor errors before switching to SSE", async () => {
    const response = await handler(apiRequest(`runs/${id}/events/stream?after=1&after=2`));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "invalid request" } });
  });

  it("supports native EventSource reconnects retaining their initial after query", async () => {
    const controller = new AbortController();
    const initialRequest = apiRequest(`runs/${id}/events/stream?after=0`);
    const firstResponse = await handler(new Request(initialRequest, { signal: controller.signal }));
    const reader = firstResponse.body!.getReader();
    const firstIds = ids(decode((await reader.read()).value));
    expect(firstIds).toEqual([1]);
    controller.abort();
    await reader.cancel();
    repository.cancelRun(owner.ownerId, id);
    const response = await handler(apiRequest(`runs/${id}/events/stream?after=0`, {
      "Last-Event-ID": String(firstIds.at(-1)),
    }));
    expect(response.status).toBe(200);
    const persisted = repository.events(owner.ownerId, id, { after: 1, limit: 100 });
    const resumed = ids(await response.text());
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed).toEqual(persisted.items.map((item) => item.sequence));
    expect(resumed).not.toContain(1);
  });

  it("denies expired cookies before headers", async () => {
    vi.setSystemTime(owner.expiresAt);
    expect((await handler(apiRequest())).status).toBe(401);
  });
});
