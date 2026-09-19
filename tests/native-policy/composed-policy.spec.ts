import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { buildComposedExtension } from "../../src/server/execution/composed-extension";
import { establishNativePolicy } from "../../src/server/execution/native-policy-session";
import { verifyNativeProxyRefusal } from "../../src/server/execution/native-proxy-attestation";
import { connectNativeWorkerControl, type NativeWorkerControl } from "../../src/server/execution/native-worker-control";
import { attachCdpTarget } from "../../src/server/execution/cdp-target";

function observeLateTraceCompletion(context: BrowserContext) {
  const browser = context.browser()!;
  const createSession = browser.newBrowserCDPSession.bind(browser);
  browser.newBrowserCDPSession = async () => {
    const session = await createSession();
    const send = session.send.bind(session);
    const detach = session.detach.bind(session);
    let owned = false;
    let endedAt: number | undefined;
    let completedAt: number | undefined;
    const complete = new Promise<{ stream?: string }>((resolve) => {
      session.once("Tracing.tracingComplete", (result) => {
        completedAt = performance.now();
        resolve(result);
      });
    });
    session.send = async (method, params) => {
      if (method === "Tracing.end" && owned) endedAt ??= performance.now();
      const result = await send(method, params);
      if (method === "Tracing.start") owned = true;
      return result;
    };
    session.detach = async () => {
      if (owned && endedAt !== undefined && completedAt === undefined) {
        // Observe only after production verification has already failed. Its verdict is unchanged.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          complete, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 10000); }),
        ]);
        clearTimeout(timer);
        console.log({
          diagnostic: "owned_trace_completion_after_failed_verification",
          completionObserved: completedAt !== undefined,
          elapsedMs: completedAt === undefined ? null : Math.round(completedAt - endedAt),
          browserConnected: browser.isConnected(),
        });
        if (result?.stream) await send("IO.close", { handle: result.stream });
      }
      await detach();
    };
    return session;
  };
}

async function launch(options: { preferences?: object; tamper?: string; cdp?: boolean } = {}) {
  // Reserve only as a preflight: the attestation must observe an actual TCP refusal.
  const guard = createTcpServer();
  await new Promise<void>((done, reject) => {
    guard.once("error", reject);
    guard.listen(65534, "127.0.0.1", done);
  });
  await new Promise<void>((done) => guard.close(() => done()));
  const root = await mkdtemp(resolve(".composed-native-"));
  const extension = join(root, "extension");
  const profile = join(root, "profile");
  let context: BrowserContext | undefined;
  let control: NativeWorkerControl | undefined;
  const nativeHandles: Awaited<ReturnType<typeof establishNativePolicy>>[] = [];
  const close = async () => {
    try { await context?.close(); }
    finally {
      try {
        for (const native of nativeHandles) await native.close();
        await control?.close();
      }
      finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    }
  };
  try {
    const bundle = await buildComposedExtension();
    await mkdir(extension, { mode: 0o700 });
    for (const [name, bytes] of bundle.files) {
      const target = join(extension, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, name === options.tamper ? Buffer.concat([bytes, Buffer.from("\n ")]) : bytes,
        { mode: 0o600, flag: "wx" });
    }
    if (options.preferences) {
      await mkdir(join(profile, "Default"), { recursive: true, mode: 0o700 });
      await writeFile(join(profile, "Default", "Preferences"), JSON.stringify(options.preferences), { mode: 0o600 });
    }
    const launchContext = () => chromium.launchPersistentContext(profile, {
      channel: "chromium", headless: true,
      args: [
        `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
        ...(options.cdp ? ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--remote-allow-origins=*"] : []),
      ],
    });
    context = await launchContext();
    observeLateTraceCompletion(context);
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    control = await connectNativeWorkerControl({ context, workerUrl: worker.url(), assertActive() {} });
    expect(await control.snapshot()).toMatchObject({ ready: false, phase: "bootstrap" });
    return {
      context, worker, profile, files: bundle.files, control,
      establish: async () => {
        const native = await establishNativePolicy({ context: context!, worker, files: bundle.files, assertActive() {} });
        nativeHandles.push(native);
        return native;
      },
      restart: async () => {
        await control!.close();
        await context!.close();
        context = await launchContext();
        const restarted = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
        control = await connectNativeWorkerControl({ context, workerUrl: restarted.url(), assertActive() {} });
        return control;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function causePolicyDrift(context: BrowserContext, workerUrl: string, setting: "proxy" | "prediction" | "webrtc") {
  const programs = {
    proxy: 'chrome.proxy.settings.set({value:{mode:"direct"},scope:"regular"})',
    prediction: 'chrome.privacy.network.networkPredictionEnabled.set({value:true,scope:"regular"})',
    webrtc: 'chrome.privacy.network.webRTCIPHandlingPolicy.set({value:"default",scope:"regular"})',
  };
  const root = await context.browser()!.newBrowserCDPSession();
  let target: Awaited<ReturnType<typeof attachCdpTarget>> | undefined;
  try {
    const targets = (await root.send("Target.getTargets")).targetInfos.filter((entry) =>
      entry.type === "service_worker" && entry.url === workerUrl);
    expect(targets).toHaveLength(1);
    target = await attachCdpTarget(root, targets[0].targetId, () => {});
    await target.send("Runtime.enable");
    const result = z.object({ result: z.object({ value: z.literal(true) }), exceptionDetails: z.never().optional() });
    result.parse(await target.send("Runtime.evaluate", {
      expression: `${programs[setting]}.then(()=>true)`, awaitPromise: true, returnByValue: true,
    }));
  } finally {
    try { await target?.close(); }
    finally { await root.detach(); }
  }
}

async function sentinel() {
  let hits = 0;
  const server = createServer((_request, response) => { hits++; response.end("owned sentinel"); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits: () => hits,
    close: () => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())),
  };
}

test("actual composed vendor worker defers policy, verifies bytes and refuses direct network", async () => {
  const browser = await launch();
  const target = await sentinel();
  try {
    const native = await browser.establish();
    const page = browser.context.pages()[0];
    await expect(page.goto(target.origin)).rejects.toThrow("ERR_PROXY_CONNECTION_FAILED");
    expect(target.hits()).toBe(0);
    await native.verify();
  } finally { await browser.close(); await target.close(); }
});

test("regular profile has no custom CDP contexts and detects a context invisible to Playwright", async () => {
  const browser = await launch();
  const cdp = await browser.context.browser()!.newBrowserCDPSession();
  let ownedContext: string | undefined;
  try {
    expect(browser.context.browser()!.contexts()).toEqual([browser.context]);
    const initial = await cdp.send("Target.getBrowserContexts");
    expect(initial.browserContextIds).toEqual([]);
    const defaultContextId: unknown = Reflect.get(initial, "defaultBrowserContextId");
    expect(typeof defaultContextId).toBe("string");
    expect(defaultContextId).toBeTruthy();
    const pageCdp = await browser.context.newCDPSession(browser.context.pages()[0]);
    try {
      const { targetInfo } = await pageCdp.send("Target.getTargetInfo");
      expect(targetInfo.browserContextId).toBe(defaultContextId);
    } finally { await pageCdp.detach(); }
    const created = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
    ownedContext = created.browserContextId;
    expect(ownedContext).toBeTruthy();
    expect(ownedContext).not.toBe(defaultContextId);
    expect((await cdp.send("Target.getBrowserContexts")).browserContextIds).toEqual([ownedContext]);
    // CDP-only contexts without targets are not reflected in Playwright's context list.
    expect(browser.context.browser()!.contexts()).toEqual([browser.context]);
    await cdp.send("Target.disposeBrowserContext", { browserContextId: ownedContext });
    ownedContext = undefined;
    expect((await cdp.send("Target.getBrowserContexts")).browserContextIds).toEqual([]);
    expect(await browser.control.snapshot())
      .toMatchObject({ phase: "bootstrap", ready: false });
  } finally {
    try {
      if (ownedContext) await cdp.send("Target.disposeBrowserContext", { browserContextId: ownedContext });
    } finally {
      try { await cdp.detach(); }
      finally { await browser.close(); }
    }
  }
});

for (const behavior of ["listening", "resetting", "responding"] as const) {
  test(`owned ${behavior} proxy is not mistaken for a TCP refusal`, async () => {
    const browser = await launch();
    const sockets = new Set<Socket>();
    let connections = 0;
    const proxy = createTcpServer((socket) => {
      connections++;
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      if (behavior === "resetting") socket.resetAndDestroy();
      if (behavior === "responding") socket.once("data", () =>
        socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
    });
    try {
      await new Promise<void>((done, reject) => {
        proxy.once("error", reject);
        proxy.listen(65534, "127.0.0.1", done);
      });
      await expect(browser.establish()).rejects.toThrow("native_proxy_endpoint_unconfirmed");
      expect(connections).toBeGreaterThan(0);
      expect(browser.context.pages()).toHaveLength(1);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => proxy.close(() => done()));
      await browser.close();
    }
  });
}

test("competing trace rejects without stopping the unowned trace", async () => {
  const browser = await launch();
  const trace = await browser.context.browser()!.newBrowserCDPSession();
  let complete = false;
  trace.on("Tracing.tracingComplete", () => { complete = true; });
  try {
    await browser.control.activate();
    await trace.send("Tracing.start", { transferMode: "ReturnAsStream", traceConfig: { includedCategories: ["toplevel"] } });
    await expect(verifyNativeProxyRefusal(browser.context, () => {})).rejects.toThrow("native_proxy_endpoint_unconfirmed");
    expect(complete).toBe(false);
    await expect(trace.send("Tracing.start")).rejects.toThrow();
    const finished = new Promise<{ stream?: string }>((done) => trace.once("Tracing.tracingComplete", done));
    await trace.send("Tracing.end");
    const result = await finished;
    expect(complete).toBe(true);
    if (result.stream) await trace.send("IO.close", { handle: result.stream });
    expect(browser.context.pages()).toHaveLength(1);
  } finally { await trace.detach(); await browser.close(); }
});

for (const name of ["blank.html", "flash-flood/policy.js", "service-worker.js"]) {
  test(`actual extension byte tamper rejects ${name}`, async () => {
    const browser = await launch({ tamper: name });
    try {
      await expect(browser.establish()).rejects.toThrow("native_extension_bytes_rejected");
      expect(await browser.control.snapshot())
        .toMatchObject({ phase: "bootstrap", ready: false });
    } finally { await browser.close(); }
  });
}

test("an untrusted bootstrap document fails before policy activation", async () => {
  const browser = await launch();
  try {
    await browser.context.pages()[0].goto("data:text/html,untrusted");
    await expect(browser.establish()).rejects.toThrow("native_untrusted_bootstrap");
    expect(await browser.control.snapshot())
      .toMatchObject({ phase: "bootstrap", ready: false });
  } finally { await browser.close(); }
});

test("effective per-origin WebRTC preferences fail the composed handshake", async () => {
  const browser = await launch({ preferences: { webrtc: {
    ip_handling_url: [{ url: "http://127.0.0.1:65533", handling: "default" }],
  } } });
  try {
    await expect(browser.establish()).rejects.toThrow("native_webrtc_preferences_rejected");
    expect(browser.context.pages()).toHaveLength(1);
  } finally { await browser.close(); }
});

for (const setting of ["proxy", "prediction", "webrtc"] as const) {
  test(`active ${setting} drift is sticky and cannot reactivate`, async () => {
    const browser = await launch();
    try {
      const native = await browser.establish();
      await causePolicyDrift(browser.context, browser.worker.url(), setting);
      await expect(native.verify()).rejects.toThrow("native_worker_command_failed");
      await expect(browser.control.activate()).rejects.toThrow("native_worker_command_failed");
      expect(await browser.control.snapshot())
        .toMatchObject({ phase: "fault", ready: false });
    } finally { await browser.close(); }
  });
}

test("worker restart with persisted profile invalidates the established handle and is unready", async () => {
  const browser = await launch();
  try {
    const native = await browser.establish();
    const restarted = await browser.restart();
    await expect(native.verify()).rejects.toThrow();
    expect(await restarted.snapshot()).toMatchObject({ ready: false, phase: "bootstrap" });
    await expect(restarted.verify()).rejects.toThrow("native_worker_command_failed");
  } finally { await browser.close(); }
});

test("maintained offline CLI guard allows only owned ports and restores Node transports", async () => {
  const cli = await promisify(execFile)(process.execPath, [
    "--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { createServer } from "node:http";
      import { Socket } from "node:net";
      import dns from "node:dns";
      import dgram from "node:dgram";
      import { installOfflineNativeNetworkGuard } from "./scripts/public-native-offline.ts";
      const server = createServer((_request, response) => response.end("owned"));
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      const port = server.address().port;
      const origin = "http://127.0.0.1:" + port;
      const connect = Socket.prototype.connect;
      const fetch = globalThis.fetch;
      const resolve4 = dns.promises.resolve4;
      const send = dgram.Socket.prototype.send;
      let outerAttempts = 0;
      const outerDeny = () => { outerAttempts++; throw new Error("outer_offline_guard"); };
      Socket.prototype.connect = function(...args) {
        const normalized = Array.isArray(args[0]) ? args[0] : args;
        const options = normalized[0];
        if (!options || options.host !== "127.0.0.1" || Number(options.port) !== port) return outerDeny();
        return Reflect.apply(connect, this, args);
      };
      globalThis.fetch = (input, options) => {
        if (new URL(input).origin !== origin) return outerDeny();
        return fetch(input, options);
      };
      dns.promises.resolve4 = outerDeny;
      dgram.Socket.prototype.send = outerDeny;
      const outerConnect = Socket.prototype.connect;
      const outerFetch = globalThis.fetch;
      const guard = installOfflineNativeNetworkGuard();
      const denied = { message: "offline_native_outbound_forbidden" };
      try {
        assert.throws(() => installOfflineNativeNetworkGuard(), { message: "offline_native_guard_already_installed" });
        assert.equal((await dns.promises.lookup("127.0.0.1")).address, "127.0.0.1");
        await assert.rejects(globalThis.fetch(origin), denied);
        guard.allowOwnedPort(port);
        assert.equal(await (await globalThis.fetch(origin)).text(), "owned");
        await assert.rejects(globalThis.fetch("https://provider.invalid/"), denied);
        for (const options of [
          { host: "provider.invalid", port: 443 },
          { host: "127.0.0.1", port: port === 65534 ? 65533 : 65534 },
          { path: "/offline-no-socket" },
        ]) {
          const socket = new Socket();
          try { assert.throws(() => socket.connect(options), denied); }
          finally { socket.destroy(); }
        }
        assert.throws(() => dns.promises.resolve4("provider.invalid"), denied);
        const udp = dgram.createSocket("udp4");
        try { assert.throws(() => udp.send("owned", port, "127.0.0.1"), denied); }
        finally { udp.close(); }
        assert.equal(guard.blockedAttempts, 7);
        assert.equal(outerAttempts, 0);
        guard.close();
        guard.close();
        assert.equal(Socket.prototype.connect, outerConnect);
        assert.equal(globalThis.fetch, outerFetch);
        assert.equal(dns.promises.resolve4, outerDeny);
        assert.equal(dgram.Socket.prototype.send, outerDeny);
        process.stdout.write("offline_native_guard_verified");
      } finally {
        guard.close();
        Socket.prototype.connect = connect;
        globalThis.fetch = fetch;
        dns.promises.resolve4 = resolve4;
        dgram.Socket.prototype.send = send;
        const closed = new Promise((done) => server.close(done));
        server.closeAllConnections();
        await closed;
      }
    `,
  ], { cwd: process.cwd(), timeout: 15000, maxBuffer: 4096 });
  expect(cli.stdout).toBe("offline_native_guard_verified");
  expect(cli.stderr).toBe("");
});

test("native preference helper executes under actual Node22 TSX without serialized name helpers", async () => {
  const cli = await promisify(execFile)(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval", `
      import { chromium } from "playwright-core";
      import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
      import { join, resolve } from "node:path";
      import { verifyNativeWebRtcPreferences } from "./src/server/execution/native-policy-attestation.ts";
      if (process.versions.node.split(".")[0] !== "22") throw new Error("offline_node_version_rejected");
      for (const override of [false, true]) {
        const profile = await mkdtemp(resolve(".native-preferences-tsx-"));
        let context;
        try {
          await mkdir(join(profile, "Default"), { mode: 0o700 });
          await writeFile(join(profile, "Default", "Preferences"), JSON.stringify({ webrtc: {
            ip_handling_policy: "disable_non_proxied_udp",
            ip_handling_url: override ? [{ url: "http://127.0.0.1:65533", handling: "default" }] : [],
          } }), { mode: 0o600 });
          context = await chromium.launchPersistentContext(profile, {
            channel: "chromium", headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND"],
          });
          let verdict = "accepted";
          try { await verifyNativeWebRtcPreferences(context); }
          catch (error) {
            if (!(error instanceof Error) || error.message !== "native_webrtc_preferences_rejected") {
              throw new Error("offline_native_preferences_probe_failed");
            }
            verdict = "rejected";
          }
          if (verdict !== (override ? "rejected" : "accepted") || context.pages().length !== 1) {
            throw new Error("offline_native_preferences_verdict_failed");
          }
        } finally {
          try { await context?.close(); }
          finally { await rm(profile, { recursive: true, force: true }); }
        }
      }
      process.stdout.write("native_preferences_tsx_verified");
    `,
  ], { cwd: process.cwd(), timeout: 20000, maxBuffer: 4096 });
  expect(cli.stdout).toBe("native_preferences_tsx_verified");
  expect(cli.stderr).toBe("");
});

test("real LOCAL Stagehand initializes and retains control across native activation without inference", async () => {
  const browser = await launch({ cdp: true });
  const api = await sentinel();
  const cdp = await browser.context.browser()!.newBrowserCDPSession();
  let sdk: Awaited<ReturnType<typeof localBrowser.connect>> | undefined;
  let stagehand: Stagehand | undefined;
  let inference = 0;
  try {
    await browser.control.close();
    expect((await cdp.send("Target.getBrowserContexts")).browserContextIds).toEqual([]);
    const [port] = (await readFile(join(browser.profile, "DevToolsActivePort"), "utf8")).split("\n");
    expect(port).toMatch(/^\d+$/);
    const extensionId = new URL(browser.worker.url()).host;
    sdk = await test.step("connect LOCAL SDK", () =>
      localBrowser.connect({ cdpUrl: `http://127.0.0.1:${port}`, extensionId }), { timeout: 15000 });
    stagehand = await test.step("initialize LOCAL Stagehand", () => Stagehand.create({
      browser: sdk!, apiKey: "offline-dummy-key", apiUrl: api.origin,
      model: { generate: async () => { inference++; throw new Error("offline_inference_forbidden"); } },
      telemetry: { traces: { endpoint: `${api.origin}/v1/traces` } },
      cache: false, selfHeal: false, logging: { level: "off" },
    }), { timeout: 15000 });
    expect(stagehand.initialized).toBe(true);
    expect((await cdp.send("Target.getBrowserContexts")).browserContextIds).toEqual([]);
    const before = await sdk.context.newPage();
    expect(await before.url()).toBe(`chrome-extension://${extensionId}/blank.html`);
    await before.close();
    const native = await test.step("establish native attestation", () => browser.establish(), { timeout: 15000 });
    const after = await sdk.context.newPage();
    expect(await after.url()).toBe(`chrome-extension://${extensionId}/blank.html`);
    expect((await sdk.context.pages()).length).toBeGreaterThan(0);
    await after.close();
    await native.verify();
    expect((await cdp.send("Target.getBrowserContexts")).browserContextIds).toEqual([]);
    expect(inference).toBe(0);
  } finally {
    const errors: unknown[] = [];
    for (const close of [
      () => stagehand?.close(), () => cdp.detach(),
      () => browser.close(), () => api.close(),
    ]) {
      try { await close(); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "offline SDK cleanup failed");
  }
});
