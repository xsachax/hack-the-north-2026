import "server-only";
import { Resolver } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { publicAddress } from "../public-address";
import { parsePublicTargetUrl } from "../target-policy";

export type PublicTransportCode =
  | "invalid_configuration" | "invalid_request" | "invalid_url" | "unsupported_method"
  | "unsupported_headers" | "unsupported_body" | "not_authorized" | "unsafe_destination"
  | "dns_failure" | "dns_timeout" | "closed" | "aborted" | "lease_revoked"
  | "request_limit" | "concurrency_limit" | "byte_limit" | "redirect_limit"
  | "duration_limit" | "request_timeout" | "network_failure" | "unsupported_response";

export class PublicTransportError extends Error {
  constructor(readonly code: PublicTransportCode) {
    super(`public_transport_${code}`);
    this.name = "PublicTransportError";
  }
}

export type PublicRequestContext = Readonly<{
  url: string;
  method: "GET" | "HEAD" | "OPTIONS";
  kind: "navigation" | "asset";
  /** Present only when authorizing a returned redirect destination. */
  redirectFrom?: string;
}>;
export type PublicTransportRequest = {
  url: string;
  method: string;
  /** Trusted interception context, not page-supplied authorization. */
  kind: PublicRequestContext["kind"];
  headers?: readonly (readonly [string, string])[];
  /** Any supplied body is rejected, including an empty one. */
  body?: Uint8Array;
  signal?: AbortSignal;
};
export type PublicTransportResponse = Readonly<{
  url: string;
  status: number;
  headers: readonly (readonly [string, string])[];
  body: Buffer;
  /** Validated destination, not fetched. The browser must be intercepted again. */
  redirectUrl?: string;
}>;
export type PublicTransportLimits = Readonly<{
  requests: number;
  concurrency: number;
  totalBytes: number;
  responseBytes: number;
  headerBytes: number;
  redirects: number;
  durationMs: number;
  requestMs: number;
  dnsMs: number;
}>;
export const PUBLIC_TRANSPORT_LIMITS: PublicTransportLimits = Object.freeze({
  requests: 256, concurrency: 8, totalBytes: 64 * 1024 * 1024,
  responseBytes: 4 * 1024 * 1024, headerBytes: 16 * 1024,
  redirects: 16, durationMs: 300_000, requestMs: 15_000, dnsMs: 2_000,
});
export type PublicTransportOptions = {
  /** Trusted synchronous predicate over an immutable per-request snapshot. */
  authorize: (request: PublicRequestContext) => boolean;
  /**
   * Opt-in for browser Origin/Referer/Cookie/Authorization. Must attest browser
   * provenance and destination binding; never pass app/server request headers.
   * Absent or false rejects supplied sensitive headers instead of stripping them.
   */
  authorizeBrowserHeaders?: (
    request: PublicRequestContext,
    headers: readonly (readonly [string, string])[],
  ) => boolean;
  /** Must throw after lease loss. Abort signal must also fire on revocation. */
  assertActive: () => void;
  signal: AbortSignal;
  /** Explicit per-job ceilings; may only reduce the published hard maximums. */
  limits: PublicTransportLimits;
};
export interface PublicTransport {
  request(input: PublicTransportRequest): Promise<PublicTransportResponse>;
  /** Terminal: cancels DNS/sockets and waits for in-flight operations to settle. */
  close(): Promise<void>;
  /** Wait for currently active work; does not authorize more work or close. */
  drain(): Promise<void>;
}

const failure = (code: PublicTransportCode) => new PublicTransportError(code);
const requestHeaders = new Set(["accept", "accept-language", "cache-control", "if-none-match", "if-modified-since"]);
const browserHeaders = new Set(["origin", "referer", "cookie", "authorization"]);
const hopHeaders = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade",
]);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function parseUrl(raw: string): URL {
  try {
    if (typeof raw !== "string") throw failure("invalid_url");
    const url = parsePublicTargetUrl(raw);
    if (url.hash || raw.includes("#") || /[\u0000-\u001f\u007f-\u009f]/.test(decodeURIComponent(url.search))) {
      throw failure("invalid_url");
    }
    return url;
  } catch { throw failure("invalid_url"); }
}

function redirectUrl(location: string, base: URL): URL {
  if (typeof location !== "string" || location.length > 4096 || /[^\x21-\x7e]|\\/.test(location)) throw failure("invalid_url");
  // Do not let WHATWG resolution erase raw authority or dot/encoded segments.
  if (/^[a-z][a-z0-9+.-]*:/i.test(location)) return parseUrl(location);
  if (location.startsWith("//")) return parseUrl(base.protocol + location);
  if (location.startsWith("/")) return parseUrl(base.origin + location);
  if (location.startsWith("?")) return parseUrl(base.origin + base.pathname + location);
  return parseUrl(base.origin + base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1) + location);
}

function outgoingHeaders(input: PublicTransportRequest["headers"], limit: number): Record<string, string> {
  const result: Record<string, string> = { "accept-encoding": "identity" };
  let bytes = 0;
  if (input !== undefined && (!Array.isArray(input) || input.length > 32)) throw failure("unsupported_headers");
  for (const pair of input ?? []) {
    if (!Array.isArray(pair) || pair.length !== 2) throw failure("unsupported_headers");
    const [name, value] = pair;
    if (typeof name !== "string" || typeof value !== "string" || name.length > 64 || value.length > limit) {
      throw failure("unsupported_headers");
    }
    const key = name.toLowerCase();
    bytes += name.length + value.length + 4;
    if ((!requestHeaders.has(key) && !browserHeaders.has(key)) || Object.hasOwn(result, key) || /[^\x20-\x7e]/.test(value) || bytes > limit) {
      throw failure("unsupported_headers");
    }
    if (key === "origin" && parseUrl(value).origin !== value) throw failure("unsupported_headers");
    if (key === "referer") parseUrl(value);
    result[key] = value;
  }
  return result;
}

function responseHeaders(response: IncomingMessage, limit: number): {
  headers: [string, string][];
  length?: number;
  location?: string;
} {
  const raw = response.rawHeaders;
  if (raw.length > 256 || raw.length % 2) throw failure("unsupported_response");
  const fields = new Map<string, string[]>();
  let bytes = 0;
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index].toLowerCase();
    const value = raw[index + 1];
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > limit || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
      throw failure("unsupported_response");
    }
    const values = fields.get(name) ?? [];
    values.push(value);
    fields.set(name, values);
  }
  for (const name of ["content-length", "content-encoding", "transfer-encoding", "location"]) {
    if ((fields.get(name)?.length ?? 0) > 1) throw failure("unsupported_response");
  }
  const encoding = fields.get("content-encoding")?.[0];
  const transfer = fields.get("transfer-encoding")?.[0];
  const length = fields.get("content-length")?.[0];
  if ((encoding && encoding.toLowerCase() !== "identity")
    || (transfer && transfer.toLowerCase() !== "chunked")
    || (transfer && length !== undefined)
    || (length !== undefined && (!/^\d{1,15}$/.test(length) || !Number.isSafeInteger(Number(length))))) {
    throw failure("unsupported_response");
  }
  const removed = new Set(hopHeaders);
  for (const token of (fields.get("connection") ?? []).join(",").split(",")) {
    if (token.trim()) removed.add(token.trim().toLowerCase());
  }
  // A peer cannot nominate security/representation metadata as hop-by-hop and
  // trick fulfillment into omitting restrictions or relabeling a redirect.
  for (const name of removed) {
    if (!hopHeaders.has(name) && fields.has(name)) throw failure("unsupported_response");
  }
  removed.add("content-length");
  removed.add("content-encoding");
  const headers: [string, string][] = [];
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index].toLowerCase();
    if (!removed.has(name)) headers.push([name, raw[index + 1]]);
  }
  return { headers, length: length === undefined ? undefined : Number(length), location: fields.get("location")?.[0] };
}

/** No factory/UI integration: callers must first establish a separate native deny boundary. */
export function createPublicTransport(options: PublicTransportOptions): PublicTransport {
  const { authorize, authorizeBrowserHeaders, assertActive, signal } = options;
  const limits = Object.freeze({ ...options.limits });
  if (typeof authorize !== "function" || typeof assertActive !== "function" || !(signal instanceof AbortSignal)
    || (authorizeBrowserHeaders !== undefined && typeof authorizeBrowserHeaders !== "function")
    || Object.keys(limits).length !== Object.keys(PUBLIC_TRANSPORT_LIMITS).length) throw failure("invalid_configuration");
  for (const key of Object.keys(PUBLIC_TRANSPORT_LIMITS) as (keyof PublicTransportLimits)[]) {
    const maximum = key === "dnsMs" ? 5000 : PUBLIC_TRANSPORT_LIMITS[key];
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum) throw failure("invalid_configuration");
  }
  const lifetime = new AbortController();
  let terminal: PublicTransportError | undefined;
  let attempts = 0;
  let redirects = 0;
  let totalBytes = 0;
  const pending = new Set<Promise<unknown>>();
  const started = performance.now();
  const stop = (code: PublicTransportCode) => {
    terminal ??= failure(code);
    lifetime.abort();
  };
  const abort = () => stop("aborted");
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const durationTimer = setTimeout(() => stop("duration_limit"), limits.durationMs);
  durationTimer.unref();

  function active() {
    if (terminal) throw terminal;
    if (signal.aborted) { stop("aborted"); throw terminal; }
    if (performance.now() - started >= limits.durationMs) { stop("duration_limit"); throw terminal; }
    try { assertActive(); }
    catch { stop("lease_revoked"); throw terminal; }
    if (signal.aborted) stop("aborted");
    if (terminal) throw terminal;
  }
  function charge(bytes: number) {
    if (bytes > limits.totalBytes - totalBytes) {
      stop("byte_limit");
      throw terminal;
    }
    totalBytes += bytes;
  }
  function allowed(context: PublicRequestContext) {
    active();
    let permitted: boolean;
    try { permitted = authorize(Object.freeze({ ...context })); }
    catch { throw failure("not_authorized"); }
    if (permitted !== true) throw failure("not_authorized");
    active();
  }

  async function run(input: PublicTransportRequest): Promise<PublicTransportResponse> {
    const controller = new AbortController();
    let reason: PublicTransportError | undefined;
    const cancel = (error: PublicTransportError) => {
      reason ??= error;
      controller.abort();
    };
    const jobAbort = () => cancel(terminal ?? failure("aborted"));
    const requestAbort = () => cancel(failure("aborted"));
    const callerSignal = input.signal;
    lifetime.signal.addEventListener("abort", jobAbort, { once: true });
    callerSignal?.addEventListener("abort", requestAbort, { once: true });
    if (lifetime.signal.aborted) jobAbort();
    if (callerSignal?.aborted) requestAbort();
    const timer = setTimeout(() => cancel(failure("request_timeout")), limits.requestMs);
    const check = () => {
      if (reason) throw reason;
      active();
      if (reason) throw reason;
    };
    // Signals are the revocation fence; polling also drains a silent/stalled peer
    // when a trusted guard changes without delivering the required signal.
    const guardTimer = setInterval(() => {
      try { check(); } catch (error) { cancel(error instanceof PublicTransportError ? error : failure("lease_revoked")); }
    }, 25);
    async function resolve(url: URL): Promise<{ address: string; family: 4 | 6 }> {
      check();
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const family = isIP(host);
      if (family) {
        if (!publicAddress(host)) throw failure("unsafe_destination");
        return { address: host, family: family === 4 ? 4 : 6 };
      }
      const resolver = new Resolver({ timeout: limits.dnsMs, tries: 1 });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let onAbort: () => void = () => {};
      try {
        const query = async (family: 4 | 6) => {
          try {
            const answers = await (family === 4 ? resolver.resolve4(host) : resolver.resolve6(host));
            return answers.map((address) => ({ address, family }));
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENODATA") return [];
            throw failure("dns_failure");
          }
        };
        const answers = await Promise.race([
          Promise.all([query(4), query(6)]).then((sets) => sets.flat()),
          new Promise<never>((_, reject) => {
            onAbort = () => { resolver.cancel(); reject(reason ?? terminal ?? failure("aborted")); };
            controller.signal.addEventListener("abort", onAbort, { once: true });
            timeout = setTimeout(() => { resolver.cancel(); reject(failure("dns_timeout")); }, limits.dnsMs);
            if (controller.signal.aborted) onAbort();
          }),
        ]);
        check();
        if (!answers.length || answers.length > 32 || answers.some(({ address, family }) =>
          typeof address !== "string" || isIP(address) !== family || !publicAddress(address))) throw failure("unsafe_destination");
        return Object.freeze({ ...answers[0] });
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", onAbort);
        resolver.cancel();
      }
    }

    try {
      check();
      const method = input.method;
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") throw failure("unsupported_method");
      if (input.body !== undefined) throw failure("unsupported_body");
      if (input.kind !== "navigation" && input.kind !== "asset") throw failure("invalid_request");
      const kind = input.kind;
      const url = parseUrl(input.url);
      const headers = outgoingHeaders(input.headers, limits.headerBytes);
      const context = Object.freeze({ url: url.href, method, kind });
      const sensitive = Object.freeze(Object.entries(headers).filter(([name]) => browserHeaders.has(name)).map((pair) => Object.freeze(pair)));
      const authorizeHeaders = () => {
        if (!sensitive.length) return;
        let permitted: boolean | undefined;
        try { permitted = authorizeBrowserHeaders?.(context, sensitive); }
        catch { throw failure("unsupported_headers"); }
        if (permitted !== true) throw failure("unsupported_headers");
        check();
      };
      charge(Buffer.byteLength(url.href) + Object.entries(headers).reduce((sum, [name, value]) => sum + name.length + value.length + 4, 0));
      allowed(context);
      authorizeHeaders();
      const address = await resolve(url);
      check();
      allowed(context);
      authorizeHeaders();
      const result = await new Promise<PublicTransportResponse>((resolveResponse, rejectResponse) => {
        const host = url.hostname.replace(/^\[|\]$/g, "");
        check();
        const connectionOptions: RequestOptions & { autoSelectFamily: false } = {
          protocol: url.protocol, hostname: host, port: url.protocol === "https:" ? 443 : 80,
          path: url.pathname + url.search, method, headers, agent: false,
          family: address.family, autoSelectFamily: false,
          maxHeaderSize: limits.headerBytes, insecureHTTPParser: false,
          rejectUnauthorized: true, servername: isIP(host) ? "" : host,
          checkServerIdentity: (_hostname, certificate) => checkServerIdentity(host, certificate),
          lookup: (_hostname, _options, callback) => {
            try { check(); callback(null, address.address, address.family); }
            catch { callback(reason ?? terminal ?? failure("aborted"), "", address.family); }
          },
        };
        const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(connectionOptions);
        let completed: PublicTransportResponse | undefined;
        let error: PublicTransportError | undefined;
        const fail = (cause: unknown) => {
          error ??= reason ?? terminal ?? (cause instanceof PublicTransportError ? cause : failure("network_failure"));
          req.destroy();
        };
        const onAbort = () => fail(reason ?? terminal ?? failure("aborted"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        req.on("error", fail);
        req.on("upgrade", (_res, socket) => {
          socket.destroy();
          fail(failure("unsupported_response"));
        });
        req.on("information", () => {
          // Bound unsolicited interim responses rather than accepting a stream.
          fail(failure("unsupported_response"));
        });
        req.on("socket", (socket) => {
          // Count each received plaintext HTTP byte before parser callbacks,
          // including incomplete headers, framing, rejected trailers and errors.
          // TLSSocket data is decrypted application data, not TLS wire billing.
          socket.prependListener("data", (chunk: Buffer) => {
            try { charge(chunk.length); } catch (cause) { fail(cause); }
          });
          const fence = () => { try { check(); } catch (cause) { fail(cause); } };
          fence();
          socket.once("connect", fence);
          socket.once("secureConnect", fence);
        });
        req.on("close", () => {
          controller.signal.removeEventListener("abort", onAbort);
          if (error) rejectResponse(error);
          else if (completed) resolveResponse(completed);
          else rejectResponse(reason ?? terminal ?? failure("network_failure"));
        });
        req.on("response", (res) => {
          let bytes = 0;
          const chunks: Buffer[] = [];
          let fields: ReturnType<typeof responseHeaders>;
          const status = res.statusCode ?? 0;
          const noBody = method === "HEAD" || [204, 205, 304].includes(status);
          res.on("error", fail);
          res.on("aborted", () => fail(failure("network_failure")));
          try {
            check();
            if (status < 200 || status > 599 || (status >= 300 && status < 400 && status !== 304 && !redirectStatuses.has(status))) {
              throw failure("unsupported_response");
            }
            fields = responseHeaders(res, limits.headerBytes);
            if (status === 204 && (fields.length !== undefined || res.headers["transfer-encoding"] !== undefined)) {
              throw failure("unsupported_response");
            }
            if ((!noBody && fields.length !== undefined && fields.length > limits.responseBytes)
              || (status === 205 && fields.length !== undefined && fields.length !== 0)) throw failure("byte_limit");
            if (redirectStatuses.has(status) && !fields.location) throw failure("unsupported_response");
          } catch (cause) { fail(cause); res.destroy(); return; }
          res.on("data", (chunk: Buffer) => {
            try {
              check();
              if ((noBody && chunk.length) || chunk.length > limits.responseBytes - bytes) throw failure("byte_limit");
              bytes += chunk.length;
              chunks.push(chunk);
            } catch (cause) { fail(cause); res.destroy(); }
          });
          res.on("end", () => {
            try {
              check();
              if (!res.complete || res.rawTrailers.length || (!noBody && fields.length !== undefined && fields.length !== bytes)) {
                throw failure("unsupported_response");
              }
              const responseFields = fields.headers;
              if (!noBody) responseFields.push(["content-length", String(bytes)]);
              completed = {
                url: url.href, status, headers: Object.freeze(responseFields.map((pair) => Object.freeze(pair))), body: Buffer.concat(chunks, bytes),
              };
            } catch (cause) { fail(cause); }
          });
        });
        try { check(); req.end(); } catch (cause) { fail(cause); }
      });
      check();
      if (redirectStatuses.has(result.status)) {
        if (redirects >= limits.redirects) throw failure("redirect_limit");
        redirects++;
        const location = result.headers.find(([name]) => name === "location")![1];
        const next = redirectUrl(location, url);
        if (url.protocol === "https:" && next.protocol !== "https:") throw failure("unsafe_destination");
        allowed({ ...context, url: next.href, redirectFrom: url.href });
        await resolve(next);
        check();
        allowed({ ...context, url: next.href, redirectFrom: url.href });
        return Object.freeze({ ...result, redirectUrl: next.href });
      }
      return Object.freeze(result);
    } catch (error) {
      throw reason ?? terminal ?? (error instanceof PublicTransportError ? error : failure("network_failure"));
    } finally {
      clearTimeout(timer);
      clearInterval(guardTimer);
      lifetime.signal.removeEventListener("abort", jobAbort);
      callerSignal?.removeEventListener("abort", requestAbort);
    }
  }
  return Object.freeze({
    request(input: PublicTransportRequest) {
      try {
        if (signal.aborted) stop("aborted");
        if (terminal) throw terminal;
        if (attempts >= limits.requests) throw failure("request_limit");
        attempts++;
        if (pending.size >= limits.concurrency) throw failure("concurrency_limit");
        if (!input || (input.signal !== undefined && !(input.signal instanceof AbortSignal))) throw failure("invalid_request");
        // Reserve before any caller callback: even synchronous reentry must see
        // this operation in concurrency and close/drain accounting.
        const { promise: work, resolve, reject } = Promise.withResolvers<PublicTransportResponse>();
        pending.add(work);
        void work.then(() => pending.delete(work), () => pending.delete(work));
        // run snapshots all URL/method/header data synchronously before its first await.
        void run(input).then(resolve, reject);
        return work;
      } catch (error) {
        return Promise.reject(error instanceof PublicTransportError ? error : failure("invalid_request"));
      }
    },
    async close() {
      stop("closed");
      clearTimeout(durationTimer);
      signal.removeEventListener("abort", abort);
      await Promise.allSettled([...pending]);
    },
    async drain() { await Promise.allSettled([...pending]); },
  });
}
