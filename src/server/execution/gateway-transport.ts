import "server-only";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";

export const GATEWAY_TRANSPORT_LIMITS = Object.freeze({
  requests: 64, concurrency: 2, totalBytes: 64 * 1024 * 1024,
  requestBytes: 8 * 1024 * 1024, responseBytes: 4 * 1024 * 1024,
  headerBytes: 16 * 1024, requestMs: 30_000,
});
export type GatewayTransportCode =
  | "invalid_configuration" | "invalid_request" | "invalid_headers" | "header_limit"
  | "request_body_limit" | "response_body_limit" | "unsupported_response" | "truncated_response"
  | "request_limit" | "concurrency_limit" | "byte_limit" | "request_timeout"
  | "aborted" | "closed" | "lease_revoked" | "dispatch_rejected" | "network_failure";

export class GatewayTransportError extends Error {
  constructor(readonly code: GatewayTransportCode) {
    super(`gateway_transport_${code}`);
    this.name = "GatewayTransportError";
  }
}
export type GatewayTransportResponse = { status: number; contentType: string; body: Buffer };
export type GatewayTransportOptions = {
  signal: AbortSignal;
  assertActive: () => void;
  onDispatch: () => void;
};
export interface GatewayTransport {
  request(headers: Readonly<Record<string, string>>, body: Buffer): Promise<GatewayTransportResponse>;
  close(): Promise<void>;
}

const hostname = "api.stagehand.browserbase.com";
const limits = GATEWAY_TRANSPORT_LIMITS;
const token = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
const removedHeaders = new Set([
  "cookie", "cookie2", "set-cookie", "set-cookie2", "host", "content-length", "connection", "keep-alive",
  "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer",
  "transfer-encoding", "upgrade", "expect", "accept-encoding",
]);
const failure = (code: GatewayTransportCode) => new GatewayTransportError(code);

function outgoingHeaders(input: Readonly<Record<string, string>>, length: number) {
  if (!input || typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw failure("invalid_headers");
  const fields = new Map<string, string>();
  let suppliedBytes = 2;
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
    const value: unknown = descriptor.value;
    if (!token.test(name) || typeof value !== "string" || /[^\x20-\x7e\t]/.test(value)) {
      throw failure("invalid_headers");
    }
    suppliedBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (suppliedBytes > limits.headerBytes) throw failure("header_limit");
    const key = name.toLowerCase();
    if (fields.has(key)) throw failure("invalid_headers");
    fields.set(key, value);
  }
  const removed = new Set(removedHeaders);
  for (const name of (fields.get("connection") ?? "").split(",")) {
    const key = name.trim().toLowerCase();
    if (key && !token.test(key)) throw failure("invalid_headers");
    if (key) removed.add(key);
  }
  const headers: Record<string, string> = Object.create(null);
  for (const [name, value] of fields) {
    if (!removed.has(name) && !name.startsWith("proxy-")) headers[name] = value;
  }
  headers.host = hostname;
  headers["content-length"] = String(length);
  headers["accept-encoding"] = "identity";
  headers.connection = "close";
  const bytes = Object.entries(headers).reduce((sum, [name, value]) =>
    sum + Buffer.byteLength(name) + Buffer.byteLength(value) + 4, 2);
  if (bytes > limits.headerBytes) throw failure("header_limit");
  return { headers, bytes };
}

function responseMetadata(response: IncomingMessage) {
  const status = response.statusCode;
  if (!Number.isInteger(status) || status === undefined || status < 200 || status > 599 ||
    (status >= 300 && status < 400) || !["1.0", "1.1"].includes(response.httpVersion)) {
    throw failure("unsupported_response");
  }
  const raw = response.rawHeaders;
  if (!Array.isArray(raw) || raw.length % 2) throw failure("unsupported_response");
  const fields = new Map<string, string[]>();
  let bytes = 2;
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i], value = raw[i + 1];
    if (typeof name !== "string" || typeof value !== "string" ||
      !token.test(name) || /[^\x20-\x7e\t]/.test(value)) throw failure("unsupported_response");
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > limits.headerBytes) throw failure("header_limit");
    const key = name.toLowerCase();
    const values = fields.get(key) ?? [];
    values.push(value);
    fields.set(key, values);
  }
  for (const name of ["content-type", "content-length", "content-encoding", "transfer-encoding"]) {
    if ((fields.get(name)?.length ?? 0) > 1) throw failure("unsupported_response");
  }
  const contentType = fields.get("content-type")?.[0];
  const mediaType = contentType?.split(";")[0].trim().split("/");
  if (!contentType || mediaType?.length !== 2 || !mediaType.every((part) => token.test(part))) {
    throw failure("unsupported_response");
  }
  const encoding = fields.get("content-encoding")?.[0];
  const transfer = fields.get("transfer-encoding")?.[0];
  const declared = fields.get("content-length")?.[0];
  if (fields.has("trailer") || fields.has("upgrade") ||
    (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") ||
    (transfer !== undefined && transfer.trim().toLowerCase() !== "chunked") ||
    (transfer !== undefined && declared !== undefined) ||
    (declared !== undefined && !/^\d{1,10}$/.test(declared))) throw failure("unsupported_response");
  for (const name of (fields.get("connection") ?? []).join(",").split(",")) {
    if (name.trim() && !["close", "keep-alive"].includes(name.trim().toLowerCase())) {
      throw failure("unsupported_response");
    }
  }
  const length = declared === undefined ? undefined : Number(declared);
  if (length !== undefined && length > limits.responseBytes) throw failure("response_body_limit");
  return { status, contentType, length, bytes };
}

function networkFailure(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "HPE_HEADER_OVERFLOW") return failure("header_limit");
  return failure(typeof code === "string" && code.startsWith("HPE_") ? "unsupported_response" : "network_failure");
}

/** Fixed control-plane transport; never reuse it as the public-URL broker. */
export function createGatewayTransport(options: GatewayTransportOptions): GatewayTransport {
  if (!options || !(options.signal instanceof AbortSignal) ||
    typeof options.assertActive !== "function" || typeof options.onDispatch !== "function") {
    throw failure("invalid_configuration");
  }
  const { signal, assertActive, onDispatch } = options;
  type Operation = { cancel: (error: GatewayTransportError) => void; drained: Promise<void> };
  const operations = new Set<Operation>();
  let terminal: GatewayTransportError | undefined;
  let closePromise: Promise<void> | undefined;
  let attempts = 0;
  let totalBytes = 0;

  function stop(code: GatewayTransportCode) {
    terminal ??= failure(code);
    signal.removeEventListener("abort", abort);
    for (const operation of operations) operation.cancel(terminal);
    return terminal;
  }
  function abort() { stop("aborted"); }
  function active() {
    if (terminal) throw terminal;
    if (signal.aborted) throw stop("aborted");
    try { assertActive(); } catch { throw stop("lease_revoked"); }
    if (signal.aborted) throw stop("aborted");
    if (terminal) throw terminal;
  }
  function charge(bytes: number) {
    if (bytes > limits.totalBytes - totalBytes) throw stop("byte_limit");
    totalBytes += bytes;
  }
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  return {
    async request(headers, body) {
      active();
      if (attempts >= limits.requests) throw stop("request_limit");
      if (operations.size >= limits.concurrency) throw failure("concurrency_limit");
      if (!Buffer.isBuffer(body)) throw failure("invalid_request");
      if (body.length > limits.requestBytes) throw failure("request_body_limit");
      let outgoing: ReturnType<typeof outgoingHeaders>;
      try { outgoing = outgoingHeaders(headers, body.length); }
      catch (error) { throw error instanceof GatewayTransportError ? error : failure("invalid_headers"); }
      const snapshot = Buffer.from(body);
      active();
      charge(outgoing.bytes + snapshot.length);
      attempts++;
      const result = await new Promise<GatewayTransportResponse>((resolve, reject) => {
        let request: ClientRequest | undefined;
        let response: IncomingMessage | undefined;
        let outcome: { value: GatewayTransportResponse } | { error: GatewayTransportError } | undefined;
        let finalized = false;
        let chunks: Buffer[] = [];
        let size = 0;
        let drain!: () => void;
        const operation: Operation = {
          cancel: fail, drained: new Promise<void>((done) => { drain = done; }),
        };
        operations.add(operation);
        const started = performance.now();
        const timer = setTimeout(() => fail(failure("request_timeout")), limits.requestMs);
        const guard = setInterval(() => {
          try { check(); } catch (error) { fail(safeError(error)); }
        }, 25);
        function safeError(error: unknown) {
          return error instanceof GatewayTransportError ? error : failure("network_failure");
        }
        function check() {
          active();
          if (performance.now() - started >= limits.requestMs) throw failure("request_timeout");
        }
        function finalize() {
          if (finalized) return;
          finalized = true;
          clearTimeout(timer);
          clearInterval(guard);
          operations.delete(operation);
          chunks = [];
          try {
            check();
            if (!outcome) throw failure("network_failure");
            if ("error" in outcome) throw outcome.error;
            resolve(outcome.value);
          } catch (error) { reject(safeError(error)); }
          drain();
        }
        function fail(error: GatewayTransportError) {
          if (finalized || (outcome && "error" in outcome)) return;
          outcome = { error };
          chunks = [];
          response?.destroy();
          request?.destroy();
          if (!request) finalize();
        }
        function guarded(callback: () => void) {
          if (outcome || finalized) return;
          try { check(); callback(); check(); } catch (error) { fail(safeError(error)); }
        }
        try {
          const connectionOptions: RequestOptions & { autoSelectFamily: false } = {
            protocol: "https:", hostname, port: 443, path: "/v1/llm/responses", method: "POST",
            servername: hostname, rejectUnauthorized: true, agent: false, autoSelectFamily: false,
            maxHeaderSize: limits.headerBytes, insecureHTTPParser: false,
            joinDuplicateHeaders: false, timeout: limits.requestMs, headers: outgoing.headers,
          };
          check();
          try {
            const dispatched: unknown = onDispatch();
            if (dispatched !== undefined) {
              // Observe invalid async guards without awaiting or authorizing them.
              void Promise.resolve(dispatched).catch(() => {});
              throw failure("dispatch_rejected");
            }
          } catch { throw failure("dispatch_rejected"); }
          check();
          request = httpsRequest(connectionOptions);
          request.on("error", (error) => fail(networkFailure(error)));
          request.once("close", finalize);
          request.on("socket", (socket) => {
            if (outcome || finalized) { socket.destroy(); return; }
            guarded(() => {});
            if (outcome) socket.destroy();
          });
          request.on("information", () => guarded(() => { throw failure("unsupported_response"); }));
          request.on("continue", () => guarded(() => { throw failure("unsupported_response"); }));
          request.on("upgrade", (_response, socket) => {
            socket.destroy();
            guarded(() => { throw failure("unsupported_response"); });
          });
          request.on("response", (incoming) => {
            if (outcome || finalized) { incoming.destroy(); return; }
            response = incoming;
            incoming.on("error", (error) => fail(networkFailure(error)));
            incoming.on("aborted", () => fail(failure("truncated_response")));
            guarded(() => {
              const metadata = responseMetadata(incoming);
              charge(metadata.bytes);
              if (metadata.length !== undefined && metadata.length > limits.totalBytes - totalBytes) {
                throw stop("byte_limit");
              }
              incoming.on("data", (chunk: unknown) => guarded(() => {
                if (!Buffer.isBuffer(chunk)) throw failure("unsupported_response");
                charge(chunk.length);
                if (chunk.length > limits.responseBytes - size) throw failure("response_body_limit");
                size += chunk.length;
                chunks.push(chunk);
              }));
              incoming.on("end", () => guarded(() => {
                if (incoming.rawTrailers.length) throw failure("unsupported_response");
                if (!incoming.complete ||
                  (metadata.length !== undefined && metadata.length !== size)) throw failure("truncated_response");
                const body = Buffer.concat(chunks, size);
                check();
                outcome = { value: { status: metadata.status, contentType: metadata.contentType, body } };
                chunks = [];
                request?.destroy();
              }));
            });
          });
          check();
          request.end(snapshot);
        } catch (error) { fail(safeError(error)); }
      });
      active();
      return result;
    },
    close() {
      if (!closePromise) {
        stop("closed");
        closePromise = Promise.all([...operations].map((operation) => operation.drained)).then(() => {});
      }
      return closePromise;
    },
  };
}
