import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium, type BrowserContext, type Worker } from "playwright-core";
import { createServer, type Server } from "node:http";
import { createServer as tlsServer } from "node:https";
import { connect as tcpConnect } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import type { RequestOptions } from "node:https";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { z } from "zod";
import { buildComposedExtension } from "../../src/server/execution/composed-extension";
import { installPublicNetwork } from "../../src/server/execution/public-network";
import { publicExecutionPolicy } from "../../src/server/execution/public-policy";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../../src/lib/public-execution";
import type { PublicTransportRequest, PublicTransportOptions } from "../../src/server/execution/public-transport";
import { attachCdpTarget } from "../../src/server/execution/cdp-target";
import { connectNativeWorkerControl, type NativeWorkerControl } from "../../src/server/execution/native-worker-control";
import { browserbase, Stagehand } from "@browserbasehq/stagehand";
import { createNativeSdkTransportMonitor } from "../../src/server/execution/native-sdk-transport";
import { establishNativePolicy } from "../../src/server/execution/native-policy-session";
import { NATIVE_TELEMETRY_ENDPOINT } from "../../src/server/execution/native-telemetry";

const mock = vi.hoisted(() => ({
  requests: new Array<PublicTransportRequest>(),
  responses: new Map<string, { status: number; body: string; headers: [string, string][] }>(),
  gatewayCookies: new Array<string | undefined>(),
  gatewayPort: 0,
  gatewayCalls: vi.fn<(options: RequestOptions) => void>(),
}));
vi.mock("node:https", async (original) => {
  const actual = await original<typeof import("node:https")>();
  const http = await vi.importActual<typeof import("node:http")>("node:http");
  return {
    ...actual,
    request(options: RequestOptions) {
      if (!mock.gatewayPort) throw new Error("unconfigured_owned_gateway");
      expect(options).toMatchObject({
        protocol: "https:", hostname: "api.stagehand.browserbase.com", port: 443,
        path: "/v1/llm/responses", method: "POST", agent: false,
        rejectUnauthorized: true, servername: "api.stagehand.browserbase.com",
      });
      mock.gatewayCalls(options);
      return http.request({ ...options, protocol: "http:", hostname: "127.0.0.1", port: mock.gatewayPort });
    },
  };
});
vi.mock("../../src/server/execution/cdp-target", async (original) => {
  const actual = await original<typeof import("../../src/server/execution/cdp-target")>();
  return {
    ...actual,
    attachCdpTarget(...[root, targetId, onEvent]: Parameters<typeof actual.attachCdpTarget>) {
      return actual.attachCdpTarget(root, targetId, (method, value) => {
        if (method === "Fetch.requestPaused") {
          const event = z.object({ request: z.object({ url: z.string(), headers: z.record(z.string(), z.string()) }) }).safeParse(value);
          if (event.success && event.data.request.url === "https://api.stagehand.browserbase.com/v1/llm/responses") {
            mock.gatewayCookies.push(Object.entries(event.data.request.headers).find(([key]) => key.toLowerCase() === "cookie")?.[1]);
          }
        }
        onEvent(method, value);
      });
    },
  };
});
vi.mock("../../src/server/execution/public-transport", async (original) => {
  const actual = await original<typeof import("../../src/server/execution/public-transport")>();
  return {
    ...actual,
    createPublicTransport(options: PublicTransportOptions) {
      return {
        async request(request: PublicTransportRequest) {
          options.assertActive();
          const method = request.method === "GET" ? "GET" : request.method === "HEAD" ? "HEAD" : "OPTIONS";
          const context = { url: request.url, method, kind: request.kind } as const;
          if (!options.authorize(context)) throw new actual.PublicTransportError("not_authorized");
          const sensitive = request.headers?.filter(([name]) => ["cookie", "origin", "referer", "authorization"].includes(name)) ?? [];
          if (sensitive.length && !options.authorizeBrowserHeaders?.(context, sensitive)) {
            throw new actual.PublicTransportError("unsupported_headers");
          }
          mock.requests.push(request);
          const response = mock.responses.get(request.url);
          if (!response) throw new actual.PublicTransportError("network_failure");
          const location = response.headers.find(([name]) => name === "location")?.[1];
          const redirectUrl = location ? new URL(location, request.url).href : undefined;
          if (redirectUrl && !options.authorize({ ...context, url: redirectUrl, redirectFrom: request.url })) {
            throw new actual.PublicTransportError("not_authorized");
          }
          return { url: request.url, ...response, body: Buffer.from(response.body), redirectUrl };
        },
        async close() {}, async drain() {},
      };
    },
  };
});

let directory: string;
let context: BrowserContext;
let worker: Worker;
let control: NativeWorkerControl | undefined;
let network: Awaited<ReturnType<typeof installPublicNetwork>> | undefined;
let server: Server | undefined;
const origin = "https://routing-fixture.example.com";
const gateway = "https://api.stagehand.browserbase.com/v1/llm/responses";
beforeEach(async ({ task }) => {
  mock.requests.length = 0;
  mock.responses.clear();
  mock.gatewayCookies.length = 0;
  mock.gatewayPort = 0;
  mock.gatewayCalls.mockClear();
  directory = await mkdtemp(join(tmpdir(), "ff-routing-"));
  const certificateArgs: string[] = [];
  if (task.name.startsWith("composes the production isolated WSS")) {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=owned-sdk",
      "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
    ], { stdio: "ignore" });
    const publicKey = execFileSync("openssl", ["x509", "-in", join(directory, "cert.pem"), "-pubkey", "-noout"]);
    const spki = execFileSync("openssl", ["pkey", "-pubin", "-outform", "DER"], { input: publicKey });
    // Trust only this ephemeral owned WSS fixture certificate in local Chromium.
    certificateArgs.push(`--ignore-certificate-errors-spki-list=${createHash("sha256").update(spki).digest("base64")}`);
  }
  const extension = join(directory, "extension");
  const bundle = await buildComposedExtension();
  for (const [name, bytes] of bundle.files) {
    const path = join(extension, name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 });
  }
  context = await chromium.launchPersistentContext(join(directory, "profile"), {
    channel: "chromium", headless: true,
    args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
      "--remote-debugging-port=0", "--remote-allow-origins=*",
      ...certificateArgs,
    ],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const lifecycle = await context.newCDPSession(context.pages()[0]);
  const versions: { running: string; status: string }[] = [];
  lifecycle.on("ServiceWorker.workerVersionUpdated", (event) => {
    for (const version of event.versions) if (version.scriptURL === worker.url() && versions.length < 16) {
      versions.push({ running: version.runningStatus, status: version.status });
    }
  });
  await lifecycle.send("ServiceWorker.enable");
  try {
    control = await connectNativeWorkerControl({ context, workerUrl: worker.url(), assertActive() {} });
    await vi.waitFor(() => expect(versions.some((version) => version.running === "running" && version.status === "activated")).toBe(true));
  } finally {
    await lifecycle.detach();
  }
  expect(await control.snapshot()).toMatchObject({ phase: "bootstrap" });
  await control.verifyFiles(bundle.files);
});
afterEach(async () => {
  try { await network?.close(); }
  finally {
    network = undefined;
    await context?.close();
    await control?.close();
    control = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
async function install(onFatal: () => void = () => {}, verifyActive: () => Promise<void> = async () => {}) {
  const policy = publicExecutionPolicy({
    executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY,
    scope: { targetUrl: `${origin}/category/start`, pathPrefixes: ["/category"], allowedSubdomains: [] },
  });
  const page = context.pages()[0];
  network = await installPublicNetwork({
    context, page, extensionOrigin: worker.url().slice(0, -"/service-worker.js".length),
    authorize: policy.authorize, assertActive() {}, verifyActive,
    signal: new AbortController().signal, onSignal() {}, onFatal, onGatewayDispatch() {},
  });
  return page;
}
function respond(path: string, body: string, headers: [string, string][] = [], status = 200) {
  mock.responses.set(path.startsWith("https:") ? path : origin + path, {
    status, body, headers: [["content-type", "text/html"], ...headers],
  });
}
async function trustedWorkerExpression(expression: string, targetUrl = worker.url(), targetType = "service_worker") {
  const root = await context.browser()!.newBrowserCDPSession();
  const infos = (await root.send("Target.getTargets")).targetInfos.filter((entry) =>
    entry.type === targetType && entry.url === targetUrl);
  expect(infos).toHaveLength(1);
  const target = await attachCdpTarget(root, infos[0].targetId, () => {});
  try {
    await target.send("Runtime.enable");
    const result = z.object({
      result: z.object({ value: z.unknown() }), exceptionDetails: z.unknown().optional(),
    }).parse(await target.send("Runtime.evaluate", {
      expression,
      awaitPromise: true, returnByValue: true,
    }));
    expect(result.exceptionDetails).toBeUndefined();
    return result.result.value;
  } finally { await target.close(); await root.detach(); }
}
function trustedWorkerPost(body: string, headers: Record<string, string>) {
  return trustedWorkerExpression(`fetch(${JSON.stringify(gateway)},${JSON.stringify({ method: "POST", body, headers, credentials: "include" })}).then(response=>response.json())`);
}
async function ownedGateway(owned: string) {
  const url = new URL(owned);
  expect(url.protocol).toBe("http:");
  expect(url.hostname).toBe("127.0.0.1");
  mock.gatewayPort = Number(url.port);
  return mock.gatewayCalls;
}

describe("actual CDP routing with synthetic broker responses, not public-site acceptance", () => {
  it("rejects SDK telemetry locally with 403 without exporting, spending model budget or failing the goal", async () => {
    await install();
    const result = await trustedWorkerExpression(`fetch(${JSON.stringify(NATIVE_TELEMETRY_ENDPOINT)}, {
      method: "POST", body: "private trace bytes"
    }).then(async response => ({ status: response.status, body: await response.text() }))`);
    expect(result).toEqual({ status: 403, body: "Native SDK telemetry export is disabled by policy." });
    expect(network!.blockedTelemetryRequests).toBe(1);
    expect(network!.errors).toEqual([]);
    expect(mock.requests).toEqual([]);
    expect(mock.gatewayCalls).not.toHaveBeenCalled();
  });

  it("does not apply the nonfatal export denial to page or offscreen initiators", async () => {
    const page = await install();
    expect(await page.evaluate((url) => fetch(url, { method: "POST", body: "not a trusted exporter" })
      .then(() => "unexpected", () => "denied"), NATIVE_TELEMETRY_ENDPOINT)).toBe("denied");
    expect(await trustedWorkerExpression(
      `fetch(${JSON.stringify(NATIVE_TELEMETRY_ENDPOINT)}, { method: "POST", body: "not the exporter" })
        .then(() => "unexpected", () => "denied")`,
      `${worker.url().slice(0, -"/service-worker.js".length)}/offscreen/service-worker-heartbeat.html`, "background_page",
    )).toBe("denied");
    expect(network!.blockedTelemetryRequests).toBe(0);
    expect(network!.errors).toContain("gateway_control_failed");
    expect(mock.requests).toEqual([]);
    expect(mock.gatewayCalls).not.toHaveBeenCalled();
  });

  it("requires the exact telemetry destination and POST method", async () => {
    await install();
    for (const [url, method] of [
      [`${NATIVE_TELEMETRY_ENDPOINT}?redirect=other`, "POST"],
      [`${NATIVE_TELEMETRY_ENDPOINT}/`, "POST"],
      [NATIVE_TELEMETRY_ENDPOINT.replace("https:", "http:"), "POST"],
      [NATIVE_TELEMETRY_ENDPOINT, "GET"],
    ]) {
      expect(await trustedWorkerExpression(`fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)} })
        .then(() => "unexpected", () => "denied")`)).toBe("denied");
    }
    expect(network!.blockedTelemetryRequests).toBe(0);
    expect(network!.errors).toEqual(Array(4).fill("gateway_control_failed"));
    expect(mock.requests).toEqual([]);
    expect(mock.gatewayCalls).not.toHaveBeenCalled();
  });

  it("fences export denial on native verification failure", async () => {
    const verify = vi.fn(async () => {});
    await install(() => {}, verify);
    verify.mockRejectedValueOnce(new Error("native policy no longer active"));
    expect(await trustedWorkerExpression(`fetch(${JSON.stringify(NATIVE_TELEMETRY_ENDPOINT)}, { method: "POST" })
      .then(() => "unexpected", () => "denied")`)).toBe("denied");
    expect(network!.blockedTelemetryRequests).toBe(0);
    expect(network!.errors).toEqual(["gateway_control_failed"]);
    expect(mock.gatewayCalls).not.toHaveBeenCalled();
  });

  it("caps even locally denied telemetry requests instead of permitting an unbounded extension loop", async () => {
    const fatal = vi.fn();
    await install(fatal);
    const statuses = await trustedWorkerExpression(`(async () => {
      const statuses = [];
      for (let count = 0; count < 129; count++) {
        statuses.push(await fetch(${JSON.stringify(NATIVE_TELEMETRY_ENDPOINT)}, { method: "POST" })
          .then(response => response.status, () => "denied"));
      }
      return statuses;
    })()`);
    expect(statuses).toEqual([...Array(128).fill(403), "denied"]);
    expect(fatal).toHaveBeenCalledOnce();
    expect(network!.errors).toContain("native_telemetry_limit");
    expect(mock.requests).toEqual([]);
    expect(mock.gatewayCalls).not.toHaveBeenCalled();
  });

  it("composes the production isolated WSS SDK, native attestation and exact one-key Gateway without provider traffic", async () => {
    const [cdpPort, cdpPath] = (await readFile(join(directory, "profile", "DevToolsActivePort"), "utf8")).trim().split("\n");
    const tunnel = tlsServer({ key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) });
    const sockets = new Set<Duplex>();
    tunnel.on("upgrade", (request, downstream, head) => {
      if (request.url !== cdpPath) { downstream.destroy(); return; }
      const upstream = tcpConnect({ host: "127.0.0.1", port: Number(cdpPort) });
      for (const socket of [downstream, upstream]) {
        sockets.add(socket);
        socket.once("close", () => { sockets.delete(socket); downstream.destroy(); upstream.destroy(); });
        socket.on("error", () => { downstream.destroy(); upstream.destroy(); });
      }
      upstream.once("connect", () => {
        const headers = Object.entries(request.headers).flatMap(([name, value]) =>
          name === "host" ? [`host: 127.0.0.1:${cdpPort}`] : typeof value === "string" ? [`${name}: ${value}`] : []);
        upstream.write(`GET ${cdpPath} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
        if (head.length) upstream.write(head);
        downstream.pipe(upstream); upstream.pipe(downstream);
      });
    });
    await new Promise<void>((resolve) => tunnel.listen(0, "127.0.0.1", resolve));
    const address = tunnel.address();
    if (!address || typeof address === "string") throw new Error("owned_tls_address_unavailable");
    const endpoint = `wss://127.0.0.1:${address.port}${cdpPath}`;
    const target = `${origin}/category/start`;
    const child = spawn(process.execPath, [
      "--conditions=react-server", "--require", resolve("tests/native-sdk-offline-guard.cjs"),
      "--import", "tsx", resolve("tests/native-sdk-runner.ts"), endpoint, "extract", target, worker.url().split("/")[2],
    ], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { NODE_ENV: "test", PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: join(directory, "cert.pem"), TSX_DISABLE_CACHE: "1" },
    });
    let output = "";
    child.stdout!.on("data", (chunk) => { output += chunk; });
    child.stderr!.on("data", (chunk) => { output += chunk; });
    const exited = once(child, "exit");
    let native: Awaited<ReturnType<typeof establishNativePolicy>> | undefined;
    const requests: { key: unknown; session: unknown }[] = [];
    try {
      expect((await once(child, "message"))[0]).toBe("ready");
      native = await establishNativePolicy({ context, worker, files: (await buildComposedExtension()).files, assertActive() {} });
      const decision = { action: "give_up", candidateId: null, value: null, commentary: "Owned fixture heading read." };
      server = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          requests.push({ key: request.headers["x-bb-api-key"], session: request.headers["x-bb-session-id"] });
          const output = requests.length === 1 ? decision : { progress: "Owned synthetic extraction complete", completed: true };
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            id: "resp_owned", object: "response", created_at: 1, status: "completed",
            model: "google/gemini-2.5-flash", output: [{
              id: "msg_owned", type: "message", role: "assistant", status: "completed",
              content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }],
            }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }));
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      await ownedGateway(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      respond("/category/start", "<h1>Owned isolated SDK Gateway fixture</h1>");
      respond("/favicon.ico", "", [], 204);
      const page = await install(() => {}, native.verify);
      await page.goto(target);
      const receipt = once(child, "message");
      child.send("extract");
      expect((await receipt)[0]).toMatchObject({
        result: decision, metrics: { totalPromptTokens: 20, totalCompletionTokens: 10 },
      });
      expect(requests).toHaveLength(2);
      expect(requests.every(({ key, session }) => key === "owned-offline-key" && session === "b32aa54d-748b-4c60-89e8-a0b115309a16")).toBe(true);
      expect(network!.errors).toEqual([]);
      await native.verify();
      await context.close();
      const closed = once(child, "message");
      child.send("close");
      expect((await closed)[0]).toMatchObject({ settled: true, rejected: false });
      expect(await exited).toEqual([0, null]);
      expect(output).toBe("");
      expect(sockets.size).toBe(0);
    } finally {
      if (child.exitCode === null) { child.kill("SIGKILL"); await exited; }
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => tunnel.close(() => resolve()));
      await native?.close();
    }
  }, 45000);

  it("routes actual browserbase-adapter SDK extraction through the original one-key Gateway session metadata", async () => {
    const [port, path] = (await readFile(join(directory, "profile", "DevToolsActivePort"), "utf8")).trim().split("\n");
    const cdpUrl = `ws://127.0.0.1:${port}${path}`;
    const sessionId = "c812d498-7f8d-4548-bc81-845cb2a5ecc9";
    const apiKey = "owned-offline-sdk-key";
    const metadataRequests: string[] = [];
    // Synthetic local Chromium has no provider session. This exact record tests
    // SDK metadata propagation, not hosted allocation or the production WSS gate.
    const metadata = createServer((request, response) => {
      metadataRequests.push(`${request.method} ${request.url}`);
      if (request.method !== "GET" || request.url !== `/v1/sessions/${sessionId}`
        || request.headers["x-bb-api-key"] !== apiKey || metadataRequests.length !== 1) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: sessionId, connectUrl: cdpUrl, region: "us-west-2" }));
    });
    await new Promise<void>((resolve) => metadata.listen(0, "127.0.0.1", resolve));
    const address = metadata.address();
    if (!address || typeof address === "string") throw new Error("owned_metadata_address_unavailable");
    const monitor = createNativeSdkTransportMonitor(cdpUrl);
    let stagehand: Stagehand | undefined;
    const requests: { key?: string; session?: string; body: unknown }[] = [];
    try {
      const browser = await monitor.run(() => browserbase.connect({
        apiKey, sessionId, baseUrl: `http://127.0.0.1:${address.port}`,
        extensionId: worker.url().split("/")[2],
      }));
      stagehand = await monitor.run(() => Stagehand.create({
        browser, apiKey, model: { modelName: "openai/gpt-4.1-mini" },
        telemetry: { traces: { endpoint: NATIVE_TELEMETRY_ENDPOINT } },
        cache: false, selfHeal: false, logging: { level: "off" },
      }));
      await new Promise<void>((resolve, reject) => metadata.close((error) => error ? reject(error) : resolve()));
      server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => { chunks.push(chunk); });
        request.on("end", () => {
          requests.push({
            key: typeof request.headers["x-bb-api-key"] === "string" ? request.headers["x-bb-api-key"] : undefined,
            session: typeof request.headers["x-bb-session-id"] === "string" ? request.headers["x-bb-session-id"] : undefined,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
          const output = requests.length === 1
            ? { title: "Owned SDK Gateway fixture" }
            : { progress: "Owned synthetic extraction complete", completed: true };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            id: "resp_owned", object: "response", created_at: 1, status: "completed",
            model: "gpt-4.1-mini", output: [{
              id: "msg_owned", type: "message", role: "assistant", status: "completed",
              content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }],
            }],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }));
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      await ownedGateway(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      respond("/category/start", "<h1>Owned SDK Gateway fixture</h1>");
      respond("/favicon.ico", "", [], 204);
      const page = await install();
      await page.goto(`${origin}/category/start`);
      const sdkPages = await browser.context.pages();
      let sdkPage;
      for (const candidate of sdkPages) {
        if (await candidate.url() === page.url()) { sdkPage = candidate; break; }
      }
      if (!sdkPage) throw new Error("owned_sdk_page_unavailable");
      const result = await stagehand.extract("Return the visible heading.", z.object({ title: z.string() }), {
        page: sdkPage,
      });
      expect(result.data).toEqual({ title: "Owned SDK Gateway fixture" });
      expect(requests).toHaveLength(2);
      for (const request of requests) expect(request).toMatchObject({ key: apiKey, session: sessionId });
      expect(JSON.stringify(requests[0].body)).toContain("Owned SDK Gateway fixture");
      expect(await stagehand.metrics()).toMatchObject({
        extractPromptTokens: 20, extractCompletionTokens: 10,
        totalPromptTokens: 20, totalCompletionTokens: 10,
      });
      expect(metadataRequests).toEqual([`GET /v1/sessions/${sessionId}`]);
      expect(network!.errors).toEqual([]);
    } finally {
      const sdkCleanup = await Promise.allSettled([stagehand?.close()]);
      await network?.close();
      network = undefined;
      await context.close();
      expect(await monitor.waitForClosed(5000)).toBe(true);
      monitor.dispose();
      metadata.closeAllConnections();
      if (metadata.listening) await new Promise<void>((resolve, reject) => metadata.close((error) => error ? reject(error) : resolve()));
      expect(sdkCleanup.every((result) => result.status === "fulfilled")).toBe(true);
    }
  });

  it("rejects and latches a real hidden custom context even when Playwright still reports one context", async () => {
    const root = await context.browser()!.newBrowserCDPSession();
    const { browserContextId } = await root.send("Target.createBrowserContext");
    try {
      expect(context.browser()!.contexts()).toHaveLength(1);
      await expect(control!.snapshot()).rejects.toThrow("native_profile_rejected");
      await expect(connectNativeWorkerControl({ context, workerUrl: worker.url(), assertActive() {} })).rejects.toThrow("native_profile_rejected");
    } finally {
      await root.send("Target.disposeBrowserContext", { browserContextId });
      await root.detach();
    }
    await expect(control!.snapshot()).rejects.toThrow("native_worker_lost");
  });

  it("rejects changed installed-byte expectations before native activation", async () => {
    const files = new Map((await buildComposedExtension()).files);
    files.set("manifest.json", Buffer.from("{}"));
    await expect(control!.verifyFiles(files)).rejects.toThrow("native_extension_bytes_rejected");
    expect(await control!.snapshot()).toMatchObject({ phase: "bootstrap", ready: false });
    await expect(connectNativeWorkerControl({
      context, workerUrl: worker.url().replace("/service-worker.js", "/flash-flood/composed.js"), assertActive() {},
    })).rejects.toThrow("native_extension_identity_rejected");
  });

  it("attests an already-running worker without resuming or replacing another debugger", async () => {
    const second = await connectNativeWorkerControl({ context, workerUrl: worker.url(), assertActive() {} });
    try {
      expect(second.startupWaiting).toBe(false);
      expect(await second.snapshot()).toMatchObject({ phase: "bootstrap" });
      await second.verifyFiles((await buildComposedExtension()).files);
    } finally { await second.close(); }
    expect(await control!.snapshot()).toMatchObject({ phase: "bootstrap" });
  });

  it("latches actual stopped-worker loss instead of trusting a stale Playwright handle", async () => {
    const lost = vi.fn();
    const watched = await connectNativeWorkerControl({ context, workerUrl: worker.url(), assertActive() {}, onLost: lost });
    const observer = await context.newCDPSession(context.pages()[0]);
    let versionId: string | undefined;
    observer.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
      versionId ??= versions.find((version) => version.scriptURL === worker.url()
        && version.runningStatus === "running" && version.status === "activated")?.versionId;
    });
    try {
      await observer.send("ServiceWorker.enable");
      await vi.waitFor(() => expect(versionId).toBeDefined());
      await observer.send("ServiceWorker.stopWorker", { versionId: versionId! });
      await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce());
      await expect(watched.snapshot()).rejects.toThrow("native_worker_lost");
    } finally { await watched.close(); await observer.detach(); }
  });

  it("fails closed when the real offscreen document is destroyed and recreated after installation", async () => {
    const fatal = vi.fn();
    const root = await context.browser()!.newBrowserCDPSession();
    const url = worker.url().replace("/service-worker.js", "/offscreen/service-worker-heartbeat.html");
    const original = (await root.send("Target.getTargets")).targetInfos.find((target) => target.url === url);
    try {
      expect(original?.type).toBe("background_page");
      await install(fatal);
      await trustedWorkerExpression("chrome.offscreen.closeDocument().then(()=>true)");
      await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());
      await trustedWorkerExpression(`(async()=>{
        if(!(await chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"],documentUrls:[${JSON.stringify(url)}]})).length){
          await chrome.offscreen.createDocument({url:"offscreen/service-worker-heartbeat.html",reasons:["WORKERS"],justification:"Owned lifecycle regression"});
        }
        return true;
      })()`);
      let recreated: string | undefined;
      await vi.waitFor(async () => {
        recreated = (await root.send("Target.getTargets")).targetInfos.find((target) => target.url === url && target.targetId !== original!.targetId)?.targetId;
        expect(recreated).toBeDefined();
      });
      expect(network!.errors.some((code) => ["public_cdp_failed", "gateway_target_lost", "gateway_target_changed", "gateway_offscreen_changed"].includes(code))).toBe(true);
      expect(fatal).toHaveBeenCalledOnce();
      expect(mock.gatewayCookies).toEqual([]);
    } finally { await root.detach(); }
  });

  it("reports WebSocket and WebTransport attempts as unsupported without a public broker request", async () => {
    respond("/category/start", '<link rel="icon" href="data:,"><h1>Owned channel fixture</h1>');
    const page = await install();
    await page.goto(`${origin}/category/start`);
    await page.evaluate(() => {
      new WebSocket("wss://routing-fixture.example.com/socket");
      const transport = new WebTransport("https://routing-fixture.example.com/transport");
      void transport.ready.catch(() => {});
      void transport.closed.catch(() => {});
    });
    await vi.waitFor(() => expect(network!.errors.filter((code) => code === "public_channel_unsupported")).toHaveLength(2));
    expect(mock.requests.map((request) => request.url)).toEqual([`${origin}/category/start`]);
  });

  it("fails the live network immediately when its actual page target disappears", async () => {
    const fatal = vi.fn();
    const page = await install(fatal);
    await page.close();
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());
    expect(network!.errors).toContain("public_cdp_failed");
    expect(mock.requests).toEqual([]);
  });

  it("intercepts every redirect hop, preserves cookies/duplicate headers and separately scoped assets", async () => {
    respond("/category/start", "", [["location", "/category/final"], ["set-cookie", "anonymous=one; Secure; SameSite=Lax"]], 302);
    respond("/category/final", '<h1>Owned routing fixture</h1><link rel="stylesheet" href="/assets/main.css"><img src="https://assets.example.net/icon.svg">', [
      ["content-security-policy", "default-src 'none'; style-src 'self'; img-src https://assets.example.net"],
      ["set-cookie", "second=two; Secure"], ["set-cookie", "third=three; Secure"],
    ]);
    mock.responses.set(`${origin}/assets/main.css`, { status: 200, body: "h1{color:rgb(12, 34, 56)}", headers: [["content-type", "text/css"]] });
    mock.responses.set("https://assets.example.net/icon.svg", { status: 200, body: '<svg xmlns="http://www.w3.org/2000/svg"/>', headers: [["content-type", "image/svg+xml"]] });
    const page = await install();
    await page.goto(`${origin}/category/start`, { waitUntil: "networkidle" });
    expect(page.url()).toBe(`${origin}/category/final`);
    expect(await page.locator("h1").evaluate((element) => getComputedStyle(element).color)).toBe("rgb(12, 34, 56)");
    expect(mock.requests.map((request) => request.url)).toEqual(expect.arrayContaining([
      `${origin}/category/start`, `${origin}/category/final`, `${origin}/assets/main.css`, "https://assets.example.net/icon.svg",
    ]));
    expect(mock.requests.find((request) => request.url.endsWith("/category/final"))?.headers)
      .toContainEqual(["cookie", "anonymous=one"]);
    expect((await context.cookies(`${origin}/category/final`)).map((cookie) => cookie.name)).toEqual(expect.arrayContaining(["anonymous", "second", "third"]));
    expect(network!.errors).toEqual([]);
  });

  it("refuses off-scope redirected documents before dispatch and never grants the asset exception to documents", async () => {
    respond("/category/start", "", [["location", "/outside"]], 302);
    const page = await install();
    await expect(page.goto(`${origin}/category/start`)).rejects.toThrow();
    expect(mock.requests.map((request) => request.url)).toEqual([`${origin}/category/start`]);
    expect(network!.errors).toContain("public_transport_not_authorized");
  });

  it("preserves CSP and rejects custom headers/body-bearing requests without forwarding them", async () => {
    respond("/category/start", "<h1>Owned fixture</h1>", [["content-security-policy", "default-src 'none'; connect-src 'self'"]]);
    const page = await install();
    await page.goto(`${origin}/category/start`);
    await page.evaluate(async () => {
      await fetch("/category/api", { method: "POST", body: "not-forwarded" }).catch(() => undefined);
      await fetch("/category/api", { headers: { "X-Unsupported": "not-forwarded" } }).catch(() => undefined);
      await fetch("https://assets.example.net/blocked-by-csp").catch(() => undefined);
    });
    expect(mock.requests.map((request) => request.url)).toEqual([`${origin}/category/start`]);
    expect(network!.errors).toContain("public_request_unsupported");
  });

  it("permits fixed Gateway POST only from the actual extension target, never the public page", async () => {
    respond("/category/start", "<h1>Owned fixture</h1>");
    server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("set-cookie", "provider-control=private; Path=/");
      response.end('{"routingFixture":true}');
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const owned = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const calls = await ownedGateway(owned);
    const page = await install();
    await page.goto(`${origin}/category/start`);
    const result = await trustedWorkerPost('{"routingFixture":true}', { "content-type": "application/json" });
    expect(result).toEqual({ routingFixture: true });
    expect(await context.cookies(owned)).toEqual([]);
    expect(calls).toHaveBeenCalledTimes(1);
    await page.evaluate(async (url) => {
      await fetch(url, { method: "POST", body: "page-must-not-use-control-plane", mode: "no-cors" }).catch(() => undefined);
    }, gateway);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(mock.requests.some((request) => request.url === gateway)).toBe(false);
    await page.evaluate(async (url) => { await fetch(url).catch(() => undefined); }, gateway);
    expect(mock.requests.some((request) => request.url === gateway)).toBe(false);
  });

  it("preserves large Unicode DOM and base64 screenshot JSON byte-for-byte from worker and offscreen targets", async () => {
    const body = JSON.stringify({
      dom: ("R\u00e9sum\u00e9 \u96ea <main>Owned screenshot fixture</main>\n").repeat(5000),
      screenshot: Buffer.alloc(512 * 1024, 90).toString("base64"),
    });
    const expectedHash = createHash("sha256").update(body).digest("hex");
    const expectedBytes = Buffer.byteLength(body);
    expect(expectedBytes).toBeGreaterThan(1024 * 512);
    const observed: { bytes: number; hash: string; authorization?: string; contentType?: string; cookie?: string }[] = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      request.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) request.destroy();
        else chunks.push(chunk);
      });
      request.on("end", () => {
        const hash = createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
        observed.push({ bytes, hash, authorization: request.headers.authorization, contentType: request.headers["content-type"], cookie: request.headers.cookie });
        response.setHeader("content-type", "application/json");
        response.setHeader("set-cookie", "gateway-private=one; Domain=api.stagehand.browserbase.com; Path=/; Secure; SameSite=None");
        response.end(JSON.stringify({ bodyHash: hash }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const owned = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await ownedGateway(owned);
    await context.addCookies([{
      name: "public-browser", value: "not-control", domain: "api.stagehand.browserbase.com",
      path: "/", secure: true, httpOnly: true, sameSite: "None",
    }]);
    const root = await context.browser()!.newBrowserCDPSession();
    const offscreenUrl = worker.url().replace("/service-worker.js", "/offscreen/service-worker-heartbeat.html");
    let offscreenId = "";
    await vi.waitFor(async () => {
      offscreenId = (await root.send("Target.getTargets")).targetInfos.find((entry) => entry.url === offscreenUrl)?.targetId ?? "";
      expect(offscreenId).not.toBe("");
    }, { timeout: 5000 });
    await install();
    const headers = { "content-type": "application/json", authorization: "Bearer offline-control-test" };
    expect(await trustedWorkerPost(body, headers)).toEqual({ bodyHash: expectedHash });
    const offscreen = await attachCdpTarget(root, offscreenId, () => {});
    try {
      const result = await offscreen.send("Runtime.evaluate", {
        expression: `fetch(${JSON.stringify(gateway)},${JSON.stringify({ method: "POST", body, headers, credentials: "include" })}).then(response=>response.json())`,
        awaitPromise: true, returnByValue: true,
      });
      expect(result).toMatchObject({ result: { value: { bodyHash: expectedHash } } });
      expect(result).not.toHaveProperty("exceptionDetails");
      expect(mock.gatewayCookies).toEqual(["public-browser=not-control", "public-browser=not-control"]);
      expect((await context.cookies(gateway)).map(({ name }) => name)).toEqual(["public-browser"]);
      expect(observed).toEqual(Array.from({ length: 2 }, () => ({
        bytes: expectedBytes, hash: expectedHash, cookie: undefined,
        authorization: "Bearer offline-control-test", contentType: "application/json",
      })));
      expect(network!.errors).toEqual([]);
    } finally {
      await offscreen.close();
      await root.detach();
    }
  });

  it("aborts an oversized chunked Gateway stream before fulfilling a response to the real worker", async () => {
    let sent = 0;
    let upstreamClosed = false;
    server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      const chunk = Buffer.alloc(64 * 1024, 32);
      let next: NodeJS.Immediate | undefined;
      response.once("close", () => { upstreamClosed = true; clearImmediate(next); });
      const write = () => {
        if (response.destroyed) return;
        sent += chunk.length;
        if (sent >= 32 * 1024 * 1024) { response.end(chunk); return; }
        if (response.write(chunk)) next = setImmediate(write);
        else response.once("drain", () => { next = setImmediate(write); });
      };
      write();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    await ownedGateway(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await install();
    const result = await trustedWorkerExpression(
      `fetch(${JSON.stringify(gateway)},{method:"POST",body:"{}",headers:{"content-type":"application/json"}}).then(()=>false,()=>true)`,
    );
    expect(result).toBe(true);
    await vi.waitFor(() => expect(upstreamClosed).toBe(true));
    expect(sent).toBeLessThan(32 * 1024 * 1024);
    expect(network!.errors).toContain("gateway_control_failed");
    expect(mock.gatewayCalls).toHaveBeenCalledTimes(1);
  });
});
