import { localBrowser, Stagehand, type StagehandBrowser } from "@browserbasehq/stagehand";
import { chromium, type BrowserContext } from "playwright-core";
import { createServer, Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import dns from "node:dns";
import dgram from "node:dgram";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { buildComposedExtension } from "../src/server/execution/composed-extension";
import { establishNativePolicy } from "../src/server/execution/native-policy-session";
import { installOfflinePublicNetworkForProbe } from "../src/server/execution/public-network";
import { publicExecutionPolicy } from "../src/server/execution/public-policy";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../src/lib/public-execution";
import { ScopedBrowserDriver } from "../src/server/execution/driver";
import { ExecutionError } from "../src/server/execution/types";
import type { ArtifactSinks } from "../src/server/execution/artifacts";
import { NATIVE_TELEMETRY_ENDPOINT } from "../src/server/execution/native-telemetry";

let networkGuardInstalled = false;

type OfflineNativePhase = "setup" | "archive" | "refused-proxy" | "sentinel" | "browser" |
  "extension-worker" | "cdp-endpoint" | "sdk-connect" | "sdk-initialize" | "native-attestation" |
  "routing" | "navigation" | "page-activation" | "observation" | "readonly-negative" | "readonly-link" |
  "metrics" | "policy-verify" | "cleanup";
const offlineFailureCodes = [
  "native_policy_state_rejected", "native_proxy_endpoint_unconfirmed", "native_browser_version_unsupported",
  "native_untrusted_bootstrap", "native_extension_identity_rejected", "offline_native_worker_missing",
  "offline_native_endpoint_rejected", "offline_native_observation_failed", "offline_native_readonly_guard_failed",
  "offline_native_routing_failed", "offline_native_inference_forbidden", "offline_native_outbound_forbidden",
  "offline_native_page_not_visible", "fixture_network_failed", "public_transport_failed",
  "page_out_of_scope", "subframes_unsupported", "telemetry_limit", "page_screenshot_failed", "page_evaluation_failed",
  "offline_native_telemetry_not_denied",
] as const;

export class OfflineNativeProbeError extends Error {
  readonly code: typeof offlineFailureCodes[number] | "unknown";
  constructor(readonly step: OfflineNativePhase, error: unknown) {
    super("offline_native_probe_failed");
    this.code = offlineFailureCodes.find((code) => error instanceof Error && error.message === code) ??
      (error instanceof Error && error.message.startsWith("page.screenshot:") ? "page_screenshot_failed" :
        error instanceof Error && error.message.startsWith("page.evaluate:") ? "page_evaluation_failed" : "unknown");
  }
}

/** Process-local offline CLI guard; only ports opened by this probe may be added. */
export function installOfflineNativeNetworkGuard() {
  if (networkGuardInstalled) throw new Error("offline_native_guard_already_installed");
  networkGuardInstalled = true;
  const ports = new Set<number>();
  let blocked = 0;
  let closed = false;
  const deny = (): never => {
    blocked++;
    throw new Error("offline_native_outbound_forbidden");
  };
  const connect = Socket.prototype.connect;
  const fetch = globalThis.fetch;
  const sendDatagram = dgram.Socket.prototype.send;
  const connectDatagram = dgram.Socket.prototype.connect;
  const lookups = [
    "lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa",
    "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa",
    "resolveSrv", "resolveTxt", "reverse",
  ];
  const dnsMethods = [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype].flatMap((api) =>
    lookups.map((name) => ({ api, name, original: Reflect.get(api, name) })))
    .filter(({ original }) => typeof original === "function");
  const permitted = (host: unknown, port: unknown) => {
    const number = typeof port === "string" && /^\d{1,5}$/.test(port) ? Number(port) : port;
    return host === "127.0.0.1" && typeof number === "number" && ports.has(number);
  };
  Socket.prototype.connect = function <T extends Socket>(this: T, ...args: unknown[]): T {
    const normalized: unknown[] = Array.isArray(args[0]) ? args[0] : args;
    const options = normalized[0];
    const object = options !== null && typeof options === "object";
    const host = object ? Reflect.get(options, "host") : normalized[1];
    const port = object ? Reflect.get(options, "port") : options;
    if (closed || object && Reflect.get(options, "path") !== undefined || !permitted(host, port)) deny();
    Reflect.apply(connect, this, args);
    return this;
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (closed || url.protocol !== "http:" || !permitted(url.hostname, url.port || "80")) deny();
    return fetch(input, init);
  };
  dgram.Socket.prototype.send = deny;
  dgram.Socket.prototype.connect = deny;
  for (const { api, name, original } of dnsMethods) {
    // Server.listen also uses lookup for literals; Node resolves this without DNS.
    if (name === "lookup" && typeof original === "function") {
      Reflect.set(api, name, (...args: unknown[]) =>
        args[0] === "127.0.0.1" ? Reflect.apply(original, api, args) : deny());
    } else Reflect.set(api, name, deny);
  }
  return {
    allowOwnedPort(port: number) {
      if (closed || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("offline_native_port_rejected");
      ports.add(port);
    },
    get blockedAttempts() { return blocked; },
    close() {
      if (closed) return;
      closed = true;
      Socket.prototype.connect = connect;
      globalThis.fetch = fetch;
      dgram.Socket.prototype.send = sendDatagram;
      dgram.Socket.prototype.connect = connectDatagram;
      for (const { api, name, original } of dnsMethods) Reflect.set(api, name, original);
      networkGuardInstalled = false;
    },
  };
}

/** Maintained actual-tsx callback/SDK probe. No provider configuration or inference is used. */
export async function offlineNativeProbe() {
  const outbound = installOfflineNativeNetworkGuard();
  let step: OfflineNativePhase = "setup";
  try { return await runOfflineNativeProbe(outbound, (value) => { step = value; }); }
  catch (error) { throw new OfflineNativeProbeError(step, error); }
  finally { outbound.close(); }
}

async function runOfflineNativeProbe(
  outbound: ReturnType<typeof installOfflineNativeNetworkGuard>,
  phase: (step: OfflineNativePhase) => void,
) {
  phase("archive");
  const bundle = await buildComposedExtension();
  phase("refused-proxy");
  const guard = createServer();
  await new Promise<void>((resolve, reject) => {
    guard.once("error", reject);
    guard.listen(65534, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve) => guard.close(() => resolve()));
  const directory = await mkdtemp(join(tmpdir(), "ff-native-cli-"));
  let context: BrowserContext | undefined;
  let browser: StagehandBrowser | undefined;
  let stagehand: Stagehand | undefined;
  let policy: Awaited<ReturnType<typeof establishNativePolicy>> | undefined;
  let network: Awaited<ReturnType<typeof installOfflinePublicNetworkForProbe>> | undefined;
  let modelCalls = 0;
  let apiCalls = 0;
  let sentinelFailures = 0;
  let verified = false;
  const sentinel = createHttpServer((request, response) => {
    const telemetry = request.method === "POST" && request.url === "/v1/traces";
    if (!telemetry) apiCalls++;
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        sentinelFailures++;
        request.destroy();
      }
    });
    request.on("end", () => {
      response.writeHead(telemetry ? 200 : 503, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  try {
    phase("sentinel");
    await new Promise<void>((resolve, reject) => {
      sentinel.once("error", reject);
      sentinel.listen(0, "127.0.0.1", resolve);
    });
    const address = sentinel.address();
    if (!address || typeof address === "string") throw new Error("offline_native_sentinel_unavailable");
    outbound.allowOwnedPort(address.port);
    const apiOrigin = `http://127.0.0.1:${address.port}`;
    const extension = join(directory, "extension");
    const profile = join(directory, "profile");
    for (const [name, bytes] of bundle.files) {
      const path = join(extension, name);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { mode: 0o600 });
    }
    phase("browser");
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium", headless: true,
      args: [
        `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
        "--remote-allow-origins=*",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
      ],
    });
    phase("extension-worker");
    const worker = context.serviceWorkers().find((entry) => entry.url().endsWith("/service-worker.js"))
      ?? await context.waitForEvent("serviceworker");
    if (!/^chrome-extension:\/\/[a-p]{32}\/service-worker.js$/.test(worker.url())) throw new Error("offline_native_worker_missing");
    phase("cdp-endpoint");
    const endpoint = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
    if (endpoint.length !== 2 || !/^[1-9]\d{0,4}$/.test(endpoint[0]) || Number(endpoint[0]) > 65535
      || !/^\/devtools\/browser\/[a-f0-9-]{36}$/.test(endpoint[1])) throw new Error("offline_native_endpoint_rejected");
    outbound.allowOwnedPort(Number(endpoint[0]));
    phase("sdk-connect");
    browser = await localBrowser.connect({
      cdpUrl: `ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`,
      extensionId: worker.url().split("/")[2],
    });
    phase("sdk-initialize");
    stagehand = await Stagehand.create({
      browser, apiKey: "offline-native-no-provider", apiUrl: apiOrigin,
      model: { generate: async () => { modelCalls++; throw new Error("offline_native_inference_forbidden"); } },
      telemetry: { traces: { endpoint: NATIVE_TELEMETRY_ENDPOINT } },
      cache: false, selfHeal: false, logging: { level: "off" },
    });
    phase("native-attestation");
    policy = await establishNativePolicy({ context, worker, files: bundle.files, assertActive() {} });
    const origin = "https://offline-native.example.com";
    const page = context.pages().find((entry) => entry.url() === "about:blank" || entry.url().endsWith("/blank.html"));
    if (!page) throw new Error("offline_native_page_missing");
    const requests: string[] = [];
    const scope = publicExecutionPolicy({
      executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY,
      scope: { targetUrl: `${origin}/category/start`, pathPrefixes: ["/category"], allowedSubdomains: [] },
    });
    phase("routing");
    network = await installOfflinePublicNetworkForProbe({
      context, page, extensionOrigin: policy.extensionOrigin, authorize: scope.authorize,
      assertActive() {}, verifyActive: policy.verify, signal: new AbortController().signal,
      onSignal() {}, onFatal() { throw new Error("offline_native_network_failed"); },
    }, (options) => ({
      async request(request) {
        if (request.method !== "GET") throw new Error("offline_native_method_rejected");
        const captured = { url: request.url, method: "GET", kind: request.kind } as const;
        const sensitive = request.headers?.filter(([name]) => ["cookie", "origin", "referer"].includes(name)) ?? [];
        if (!options.authorize(captured) || (sensitive.length && !options.authorizeBrowserHeaders?.(captured, sensitive))) {
          throw new Error("offline_native_scope_rejected");
        }
        requests.push(request.url);
        if (request.url === `${origin}/category/start`) return {
          url: request.url, status: 302, body: Buffer.alloc(0),
          headers: [["location", "/category/read"], ["set-cookie", "offline=one; Secure; Path=/category"]],
          redirectUrl: `${origin}/category/read`,
        };
        if (![`${origin}/category/read`, `${origin}/category/next`].includes(request.url)) throw new Error("offline_native_fixture_missing");
        return {
          url: request.url, status: 200, headers: [["content-type", "text/html"]],
          body: Buffer.from('<!doctype html><title>Owned offline routing fixture</title><link rel="icon" href="data:,"><h1>Owned offline routing fixture</h1><a href="/category/next">Read next</a><button>Mutate state</button><input aria-label="Unsupported input">'),
        };
      },
      async close() {}, async drain() {},
    }));
    // Cross the pinned SDK's one-second export interval instead of racing past background telemetry.
    await stagehand.metrics();
    const telemetryDeadline = Date.now() + 5000;
    while (!network.blockedTelemetryRequests && Date.now() < telemetryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!network.blockedTelemetryRequests) throw new Error("offline_native_telemetry_not_denied");
    phase("navigation");
    await page.goto(`${origin}/category/start`, { waitUntil: "domcontentloaded", timeout: 10000 });
    phase("page-activation");
    await page.bringToFront();
    if (await page.evaluate(() => document.visibilityState) !== "visible") throw new Error("offline_native_page_not_visible");
    const reference = (bytes: Uint8Array, kind: "screenshot" | "json") => {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return { key: sha256, sha256, bytes: bytes.length, kind };
    };
    const artifacts: ArtifactSinks = {
      screenshot: async (bytes) => reference(bytes, "screenshot"),
      json: async (value) => reference(Buffer.from(JSON.stringify(value)), "json"),
      telemetry: async (value) => reference(Buffer.from(JSON.stringify(value)), "json"),
    };
    const driver = new ScopedBrowserDriver({
      page, artifacts, readOnly: true, scope: scope.navigation, networkErrors: network.errors,
      close: async () => ({ status: "closed", errors: [] }),
    });
    const signal = new AbortController().signal;
    phase("observation");
    const observed = await driver.observe(signal);
    const button = observed.candidates.find((candidate) => candidate.label === "Mutate state");
    const link = observed.candidates.find((candidate) => candidate.label === "Read next");
    if (!button || !link) throw new Error("offline_native_observation_failed");
    phase("readonly-negative");
    let rejected = false;
    try {
      await driver.act({ actor: "agent", action: "click", candidateId: button.id, value: null, commentary: "" }, signal);
    } catch (error) {
      rejected = error instanceof ExecutionError && error.message === "read_only_link_required";
    }
    if (!rejected) throw new Error("offline_native_readonly_guard_failed");
    phase("readonly-link");
    await driver.act({ actor: "agent", action: "click", candidateId: link.id, value: null, commentary: "" }, signal);
    await driver.observe(signal);
    if (page.url() !== `${origin}/category/next` || requests.length !== 3 || network.errors.length) {
      throw new Error("offline_native_routing_failed");
    }
    await driver.close();
    phase("metrics");
    const metrics = await stagehand.metrics();
    if (modelCalls || apiCalls || sentinelFailures || outbound.blockedAttempts
      || metrics.totalPromptTokens !== 0 || metrics.totalCompletionTokens !== 0 || metrics.totalInferenceTimeMs !== 0) {
      throw new Error("offline_native_inference_forbidden");
    }
    phase("policy-verify");
    await policy.verify();
    verified = true;
    return {
      phase: "offline-native-probe", providerCalls: 0, modelCalls: 0,
      browserVersion: policy.version, archiveDigest: bundle.sha256, remotePolicyProved: false,
      broker: "synthetic-owned-fixture", publicSiteAcceptance: false, readonlyActionsVerified: true,
      sdkTelemetry: "denied-no-egress",
    };
  } finally {
    if (verified) phase("cleanup");
    try {
      await stagehand?.close();
      if (verified && network?.errors.length) throw new Error("offline_native_routing_failed");
    }
    finally {
      try { await network?.close(); }
      finally {
        try { await context?.close(); }
        finally {
          try { await policy?.close(); }
          finally {
            try {
              if (sentinel.listening) {
                const closed = new Promise<void>((resolve, reject) =>
                  sentinel.close((error) => error ? reject(error) : resolve()));
                sentinel.closeAllConnections();
                await closed;
              }
            } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
          }
        }
      }
    }
  }
}
