import Browserbase from "@browserbasehq/sdk";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";
import { REPLAY_POLLING, type ReplayReport, type ReplayStatus } from "../../lib/replay-contracts";

const API_ORIGIN = "https://api.browserbase.com";
export const REPLAY_LIMITS = {
  metadataBytes: 64 * 1024,
  playlistBytes: 256 * 1024,
  segmentBytes: 16 * 1024 * 1024,
  timeoutMs: 10_000,
  pages: 100,
  segments: 2000,
  cacheEntries: 32,
  manifestEntries: 4,
  cacheMs: 60_000,
  requestsPerMinute: 100,
} as const;

/**
 * Construct ONLY from a trusted stored session reference after checking the
 * current owner, run, assignment and attempt. This is not an authorization token.
 */
export type AuthorizedReplayAssociation = {
  sessionId: string;
  state: "running" | "ended";
  recordingEnabled: boolean;
  /** Explicit authorization to view unredacted video, not merely report access. */
  sensitivePlaybackAuthorized: boolean;
  /** App route for this exact run/assignment/attempt; never a provider URL. */
  playbackBasePath: string;
  /** Trusted provider-retention deadline; omit when unknown. */
  expiresAt?: number;
};

export interface ReplayProvider {
  metadata(sessionId: string, signal: AbortSignal): Promise<unknown>;
  playlist(sessionId: string, pageId: string, signal: AbortSignal): Promise<string>;
}

export type ReplayAsset = {
  status: 200 | 206;
  body: Uint8Array;
  contentType: "video/mp4";
  contentRange?: string;
};

export class ReplayError extends Error {
  constructor(readonly status: Exclude<ReplayStatus, "ready">) {
    super(`replay_${status}`);
  }
}

const associationSchema = z.strictObject({
  sessionId: z.uuid(),
  state: z.enum(["running", "ended"]),
  recordingEnabled: z.boolean(),
  sensitivePlaybackAuthorized: z.boolean(),
  playbackBasePath: z.string().max(256).regex(/^\/api\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/),
  expiresAt: z.number().int().nonnegative().optional(),
});
const metadataSchema = z.object({
  pageCount: z.number().int().min(0).max(REPLAY_LIMITS.pages),
  pages: z.array(z.object({
    pageId: z.string().regex(/^\d{1,3}$/),
    url: z.string().max(256),
    startTimeMs: z.number().int().min(0).max(86_400_000),
    endTimeMs: z.number().int().min(0).max(86_400_000),
  })).max(REPLAY_LIMITS.pages),
});
type Page = z.infer<typeof metadataSchema>["pages"][number];
type Manifest = { readonly lines: readonly string[]; readonly urls: readonly string[] };
type SessionManifest = Manifest & { readonly sessionId: string; readonly pageId: string };

function safeFailure(error: unknown): ReplayError {
  if (error instanceof ReplayError) return error;
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  // 404 also means "never recorded"; it is not evidence of expiration.
  if (status === 410) return new ReplayError("expired");
  if (status === 429 || status === 409 || status === 202) return new ReplayError("processing");
  if (status === 501 || status === 415) return new ReplayError("unsupported");
  return new ReplayError("unavailable");
}

async function deadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ReplayError("unavailable"));
        }, REPLAY_LIMITS.timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new ReplayError("unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new ReplayError("unsupported");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ReplayError("unsupported");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Fixed authenticated origin; no environment base URL override, redirects or retries.
 * The provider contract binds the returned playlist to this session/page:
 * https://docs.browserbase.com/reference/api/session-replay-page
 */
export function createBrowserbaseReplayProvider(apiKey: string): ReplayProvider {
  const assertPrivate = () => {
    // The pinned SDK's DEBUG=true mode prints request authentication headers.
    if (!apiKey.trim() || process.env.DEBUG === "true") throw new ReplayError("unavailable");
  };
  assertPrivate();
  const sdk = new Browserbase({
    apiKey, baseURL: API_ORIGIN, maxRetries: 0, timeout: REPLAY_LIMITS.timeoutMs,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== API_ORIGIN || !/^\/v1\/sessions\/[a-fA-F0-9-]{36}\/replays(?:\/\d{1,3})?$/.test(url.pathname)
        || url.search || url.hash || init?.method !== "GET") throw new ReplayError("unsupported");
      const response = await fetch(url, {
        method: "GET", headers: { "X-BB-API-Key": apiKey, Accept: "application/json, application/vnd.apple.mpegurl" },
        redirect: "error", signal: init.signal, cache: "no-store",
      });
      const limit = /\/replays$/.test(url.pathname) ? REPLAY_LIMITS.metadataBytes : REPLAY_LIMITS.playlistBytes;
      const body = await boundedBody(response, limit);
      return new Response(Buffer.from(body), { status: response.status, headers: response.headers });
    },
  });
  return {
    metadata: (sessionId, signal) => {
      assertPrivate();
      z.uuid().parse(sessionId);
      return sdk.sessions.replays.retrieve(sessionId, { signal });
    },
    playlist: async (sessionId, pageId, signal) => {
      assertPrivate();
      z.uuid().parse(sessionId);
      z.string().regex(/^\d{1,3}$/).parse(pageId);
      return (await sdk.sessions.replays.retrievePage(sessionId, pageId, { signal })).text();
    },
  };
}

function segmentUrl(raw: string, allowedOrigins: ReadonlySet<string>): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ReplayError("unsupported"); }
  if (raw.length > 8192 || url.protocol !== "https:" || url.username || url.password || url.hash
    || url.port || !allowedOrigins.has(url.origin) || isIP(url.hostname)
    || /[\s\\]/.test(raw)) throw new ReplayError("unsupported");
  return url;
}

function parseManifest(text: string, allowedOrigins: ReadonlySet<string>): Manifest {
  if (Buffer.byteLength(text) > REPLAY_LIMITS.playlistBytes || /[^\x09\x0a\x0d\x20-\x7e]/.test(text)) {
    throw new ReplayError("unsupported");
  }
  const source = text.replace(/\r\n/g, "\n").trim().split("\n");
  if (source[0] !== "#EXTM3U" || source.at(-1) !== "#EXT-X-ENDLIST") throw new ReplayError("unsupported");
  const lines: string[] = [];
  const urls: string[] = [];
  let pendingSegment = false;
  let mapSeen = false;
  let segmentCount = 0;
  for (const line of source) {
    if (!line) continue;
    if (line.startsWith("#EXT-X-MAP:")) {
      const match = /^#EXT-X-MAP:URI="([^"]+)"$/.exec(line);
      if (!match || mapSeen || pendingSegment) throw new ReplayError("unsupported");
      segmentUrl(match[1], allowedOrigins);
      lines.push(`#EXT-X-MAP:URI="{{asset:${urls.length}}}"`);
      urls.push(match[1]);
      mapSeen = true;
    } else if (/^#EXTINF:\d+(?:\.\d+)?,.*$/.test(line)) {
      if (pendingSegment) throw new ReplayError("unsupported");
      const duration = Number(line.slice(8).split(",")[0]);
      if (duration <= 0 || duration > 120) throw new ReplayError("unsupported");
      // Never forward titles/comments: they may contain URLs, secrets or markup.
      lines.push(`#EXTINF:${duration},`);
      pendingSegment = true;
    } else if (!line.startsWith("#")) {
      if (!pendingSegment || !mapSeen) throw new ReplayError("unsupported");
      segmentUrl(line, allowedOrigins);
      lines.push(`{{asset:${urls.length}}}`);
      urls.push(line);
      pendingSegment = false;
      segmentCount++;
    } else if (/^#EXT-X-(?:VERSION:[1-9]\d?|TARGETDURATION:[1-9]\d{0,2}|MEDIA-SEQUENCE:\d{1,9}|DISCONTINUITY-SEQUENCE:\d{1,9}|PLAYLIST-TYPE:VOD|INDEPENDENT-SEGMENTS|DISCONTINUITY)$/.test(line)
      || line === "#EXTM3U" || line === "#EXT-X-ENDLIST") {
      lines.push(line);
    } else {
      // Reject encryption, nested manifests, byte ranges, external audio, data
      // tags and every unknown extension instead of partially rewriting a URL.
      throw new ReplayError("unsupported");
    }
  }
  if (pendingSegment || !segmentCount || urls.length > REPLAY_LIMITS.segments) throw new ReplayError("unsupported");
  return Object.freeze({ lines: Object.freeze(lines), urls: Object.freeze(urls) });
}

/** Restrict the proxy to global unicast IPv4 and pin DNS to the TLS connection. */
function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

async function downloadSegment(url: URL, signal: AbortSignal): Promise<Uint8Array> {
  const addresses = await lookup(url.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(({ address }) => !publicIPv4(address))) throw new ReplayError("unsupported");
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET", signal, agent: false, family: 4,
      headers: { Accept: "video/mp4, application/octet-stream", "Accept-Encoding": "identity" },
      lookup: (_hostname, _options, callback) => callback(null, addresses[0].address, 4),
    }, (res) => {
      if (res.statusCode !== 200 || (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")) {
        res.destroy();
        reject(new ReplayError("unavailable"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      if (Number(res.headers["content-length"]) > REPLAY_LIMITS.segmentBytes) {
        res.destroy();
        reject(new ReplayError("unsupported"));
        return;
      }
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > REPLAY_LIMITS.segmentBytes) {
          res.destroy();
          reject(new ReplayError("unsupported"));
        } else chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks, bytes)));
      res.on("error", reject);
      res.on("aborted", () => reject(new ReplayError("unavailable")));
    });
    req.on("error", reject);
    req.end();
  });
}

function checkMp4(body: Uint8Array): void {
  if (body.byteLength < 8 || body.byteLength > REPLAY_LIMITS.segmentBytes) throw new ReplayError("unsupported");
  // HTML/SVG/JS can never become an authorized media response.
  const box = Buffer.from(body.subarray(4, 8)).toString("ascii");
  if (!["ftyp", "styp", "moof", "sidx", "free", "emsg"].includes(box)) throw new ReplayError("unsupported");
}

/** Accept a single explicit, bounded range; never forward a client Range upstream. */
export function parseReplayRange(value?: string): { start: number; end: number } | undefined {
  if (value === undefined) return undefined;
  const match = /^bytes=(\d{1,8})-(\d{1,8})$/.exec(value);
  if (!match) throw new ReplayError("unsupported");
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (end < start || end >= REPLAY_LIMITS.segmentBytes) throw new ReplayError("unsupported");
  return { start, end };
}

export function createReplayAdapter(options: {
  /** Trusted server code. Production must use the fixed-origin SDK provider. */
  provider: ReplayProvider;
  /** Deployment-controlled exact CDN origins, verified out of band. No wildcards. */
  segmentOrigins: readonly string[];
  now?: () => number;
  /** Trusted transport injection for offline tests; never construct from HTTP input. */
  download?: (url: URL, signal: AbortSignal) => Promise<Uint8Array>;
}) {
  const now = options.now ?? Date.now;
  const origins = new Set(options.segmentOrigins);
  for (const origin of origins) {
    const url = segmentUrl(origin, origins);
    if (origin !== url.origin || !url.hostname.includes(".") || url.hostname.endsWith(".localhost")) {
      throw new ReplayError("unsupported");
    }
  }
  type Cache = { expires: number; pages: Promise<Page[]>; manifests: Map<number, Promise<SessionManifest>> };
  const cache = new Map<string, Cache>();
  let budgetStarted = now();
  let requests = 0;
  let inFlight = 0;
  function authorize(input: AuthorizedReplayAssociation) {
    const result = associationSchema.safeParse(input);
    if (!result.success) throw new ReplayError("unavailable");
    const association = result.data;
    if (association.playbackBasePath.toLowerCase().includes(association.sessionId.toLowerCase())) {
      throw new ReplayError("unavailable");
    }
    if (!association.sensitivePlaybackAuthorized) throw new ReplayError("unavailable");
    if (!association.recordingEnabled) throw new ReplayError("unavailable");
    if (association.expiresAt !== undefined && association.expiresAt <= now()) throw new ReplayError("expired");
    if (association.state !== "ended") throw new ReplayError("processing");
    if (!origins.size) throw new ReplayError("unsupported");
    return association;
  }
  async function limited<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (now() - budgetStarted >= 60_000) { requests = 0; budgetStarted = now(); }
    if (requests >= REPLAY_LIMITS.requestsPerMinute || inFlight >= 4) throw new ReplayError("processing");
    requests++;
    inFlight++;
    try { return await deadline(work); }
    catch (error) { throw safeFailure(error); }
    finally { inFlight--; }
  }
  function entry(association: AuthorizedReplayAssociation): Cache {
    const existing = cache.get(association.sessionId);
    if (existing && existing.expires > now()) return existing;
    cache.delete(association.sessionId);
    if (cache.size >= REPLAY_LIMITS.cacheEntries) cache.delete(cache.keys().next().value!);
    const pages = limited(async (signal) => {
      const raw = await options.provider.metadata(association.sessionId, signal);
      const result = metadataSchema.safeParse(raw);
      if (!result.success) throw new ReplayError("unsupported");
      const meta = result.data;
      if (meta.pageCount !== meta.pages.length || new Set(meta.pages.map((page) => page.pageId)).size !== meta.pages.length
        || meta.pages.some((page) => page.url !== `/v1/sessions/${association.sessionId}/replays/${page.pageId}`
          || page.endTimeMs < page.startTimeMs)) throw new ReplayError("unsupported");
      return meta.pages;
    });
    const value = { expires: now() + REPLAY_LIMITS.cacheMs, pages, manifests: new Map<number, Promise<SessionManifest>>() };
    void pages.catch(() => { value.expires = now() + REPLAY_POLLING.intervalSeconds * 1000; });
    cache.set(association.sessionId, value);
    return value;
  }
  async function manifest(association: AuthorizedReplayAssociation, index: number): Promise<SessionManifest> {
    if (!Number.isInteger(index) || index < 0 || index >= REPLAY_LIMITS.pages) throw new ReplayError("unavailable");
    const cached = entry(association);
    const pages = await cached.pages;
    const page = pages[index];
    if (!page) throw new ReplayError("unavailable");
    let value = cached.manifests.get(index);
    if (!value) {
      if (cached.manifests.size >= REPLAY_LIMITS.manifestEntries) {
        cached.manifests.delete(cached.manifests.keys().next().value!);
      }
      // The authenticated session/page API, not a CDN filename, supplies media
      // provenance. This private mapping is cached only beneath that session.
      value = limited(async (signal) => Object.freeze({
        ...parseManifest(await options.provider.playlist(association.sessionId, page.pageId, signal), origins),
        sessionId: association.sessionId,
        pageId: page.pageId,
      }));
      cached.manifests.set(index, value);
      void value.catch(() => { cached.expires = now() + REPLAY_POLLING.intervalSeconds * 1000; });
    }
    const resolved = await value;
    if (resolved.sessionId !== association.sessionId || resolved.pageId !== page.pageId) throw new ReplayError("unsupported");
    return resolved;
  }
  return {
    async inspect(input: AuthorizedReplayAssociation): Promise<ReplayReport> {
      const base = { format: "hls" as const, sensitive: true as const, fallback: "operator-dashboard" as const };
      try {
        const association = authorize(input);
        const pages = await entry(association).pages;
        if (!pages.length) throw new ReplayError("unavailable");
        // Ready means the first page is actually a supported, rewritable playlist.
        await manifest(association, 0);
        return {
          ...base, status: "ready",
          pages: pages.map((page, index) => ({
            index, startTimeMs: page.startTimeMs, endTimeMs: page.endTimeMs,
            playlistPath: `${association.playbackBasePath}/pages/${index}/playlist`,
          })),
        };
      } catch (error) {
        const status = safeFailure(error).status;
        return { ...base, status, pages: [], ...(status === "processing" ? { retryAfterSeconds: REPLAY_POLLING.intervalSeconds } : {}) };
      }
    },
    async playlist(input: AuthorizedReplayAssociation, pageIndex: number): Promise<string> {
      try {
        const association = authorize(input);
        const data = await manifest(association, pageIndex);
        return data.lines.join("\n").replace(/\{\{asset:(\d+)\}\}/g,
          (_, index: string) => `${association.playbackBasePath}/pages/${pageIndex}/segments/${index}`) + "\n";
      } catch (error) { throw safeFailure(error); }
    },
    async segment(input: AuthorizedReplayAssociation, pageIndex: number, segmentIndex: number, range?: string): Promise<ReplayAsset> {
      try {
        const association = authorize(input);
        const parsedRange = parseReplayRange(range);
        if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= REPLAY_LIMITS.segments) {
          throw new ReplayError("unavailable");
        }
        const data = await manifest(association, pageIndex);
        if (!data.urls[segmentIndex]) throw new ReplayError("unavailable");
        const url = segmentUrl(data.urls[segmentIndex], origins);
        const body = await limited((signal) => (options.download ?? downloadSegment)(url, signal));
        checkMp4(body);
        if (!parsedRange) return { status: 200, body, contentType: "video/mp4" };
        if (parsedRange.start >= body.byteLength) throw new ReplayError("unsupported");
        const end = Math.min(parsedRange.end, body.byteLength - 1);
        return {
          status: 206, body: body.slice(parsedRange.start, end + 1), contentType: "video/mp4",
          contentRange: `bytes ${parsedRange.start}-${end}/${body.byteLength}`,
        };
      } catch (error) { throw safeFailure(error); }
    },
  };
}
