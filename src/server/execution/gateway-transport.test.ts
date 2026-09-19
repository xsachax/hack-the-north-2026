import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type RequestOptions } from "node:https";
import { createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayTransport, GATEWAY_TRANSPORT_LIMITS as limits,
  type GatewayTransport, type GatewayTransportOptions,
} from "./gateway-transport";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  port: 0, tls: false, ca: "", holdLookup: false, throwRequest: false,
  lateLookup: undefined as (() => void) | undefined,
  dispatches: [] as RequestOptions[],
  clients: [] as ClientRequest[],
  beforeRequest: undefined as (() => void) | undefined,
}));

// Synthetic socket tests: only this spy maps the fixed provider endpoint to our
// owned loopback servers. They are not evidence of real provider connectivity.
vi.mock("node:https", async (original) => {
  const actual = await original<typeof import("node:https")>();
  const http = await vi.importActual<typeof import("node:http")>("node:http");
  return {
    ...actual,
    request: (options: RequestOptions) => {
      state.beforeRequest?.();
      state.dispatches.push(options);
      if (state.throwRequest) throw new Error("private upstream detail must not escape");
      const mapped: RequestOptions = {
        ...options, protocol: state.tls ? "https:" : "http:", port: state.port,
        ca: state.tls ? state.ca : undefined,
        lookup: (_host, _options, callback) => {
          const invoke = () => callback(null, "127.0.0.1", 4);
          if (state.holdLookup) state.lateLookup = invoke;
          else invoke();
        },
      };
      const request = state.tls ? actual.request(mapped) : http.request(mapped);
      state.clients.push(request);
      return request;
    },
  };
});

const hostname = "api.stagehand.browserbase.com";
const transports: GatewayTransport[] = [];
const sockets = new Set<Socket>();
let handler: (request: IncomingMessage, response: ServerResponse) => void;
let received: { headers: IncomingMessage["headers"]; method?: string; url?: string; bodyBytes: number }[];
function receive(request: IncomingMessage, response: ServerResponse) {
  const record = { headers: request.headers, method: request.method, url: request.url, bodyBytes: 0 };
  received.push(record);
  request.on("data", (chunk: Buffer) => { record.bodyBytes += chunk.length; });
  handler(request, response);
}
const server = createServer(receive);
let tlsServer: ReturnType<typeof createHttpsServer>;
let rawServer: ReturnType<typeof createTcpServer>;
let rawReply = "";
let rawHold = false;
let port = 0, tlsPort = 0, rawPort = 0, directory = "";

function transport(overrides: Partial<GatewayTransportOptions> = {}) {
  const result = createGatewayTransport({
    signal: new AbortController().signal, assertActive: () => {}, onDispatch: () => {}, ...overrides,
  });
  transports.push(result);
  return result;
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 2000, interval: 5 });
}
function rawResponse(reply: string, hold = false) {
  state.port = rawPort;
  rawReply = reply;
  rawHold = hold;
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "ff-gateway-transport-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", `/CN=${hostname}`, "-addext", `subjectAltName=DNS:${hostname}`,
    "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
  ], { stdio: "ignore" });
  state.ca = readFileSync(join(directory, "cert.pem"), "utf8");
  tlsServer = createHttpsServer({ key: readFileSync(join(directory, "key.pem")), cert: state.ca }, receive);
  rawServer = createTcpServer((socket) => socket.once("data", () => {
    if (rawHold) socket.write(rawReply);
    else socket.end(rawReply);
  }));
  for (const item of [server, tlsServer, rawServer]) {
    item.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => item.listen(0, "127.0.0.1", resolve));
  }
  const addresses = [server, tlsServer, rawServer].map((item) => {
    const address = item.address();
    if (!address || typeof address === "string") throw new Error("missing_owned_listener");
    return address.port;
  });
  [port, tlsPort, rawPort] = addresses;
});
beforeEach(() => {
  state.port = port;
  state.tls = false;
  state.holdLookup = false;
  state.throwRequest = false;
  state.lateLookup = undefined;
  state.beforeRequest = undefined;
  state.dispatches.length = 0;
  state.clients.length = 0;
  received = [];
  handler = (request, response) => request.once("end", () => {
    response.setHeader("Content-Type", "application/json");
    response.end("{}");
  });
});
afterEach(async () => {
  await Promise.all(transports.splice(0).map((item) => item.close()));
  for (const socket of sockets) socket.destroy();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await Promise.all([server, tlsServer, rawServer].map((item) =>
    new Promise<void>((resolve) => item.close(() => resolve()))));
  rmSync(directory, { recursive: true, force: true });
});

describe("fixed control-plane dispatch", () => {
  it("uses only the fixed POST/TLS authority, no shared agent, family racing, proxy, or retry", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("ALL_PROXY", "http://127.0.0.1:1");
    const dispatch = vi.fn();
    state.beforeRequest = () => expect(dispatch).toHaveBeenCalledTimes(1);
    const broker = transport({ onDispatch: dispatch });
    const pending = broker.request({ Authorization: "Bearer offline-test", "X-BB-Session-ID": "offline-session" }, Buffer.from("{}"));
    expect(dispatch).toHaveBeenCalledTimes(1);
    const result = await pending;
    expect(result).toEqual({ status: 200, contentType: "application/json", body: Buffer.from("{}") });
    expect(state.dispatches).toHaveLength(1);
    expect(state.dispatches[0]).toMatchObject({
      protocol: "https:", hostname, port: 443, path: "/v1/llm/responses", method: "POST",
      servername: hostname, rejectUnauthorized: true, agent: false, autoSelectFamily: false,
      insecureHTTPParser: false, joinDuplicateHeaders: false, maxHeaderSize: 16384, timeout: 30000,
    });
    expect(state.dispatches[0]).not.toHaveProperty("lookup");
    expect(state.dispatches[0]).not.toHaveProperty("auth");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      method: "POST", url: "/v1/llm/responses", bodyBytes: 2,
      headers: { host: hostname, authorization: "Bearer offline-test", "x-bb-session-id": "offline-session" },
    });
  });
  it("performs a verified TLS handshake against the explicitly mapped owned certificate", async () => {
    state.tls = true;
    state.port = tlsPort;
    const result = await transport().request({}, Buffer.alloc(0));
    expect(result.status).toBe(200);
    expect(state.dispatches[0].servername).toBe(hostname);
    expect(received[0].headers.host).toBe(hostname);
  });
  it("strips both cookies and caller authority/framing/hop headers, including Connection nominations", async () => {
    await transport().request({
      Cookie: "private=ignored", Cookie2: "private2=ignored", "Set-Cookie": "private3=ignored",
      "Set-Cookie2": "private4=ignored", Host: "127.0.0.1",
      "Content-Length": "999", "Transfer-Encoding": "chunked", "Accept-Encoding": "gzip",
      Connection: "X-Private-Hop, keep-alive", "X-Private-Hop": "strip-me", "Keep-Alive": "timeout=10",
      "Proxy-Authorization": "private-proxy", "Proxy-Connection": "keep-alive", "Proxy-Other": "strip-me",
      TE: "trailers", Trailer: "X-Trailer", Upgrade: "websocket", Expect: "100-continue",
      Authorization: "Bearer offline-test", "X-Stagehand-Session-Id": "trusted-session", "Content-Type": "application/json",
    }, Buffer.from("{}"));
    expect(received[0].headers).toEqual({
      host: hostname, "content-length": "2", "accept-encoding": "identity", connection: "close",
      authorization: "Bearer offline-test", "x-stagehand-session-id": "trusted-session", "content-type": "application/json",
    });
  });
  it("ignores Set-Cookie/Set-Cookie2 without exposing or replaying either on later requests", async () => {
    handler = (request, response) => request.once("end", () => {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Set-Cookie", ["private=first; Secure", "private2=second; HttpOnly"]);
      response.setHeader("Set-Cookie2", "private3=third");
      response.end("{}");
    });
    const broker = transport();
    const result = await broker.request({ Cookie: "private=caller" }, Buffer.alloc(0));
    expect(Object.keys(result).sort()).toEqual(["body", "contentType", "status"]);
    await broker.request({}, Buffer.alloc(0));
    expect(received.every((item) => !item.headers.cookie && !item.headers.cookie2)).toBe(true);
  });
  it("returns bounded non-success responses without fabricating success or a content type", async () => {
    handler = (_request, response) => {
      response.writeHead(429, { "Content-Type": "application/problem+json" });
      response.end('{"error":"offline"}');
    };
    expect(await transport().request({}, Buffer.alloc(0))).toEqual({
      status: 429, contentType: "application/problem+json", body: Buffer.from('{"error":"offline"}'),
    });
  });
  it("sanitizes synchronous and asynchronous network failures and never retries", async () => {
    state.throwRequest = true;
    await expect(transport().request({}, Buffer.alloc(0))).rejects.toThrow(/^gateway_transport_network_failure$/);
    state.throwRequest = false;
    rawResponse("");
    await expect(transport().request({}, Buffer.alloc(0))).rejects.toThrow(/^gateway_transport_network_failure$/);
    expect(state.dispatches).toHaveLength(2);
  });
  it("lets a synchronous onDispatch rejection prevent all network activity without exposing its error", async () => {
    const dispatch = vi.fn(() => { throw new Error("private model budget detail"); });
    await expect(transport({ onDispatch: dispatch }).request({}, Buffer.alloc(0)))
      .rejects.toThrow(/^gateway_transport_dispatch_rejected$/);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(state.dispatches).toHaveLength(0);
  });
  it.each([
    () => true,
    () => false,
    () => 1,
    () => null,
    () => ({}),
    () => Promise.resolve(),
    () => Promise.reject(new Error("private async dispatch detail")),
  ])("rejects non-undefined onDispatch returns before network, including async guards %#", async (onDispatch) => {
    await expect(transport({ onDispatch }).request({}, Buffer.alloc(0)))
      .rejects.toThrow(/^gateway_transport_dispatch_rejected$/);
    expect(state.dispatches).toHaveLength(0);
    expect(received).toHaveLength(0);
  });
  it("does not await a pending dispatch guard or dispatch when it later resolves", async () => {
    const dispatch = deferred();
    const broker = transport({ onDispatch: () => dispatch.promise });
    await expect(broker.request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "dispatch_rejected" });
    await broker.close();
    dispatch.resolve();
    await dispatch.promise;
    expect(state.dispatches).toHaveLength(0);
  });
});

describe("streamed response validation", () => {
  it("accepts identity chunked responses up to the exact body limit", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "identity" });
      for (let i = 0; i < 64; i++) response.write(Buffer.alloc(65536, 97));
      response.end();
    };
    const result = await transport().request({}, Buffer.alloc(0));
    expect(result.body.length).toBe(limits.responseBytes);
    expect(result.body[0]).toBe(97);
  });
  it("stops oversized chunked input early without concatenating a giant response", async () => {
    let written = 0;
    const stopped = deferred();
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.once("close", () => stopped.resolve());
      const chunk = Buffer.alloc(65536);
      function pump() {
        if (response.destroyed) return;
        if (written >= 32 * 1024 * 1024) { response.end(); return; }
        written += chunk.length;
        if (response.write(chunk)) setImmediate(pump);
        else response.once("drain", pump);
      }
      pump();
    };
    const concat = vi.spyOn(Buffer, "concat");
    await expect(transport().request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "response_body_limit" });
    await stopped.promise;
    expect(written).toBeLessThan(16 * 1024 * 1024);
    expect(concat.mock.calls.filter(([, length]) => length !== undefined && length >= limits.responseBytes)).toHaveLength(0);
  });
  it("rejects oversized declared content length before waiting for or buffering body bytes", async () => {
    rawResponse(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${limits.responseBytes + 1}\r\n\r\n`, true);
    await expect(transport().request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "response_body_limit" });
  });
  it.each([301, 302, 303, 304, 307, 308])("rejects %s without following its private redirect or cookies", async (status) => {
    rawResponse(`HTTP/1.1 ${status} Redirect\r\nLocation: http://127.0.0.1/private\r\nSet-Cookie: private=value\r\nContent-Type: application/json\r\nContent-Length: 0\r\n\r\n`);
    await expect(transport().request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "unsupported_response" });
    expect(state.dispatches).toHaveLength(1);
  });
  it.each([100, 102, 103])("rejects interim %s instead of accepting the subsequent success", async (status) => {
    rawResponse(`HTTP/1.1 ${status} Interim\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`);
    await expect(transport().request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "unsupported_response" });
  });
  it("rejects switching protocols and destroys the upgraded socket", async () => {
    rawResponse("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n", true);
    await expect(transport().request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "unsupported_response" });
  });
  it.each([
    "",
    "Content-Type: \r\n",
    "Content-Type: unknown\r\n",
    "Content-Type: application/json\r\nContent-Type: text/plain\r\n",
    "Content-Type: application/json\r\nContent-Encoding: gzip\r\n",
    "Content-Type: application/json\r\nContent-Encoding: \r\n",
    "Content-Type: application/json\r\nContent-Encoding: identity\r\nContent-Encoding: identity\r\n",
    "Content-Type: application/json\r\nTrailer: X-Private\r\n",
    "Content-Type: application/json\r\nConnection: Content-Type\r\n",
  ])("rejects missing/ambiguous/unsupported representation metadata %#", async (headers) => {
    rawResponse(`HTTP/1.1 200 OK\r\n${headers}Content-Length: 2\r\n\r\n{}`);
    await expect(transport().request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "unsupported_response" });
  });
  it.each([
    "Content-Length: 2\r\nContent-Length: 2\r\n",
    "Content-Length: 2\r\nTransfer-Encoding: chunked\r\n",
    "Content-Length: nope\r\n",
    "Transfer-Encoding: gzip\r\n",
  ])("rejects malformed or ambiguous response framing %#", async (framing) => {
    rawResponse(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n${framing}\r\n{}`);
    await expect(transport().request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "unsupported_response" });
  });
  it("rejects an unannounced trailer instead of accepting its body", async () => {
    rawResponse("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\nX-Private: ignored\r\n\r\n");
    await expect(transport().request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "unsupported_response" });
  });
  it.each([
    "Content-Length: 100\r\n\r\n{}",
    "Transfer-Encoding: chunked\r\n\r\n4\r\n{}",
  ])("rejects truncated fixed-length or chunked bodies %#", async (framing) => {
    rawResponse(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n${framing}`);
    await expect(transport().request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "truncated_response" });
  });
  it("bounds response headers at the native parser before collecting a body", async () => {
    rawResponse(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Large: ${"a".repeat(limits.headerBytes)}\r\nContent-Length: 2\r\n\r\n{}`);
    await expect(transport().request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "header_limit" });
  });
  it("accepts exactly 16 KiB of response headers and rejects one additional byte", async () => {
    const prefix = "Content-Type: application/json\r\nContent-Length: 2\r\nX-Fill: ";
    const fill = "a".repeat(limits.headerBytes - Buffer.byteLength(prefix + "\r\n\r\n"));
    rawResponse(`HTTP/1.1 200 OK\r\n${prefix}${fill}\r\n\r\n{}`);
    await expect(transport().request({}, Buffer.alloc(0))).resolves.toMatchObject({ status: 200 });
    rawResponse(`HTTP/1.1 200 OK\r\n${prefix}${fill}a\r\n\r\n{}`);
    await expect(transport().request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "header_limit" });
  });
  it("rejects bytes after a complete response rather than interpreting a second response", async () => {
    rawResponse("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}unexpected");
    await expect(transport().request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "unsupported_response" });
  });
  it("rejects unknown response status shapes", async () => {
    rawResponse("HTTP/1.1 600 Unknown\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}");
    await expect(transport().request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "unsupported_response" });
  });
});

describe("per-job request and byte budgets", () => {
  it("accepts exactly 8 MiB of request body and rejects one extra byte before dispatch", async () => {
    const broker = transport();
    await broker.request({}, Buffer.alloc(limits.requestBytes));
    expect(received[0].bodyBytes).toBe(limits.requestBytes);
    await expect(broker.request({}, Buffer.alloc(limits.requestBytes + 1))).rejects.toMatchObject({ code: "request_body_limit" });
    expect(state.dispatches).toHaveLength(1);
  });
  it("copies caller-owned body and headers before asynchronous dispatch work", async () => {
    state.holdLookup = true;
    handler = (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.once("end", () => {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end(Buffer.concat(chunks));
      });
    };
    const headers = { Authorization: "original" }, body = Buffer.from("original");
    const broker = transport();
    const pending = broker.request(headers, body);
    headers.Authorization = "mutated";
    body.fill(120);
    await until(() => state.lateLookup !== undefined);
    state.lateLookup?.();
    expect((await pending).body.toString()).toBe("original");
    expect(state.dispatches[0].headers).toMatchObject({ authorization: "original", "content-length": "8" });
    expect(received[0].headers.authorization).toBe("original");
  });
  it.each<Record<string, string>>([
    { "Bad Header": "invalid" },
    { Authorization: "value\r\nCookie: private" },
    { Authorization: "one", authorization: "two" },
    { Connection: "invalid header name" },
  ])("rejects malformed headers before onDispatch %#", async (headers) => {
    const dispatch = vi.fn();
    await expect(transport({ onDispatch: dispatch }).request(headers, Buffer.alloc(0)))
      .rejects.toMatchObject({ code: "invalid_headers" });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("rejects accessors without invoking them", async () => {
    const getter = vi.fn(() => "private");
    const headers: Record<string, string> = {};
    Object.defineProperty(headers, "authorization", { enumerable: true, get: getter });
    await expect(transport().request(headers, Buffer.alloc(0))).rejects.toMatchObject({ code: "invalid_headers" });
    expect(getter).not.toHaveBeenCalled();
    expect(state.dispatches).toHaveLength(0);
  });
  it("sanitizes header inspection errors without disclosing private details", async () => {
    const headers = new Proxy({}, { getPrototypeOf() { throw new Error("private header detail"); } });
    await expect(transport().request(headers, Buffer.alloc(0))).rejects.toThrow(/^gateway_transport_invalid_headers$/);
    expect(state.dispatches).toHaveLength(0);
  });
  it("bounds supplied and generated request headers, including stripped private headers", async () => {
    const broker = transport();
    await expect(broker.request({ Authorization: "x".repeat(limits.headerBytes) }, Buffer.alloc(0)))
      .rejects.toMatchObject({ code: "header_limit" });
    await expect(broker.request({ Cookie: "x".repeat(limits.headerBytes) }, Buffer.alloc(0)))
      .rejects.toMatchObject({ code: "header_limit" });
    await expect(broker.request({ "X-Large": "x".repeat(limits.headerBytes - 30) }, Buffer.alloc(0)))
      .rejects.toMatchObject({ code: "header_limit" });
    expect(state.dispatches).toHaveLength(0);
  });
  it("includes generated authority and framing in the exact 16 KiB request-header ceiling", async () => {
    const generated = `host: ${hostname}\r\ncontent-length: 0\r\naccept-encoding: identity\r\nconnection: close\r\n\r\n`;
    const fill = "a".repeat(limits.headerBytes - Buffer.byteLength(generated + "x-fill: \r\n"));
    const broker = transport();
    await broker.request({ "X-Fill": fill }, Buffer.alloc(0));
    await expect(broker.request({ "X-Fill": fill + "a" }, Buffer.alloc(0))).rejects.toMatchObject({ code: "header_limit" });
    expect(state.dispatches).toHaveLength(1);
  });
  it("allows 64 requests but never dispatches a 65th", async () => {
    const broker = transport();
    for (let i = 0; i < limits.requests; i++) await broker.request({}, Buffer.alloc(0));
    await expect(broker.request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "request_limit" });
    expect(state.dispatches).toHaveLength(64);
  });
  it("allows two in-flight requests, rejects the third, and frees capacity after completion", async () => {
    const replies: ServerResponse[] = [];
    handler = (_request, response) => { replies.push(response); };
    const broker = transport();
    const first = broker.request({}, Buffer.alloc(0)), second = broker.request({}, Buffer.alloc(0));
    await until(() => replies.length === 2);
    await expect(broker.request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "concurrency_limit" });
    for (const reply of replies) reply.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    await Promise.all([first, second]);
    handler = (_request, response) => response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    await broker.request({}, Buffer.alloc(0));
    expect(state.dispatches).toHaveLength(3);
  });
  it("counts outgoing bodies plus request/response headers toward the 64 MiB lifetime limit", async () => {
    const broker = transport(), body = Buffer.alloc(limits.requestBytes);
    for (let i = 0; i < 7; i++) await broker.request({}, body);
    await expect(broker.request({}, body)).rejects.toMatchObject({ code: "byte_limit" });
    expect(state.dispatches).toHaveLength(7);
  });
  it("charges streamed response bytes across requests, not merely declared lengths", async () => {
    const chunk = Buffer.alloc(65536);
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      for (let i = 0; i < 64; i++) response.write(chunk);
      response.end();
    };
    const broker = transport();
    for (let i = 0; i < 15; i++) await broker.request({}, Buffer.alloc(0));
    await expect(broker.request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "byte_limit" });
    expect(state.dispatches).toHaveLength(16);
    await expect(broker.request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "byte_limit" });
  });
});

describe("deadline, revocation, and terminal cleanup", () => {
  it("prevents network for an already-aborted signal or revoked guard", async () => {
    const signal = AbortSignal.abort("private abort detail");
    await expect(transport({ signal }).request({}, Buffer.alloc(0))).rejects.toThrow(/^gateway_transport_aborted$/);
    await expect(transport({ assertActive: () => { throw new Error("private lease detail"); } }).request({}, Buffer.alloc(0)))
      .rejects.toThrow(/^gateway_transport_lease_revoked$/);
    expect(state.dispatches).toHaveLength(0);
  });
  it("rechecks abort and guard state after onDispatch, before creating the socket", async () => {
    const controller = new AbortController();
    await expect(transport({ signal: controller.signal, onDispatch: () => controller.abort() })
      .request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "aborted" });
    let live = true;
    await expect(transport({
      assertActive: () => { if (!live) throw new Error("revoked"); }, onDispatch: () => { live = false; },
    }).request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "lease_revoked" });
    expect(state.dispatches).toHaveLength(0);
  });
  it("drains both in-flight sockets on job abort and remains terminal", async () => {
    handler = () => {};
    const controller = new AbortController(), broker = transport({ signal: controller.signal });
    const pending = [broker.request({}, Buffer.alloc(0)), broker.request({}, Buffer.alloc(0))];
    const rejected = Promise.all(pending.map((item) => expect(item).rejects.toMatchObject({ code: "aborted" })));
    await until(() => received.length === 2);
    controller.abort("private cancellation reason");
    await rejected;
    await broker.close();
    expect(state.clients.every((item) => item.destroyed && item.closed)).toBe(true);
    await expect(broker.request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "aborted" });
  });
  it("enforces a 30-second wall-clock deadline even while response chunks keep arriving", async () => {
    const started = deferred();
    let response: ServerResponse | undefined;
    handler = (_request, incoming) => {
      response = incoming;
      incoming.writeHead(200, { "Content-Type": "application/json" });
      incoming.write("a");
      started.resolve();
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const broker = transport(), pending = broker.request({}, Buffer.alloc(0));
    const rejected = expect(pending).rejects.toMatchObject({ code: "request_timeout" });
    await started.promise;
    await vi.advanceTimersByTimeAsync(limits.requestMs - 1);
    response?.write("b");
    expect(state.clients[0].destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(state.clients[0].destroyed).toBe(true);
    expect(state.dispatches).toHaveLength(1);
  });
  it("times out stalled lookup and destroys late lookup results without dispatching another request", async () => {
    state.holdLookup = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const broker = transport(), pending = broker.request({}, Buffer.alloc(0));
    const rejected = expect(pending).rejects.toMatchObject({ code: "request_timeout" });
    await vi.advanceTimersByTimeAsync(limits.requestMs);
    await rejected;
    state.lateLookup?.();
    await broker.close();
    expect(received).toHaveLength(0);
    expect(state.dispatches).toHaveLength(1);
  });
  it("rejects revocation discovered during streamed callbacks without returning the buffered body", async () => {
    let active = true;
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write("{");
      active = false;
      response.end("}");
    };
    const broker = transport({ assertActive: () => { if (!active) throw new Error("private revocation"); } });
    await expect(broker.request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "lease_revoked" });
  });
  it("polls a revoked guard to cancel a silent peer without waiting for its deadline", async () => {
    let active = true;
    handler = () => {};
    const broker = transport({ assertActive: () => { if (!active) throw new Error("revoked"); } });
    const pending = broker.request({}, Buffer.alloc(0));
    const rejected = expect(pending).rejects.toMatchObject({ code: "lease_revoked" });
    await until(() => received.length === 1);
    active = false;
    await rejected;
  });
  it("makes close terminal/idempotent, drains stalled work, and ignores late response callbacks", async () => {
    state.holdLookup = true;
    const broker = transport(), pending = broker.request({}, Buffer.alloc(0));
    const rejected = expect(pending).rejects.toMatchObject({ code: "closed" });
    await until(() => state.lateLookup !== undefined);
    const close = broker.close();
    expect(broker.close()).toBe(close);
    await Promise.all([close, rejected]);
    state.lateLookup?.();
    const destroy = vi.fn();
    state.clients[0].emit("response", { destroy });
    state.clients[0].emit("information", { statusCode: 103 });
    state.clients[0].emit("error", new Error("late private detail"));
    expect(destroy).toHaveBeenCalledOnce();
    await expect(broker.request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "closed" });
    expect(state.dispatches).toHaveLength(1);
    expect(received).toHaveLength(0);
  });
  it("allows a reentrant close during onDispatch to prevent even initial socket creation", async () => {
    const broker: GatewayTransport = transport({ onDispatch: () => { void broker.close(); } });
    await expect(broker.request({}, Buffer.alloc(0))).rejects.toMatchObject({ code: "closed" });
    await broker.close();
    expect(state.dispatches).toHaveLength(0);
  });
});
