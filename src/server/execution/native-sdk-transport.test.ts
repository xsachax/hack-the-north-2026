import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { type Duplex } from "node:stream";
import { once } from "node:events";
import { channel } from "node:diagnostics_channel";
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { z } from "zod";
import { createNativeSdkTransportMonitor } from "./native-sdk-transport";

const extensionId = "a".repeat(32);
const commandSchema = z.object({
  id: z.number(), method: z.string(), params: z.record(z.string(), z.unknown()).optional(), sessionId: z.string().optional(),
});
type Command = z.infer<typeof commandSchema>;
type Monitor = ReturnType<typeof createNativeSdkTransportMonitor>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

// This fixture implements only SDK startup CDP/RPC, not a browser or model runtime.
async function cdpFixture(hold?: "targets" | "stagehand") {
  const sockets = new Set<Duplex>();
  const commands: Command[] = [];
  const requests: string[] = [];
  const held = deferred<void>();
  const closed = deferred<void>();
  const errors: unknown[] = [];
  const server = createServer((_request, response) => {
    requests.push("unexpected-http");
    response.writeHead(500).end();
  });
  function send(socket: Duplex, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value));
    const header = bytes.length < 126 ? Buffer.from([0x81, bytes.length]) : Buffer.alloc(4);
    if (bytes.length >= 126) {
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(bytes.length, 2);
    }
    socket.write(Buffer.concat([header, bytes]));
  }
  function respond(socket: Duplex, command: Command) {
    if ((hold === "targets" && command.method === "Target.getTargets")
      || (hold === "stagehand" && command.method === "Runtime.evaluate"
        && String(command.params?.expression).startsWith("void globalThis.__stagehandReceiveFromHost("))) {
      held.resolve(undefined);
      return;
    }
    let result: unknown;
    if (command.method === "Target.getTargets") {
      result = { targetInfos: [{
        targetId: "owned-worker", type: "service_worker", title: "Stagehand Runtime",
        url: `chrome-extension://${extensionId}/service-worker.js`,
      }] };
    } else if (command.method === "Target.attachToTarget") {
      result = { sessionId: "owned-worker-session" };
    } else if (command.method === "Runtime.enable" || command.method === "Runtime.addBinding") {
      result = {};
    } else if (command.method === "Runtime.evaluate" && String(command.params?.expression).includes("__stagehand_runtime")) {
      result = { result: { value: {
        marker: { protocolVersion: "2.0.0", serverInfo: { name: "stagehand", version: "4.1.0" } },
        hasReceiver: true,
      } } };
    } else if (command.method === "Runtime.evaluate") {
      const expression = z.string().parse(command.params?.expression);
      const prefix = "void globalThis.__stagehandReceiveFromHost(";
      if (!expression.startsWith(prefix) || !expression.endsWith("); true")) throw new Error("unexpected-fixture-expression");
      const request = z.object({ id: z.number(), method: z.literal("stagehand.init") })
        .parse(JSON.parse(JSON.parse(expression.slice(prefix.length, -"); true".length))));
      send(socket, { id: command.id, sessionId: command.sessionId, result: { result: { value: true } } });
      send(socket, {
        method: "Runtime.bindingCalled", sessionId: command.sessionId,
        params: {
          name: "__stagehandSendToHost", executionContextId: 1,
          payload: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { initialized: true, pages: [] } }),
        },
      });
      return;
    } else {
      throw new Error("unexpected-fixture-command");
    }
    send(socket, { id: command.id, sessionId: command.sessionId, result });
  }
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.on("error", (error) => { errors.push(error); });
    socket.once("close", () => { sockets.delete(socket); closed.resolve(undefined); });
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") { socket.destroy(); return; }
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      try {
        while (buffered.length >= 2) {
          const opcode = buffered[0] & 15;
          const masked = (buffered[1] & 128) !== 0;
          let length = buffered[1] & 127;
          let offset = 2;
          if (length === 126) {
            if (buffered.length < 4) return;
            length = buffered.readUInt16BE(2);
            offset = 4;
          }
          if (!masked || length === 127) throw new Error("unsupported-fixture-frame");
          if (buffered.length < offset + 4 + length) return;
          const mask = buffered.subarray(offset, offset + 4);
          const bytes = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
          for (let i = 0; i < bytes.length; i++) bytes[i] ^= mask[i % 4];
          buffered = buffered.subarray(offset + 4 + length);
          if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
          if (opcode !== 1) throw new Error("unsupported-fixture-opcode");
          const command = commandSchema.parse(JSON.parse(bytes.toString("utf8")));
          commands.push(command);
          respond(socket, command);
        }
      } catch (error) {
        errors.push(error);
        socket.destroy();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture-address-unavailable");
  return {
    url: `ws://127.0.0.1:${address.port}/devtools/browser/owned?token=offline-only`,
    commands, requests, errors, held: held.promise, closed: closed.promise,
    terminate(index?: number) {
      if (index !== undefined) [...sockets][index]?.destroy();
      else for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
    },
  };
}

const fixtures: Awaited<ReturnType<typeof cdpFixture>>[] = [];
const monitors: Monitor[] = [];
const subscriptions: Array<{ name: string; listener: (message: unknown) => void }> = [];
let fetchSpy: MockInstance<typeof fetch>;
let timeoutSpy: MockInstance<typeof setTimeout>;
let clearTimeoutSpy: MockInstance<typeof clearTimeout>;
let unexpectedRequests: number;

async function fixture(hold?: "targets" | "stagehand") {
  const value = await cdpFixture(hold);
  fixtures.push(value);
  return value;
}
function monitor(url: string) {
  const value = createNativeSdkTransportMonitor(url);
  monitors.push(value);
  return value;
}
function subscribe(name: string, listener: (message: unknown) => void) {
  channel(name).subscribe(listener);
  subscriptions.push({ name, listener });
}
function expectInitTimersCleared(count: number) {
  const timers = timeoutSpy.mock.calls.flatMap((call, index) =>
    call[1] === 60000 ? [timeoutSpy.mock.results[index].value] : []);
  expect(timers).toHaveLength(count);
  for (const timer of timers) expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
}

beforeEach(() => {
  unexpectedRequests = 0;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider HTTP forbidden in offline transport tests"));
  timeoutSpy = vi.spyOn(globalThis, "setTimeout");
  clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
  subscribe("undici:request:create", (message) => {
    const parsed = z.object({ request: z.object({ origin: z.string(), path: z.string(), method: z.string() }) }).safeParse(message);
    if (!parsed.success || !fixtures.some((endpoint) => {
      const expected = new URL(endpoint.url);
      return parsed.data.request.origin === `http://${expected.host}` && parsed.data.request.method === "GET"
        && parsed.data.request.path.startsWith("/devtools/browser/owned");
    })) unexpectedRequests++;
  });
});
afterEach(async () => {
  for (const value of monitors.splice(0)) value.dispose();
  for (const { name, listener } of subscriptions.splice(0)) channel(name).unsubscribe(listener);
  for (const value of fixtures.splice(0)) {
    await value.close();
    expect(value.errors).toEqual([]);
    expect(value.requests).toEqual([]);
    expect(value.commands.some(({ method }) => method === "Browser.close")).toBe(false);
  }
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(unexpectedRequests).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pinned SDK local-only transport diagnostics", () => {
  it("observes real Node diagnostics for localBrowser.connect and Stagehand.create without branded browser.close", async () => {
    const endpoint = await fixture();
    const ownership = monitor(endpoint.url);
    const opens: unknown[] = [];
    const closes: unknown[] = [];
    subscribe("undici:websocket:open", (message) => { opens.push(message); });
    subscribe("undici:websocket:close", (message) => { closes.push(message); });
    const browser = await ownership.run(() => localBrowser.connect({ cdpUrl: endpoint.url, extensionId }));
    const stagehand = await ownership.run(() => Stagehand.create({
      browser, apiKey: "unit-test-native-key", logging: { level: "off" },
    }));
    expect(stagehand.initialized).toBe(true);
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({
      address: { address: "127.0.0.1", family: "IPv4", port: expect.any(Number) },
      protocol: null, extensions: null,
    });
    expectInitTimersCleared(2);
    const closing = ownership.waitForClosed(1000);
    endpoint.terminate();
    expect(await closing).toBe(true);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ websocket: expect.any(WebSocket), code: 1006, reason: "" });
    expect(endpoint.commands.map(({ method }) => method)).toEqual([
      "Target.getTargets", "Target.attachToTarget", "Runtime.enable", "Runtime.addBinding",
      "Runtime.evaluate", "Runtime.evaluate",
    ]);
  });

  it("does not accept a release attempt while the owned SDK socket remains open", async () => {
    const endpoint = await fixture();
    const ownership = monitor(endpoint.url);
    await ownership.run(() => localBrowser.connect({ cdpUrl: endpoint.url, extensionId }));
    expect(await ownership.waitForClosed(5)).toBe(false);
    endpoint.terminate();
    expect(await ownership.waitForClosed(1000)).toBe(true);
    expectInitTimersCleared(1);
  });

  it.each(["targets", "stagehand"] as const)("waits for %s initialization rejection and its SDK timeout cleanup after remote closure", async (hold) => {
    const endpoint = await fixture(hold);
    const ownership = monitor(endpoint.url);
    const browser = ownership.run(() => localBrowser.connect({ cdpUrl: endpoint.url, extensionId }));
    const initializing = hold === "targets" ? browser : ownership.run(async () => Stagehand.create({
      browser: await browser, apiKey: "unit-test-native-key", logging: { level: "off" },
    }));
    const rejected = expect(initializing).rejects.toThrow();
    await endpoint.held;
    expect(await ownership.waitForClosed(5)).toBe(false);
    endpoint.terminate();
    await rejected;
    expect(await ownership.waitForClosed(1000)).toBe(true);
    expectInitTimersCleared(hold === "targets" ? 1 : 2);
  });

  it("requires all tracked initialization promises to settle even after the actual SDK socket closes", async () => {
    const endpoint = await fixture();
    const ownership = monitor(endpoint.url);
    const connected = deferred<void>();
    const release = deferred<void>();
    const pending = ownership.run(async () => {
      const browser = await localBrowser.connect({ cdpUrl: endpoint.url, extensionId });
      connected.resolve(undefined);
      await release.promise;
      return browser;
    });
    await connected.promise;
    const socketClosed = deferred<void>();
    subscribe("undici:websocket:close", () => { socketClosed.resolve(undefined); });
    endpoint.terminate();
    await socketClosed.promise;
    expect(await ownership.waitForClosed(0)).toBe(false);
    release.resolve(undefined);
    await pending;
    expect(await ownership.waitForClosed(0)).toBe(true);
    expectInitTimersCleared(1);
  });

  it("keeps a late successful connection contained after the first bounded cleanup check fails", async () => {
    const endpoint = await fixture();
    const ownership = monitor(endpoint.url);
    const dispatch = deferred<void>();
    const pending = ownership.run(async () => {
      await dispatch.promise;
      return localBrowser.connect({ cdpUrl: endpoint.url, extensionId });
    });
    expect(await ownership.waitForClosed(5)).toBe(false);
    dispatch.resolve(undefined);
    await pending;
    expect(await ownership.waitForClosed(0)).toBe(false);
    endpoint.terminate();
    expect(await ownership.waitForClosed(1000)).toBe(true);
    expectInitTimersCleared(1);
  });

  it("does not confuse concurrent owners even when their actual CDP URLs are identical", async () => {
    const endpoint = await fixture();
    const first = monitor(endpoint.url);
    const second = monitor(endpoint.url);
    await first.run(() => localBrowser.connect({ cdpUrl: endpoint.url, extensionId }));
    await second.run(() => localBrowser.connect({ cdpUrl: endpoint.url, extensionId }));
    endpoint.terminate(1);
    expect(await second.waitForClosed(1000)).toBe(true);
    expect(await first.waitForClosed(0)).toBe(false);
    endpoint.terminate();
    expect(await first.waitForClosed(1000)).toBe(true);
    expectInitTimersCleared(2);
  });

  it("requires every owned connection to close, not just one matching URL", async () => {
    const endpoint = await fixture();
    const ownership = monitor(endpoint.url);
    await ownership.run(() => localBrowser.connect({ cdpUrl: endpoint.url, extensionId }));
    await ownership.run(() => localBrowser.connect({ cdpUrl: endpoint.url, extensionId }));
    const firstClosed = deferred<void>();
    subscribe("undici:websocket:close", () => { firstClosed.resolve(undefined); });
    endpoint.terminate(0);
    await firstClosed.promise;
    expect(await ownership.waitForClosed(0)).toBe(false);
    endpoint.terminate();
    expect(await ownership.waitForClosed(1000)).toBe(true);
    expectInitTimersCleared(2);
  });

  it.each(["same", "different"])("ignores an unrelated %s-URL socket closed outside the owned initialization scope", async (kind) => {
    const endpoint = await fixture();
    const ownership = monitor(endpoint.url);
    await ownership.run(() => localBrowser.connect({ cdpUrl: endpoint.url, extensionId }));
    const unrelated = new WebSocket(kind === "same" ? endpoint.url : endpoint.url + "-other");
    await once(unrelated, "open");
    const closed = once(unrelated, "close");
    unrelated.close();
    await closed;
    expect(await ownership.waitForClosed(0)).toBe(false);
    endpoint.terminate();
    expect(await ownership.waitForClosed(1000)).toBe(true);
  });

  it.each(["path", "query"])("rejects a scoped socket whose %s differs from the owned normalized URL", async (part) => {
    const endpoint = await fixture();
    const url = new URL(endpoint.url);
    if (part === "path") url.pathname += "-other";
    else url.searchParams.set("token", "different");
    const ownership = monitor(endpoint.url);
    await ownership.run(() => localBrowser.connect({ cdpUrl: url.href, extensionId }));
    endpoint.terminate();
    expect(await ownership.waitForClosed(1000)).toBe(false);
    expectInitTimersCleared(1);
  });

  it.each(["open", "close", "both"])("denies closure acceptance when %s diagnostics are absent", async (missing) => {
    const endpoint = await fixture();
    const opening = missing !== "close" ? vi.spyOn(channel("undici:websocket:open"), "subscribe").mockImplementation(() => {}) : undefined;
    const closing = missing !== "open" ? vi.spyOn(channel("undici:websocket:close"), "subscribe").mockImplementation(() => {}) : undefined;
    const ownership = monitor(endpoint.url);
    opening?.mockRestore();
    closing?.mockRestore();
    await ownership.run(() => localBrowser.connect({ cdpUrl: endpoint.url, extensionId }));
    endpoint.terminate();
    expect(await ownership.waitForClosed(5)).toBe(false);
    expectInitTimersCleared(1);
  });

  it("matches the normalized actual URL, including the complete query string", async () => {
    const endpoint = await fixture();
    const ownership = monitor(endpoint.url.replace("/devtools/", "/ignored/../devtools/"));
    await ownership.run(() => localBrowser.connect({ cdpUrl: endpoint.url, extensionId }));
    endpoint.terminate();
    expect(await ownership.waitForClosed(1000)).toBe(true);
    expectInitTimersCleared(1);
  });

  it.each([
    ["undici:websocket:open", null],
    ["undici:websocket:open", { address: "127.0.0.1", protocol: null, extensions: null }],
    ["undici:websocket:open", { address: { address: "127.0.0.1", family: "IPv4", port: 1 }, protocol: 1, extensions: null }],
    ["undici:websocket:close", null],
    ["undici:websocket:close", { websocket: { url: "ws://example.invalid/" }, code: 1000, reason: "" }],
  ] as const)("denies unknown scoped %s event shapes without leaking payloads", async (name, payload) => {
    const endpoint = await fixture();
    const ownership = monitor(endpoint.url);
    await ownership.run(async () => {
      const browser = await localBrowser.connect({ cdpUrl: endpoint.url, extensionId });
      channel(name).publish(payload);
      return browser;
    });
    endpoint.terminate();
    expect(await ownership.waitForClosed(1000)).toBe(false);
    expectInitTimersCleared(1);
  });
});

describe("native SDK monitor lifecycle", () => {
  it.each(["https://example.invalid/", "ws://user:secret@example.invalid/", "ws://example.invalid/#secret", "not a URL"])(
    "rejects unsupported URL input without including it in the error: %s", (url) => {
      expect(() => createNativeSdkTransportMonitor(url)).toThrow(/^native_sdk_transport_url_invalid$/);
    },
  );

  it("allows unused ownership to dispose without claiming any SDK allocation", async () => {
    const ownership = monitor("ws://example.invalid/");
    expect(await ownership.waitForClosed(0)).toBe(true);
    ownership.dispose();
    ownership.dispose();
    expect(await ownership.waitForClosed(0)).toBe(false);
    await expect(ownership.run(async () => "unused")).rejects.toThrow("native_sdk_transport_inactive");
  });

  it("does not treat a fulfilled initialization without observable transport as confirmed closure", async () => {
    const ownership = monitor("ws://example.invalid/");
    expect(await ownership.run(async () => 42)).toBe(42);
    expect(await ownership.waitForClosed(0)).toBe(false);
    await expect(ownership.run(async () => 1)).rejects.toThrow("native_sdk_transport_inactive");
  });

  it("propagates initialization errors and requires transport evidence even after rejection", async () => {
    const ownership = monitor("ws://example.invalid/");
    const failure = new Error("initialization failed");
    await expect(ownership.run(() => { throw failure; })).rejects.toBe(failure);
    expect(await ownership.waitForClosed(0)).toBe(false);
  });

  it("bounds waiting and clears its timer when disposing concurrent waiters", async () => {
    vi.useFakeTimers();
    const ownership = monitor("ws://example.invalid/");
    await ownership.run(async () => undefined);
    const timed = ownership.waitForClosed(25);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(24);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await timed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const first = ownership.waitForClosed(1000);
    const second = ownership.waitForClosed(1000);
    expect(vi.getTimerCount()).toBe(2);
    ownership.dispose();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unsubscribes both public diagnostic listeners exactly once", () => {
    const opening = vi.spyOn(channel("undici:websocket:open"), "unsubscribe");
    const closing = vi.spyOn(channel("undici:websocket:close"), "unsubscribe");
    const ownership = monitor("ws://example.invalid/");
    ownership.dispose();
    ownership.dispose();
    expect(opening).toHaveBeenCalledOnce();
    expect(closing).toHaveBeenCalledOnce();
  });

  it.each([-1, NaN, Infinity, 0.5, 2147483648])("rejects invalid wait duration %s", async (milliseconds) => {
    const ownership = monitor("ws://example.invalid/");
    await expect(ownership.waitForClosed(milliseconds)).rejects.toThrow("native_sdk_transport_timeout_invalid");
  });
});
