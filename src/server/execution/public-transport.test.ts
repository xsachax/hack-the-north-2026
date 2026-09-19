import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type RequestOptions } from "node:https";
import { createServer as createTcpServer, type Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicTransport, PUBLIC_TRANSPORT_LIMITS, type PublicTransport,
  type PublicRequestContext, type PublicTransportOptions, type PublicTransportRequest,
} from "./public-transport";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  v4: vi.fn<() => Promise<string[]>>(),
  v6: vi.fn<() => Promise<string[]>>(),
  cancel: vi.fn(),
  dispatches: [] as RequestOptions[],
  pins: [] as { address: string; family: number }[],
  port: 0,
  ca: "",
  holdLookup: false,
  lateLookup: undefined as (() => void) | undefined,
  sockets: [] as Socket[],
}));
vi.mock("node:dns/promises", async (original) => ({
  ...await original<typeof import("node:dns/promises")>(),
  Resolver: class {
    resolve4 = state.v4;
    resolve6 = state.v6;
    cancel = state.cancel;
  },
}));

// Only this test boundary maps sockets to an owned loopback listener. Production
// classification/pinning is unchanged; this is not a real public-IP socket proof.
function mappedOptions(options: RequestOptions): RequestOptions {
  state.dispatches.push(options);
  return {
    ...options, hostname: "example.com", port: state.port, ca: state.ca,
    lookup: (host, opts, callback) => {
      const invoke = () => {
        if (!options.lookup) throw new Error("Missing production pinned lookup");
        options.lookup(host, opts, (error, address, family) => {
          if (!error) {
            if (typeof address !== "string" || family === undefined) throw new Error("Unexpected pin shape");
            state.pins.push({ address, family });
          }
          callback(error, "127.0.0.1", 4);
        });
      };
      if (state.holdLookup) state.lateLookup = invoke;
      else invoke();
    },
  };
}
vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  return { ...actual, request: (options: RequestOptions) => {
    const req = actual.request(mappedOptions(options));
    req.once("socket", (socket) => state.sockets.push(socket));
    return req;
  } };
});
vi.mock("node:https", async (original) => {
  const actual = await original<typeof import("node:https")>();
  return { ...actual, request: (options: RequestOptions) => {
    const req = actual.request(mappedOptions(options));
    req.once("socket", (socket) => state.sockets.push(socket));
    return req;
  } };
});

const input: PublicTransportRequest = { url: "http://example.com/docs", method: "GET", kind: "navigation" };
const transports: PublicTransport[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let received: { url: string; headers: IncomingMessage["headers"]; method: string }[];
const server = createServer((req, res) => {
  received.push({ url: req.url!, headers: req.headers, method: req.method! });
  handler(req, res);
});
let tlsServer: ReturnType<typeof createHttpsServer>;
let rawServer: ReturnType<typeof createTcpServer>;
let rawReply = "";
let rawHold = false;
let port = 0;
let tlsPort = 0;
let rawPort = 0;
let directory = "";

function transport(options: Partial<PublicTransportOptions> = {}) {
  const result = createPublicTransport({
    authorize: () => true, assertActive: () => {}, signal: new AbortController().signal,
    limits: PUBLIC_TRANSPORT_LIMITS, ...options,
  });
  transports.push(result);
  return result;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 2000, interval: 5 });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing owned listener");
  port = address.port;
  directory = mkdtempSync(join(tmpdir(), "ff-public-transport-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=example.com", "-addext", "subjectAltName=DNS:example.com",
    "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
  ], { stdio: "ignore" });
  state.ca = readFileSync(join(directory, "cert.pem"), "utf8");
  tlsServer = createHttpsServer({ key: readFileSync(join(directory, "key.pem")), cert: state.ca }, (req, res) => handler(req, res));
  await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
  const tlsAddress = tlsServer.address();
  if (!tlsAddress || typeof tlsAddress === "string") throw new Error("Missing TLS listener");
  tlsPort = tlsAddress.port;
  rawServer = createTcpServer((socket) => socket.once("data", () => { if (rawHold) socket.write(rawReply); else socket.end(rawReply); }));
  await new Promise<void>((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
  const rawAddress = rawServer.address();
  if (!rawAddress || typeof rawAddress === "string") throw new Error("Missing raw listener");
  rawPort = rawAddress.port;
});
beforeEach(() => {
  state.v4.mockReset().mockResolvedValue(["93.184.216.34"]);
  state.v6.mockReset().mockResolvedValue(["2606:4700:4700::1111"]);
  state.dispatches.length = 0;
  state.pins.length = 0;
  state.sockets.length = 0;
  state.port = port;
  state.holdLookup = false;
  state.lateLookup = undefined;
  rawHold = false;
  rawReply = "";
  received = [];
  handler = (_req, res) => res.end("hello");
});
afterEach(async () => {
  await Promise.all(transports.splice(0).map((item) => item.close()));
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await Promise.all([server, tlsServer, rawServer].map((item) => new Promise<void>((resolve) => item.close(() => resolve()))));
  rmSync(directory, { recursive: true });
});

describe("fresh all-answer resolution and pinned Node dispatch", () => {
  it("resolves both families, pins the actual lookup callback, and never reuses a connection", async () => {
    const broker = transport();
    const first = await broker.request(input);
    expect(first.status).toBe(200);
    expect(first.body.toString()).toBe("hello");
    state.v4.mockResolvedValue(["1.1.1.1"]);
    await broker.request(input);
    expect(state.v4).toHaveBeenCalledTimes(2);
    expect(state.v6).toHaveBeenCalledTimes(2);
    expect(state.pins).toEqual([{ address: "93.184.216.34", family: 4 }, { address: "1.1.1.1", family: 4 }]);
    expect(state.dispatches.every((options) => options.agent === false && options.family === 4)).toBe(true);
  });

  it("rejects public-to-private DNS rebinding within one transport and process", async () => {
    const broker = transport();
    await broker.request(input);
    state.v4.mockResolvedValue(["127.0.0.1"]);
    await expect(broker.request(input)).rejects.toMatchObject({ code: "unsafe_destination" });
    expect(state.dispatches).toHaveLength(1);
    expect(received).toHaveLength(1);
  });

  it.each([
    ["93.184.216.34", "10.0.0.1"], ["168.63.129.16"], ["169.254.169.254"],
    ["0.0.0.0"], ["198.18.0.1"], ["2130706433"], ["2606:4700::1111"], ["garbage"],
  ])("rejects unsafe/malformed/mixed A answers %j", async (...answers) => {
    state.v4.mockResolvedValue(answers);
    await expect(transport().request(input)).rejects.toMatchObject({ code: "unsafe_destination" });
    expect(state.dispatches).toHaveLength(0);
  });
  it.each([
    "::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "64:ff9b:1::1",
    "2002:0808:0808::1", "2001:20::1", "3fff::1", "fd00::1", "fe80::1%lo", "8.8.8.8",
  ])("rejects unsafe/malformed AAAA answer %s even with public A", async (address) => {
    state.v6.mockResolvedValue([address]);
    await expect(transport().request(input)).rejects.toMatchObject({ code: "unsafe_destination" });
    expect(state.dispatches).toHaveLength(0);
  });
  it("accepts only public IPv6, including literals, with the matching pinned family", async () => {
    state.v4.mockResolvedValue([]);
    await transport().request(input);
    expect(state.pins[0]).toEqual({ address: "2606:4700:4700::1111", family: 6 });
    state.v4.mockClear();
    state.v6.mockClear();
    await transport().request({ ...input, url: "http://[2606:4700:4700::1111]/docs" });
    expect(state.dispatches[1].hostname).toBe("2606:4700:4700::1111");
    expect(state.v4).not.toHaveBeenCalled();
    expect(state.v6).not.toHaveBeenCalled();
  });
  it("rejects empty/excessive answers and failure in either family", async () => {
    state.v4.mockResolvedValue([]);
    state.v6.mockResolvedValue([]);
    await expect(transport().request(input)).rejects.toMatchObject({ code: "unsafe_destination" });
    state.v4.mockResolvedValue(Array(33).fill("8.8.8.8"));
    await expect(transport().request(input)).rejects.toMatchObject({ code: "unsafe_destination" });
    state.v4.mockRejectedValue(new Error("private DNS configuration"));
    await expect(transport().request(input)).rejects.toMatchObject({ code: "dns_failure", message: "public_transport_dns_failure" });
    expect(state.dispatches).toHaveLength(0);
  });
  it("accepts ENODATA for one family, not generic DNS failures", async () => {
    state.v6.mockRejectedValue(Object.assign(new Error("no AAAA"), { code: "ENODATA" }));
    await expect(transport().request(input)).resolves.toHaveProperty("status", 200);
  });
});

describe("strict URL, immutable authorization and safe-method contract", () => {
  it.each([
    "http://127.1/", "http://2130706433/", "http://0177.0.0.1/", "http://0x7f000001/",
    "http://%65xample.com/", "http://localhost/", "http://localhost:3000/",
    "http://127.0.0.1/", "http://[::1]/", "http://[::ffff:808:808]/",
    "http://[64:ff9b::808:808]/", "http://example.com:81/", "http://example.com:080/",
    "http://user:password@example.com/", "http://example.com./", "http://example.com\\other/",
    "http://example.com/docs/%2e%2e/admin", "http://example.com/docs/%252fadmin",
    "http://example.com/docs/../admin", "http://example.com/?a=%0d%0aHost:evil",
    "http://example.com/?a=%", "http://example.com/#x", "http://example.com/\r\n",
  ])("rejects %s even in development", async (url) => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(transport().request({ ...input, url })).rejects.toBeInstanceOf(Error);
    expect(state.dispatches).toHaveLength(0);
  });
  it("preserves valid encoded query bytes, plus signs, order and duplicate keys", async () => {
    await transport().request({ ...input, url: "http://example.com/docs?q=a+b&q=%2f%3b%25&utf=%C3%A9" });
    expect(received[0].url).toBe("/docs?q=a+b&q=%2f%3b%25&utf=%C3%A9");
  });
  it.each(["POST", "PUT", "DELETE", "CONNECT", "TRACE", "get", "GET\r\nHost: evil"])("denies method %s", async (method) => {
    await expect(transport().request({ ...input, method })).rejects.toMatchObject({ code: "unsupported_method" });
    expect(state.v4).not.toHaveBeenCalled();
  });
  it("rejects even an empty supplied body", async () => {
    await expect(transport().request({ ...input, body: Buffer.alloc(0) })).rejects.toMatchObject({ code: "unsupported_body" });
  });
  it("supports HEAD and OPTIONS without inventing a body", async () => {
    handler = (_req, res) => { res.setHeader("content-length", "99999999"); res.end(); };
    const head = await transport().request({ ...input, method: "HEAD" });
    expect(head.body.length).toBe(0);
    expect(head.headers.some(([name]) => name === "content-length")).toBe(false);
    handler = (_req, res) => { res.statusCode = 204; res.end(); };
    const options = await transport().request({ ...input, method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.body.length).toBe(0);
  });
  it.each([205, 304, 404, 500])("preserves actual status %i without inventing HTTP success", async (status) => {
    handler = (_req, res) => { res.statusCode = status; res.end(status >= 400 ? "failure" : undefined); };
    const result = await transport().request(input);
    expect(result.status).toBe(status);
    expect(result.body.toString()).toBe(status >= 400 ? "failure" : "");
  });
  it("snapshots input/config and distinguishes navigation from explicitly authorized assets", async () => {
    const wait = deferred<string[]>();
    state.v4.mockReturnValue(wait.promise);
    const authorize = vi.fn((context: PublicRequestContext) => Object.isFrozen(context) && context.kind === "asset" && context.url === "http://example.com/docs");
    const options: Pick<PublicTransportOptions, "authorize"> & { limits: { -readonly [Key in keyof typeof PUBLIC_TRANSPORT_LIMITS]: number } } =
      { authorize, limits: { ...PUBLIC_TRANSPORT_LIMITS } };
    const broker = transport(options);
    const request: PublicTransportRequest = { ...input, kind: "asset", headers: [["accept", "text/css"]] };
    const pending = broker.request(request);
    request.url = "http://127.0.0.1/secret";
    request.headers = [["cookie", "app=secret"]];
    options.authorize = () => false;
    options.limits.requests = 0;
    wait.resolve(["8.8.8.8"]);
    await pending;
    expect(received[0].url).toBe("/docs");
    expect(received[0].headers.accept).toBe("text/css");
    expect(received[0].headers.cookie).toBeUndefined();
    await expect(broker.request(input)).rejects.toMatchObject({ code: "not_authorized" });
  });
});

describe("header provenance, response semantics and browser redirects", () => {
  it.each(["host", ":authority", "content-length", "transfer-encoding", "connection", "proxy-authorization",
    "proxy-connection", "upgrade", "te", "trailer", "x-bb-api-key", "x-api-key", "accept-encoding",
    "sec-websocket-key", "x-forwarded-host"])("rejects untrusted %s even with browser permission", async (name) => {
    await expect(transport({ authorizeBrowserHeaders: () => true }).request({ ...input, headers: [[name, "secret"]] }))
      .rejects.toMatchObject({ code: "unsupported_headers" });
    expect(state.dispatches).toHaveLength(0);
  });
  it.each<{ headers: [string, string][] }>([
    { headers: [["accept", "x\r\nCookie: stolen"]] }, { headers: [["accept", "x\0y"]] },
    { headers: [["accept", "x"], ["Accept", "y"]] }, { headers: [[" accept", "text/html"]] },
  ])("rejects injection and duplicates $headers", async ({ headers }) => {
    await expect(transport().request({ ...input, headers })).rejects.toMatchObject({ code: "unsupported_headers" });
  });
  it("never introduces environment credentials, proxies, app cookies or CORS overrides", async () => {
    vi.stubEnv("BROWSERBASE_API_KEY", "provider-secret");
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
    const result = await transport().request(input);
    expect(received[0].headers["accept-encoding"]).toBe("identity");
    expect(JSON.stringify(received)).not.toContain("provider-secret");
    expect(received[0].headers.cookie).toBeUndefined();
    expect(result.headers.some(([name]) => name.startsWith("access-control-"))).toBe(false);
  });
  it.each(["origin", "referer", "cookie", "authorization"])("rejects browser %s by default, never silently strips", async (name) => {
    const value = name === "origin" ? "https://example.com" : name === "referer" ? "https://example.com/docs" : "secret";
    await expect(transport().request({ ...input, headers: [[name, value]] })).rejects.toMatchObject({ code: "unsupported_headers" });
  });
  it("allows exact destination-bound browser headers only with explicit immutable policy", async () => {
    const headers: [string, string][] = [
      ["origin", "https://example.com"], ["referer", "https://example.com/docs?q=1"],
      ["cookie", "target=anonymous"], ["authorization", "Bearer target-token"],
    ];
    const policy = vi.fn((context: PublicRequestContext, fields: readonly (readonly [string, string])[]) =>
      context.url === input.url && Object.isFrozen(fields) && fields.every(Object.isFrozen));
    const broker = transport({ authorizeBrowserHeaders: policy });
    await broker.request({ ...input, headers });
    expect(policy).toHaveBeenCalledTimes(2);
    expect(received[0].headers.cookie).toBe("target=anonymous");
    await expect(broker.request({ ...input, url: "http://other.example.com/docs", headers }))
      .rejects.toMatchObject({ code: "unsupported_headers" });
    expect(received).toHaveLength(1);
  });
  it("rechecks sensitive header grants after awaiting DNS", async () => {
    const wait = deferred<string[]>();
    state.v4.mockReturnValue(wait.promise);
    let permitted = true;
    const broker = transport({ authorizeBrowserHeaders: () => permitted });
    const result = broker.request({ ...input, headers: [["cookie", "target=1"]] });
    permitted = false;
    wait.resolve(["8.8.8.8"]);
    await expect(result).rejects.toMatchObject({ code: "unsupported_headers" });
    expect(state.dispatches).toHaveLength(0);
  });
  it.each([
    ["origin", "null"], ["origin", "https://example.com/"], ["origin", "https://user@example.com"],
    ["origin", "https://example.com/path"], ["referer", "https://example.com/#secret"],
    ["referer", "https://user:secret@example.com/"], ["referer", "https://example.com/?x=%0a"],
  ])("rejects noncanonical browser header %s=%s", async (name, value) => {
    await expect(transport({ authorizeBrowserHeaders: () => true }).request({ ...input, headers: [[name, value]] }))
      .rejects.toBeInstanceOf(Error);
    expect(state.dispatches).toHaveLength(0);
  });
  it("preserves MIME, CSP, CORS and repeated Set-Cookie, strips framing, and sets byte-exact length", async () => {
    handler = (_req, res) => {
      res.setHeader("set-cookie", ["a=1; Secure; HttpOnly", "b=2; SameSite=Lax"]);
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("content-security-policy", "default-src 'none'");
      res.setHeader("access-control-allow-origin", "https://example.com");
      res.write("he");
      res.end("llo");
    };
    const response = await transport().request(input);
    expect(response.headers.filter(([name]) => name === "set-cookie")).toHaveLength(2);
    expect(response.headers).toContainEqual(["content-security-policy", "default-src 'none'"]);
    expect(response.headers).toContainEqual(["content-type", "text/html; charset=utf-8"]);
    expect(response.headers).toContainEqual(["access-control-allow-origin", "https://example.com"]);
    expect(response.headers).toContainEqual(["content-length", "5"]);
    expect(response.headers.some(([name]) => ["connection", "transfer-encoding", "keep-alive"].includes(name))).toBe(false);
  });
  it("returns a validated redirect without following or reusing credentials; next hop must be authorized again", async () => {
    handler = (_req, res) => { res.writeHead(302, { location: "http://assets.example.com/file?x=%2f" }); res.end(); };
    const authorize = vi.fn(() => true);
    const broker = transport({ authorize, authorizeBrowserHeaders: (context) => context.url === input.url });
    const result = await broker.request({ ...input, headers: [["cookie", "target=1"]] });
    expect(result.redirectUrl).toBe("http://assets.example.com/file?x=%2f");
    expect(result.url).toBe(input.url);
    expect(state.dispatches).toHaveLength(1);
    expect(state.v4).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ redirectFrom: input.url, url: result.redirectUrl }));
    await expect(broker.request({ ...input, url: result.redirectUrl!, headers: [["cookie", "target=1"]] }))
      .rejects.toMatchObject({ code: "unsupported_headers" });
    state.v4.mockResolvedValue(["127.0.0.1"]);
    await expect(broker.request({ ...input, url: result.redirectUrl! })).rejects.toMatchObject({ code: "unsafe_destination" });
    expect(state.dispatches).toHaveLength(1);
  });
  it.each([
    "http://127.0.0.1/", "//127.1/", "http://0x7f000001/", "/docs/../private",
    "/docs/%2e%2e/private", "%2e%2e/private", "http://example.com:080/",
    "http://user:password@example.com/", "http://example.com/?x=%0d", "file:///etc/passwd",
  ])("does not return unsafe redirect %s as success", async (location) => {
    handler = (_req, res) => { res.writeHead(302, { location }); res.end(); };
    await expect(transport().request(input)).rejects.toBeInstanceOf(Error);
    expect(state.dispatches).toHaveLength(1);
  });
  it("denies redirect scope escape and counts loops across the instance", async () => {
    handler = (_req, res) => { res.writeHead(302, { location: "/other" }); res.end(); };
    await expect(transport({ authorize: (context) => context.url === input.url }).request(input))
      .rejects.toMatchObject({ code: "not_authorized" });
    const broker = transport({ limits: { ...PUBLIC_TRANSPORT_LIMITS, redirects: 1 } });
    await broker.request(input);
    await expect(broker.request(input)).rejects.toMatchObject({ code: "redirect_limit" });
  });
});

describe("real owned TLS and hostile response framing", () => {
  it("uses hostname SNI, verifies certificates even with NODE_TLS_REJECT_UNAUTHORIZED=0", async () => {
    state.port = tlsPort;
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    let sni = "";
    tlsServer.once("secureConnection", (socket) => { if ("servername" in socket) sni = String(socket.servername); });
    await transport().request({ ...input, url: "https://example.com/docs" });
    expect(sni).toBe("example.com");
    expect(state.dispatches[0].rejectUnauthorized).toBe(true);
    await expect(transport().request({ ...input, url: "https://wrong.example.com/docs" }))
      .rejects.toMatchObject({ code: "network_failure" });
    await expect(transport().request({ ...input, url: "https://8.8.8.8/docs" }))
      .rejects.toMatchObject({ code: "network_failure" });
    expect(state.dispatches[2].servername).toBe("");
  });
  it("rejects HTTPS downgrade instead of following it", async () => {
    state.port = tlsPort;
    handler = (_req, res) => { res.writeHead(302, { location: "http://example.com/docs" }); res.end(); };
    await expect(transport().request({ ...input, url: "https://example.com/docs" }))
      .rejects.toMatchObject({ code: "unsafe_destination" });
    expect(state.dispatches).toHaveLength(1);
  });
  it.each([
    "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\n\r\nxx",
    "HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nshort",
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nxx",
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nabc",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\nX-Trailer: secret\r\n\r\n",
    "HTTP/1.1 200 OK\r\nConnection: content-security-policy\r\nContent-Security-Policy: default-src 'none'\r\nContent-Length: 0\r\n\r\n",
    "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    "HTTP/1.1 103 Early Hints\r\nLink: </asset>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
    "HTTP/1.1 302 Found\r\nContent-Length: 0\r\n\r\n",
    "HTTP/1.1 305 Use Proxy\r\nLocation: http://example.com/\r\nContent-Length: 0\r\n\r\n",
    "HTTP/1.1 204 No Content\r\nContent-Length: 12\r\n\r\n",
  ])("rejects truncated/unsupported/raw response %#", async (reply) => {
    state.port = rawPort;
    rawReply = reply;
    await expect(transport().request(input)).rejects.toBeInstanceOf(Error);
  });
  it("enforces declared and streamed sizes without promoting a partial body to success", async () => {
    const limits = { ...PUBLIC_TRANSPORT_LIMITS, responseBytes: 4 };
    await expect(transport({ limits }).request(input)).rejects.toMatchObject({ code: "byte_limit" });
    handler = (_req, res) => { res.write("123"); res.end("45"); };
    await expect(transport({ limits }).request(input)).rejects.toMatchObject({ code: "byte_limit" });
    handler = (_req, res) => { res.setHeader("x-long", "x".repeat(2048)); res.end(); };
    await expect(transport({ limits: { ...limits, headerBytes: 1024 } }).request(input)).rejects.toMatchObject({ code: "network_failure" });
  });
  it("bounds a real connected TLS socket with a stalled handshake and never retries", async () => {
    state.port = rawPort;
    rawHold = true;
    await expect(transport({ limits: { ...PUBLIC_TRANSPORT_LIMITS, requestMs: 50 } })
      .request({ ...input, url: "https://example.com/docs" })).rejects.toMatchObject({ code: "request_timeout" });
    expect(state.dispatches).toHaveLength(1);
  });
});

describe("job budgets, cancellation, close/drain and late callbacks", () => {
  it("counts denied and concurrency-rejected attempts and serializes budget reservations", async () => {
    const wait = deferred<string[]>();
    state.v4.mockReturnValue(wait.promise);
    const broker = transport({ limits: { ...PUBLIC_TRANSPORT_LIMITS, requests: 3, concurrency: 1 } });
    await expect(broker.request({ ...input, method: "POST" })).rejects.toMatchObject({ code: "unsupported_method" });
    const first = broker.request(input);
    await expect(broker.request(input)).rejects.toMatchObject({ code: "concurrency_limit" });
    await expect(broker.request(input)).rejects.toMatchObject({ code: "request_limit" });
    wait.resolve(["8.8.8.8"]);
    await first;
    expect(state.dispatches).toHaveLength(1);
  });
  it("enforces aggregate bytes across parallel responses, including failed operations", async () => {
    handler = (_req, res) => res.end(Buffer.alloc(800, "x"));
    const broker = transport({ limits: { ...PUBLIC_TRANSPORT_LIMITS, totalBytes: 1500 } });
    const results = await Promise.allSettled([broker.request(input), broker.request(input)]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBeLessThanOrEqual(1);
    expect(results.some((result) => result.status === "rejected" && result.reason.code === "byte_limit")).toBe(true);
    await expect(broker.request(input)).rejects.toMatchObject({ code: "byte_limit" });
  });
  it("charges rejected response headers before semantic validation and fences later requests", async () => {
    handler = (_req, res) => {
      res.setHeader("x-padding", "x".repeat(2000));
      res.setHeader("content-encoding", "gzip");
      res.end();
    };
    const broker = transport({ limits: { ...PUBLIC_TRANSPORT_LIMITS, totalBytes: 3000 } });
    await expect(broker.request(input)).rejects.toMatchObject({ code: "unsupported_response" });
    await expect(broker.request(input)).rejects.toMatchObject({ code: "byte_limit" });
    await expect(broker.request(input)).rejects.toMatchObject({ code: "byte_limit" });
    expect(state.dispatches).toHaveLength(2);
  });
  it("charges parser-rejected bytes that have no response callback exactly once", async () => {
    state.port = rawPort;
    rawReply = `HTTP/1.1 200 OK\r\nX-Long: ${"x".repeat(2048)}\r\n\r\n`;
    const broker = transport({ limits: { ...PUBLIC_TRANSPORT_LIMITS, headerBytes: 1024, totalBytes: 3000 } });
    await expect(broker.request(input)).rejects.toMatchObject({ code: "network_failure" });
    await expect(broker.request(input)).rejects.toMatchObject({ code: "byte_limit" });
    await expect(broker.request(input)).rejects.toMatchObject({ code: "byte_limit" });
    expect(state.dispatches).toHaveLength(2);
  });
  it.each(["trailers", "eof", "timeout", "cancel"] as const)("charges rejected %s bytes before failure and fences subsequent requests", async (mode) => {
    state.port = rawPort;
    const incomplete = `HTTP/1.1 200 OK\r\nX-Padding: ${"x".repeat(2000)}`;
    rawReply = mode === "trailers"
      ? `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-Padding: ${"x".repeat(2000)}\r\n\r\n`
      : incomplete;
    rawHold = mode === "timeout" || mode === "cancel";
    const broker = transport({ limits: { ...PUBLIC_TRANSPORT_LIMITS, headerBytes: 4096, totalBytes: 3000, requestMs: 100 } });
    const cancel = new AbortController();
    const first = broker.request({ ...input, signal: cancel.signal });
    const failed = expect(first).rejects.toMatchObject({
      code: mode === "trailers" ? "unsupported_response" : mode === "timeout" ? "request_timeout" : mode === "cancel" ? "aborted" : "network_failure",
    });
    if (mode === "cancel") {
      await until(() => (state.sockets[0]?.bytesRead ?? 0) >= Buffer.byteLength(rawReply));
      cancel.abort();
    }
    await failed;
    await expect(broker.request(input)).rejects.toMatchObject({ code: "byte_limit" });
    await expect(broker.request(input)).rejects.toMatchObject({ code: "byte_limit" });
    expect(state.dispatches).toHaveLength(2);
  });
  it("does not double-charge valid response headers or body", async () => {
    state.port = rawPort;
    rawReply = "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n" + "x".repeat(1000);
    const broker = transport({ limits: { ...PUBLIC_TRANSPORT_LIMITS, totalBytes: 1500 } });
    expect((await broker.request(input)).body.length).toBe(1000);
  });
  it("charges actual decrypted TLS data to the same terminal aggregate limit", async () => {
    state.port = tlsPort;
    handler = (_req, res) => res.end("x".repeat(1000));
    const broker = transport({ limits: { ...PUBLIC_TRANSPORT_LIMITS, totalBytes: 900 } });
    await expect(broker.request({ ...input, url: "https://example.com/docs" })).rejects.toMatchObject({ code: "byte_limit" });
    await expect(broker.request(input)).rejects.toMatchObject({ code: "byte_limit" });
    expect(state.dispatches).toHaveLength(1);
  });
  it.each(["authorize", "assertActive", "authorizeBrowserHeaders"] as const)("reserves concurrency before synchronous %s reentry", async (callback) => {
    let nested: Promise<unknown> | undefined;
    let entered = false;
    const reenter = () => {
      if (!entered) {
        entered = true;
        nested = broker.request(input).then(() => "unexpected success", (error) => error.code);
      }
      return true;
    };
    const broker = transport({
      limits: { ...PUBLIC_TRANSPORT_LIMITS, concurrency: 1 },
      [callback]: reenter,
    });
    await broker.request({ ...input, ...(callback === "authorizeBrowserHeaders" ? { headers: [["cookie", "target=1"] as const] } : {}) });
    expect(await nested).toBe("concurrency_limit");
    expect(state.dispatches).toHaveLength(1);
  });
  it.each(["abort", "close", "revoke", "request-abort", "timeout"] as const)("fences %s during DNS and late resolution", async (mode) => {
    const wait = deferred<string[]>();
    state.v4.mockReturnValue(wait.promise);
    const controller = new AbortController();
    const requestController = new AbortController();
    let live = true;
    const broker = transport({
      signal: controller.signal, assertActive: () => { if (!live) throw new Error("secret lease"); },
      limits: { ...PUBLIC_TRANSPORT_LIMITS, dnsMs: mode === "timeout" ? 15 : 2000 },
    });
    const result = broker.request({ ...input, signal: requestController.signal });
    const rejected = expect(result).rejects.toMatchObject({
      code: mode === "close" ? "closed" : mode === "revoke" ? "lease_revoked" : mode === "timeout" ? "dns_timeout" : "aborted",
    });
    if (mode === "abort") controller.abort(new Error("secret reason"));
    if (mode === "request-abort") requestController.abort();
    if (mode === "close") await broker.close();
    if (mode === "revoke") live = false;
    await rejected;
    wait.resolve(["8.8.8.8"]);
    await broker.drain();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(state.dispatches).toHaveLength(0);
    expect(state.cancel).toHaveBeenCalled();
  });
  it("prevents connect after a late Node lookup callback following close", async () => {
    state.holdLookup = true;
    const broker = transport();
    const pending = broker.request(input);
    const rejected = expect(pending).rejects.toMatchObject({ code: "closed" });
    await until(() => state.lateLookup !== undefined);
    await broker.close();
    state.lateLookup!();
    await rejected;
    expect(received).toHaveLength(0);
    expect(state.pins).toHaveLength(0);
  });
  it("cancels the redirect DNS check after the first socket has drained", async () => {
    handler = (_req, res) => { res.writeHead(302, { location: "/next" }); res.end(); };
    const wait = deferred<string[]>();
    state.v4.mockResolvedValueOnce(["8.8.8.8"]).mockReturnValueOnce(wait.promise);
    const broker = transport();
    const result = broker.request(input);
    const rejected = expect(result).rejects.toMatchObject({ code: "closed" });
    await until(() => state.v4.mock.calls.length === 2);
    await broker.close();
    await rejected;
    wait.resolve(["8.8.8.8"]);
    expect(state.dispatches).toHaveLength(1);
  });
  it.each(["abort", "close", "revoke", "timeout"] as const)("drains a stalled read on %s without successful truncation", async (mode) => {
    handler = (_req, res) => { res.writeHead(200); res.write("prefix"); };
    const controller = new AbortController();
    let live = true;
    const broker = transport({
      signal: controller.signal, assertActive: () => { if (!live) throw new Error("private lease"); },
      limits: { ...PUBLIC_TRANSPORT_LIMITS, requestMs: mode === "timeout" ? 100 : 2000 },
    });
    const pending = broker.request(input);
    const rejected = expect(pending).rejects.toMatchObject({
      code: mode === "close" ? "closed" : mode === "revoke" ? "lease_revoked" : mode === "timeout" ? "request_timeout" : "aborted",
    });
    await until(() => received.length === 1);
    if (mode === "close") await broker.close();
    if (mode === "abort") controller.abort();
    if (mode === "revoke") live = false;
    await rejected;
    await broker.drain();
    if (mode !== "timeout") await expect(broker.request(input)).rejects.toMatchObject({ code: mode === "revoke" ? "lease_revoked" : mode === "close" ? "closed" : "aborted" });
  });
  it("bounds the whole instance duration and fails closed before dispatch on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(transport({ signal: controller.signal }).request(input)).rejects.toMatchObject({ code: "aborted" });
    const broker = transport({ limits: { ...PUBLIC_TRANSPORT_LIMITS, durationMs: 10 } });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await expect(broker.request(input)).rejects.toMatchObject({ code: "duration_limit" });
    expect(state.dispatches).toHaveLength(0);
  });
  it("observes cancellation delivered synchronously inside a guard or authorization callback", async () => {
    const controller = new AbortController();
    const broker = transport({ signal: controller.signal, assertActive: () => controller.abort() });
    await expect(broker.request(input)).rejects.toMatchObject({ code: "aborted" });
    const local = new AbortController();
    await expect(transport({ authorize: () => { local.abort(); return true; } })
      .request({ ...input, signal: local.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(state.dispatches).toHaveLength(0);
  });
  it.each([0, -1, Infinity, NaN, 1.5, 257])("rejects unsafe request budget %s", (requests) => {
    expect(() => transport({ limits: { ...PUBLIC_TRANSPORT_LIMITS, requests } })).toThrow("invalid_configuration");
  });
});
