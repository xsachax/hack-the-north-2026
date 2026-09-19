import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import type { AddressInfo, Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { proxyValue } from "../../src/server/execution/native-policy-extension/policy.js";
import { assertWorkerChannelProof } from "./channel-proof";

const workerProbe = `
async function probe(address, reply) {
  if (typeof WebTransport === 'undefined') { reply.postMessage('unavailable'); return; }
  const connection = new WebTransport(address, {
    serverCertificateHashes: [{algorithm: 'sha-256', value: new Uint8Array(32)}]
  });
  void connection.closed.catch(() => {});
  void connection.ready.catch(() => {});
  await new Promise(done => setTimeout(done, 1600));
  connection.close();
  reply.postMessage('available');
}`;

type PolicyGlobal = typeof globalThis & {
  chrome: { proxy: { settings: {
    clear(options: { scope: string }): Promise<void>;
    set(options: { scope: string; value: typeof proxyValue }): Promise<void>;
  } } };
};

test("native policy blocks WebTransport packets from every exposed worker kind", async () => {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    if (request.url === "/sw.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(`${workerProbe}
        self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('message', event => event.waitUntil(probe(event.data, event.ports[0])));`);
    } else response.end("<!doctype html><body>Owned secure loopback source</body>");
  });
  server.on("connection", (socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const baseline = new Map<string, string>();
  const extension = resolve("src/server/execution/native-policy-extension");
  try {
    for (const protectedLane of [false, true]) {
      const directory = await mkdtemp(join(tmpdir(), "flash-flood-worker-channels-"));
      let context: BrowserContext | undefined;
      try {
        context = await chromium.launchPersistentContext(directory, {
          channel: "chromium", headless: true, serviceWorkers: "allow",
          args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
        });
        const policyWorker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
        await expect.poll(() => policyWorker.evaluate(() => Reflect.get(globalThis, "flashFloodNativePolicy")))
          .toMatchObject({ ready: true, fault: null });
        await policyWorker.evaluate(async () => {
          const chrome = (globalThis as PolicyGlobal).chrome;
          await chrome.proxy.settings.clear({ scope: "regular" });
        });
        const page = context.pages()[0];
        await page.goto(origin);
        expect(await page.evaluate(() => isSecureContext)).toBe(true);
        await page.evaluate(async () => {
          await navigator.serviceWorker.register("/sw.js");
          await navigator.serviceWorker.ready;
        });
        if (protectedLane) {
          await policyWorker.evaluate(async (value) => {
            const chrome = (globalThis as PolicyGlobal).chrome;
            await chrome.proxy.settings.set({ value, scope: "regular" });
          }, proxyValue);
        }
        for (const kind of ["classic", "module", "shared", "service"] as const) {
          // Independent ports separate initial QUIC packets from earlier retries.
          const udp = createSocket("udp4");
          let packets = 0;
          udp.on("message", () => { packets++; });
          await new Promise<void>((done) => udp.bind(0, "127.0.0.1", done));
          try {
            const address = `https://127.0.0.1:${udp.address().port}/worker-transport`;
            const availability = await page.evaluate(async ({ kind, workerProbe, address }) => {
              const channel = new MessageChannel();
              let worker: Worker | SharedWorker | undefined;
              let url: string | undefined;
              let timer: number | undefined;
              const result = new Promise<string>((done, reject) => {
                timer = window.setTimeout(() => reject(new Error("worker_channel_probe_timeout")), 5000);
                channel.port1.onmessage = (event) => { clearTimeout(timer); done(event.data); };
              });
              try {
                if (kind === "service") {
                  const registration = await navigator.serviceWorker.ready;
                  registration.active!.postMessage(address, [channel.port2]);
                } else {
                  const handler = kind === "shared"
                    ? "onconnect = event => { event.ports[0].onmessage = message => probe(message.data.address, message.ports[0]); };"
                    : "onmessage = event => probe(event.data.address, event.ports[0]);";
                  url = URL.createObjectURL(new Blob([workerProbe, handler], { type: "text/javascript" }));
                  if (kind === "shared") {
                    worker = new SharedWorker(url);
                    worker.port.postMessage({ address }, [channel.port2]);
                  } else {
                    worker = new Worker(url, { type: kind });
                    worker.postMessage({ address }, [channel.port2]);
                  }
                }
                return await result;
              } finally {
                clearTimeout(timer);
                if (worker instanceof Worker) worker.terminate();
                else if (worker) worker.port.close();
                if (url) URL.revokeObjectURL(url);
                channel.port1.close();
              }
            }, { kind, workerProbe, address });
            assertWorkerChannelProof(kind, availability, packets, protectedLane);
            if (protectedLane) {
              expect(availability, kind).toBe(baseline.get(kind));
            } else {
              baseline.set(kind, availability);
            }
          } finally { await new Promise<void>((done) => udp.close(done)); }
        }
      } finally {
        await context?.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
    for (const kind of ["classic", "module", "shared", "service"]) expect(baseline.get(kind), kind).toBe("available");
    console.log("Native worker WebTransport exposure:", Object.fromEntries(baseline));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
});
