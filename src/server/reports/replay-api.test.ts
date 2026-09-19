import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../api";
import { WorkerRepository } from "../worker/repository";
import { createReplayAdapter, type ReplayProvider } from "./replay";

const origin = "https://reports.example";
let directory: string;
let repository: WorkerRepository;
let owner: ReturnType<WorkerRepository["createSession"]>;
let foreign: ReturnType<WorkerRepository["createSession"]>;
let sessionId: string;
let runId: string;
let attemptId: string;
let clock: number;
let api: ReturnType<typeof createApi>;
let metadata: ReturnType<typeof vi.fn<ReplayProvider["metadata"]>>;
const base = () => `runs/${runId}/attempts/${attemptId}/replay`;
function request(path: string, options: { token?: string; grant?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new Request(`${origin}/api/v1/${path}`, {
    method: options.method ?? "GET",
    headers: {
      cookie: `__Host-ff_owner=${options.token ?? owner.token}${options.grant ? `; ${options.grant}` : ""}`,
      ...(options.method === "POST" ? { origin, "x-csrf-token": owner.csrf, "content-type": "application/json" } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}
async function authorize() {
  const response = await api(request(`${base()}/authorize`, { method: "POST", body: { acknowledgeSensitiveVideo: true } }));
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly; SameSite=Strict;");
  expect(cookie).toContain(`Path=/api/v1/${base()}`);
  expect(cookie).toContain("Secure");
  expect(await response.text()).not.toContain(cookie.split("=")[1].split(";")[0]);
  return cookie.split(";")[0];
}

beforeEach(() => {
  clock = Date.now();
  directory = join(process.cwd(), `.replay-api-test-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  repository = new WorkerRepository(directory, {}, () => clock);
  owner = repository.createSession(); foreign = repository.createSession();
  runId = repository.createControlledRun(owner.ownerId, randomUUID(), {
    authorizationAcknowledged: true, controlledSiteId: "project-board",
    assignments: [{ personaId: "careful-first-timer", goal: "Inspect list", criteria: ["List is visible"] }],
  }).run.id;
  const claim = repository.claim("offline-replay-worker")!;
  attemptId = claim.attempt.id;
  sessionId = randomUUID();
  repository.sessionReference(claim, {
    sessionId, timeoutSeconds: 240, liveViewUrl: "", replayUrl: `https://www.browserbase.com/sessions/${sessionId}`,
  });
  repository.finish(claim, {
    status: "gave_up", reason: "Stopped", originalTerminal: { status: "gave_up", reason: "Stopped" },
    checks: [], steps: 0, modelCalls: 0, durationMs: 0, cleanup: { status: "closed", errors: [] }, errors: [],
  }, { reservedSeconds: 240, elapsedSeconds: 2, actualBrowserSeconds: 2, remoteStatus: "COMPLETED" });
  metadata = vi.fn(async () => ({
    pageCount: 1, pages: [{ pageId: "1", url: `/v1/sessions/${sessionId}/replays/1`, startTimeMs: 0, endTimeMs: 1000 }],
  }));
  const replay = createReplayAdapter({
    provider: {
      metadata,
      playlist: async () => `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="https://cdn.example.com/init.mp4?signature=private"\n#EXTINF:1,\nhttps://cdn.example.com/segment.mp4?signature=private\n#EXT-X-ENDLIST\n`,
    },
    segmentOrigins: ["https://cdn.example.com"], now: () => clock,
    download: async () => Buffer.from("000000106674797069736f6d00000000", "hex"),
  });
  api = createApi({ repository, replay, configuration: { origin, production: true, accessCode: "test-only-access-code-at-least-32-characters" } });
});
afterEach(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });

describe("owner and consent protected recording routes", () => {
  it("does not contact the provider before explicit CSRF-protected sensitive playback consent", async () => {
    const response = await api(request(base()));
    expect(response.status).toBe(200);
    expect((await response.json()).data.status).toBe("unavailable");
    expect(metadata).not.toHaveBeenCalled();
    expect((await api(request(`${base()}/authorize`, { method: "POST", body: { acknowledgeSensitiveVideo: false } }))).status).toBe(400);
    expect((await api(request(`${base()}/authorize`, { method: "POST", body: { acknowledgeSensitiveVideo: true },
      headers: { "x-csrf-token": "bad" } }))).status).toBe(403);
    const grant = await authorize();
    const ready = await api(request(base(), { grant }));
    const body = await ready.text();
    expect(JSON.parse(body).data.status).toBe("ready");
    expect(body).not.toContain(sessionId);
    expect(body).not.toContain("cdn.example.com");
    expect(body).not.toContain("signature=private");
    expect(metadata).toHaveBeenCalledTimes(1);
  });

  it("proxies only the authorized opaque playlist and media, with bounded range handling", async () => {
    const grant = await authorize();
    const playlist = await api(request(`${base()}/pages/0/playlist`, { grant }));
    expect(playlist.status).toBe(200);
    expect(playlist.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    const text = await playlist.text();
    expect(text).toContain(`/api/v1/${base()}/pages/0/segments/0`);
    expect(text).not.toContain("cdn.example.com");
    expect(text).not.toContain("private");
    const segment = await api(request(`${base()}/pages/0/segments/0`, { grant, headers: { range: "bytes=0-7" } }));
    expect(segment.status).toBe(206);
    expect(segment.headers.get("content-range")).toBe("bytes 0-7/16");
    expect(segment.headers.get("content-type")).toBe("video/mp4");
    expect(segment.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await segment.arrayBuffer()).byteLength).toBe(8);
    expect((await api(request(`${base()}/pages/0/segments/0`, { grant, headers: { range: "bytes=0-" } }))).status).toBe(416);
    expect((await api(request(`${base()}/pages/0/playlist`, { grant, headers: { range: "bytes=0-8" } }))).status).toBe(416);
    expect((await api(request(`${base()}/pages/0/segments/0?url=https://127.0.0.1`, { grant }))).status).toBe(400);
    expect((await api(request(`${base()}/pages/00/playlist`, { grant }))).status).toBe(400);
  });

  it.each(["", "/pages/0/playlist", "/pages/0/segments/0", "/dashboard"])(
    "rechecks ownership and grant on every nested recording route %s", async (suffix) => {
      const grant = await authorize();
      const foreignRead = await api(request(`${base()}${suffix}`, { token: foreign.token, grant }));
      expect(foreignRead.status).toBe(404);
      const anonymous = await api(request(`${base()}${suffix}`, { token: "missing", grant }));
      expect(anonymous.status).toBe(401);
      const crossOrigin = await api(request(`${base()}${suffix}`, { grant, headers: { origin: "https://attacker.example" } }));
      expect(crossOrigin.status).toBe(403);
      expect(metadata).not.toHaveBeenCalled();
    });

  it("expires consent and binds its opaque cookie to the exact actual attempt/session", async () => {
    const grant = await authorize();
    expect((await api(request(`${base()}/pages/0/playlist`))).status).toBe(404);
    expect((await api(request(`${base()}/pages/0/playlist`, { grant: `${grant}; ${grant}` }))).status).toBe(404);
    expect((await api(request(`runs/${runId}/attempts/${randomUUID()}/replay`, { grant }))).status).toBe(404);
    clock += 900_001;
    expect((await api(request(`${base()}/pages/0/playlist`, { grant }))).status).toBe(404);
    expect(metadata).not.toHaveBeenCalled();
  });

  it("constructs the dashboard fallback only from the authorized binding, never from a caller URL", async () => {
    const grant = await authorize();
    const response = await api(request(`${base()}/dashboard`, { grant }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`https://www.browserbase.com/sessions/${sessionId}`);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await api(request(`${base()}/dashboard?next=https://attacker.example`, { grant }))).status).toBe(400);
  });
});
