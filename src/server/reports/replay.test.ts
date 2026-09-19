import { afterEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("node:dns/promises", async (original) => ({
  ...await original<typeof import("node:dns/promises")>(), lookup: vi.fn(),
}));
vi.mock("node:https", async (original) => ({
  ...await original<typeof import("node:https")>(), request: vi.fn(),
}));

import {
  createBrowserbaseReplayProvider, createReplayAdapter, parseReplayRange,
  REPLAY_LIMITS, type AuthorizedReplayAssociation, type ReplayProvider,
} from "./replay";

const SESSION = "6f5cbab0-5263-471b-9081-76ea2a49a8aa";
const OTHER = "d2cfe570-b56c-4d50-bc47-709df06c31f3";
const ORIGIN = "https://cdn.example.com";
const association: AuthorizedReplayAssociation = {
  sessionId: SESSION, state: "ended", recordingEnabled: true,
  sensitivePlaybackAuthorized: true, playbackBasePath: "/api/reports/run/attempt/replay",
};
const metadata = (sessionId = SESSION) => ({
  pageCount: 1, pages: [{ pageId: "0", url: `/v1/sessions/${sessionId}/replays/0`, startTimeMs: 0, endTimeMs: 1000 }],
});
const playlist = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="${ORIGIN}/init.mp4?signature=private"
#EXTINF:1,secret title
${ORIGIN}/segment.m4s?signature=private
#EXT-X-ENDLIST
`;
const mp4 = Buffer.from([0, 0, 0, 12, ...Buffer.from("ftyp"), 0, 0, 0, 0]);
function setup(options: { metadata?: unknown; playlist?: string; now?: () => number; segmentOrigins?: string[] } = {}) {
  const provider = {
    metadata: vi.fn<ReplayProvider["metadata"]>(async () => options.metadata ?? metadata()),
    playlist: vi.fn<ReplayProvider["playlist"]>(async () => options.playlist ?? playlist),
  };
  const download = vi.fn<(url: URL, signal: AbortSignal) => Promise<Uint8Array>>(async () => mp4);
  const adapter = createReplayAdapter({
    provider, download, segmentOrigins: options.segmentOrigins ?? [ORIGIN], now: options.now,
  });
  return { adapter, provider, download };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("authorized replay adapter", () => {
  it("uses the real HLS format and emits only application-relative playback paths", async () => {
    const { adapter, provider, download } = setup();
    const report = await adapter.inspect(association);
    expect(report).toMatchObject({
      status: "ready", format: "hls", sensitive: true, fallback: "operator-dashboard",
      pages: [{ index: 0, playlistPath: `${association.playbackBasePath}/pages/0/playlist` }],
    });
    const result = await adapter.playlist(association, 0);
    expect(result).toContain(`#EXT-X-MAP:URI="${association.playbackBasePath}/pages/0/segments/0"`);
    expect(result).toContain(`${association.playbackBasePath}/pages/0/segments/1`);
    expect(result).toContain("#EXTINF:1,");
    for (const forbidden of [SESSION, ORIGIN, "signature", "private", "secret title", "browserbase"]) {
      expect(JSON.stringify(report) + result).not.toContain(forbidden);
    }
    expect(await adapter.segment(association, 0, 1)).toEqual({ status: 200, body: mp4, contentType: "video/mp4" });
    expect(download.mock.calls[0][0].toString()).toBe(`${ORIGIN}/segment.m4s?signature=private`);
    expect(provider.metadata).toHaveBeenCalledExactlyOnceWith(SESSION, expect.any(AbortSignal));
    expect(provider.playlist).toHaveBeenCalledExactlyOnceWith(SESSION, "0", expect.any(AbortSignal));
  });

  it.each([
    [{ sensitivePlaybackAuthorized: false }, "unavailable"],
    [{ recordingEnabled: false }, "unavailable"],
    [{ state: "running" }, "processing"],
    [{ expiresAt: 1 }, "expired"],
    [{ sessionId: `../${SESSION}` }, "unavailable"],
    [{ sessionId: "https://127.0.0.1" }, "unavailable"],
    [{ playbackBasePath: "//evil.example/replay" }, "unavailable"],
    [{ playbackBasePath: "/api/a/%2e%2e" }, "unavailable"],
    [{ playbackBasePath: "/api/a?secret=1" }, "unavailable"],
    [{ playbackBasePath: `/api/replays/${SESSION}` }, "unavailable"],
  ])("rejects invalid or unauthorized association %j before provider access", async (patch, status) => {
    const { adapter, provider, download } = setup();
    const input = { ...association, ...patch } as AuthorizedReplayAssociation;
    expect((await adapter.inspect(input)).status).toBe(status);
    await expect(adapter.playlist(input, 0)).rejects.toMatchObject({ status });
    await expect(adapter.segment(input, 0, 0)).rejects.toMatchObject({ status });
    expect(provider.metadata).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("rechecks sensitive access even when another request warmed the cache", async () => {
    const { adapter, download } = setup();
    await adapter.inspect(association);
    await expect(adapter.segment({ ...association, sensitivePlaybackAuthorized: false }, 0, 0))
      .rejects.toMatchObject({ status: "unavailable" });
    expect(download).not.toHaveBeenCalled();
  });

  it.each([
    metadata(OTHER),
    { ...metadata(), pageCount: 2 },
    { pageCount: 2, pages: [...metadata().pages, ...metadata().pages] },
    { pageCount: 101, pages: [] },
    { pageCount: 1, pages: [{ ...metadata().pages[0], pageId: "../0" }] },
    { pageCount: 1, pages: [{ ...metadata().pages[0], url: "https://127.0.0.1/private" }] },
    { pageCount: 1, pages: [{ ...metadata().pages[0], url: `https://api.browserbase.com/v1/sessions/${SESSION}/replays/0` }] },
    { pageCount: 1, pages: [{ ...metadata().pages[0], endTimeMs: -1 }] },
    { pageCount: 1, pages: [{ ...metadata().pages[0], startTimeMs: Infinity }] },
    { pageCount: 1, pages: [{ ...metadata().pages[0], startTimeMs: 2000 }] },
    [{ sessionId: SESSION, type: 2, data: { node: "<script>alert(1)</script>" }, timestamp: 1 }],
    { downloadUrl: "http://169.254.169.254/latest/meta-data" },
  ])("fails closed on malicious, cross-session or unsupported metadata %#", async (raw) => {
    const { adapter, provider, download } = setup({ metadata: raw });
    expect((await adapter.inspect(association)).status).toBe("unsupported");
    expect(provider.playlist).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("strips unknown metadata and never returns provider diagnostics", async () => {
    const { adapter } = setup({ metadata: {
      ...metadata(), apiKey: "credential", liveViewUrl: "https://live.browserbase.com",
    } });
    expect(JSON.stringify(await adapter.inspect(association))).not.toMatch(/credential|liveView/);
  });

  it.each([
    [404, "unavailable"], [401, "unavailable"], [403, "unavailable"], [500, "unavailable"],
    [410, "expired"], [429, "processing"], [409, "processing"], [501, "unsupported"],
  ])("maps HTTP %i to safe %s without error text", async (httpStatus, expected) => {
    const { adapter, provider } = setup();
    provider.metadata.mockRejectedValue({ status: httpStatus, message: `API-KEY https://secret/${SESSION}` });
    const report = await adapter.inspect(association);
    expect(report.status).toBe(expected);
    expect(JSON.stringify(report)).not.toMatch(/API-KEY|secret|6f5cbab0/);
  });

  it("does not guess whether an empty recording is processing or expired", async () => {
    const { adapter } = setup({ metadata: { pageCount: 0, pages: [] } });
    expect((await adapter.inspect(association)).status).toBe("unavailable");
  });

  it("returns unsupported without guessing CDN allowlists", async () => {
    const { adapter, provider } = setup({ segmentOrigins: [] });
    expect((await adapter.inspect(association)).status).toBe("unsupported");
    expect(provider.metadata).not.toHaveBeenCalled();
  });

  it.each([
    "http://cdn.example.com/seg", "https://cdn.example.com.evil.test/seg", "https://127.0.0.1/seg",
    "https://169.254.169.254/seg", "https://user:pass@cdn.example.com/seg", "//cdn.example.com/seg",
    "file:///etc/passwd", "data:video/mp4;base64,AAAA", "javascript:alert(1)",
    "https://cdn.example.com:444/seg", "https://cdn.example.com/seg#fragment",
    "https://cdn.example.com\\@evil.test/seg",
  ])("never fetches a malicious segment URI %s", async (url) => {
    const { adapter, download } = setup({ playlist: playlist.replace(`${ORIGIN}/segment.m4s?signature=private`, url) });
    expect((await adapter.inspect(association)).status).toBe("unsupported");
    expect(download).not.toHaveBeenCalled();
  });

  it.each([
    '#EXT-X-KEY:METHOD=AES-128,URI="https://evil.test/key"',
    '#EXT-X-SESSION-DATA:DATA-ID="secret",URI="https://evil.test/"',
    '#EXT-X-MEDIA:TYPE=AUDIO,URI="https://evil.test/"',
    "#EXT-X-BYTERANGE:100@0", "#EXT-X-STREAM-INF:BANDWIDTH=1",
    '#EXT-X-MAP:URI="https://evil.test/init"',
    "#secret-comment https://secret.example",
    "#EXT-X-PROGRAM-DATE-TIME:2026-09-19T09:00:00Z",
  ])("rejects unknown or externally referencing manifest syntax %s", async (line) => {
    const { adapter, download } = setup({ playlist: playlist.replace("#EXT-X-VERSION:7", line) });
    expect((await adapter.inspect(association)).status).toBe("unsupported");
    expect(download).not.toHaveBeenCalled();
  });

  it.each([
    "<html>signed credential</html>", playlist.replace("#EXT-X-ENDLIST", ""),
    playlist.replace("#EXTINF:1,secret title", "#EXTINF:NaN,"),
    playlist.replace("#EXTINF:1,secret title", "#EXTINF:9999,"),
    "x".repeat(REPLAY_LIMITS.playlistBytes + 1),
  ])("rejects malformed, live, or oversized playlists %#", async (text) => {
    const { adapter } = setup({ playlist: text });
    expect((await adapter.inspect(association)).status).toBe("unsupported");
  });

  it("binds cache and page selection to the exact trusted session", async () => {
    const { adapter, provider } = setup();
    await adapter.inspect(association);
    expect((await adapter.inspect({ ...association, sessionId: OTHER })).status).toBe("unsupported");
    expect(provider.metadata).toHaveBeenCalledTimes(2);
    await expect(adapter.playlist(association, 1)).rejects.toMatchObject({ status: "unavailable" });
    await expect(adapter.segment(association, 0, -1)).rejects.toMatchObject({ status: "unavailable" });
    await expect(adapter.segment(association, 0, 2)).rejects.toMatchObject({ status: "unavailable" });
  });

  it("bounds ranges locally without forwarding client ranges upstream", async () => {
    const { adapter, download } = setup();
    expect(await adapter.segment(association, 0, 0, "bytes=4-7")).toEqual({
      status: 206, body: mp4.slice(4, 8), contentType: "video/mp4", contentRange: "bytes 4-7/12",
    });
    expect(download.mock.calls[0]).toHaveLength(2);
    await expect(adapter.segment(association, 0, 0, "bytes=12-15")).rejects.toMatchObject({ status: "unsupported" });
  });

  it.each(["bytes=0-", "bytes=-100", "bytes=0-1,3-4", "bytes=3-1", "bytes=0-99999999", "bytes=0-2\r\nHost:evil"])(
    "rejects unsupported Range %s before any provider access", async (range) => {
      const { adapter, provider } = setup();
      expect(() => parseReplayRange(range)).toThrow();
      await expect(adapter.segment(association, 0, 0, range)).rejects.toMatchObject({ status: "unsupported" });
      expect(provider.metadata).not.toHaveBeenCalled();
    },
  );

  it.each([Buffer.from("<svg/onload=alert(1)>"), Buffer.alloc(REPLAY_LIMITS.segmentBytes + 1), Buffer.alloc(0)])(
    "rejects non-media or oversized upstream body %#", async (body) => {
      const { adapter, download } = setup();
      download.mockResolvedValue(body);
      await expect(adapter.segment(association, 0, 0)).rejects.toMatchObject({ status: "unsupported" });
    },
  );

  it("deduplicates cached metadata/playlist requests and expires the cache", async () => {
    let time = 100;
    const { adapter, provider } = setup({ now: () => time });
    await Promise.all(Array.from({ length: 20 }, () => adapter.inspect(association)));
    expect(provider.metadata).toHaveBeenCalledTimes(1);
    expect(provider.playlist).toHaveBeenCalledTimes(1);
    time += REPLAY_LIMITS.cacheMs + 1;
    await adapter.inspect(association);
    expect(provider.metadata).toHaveBeenCalledTimes(2);
  });

  it("does not poll or retry, and aborts a hanging provider within ten seconds", async () => {
    vi.useFakeTimers();
    const { adapter, provider } = setup();
    let signal: AbortSignal | undefined;
    provider.metadata.mockImplementation((_id?: string, received?: AbortSignal) => {
      signal = received;
      return new Promise(() => {});
    });
    const pending = adapter.inspect(association);
    await vi.advanceTimersByTimeAsync(REPLAY_LIMITS.timeoutMs);
    expect((await pending).status).toBe("unavailable");
    expect(signal?.aborted).toBe(true);
    expect(provider.metadata).toHaveBeenCalledTimes(1);
  });

  it("bounds request budget even when repeated segment requests bypass cache", async () => {
    const { adapter, download } = setup({ now: () => 100 });
    await adapter.inspect(association);
    for (let i = 0; i < REPLAY_LIMITS.requestsPerMinute - 2; i++) await adapter.segment(association, 0, 1);
    await expect(adapter.segment(association, 0, 1)).rejects.toMatchObject({ status: "processing" });
    expect(download).toHaveBeenCalledTimes(REPLAY_LIMITS.requestsPerMinute - 2);
  });

  it.each([
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.19.0.1", "192.0.0.8",
    "203.0.113.1", "198.51.100.1", "::1",
  ])("rejects CDN DNS resolution to nonpublic address %s", async (address) => {
    const { provider } = setup();
    vi.mocked(lookup).mockImplementation(async () => [{ address, family: 4 }] as never);
    const adapter = createReplayAdapter({ provider, segmentOrigins: [ORIGIN] });
    await expect(adapter.segment(association, 0, 0)).rejects.toMatchObject({ status: "unsupported" });
    expect(request).not.toHaveBeenCalled();
  });

  it("pins public DNS, sends no credentials, and refuses CDN redirects", async () => {
    const { provider } = setup();
    vi.mocked(lookup).mockImplementation(async () => [{ address: "93.184.216.34", family: 4 }] as never);
    const response = Object.assign(new PassThrough(), {
      statusCode: 302, headers: { location: "http://169.254.169.254/credentials" },
    });
    const req = Object.assign(new EventEmitter(), { end: vi.fn() });
    vi.mocked(request).mockImplementation(((_url: URL, _options: object, callback: (response: unknown) => void) => {
      req.end.mockImplementation(() => callback!(response as never));
      return req;
    }) as unknown as typeof request);
    const adapter = createReplayAdapter({ provider, segmentOrigins: [ORIGIN] });
    await expect(adapter.segment(association, 0, 0)).rejects.toMatchObject({ status: "unavailable" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(response.destroyed).toBe(true);
    const options = vi.mocked(request).mock.calls[0][1] as import("node:https").RequestOptions;
    expect(options).toMatchObject({ family: 4, agent: false, method: "GET" });
    expect(options.headers).toEqual({ Accept: "video/mp4, application/octet-stream", "Accept-Encoding": "identity" });
    const resolved = vi.fn();
    (options.lookup as CallableFunction)("cdn.example.com", {}, resolved);
    expect(resolved).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });
});

describe("provider-backed session provenance and cache isolation", () => {
  const secondAssociation = { ...association, sessionId: OTHER, playbackBasePath: "/api/reports/other/attempt/replay" };
  const manifestFor = (id: string) => playlist
    .replace("/init.mp4", id === SESSION ? "/opaque-alpha/init.mp4" : "/opaque-beta/init.mp4")
    .replace("/segment.m4s", id === SESSION ? "/opaque-alpha/segment.m4s" : "/opaque-beta/segment.m4s");
  function sessions() {
    const provider = {
      metadata: vi.fn<ReplayProvider["metadata"]>(async (id) => metadata(id)),
      playlist: vi.fn<ReplayProvider["playlist"]>(async (id) => manifestFor(id)),
    };
    const download = vi.fn(async (url: URL) => {
      const bytes = Buffer.from(mp4);
      bytes[11] = url.pathname.includes("opaque-alpha") ? 1 : 2;
      return bytes;
    });
    const adapter = createReplayAdapter({ provider, download, segmentOrigins: [ORIGIN] });
    return { adapter, provider, download };
  }

  it("keeps A/B initialization and media mappings separate on the same CDN with identical page/index numbers", async () => {
    const { adapter, provider, download } = sessions();
    const [a, b] = await Promise.all([adapter.inspect(association), adapter.inspect(secondAssociation)]);
    expect(a.status).toBe("ready");
    expect(b.status).toBe("ready");
    expect(provider.playlist).toHaveBeenCalledWith(SESSION, "0", expect.any(AbortSignal));
    expect(provider.playlist).toHaveBeenCalledWith(OTHER, "0", expect.any(AbortSignal));
    for (const [input, marker] of [[association, 1], [secondAssociation, 2], [association, 1]] as const) {
      for (const index of [0, 1]) {
        expect((await adapter.segment(input, 0, index)).body[11]).toBe(marker);
      }
    }
    expect(download.mock.calls.map(([url]) => url.pathname)).toEqual([
      "/opaque-alpha/init.mp4", "/opaque-alpha/segment.m4s",
      "/opaque-beta/init.mp4", "/opaque-beta/segment.m4s",
      "/opaque-alpha/init.mp4", "/opaque-alpha/segment.m4s",
    ]);
    const aPlaylist = await adapter.playlist(association, 0);
    const bPlaylist = await adapter.playlist(secondAssociation, 0);
    expect(aPlaylist).not.toContain(secondAssociation.playbackBasePath);
    expect(bPlaylist).not.toContain(association.playbackBasePath);
    expect(aPlaylist + bPlaylist).not.toMatch(/opaque-alpha|opaque-beta|signature=private/);
    expect(provider.metadata).toHaveBeenCalledTimes(2);
    expect(provider.playlist).toHaveBeenCalledTimes(2);
  });

  it("cannot attach B's earlier completion to A's pending cache slot", async () => {
    const { adapter, provider } = sessions();
    let releaseA!: () => void;
    const pendingA = new Promise<void>((resolve) => { releaseA = resolve; });
    provider.playlist.mockImplementation(async (id) => {
      if (id === SESSION) await pendingA;
      return manifestFor(id);
    });
    const first = adapter.inspect(association);
    await vi.waitFor(() => expect(provider.playlist).toHaveBeenCalledTimes(1));
    expect((await adapter.inspect(secondAssociation)).status).toBe("ready");
    expect((await adapter.segment(secondAssociation, 0, 0)).body[11]).toBe(2);
    releaseA();
    expect((await first).status).toBe("ready");
    expect((await adapter.segment(association, 0, 0)).body[11]).toBe(1);
    expect((await adapter.segment(association, 0, 1)).body[11]).toBe(1);
  });

  it("preserves A/B provenance through the actual SDK wrapper across sequential, concurrent and expired caches", async () => {
    let clock = 100;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const id = url.pathname.split("/")[3];
      expect(url.origin).toBe("https://api.browserbase.com");
      expect([SESSION, OTHER]).toContain(id);
      return url.pathname.endsWith("/replays")
        ? new Response(JSON.stringify(metadata(id)), { headers: { "content-type": "application/json" } })
        : new Response(manifestFor(id), { headers: { "content-type": "application/vnd.apple.mpegurl" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const download = vi.fn(async (url: URL) => {
      const body = Buffer.from(mp4);
      body[11] = url.pathname.includes("opaque-alpha") ? 1 : 2;
      return body;
    });
    const adapter = createReplayAdapter({
      provider: createBrowserbaseReplayProvider("offline-provenance-test"),
      segmentOrigins: [ORIGIN], download, now: () => clock,
    });
    for (const [input, marker] of [[association, 1], [secondAssociation, 2], [association, 1]] as const) {
      expect((await adapter.inspect(input)).status).toBe("ready");
      for (const index of [0, 1]) expect((await adapter.segment(input, 0, index)).body[11]).toBe(marker);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const expire of [false, true]) {
      if (expire) clock += REPLAY_LIMITS.cacheMs + 1;
      const results = await Promise.all([association, secondAssociation, association, secondAssociation].map(async (input) => {
        expect((await adapter.inspect(input)).status).toBe("ready");
        return (await adapter.segment(input, 0, 1)).body[11];
      }));
      expect(results).toEqual([1, 2, 1, 2]);
      expect(fetchMock).toHaveBeenCalledTimes(expire ? 8 : 4);
    }
    for (const id of [SESSION, OTHER]) {
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === `https://api.browserbase.com/v1/sessions/${id}/replays`)).toHaveLength(2);
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === `https://api.browserbase.com/v1/sessions/${id}/replays/0`)).toHaveLength(2);
    }
  });

  it("rejects A metadata pointing at B without following it or poisoning B's warm cache", async () => {
    const { adapter, provider, download } = sessions();
    await adapter.inspect(secondAssociation);
    provider.metadata.mockImplementation(async () => metadata(OTHER));
    expect((await adapter.inspect(association)).status).toBe("unsupported");
    expect(provider.playlist).toHaveBeenCalledTimes(1);
    expect(provider.playlist).not.toHaveBeenCalledWith(SESSION, expect.anything(), expect.anything());
    expect(download).not.toHaveBeenCalled();
    expect((await adapter.segment(secondAssociation, 0, 1)).body[11]).toBe(2);
  });

  it("snapshots metadata rather than retaining mutable provider-owned objects", async () => {
    const { adapter, provider } = sessions();
    const response = metadata();
    provider.metadata.mockResolvedValue(response);
    await adapter.inspect(association);
    response.pages[0].pageId = "1";
    response.pages[0].url = `/v1/sessions/${OTHER}/replays/1`;
    expect((await adapter.segment(association, 0, 0)).body[11]).toBe(1);
    expect(provider.playlist).toHaveBeenCalledExactlyOnceWith(SESSION, "0", expect.any(AbortSignal));
  });

  it("accepts no client URL, session ID, or rewritten client manifest as an asset selector", async () => {
    const { adapter, download } = sessions();
    await Promise.all([adapter.inspect(association), adapter.inspect(secondAssociation)]);
    for (const selector of [OTHER, `${ORIGIN}/opaque-beta/init.mp4?signature=private`, "../1", "0"]) {
      await expect(adapter.segment(association, 0, selector as unknown as number)).rejects.toMatchObject({ status: "unavailable" });
      await expect(adapter.segment(association, selector as unknown as number, 0)).rejects.toMatchObject({ status: "unavailable" });
    }
    await expect(adapter.segment({
      ...association, url: `${ORIGIN}/opaque-beta/init.mp4?signature=private`,
    } as AuthorizedReplayAssociation, 0, 0)).rejects.toMatchObject({ status: "unavailable" });
    expect(download).not.toHaveBeenCalled();
    expect((await adapter.segment(association, 0, 0)).body[11]).toBe(1);
  });

  it("rejects A's public consent grant on a different existing attempt B in the same owned run", async () => {
    const [{ createApi }, { WorkerRepository }, { mkdirSync, rmSync }, { randomUUID }] = await Promise.all([
      import("../api"), import("../worker/repository"), import("node:fs"), import("node:crypto"),
    ]);
    const directory = `${process.cwd()}/.replay-cross-attempt-${randomUUID()}`;
    mkdirSync(directory, { mode: 0o700 });
    const repository = new WorkerRepository(directory);
    try {
      const owner = repository.createSession();
      const run = repository.createControlledRun(owner.ownerId, randomUUID(), {
        authorizationAcknowledged: true, controlledSiteId: "project-board",
        assignments: [
          { personaId: "careful-first-timer", goal: "Inspect list", criteria: ["List is visible"] },
          { personaId: "keyboard-only", goal: "Inspect list", criteria: ["List is visible"] },
        ],
      }).run;
      const attempts: string[] = [];
      for (const sessionId of [SESSION, OTHER]) {
        const claim = repository.claim("offline-provenance-worker")!;
        expect(claim).toBeDefined();
        attempts.push(claim.attempt.id);
        repository.sessionReference(claim, {
          sessionId, timeoutSeconds: 240, liveViewUrl: "", replayUrl: `https://www.browserbase.com/sessions/${sessionId}`,
        });
        repository.finish(claim, {
          status: "gave_up", reason: "Stopped", originalTerminal: { status: "gave_up", reason: "Stopped" },
          checks: [], steps: 0, modelCalls: 0, durationMs: 0, cleanup: { status: "closed", errors: [] }, errors: [],
        }, { reservedSeconds: 240, elapsedSeconds: 2, actualBrowserSeconds: 2, remoteStatus: "COMPLETED" });
      }
      const origin = "https://reports.example";
      const { adapter, provider, download } = sessions();
      const api = createApi({
        repository, replay: adapter,
        configuration: { origin, production: true, accessCode: "offline-access-code-at-least-32-characters" },
      });
      const base = (attempt: string) => `/api/v1/runs/${run.id}/attempts/${attempt}/replay`;
      const makeRequest = (path: string, grant = "", authorize = false) => new Request(`${origin}${path}`, {
        method: authorize ? "POST" : "GET",
        headers: {
          cookie: `__Host-ff_owner=${owner.token}${grant ? `; ${grant}` : ""}`,
          ...(authorize ? { origin, "x-csrf-token": owner.csrf, "content-type": "application/json" } : {}),
        },
        ...(authorize ? { body: JSON.stringify({ acknowledgeSensitiveVideo: true }) } : {}),
      });
      const authorizeA = await api(makeRequest(`${base(attempts[0])}/authorize`, "", true));
      expect(authorizeA.status).toBe(200);
      const grantA = authorizeA.headers.get("set-cookie")!.split(";")[0];
      const readA = await api(makeRequest(base(attempts[0]), grantA));
      expect((await readA.json()).data.status).toBe("ready");
      const callsBeforeB = provider.metadata.mock.calls.length;
      const readB = await api(makeRequest(base(attempts[1]), grantA));
      expect((await readB.json()).data.status).toBe("unavailable");
      for (const suffix of ["/pages/0/playlist", "/pages/0/segments/0", "/pages/0/segments/1", "/dashboard"]) {
        expect((await api(makeRequest(`${base(attempts[1])}${suffix}`, grantA))).status).toBe(404);
      }
      expect(provider.metadata).toHaveBeenCalledTimes(callsBeforeB);
      expect(download).not.toHaveBeenCalled();
      const authorizeB = await api(makeRequest(`${base(attempts[1])}/authorize`, "", true));
      expect(authorizeB.status).toBe(200);
      const grantB = authorizeB.headers.get("set-cookie")!.split(";")[0];
      const readAuthorizedB = await api(makeRequest(base(attempts[1]), grantB));
      expect((await readAuthorizedB.json()).data.status).toBe("ready");
      expect(provider.playlist).toHaveBeenCalledWith(SESSION, "0", expect.any(AbortSignal));
      expect(provider.playlist).toHaveBeenCalledWith(OTHER, "0", expect.any(AbortSignal));
    } finally {
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats injected provider code as the trusted authority, not client-controlled attestation", async () => {
    const { adapter, provider, download } = sessions();
    // A provider violating the authenticated endpoint contract is outside the
    // application-owner boundary; opaque CDN paths cannot independently detect it.
    provider.playlist.mockResolvedValue(manifestFor(OTHER));
    expect((await adapter.inspect(association)).status).toBe("ready");
    expect((await adapter.segment(association, 0, 0)).body[11]).toBe(2);
    expect(download.mock.calls[0][0].pathname).toBe("/opaque-beta/init.mp4");
  });
});

describe("pinned SDK fixed-origin transport (offline)", () => {
  it("refuses SDK debug logging that would expose authentication headers", () => {
    vi.stubEnv("DEBUG", "true");
    expect(() => createBrowserbaseReplayProvider("offline-key")).toThrow("replay_unavailable");
  });

  it("uses only documented SDK paths, blocks redirects, never trusts environment baseURL", async () => {
    vi.stubEnv("BROWSERBASE_BASE_URL", "https://evil.example");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(metadata()), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createBrowserbaseReplayProvider("test-only-not-a-secret");
    await provider.metadata(SESSION, new AbortController().signal);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://api.browserbase.com/v1/sessions/${SESSION}/replays`);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error", cache: "no-store" });
    fetchMock.mockResolvedValue(new Response(playlist));
    expect(await provider.playlist(SESSION, "0", new AbortController().signal)).toBe(playlist);
    expect(String(fetchMock.mock.calls[1][0])).toBe(`https://api.browserbase.com/v1/sessions/${SESSION}/replays/0`);
    vi.unstubAllEnvs();
  });

  it("bounds streamed API data without relying on Content-Length", async () => {
    const fetchMock = vi.fn(async () => new Response("x".repeat(REPLAY_LIMITS.metadataBytes + 1)));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createBrowserbaseReplayProvider("offline-test");
    await expect(provider.metadata(SESSION, new AbortController().signal)).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
