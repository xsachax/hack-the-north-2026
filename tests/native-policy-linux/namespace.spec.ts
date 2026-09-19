import { test, expect, chromium, type BrowserContext, type Worker } from "@playwright/test";
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer, type Server } from "node:http";
import { createConnection, createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { proxyValue } from "../../src/server/execution/native-policy-extension/policy.js";

const ips = ["10.77.0.1", "169.254.77.1", "::1", "fd00::1"];
const hostname = "owned-rebind.test";
type PolicyState = { ready: boolean; fault: string | null; proxyErrors: number };
type ChromeSetting = { get(options: object): Promise<{ value: unknown; levelOfControl: string }> };
type ExtensionGlobal = typeof globalThis & {
  flashFloodNativePolicy: PolicyState;
  chrome: {
    proxy: { settings: ChromeSetting & { clear(options: { scope: string }): Promise<void> } };
    privacy: { network: {
      webRTCIPHandlingPolicy: ChromeSetting;
      networkPredictionEnabled: ChromeSetting;
    } };
  };
};

async function verifyIsolation() {
  assert.equal(process.platform, "linux", "Run via scripts/native-policy-linux.ts on Linux");
  const scratch = process.env.NATIVE_POLICY_LINUX_SCRATCH;
  const hostNet = process.env.NATIVE_POLICY_LINUX_HOST_NET;
  const hostMount = process.env.NATIVE_POLICY_LINUX_HOST_MOUNT;
  assert(scratch && hostNet && hostMount, "Namespace launcher is mandatory");
  assert.notEqual(await readlink("/proc/self/ns/net"), hostNet, "Must not use host networking");
  assert.notEqual(await readlink("/proc/self/ns/mnt"), hostMount, "Must not use host mounts");
  assert.equal(await readFile("/etc/resolv.conf", "utf8"), "nameserver 127.0.0.1\noptions timeout:1 attempts:1\n");
  return scratch;
}

async function readPolicy(worker: Worker) {
  return worker.evaluate(async () => {
    const global = globalThis as ExtensionGlobal;
    const network = global.chrome.privacy.network;
    return {
      state: global.flashFloodNativePolicy,
      proxy: await global.chrome.proxy.settings.get({ incognito: false }),
      rtc: await network.webRTCIPHandlingPolicy.get({}),
      prediction: await network.networkPredictionEnabled.get({}),
    };
  });
}

async function expectPolicy(worker: Worker) {
  await expect.poll(() => readPolicy(worker)).toMatchObject({
    state: { ready: true, fault: null },
    proxy: { value: proxyValue, levelOfControl: "controlled_by_this_extension" },
    rtc: { value: "disable_non_proxied_udp", levelOfControl: "controlled_by_this_extension" },
    prediction: { value: false, levelOfControl: "controlled_by_this_extension" },
  });
}

async function proveClosedProxy() {
  const endpoint = { host: "127.0.0.1", port: 65534 };
  for (const proxy of [proxyValue.rules.proxyForHttp, proxyValue.rules.proxyForHttps, proxyValue.rules.fallbackProxy]) {
    expect(proxy).toMatchObject(endpoint);
  }
  const guard = createTcpServer();
  try {
    await new Promise<void>((done, reject) => {
      guard.once("error", reject);
      guard.listen(endpoint, done);
    });
  } finally {
    if (guard.listening) await new Promise<void>((done, reject) => {
      guard.close((error) => error ? reject(error) : done());
    });
  }
  const probe = createConnection(endpoint);
  try {
    const error = await new Promise<NodeJS.ErrnoException>((done, reject) => {
      probe.once("error", done);
      probe.once("connect", () => reject(new Error("The deny proxy endpoint unexpectedly accepted a connection")));
      probe.setTimeout(2000, () => reject(new Error("The deny proxy endpoint did not refuse promptly")));
    });
    expect(error.code).toBe("ECONNREFUSED");
  } finally { probe.destroy(); }
}

async function launch(scratch: string) {
  await proveClosedProxy();
  const profile = await mkdtemp(join(scratch, "profile-"));
  const extension = resolve("src/server/execution/native-policy-extension");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      serviceWorkers: "allow",
      timeout: 15_000,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        // Use the namespace resolver, never DoH or a host resolver mapping.
        "--disable-features=DnsOverHttps",
      ],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
    await expectPolicy(worker);
    return { context, worker, close: async () => {
      try { await context!.close(); } finally { await rm(profile, { recursive: true, force: true }); }
    } };
  } catch (error) {
    try { await context?.close(); } finally { await rm(profile, { recursive: true, force: true }); }
    throw error;
  }
}

async function sentinels() {
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  const connections = new Map(ips.map((ip) => [ip, 0]));
  const hits: { ip: string; path: string }[] = [];
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise<void>((done) => server.close(() => done()))));
  };
  let port = 0;
  try {
    for (const ip of ips) {
      const server = createServer((request, response) => {
        hits.push({ ip, path: request.url ?? "" });
        response.setHeader("cache-control", "no-store");
        response.setHeader("connection", "close");
        response.end(`owned sentinel ${ip}`);
      });
      servers.push(server);
      server.on("connection", (socket) => {
        connections.set(ip, connections.get(ip)! + 1);
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen({ host: ip, port, ipv6Only: ip.includes(":") }, done);
      });
      port = (server.address() as AddressInfo).port;
    }
    return { port, hits, connections, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function dns() {
  const socket = createSocket("udp4");
  let address = ips[0];
  const answers: string[] = [];
  const errors: Error[] = [];
  socket.on("error", (error) => errors.push(error));
  socket.on("message", (query, remote) => {
    // A deliberately tiny authoritative responder: one uncompressed question,
    // A for our exact .test name, NODATA for AAAA, NXDOMAIN for other names.
    if (query.length < 12 || query.readUInt16BE(4) !== 1 || (query[2] & 0x80)) return;
    let end = 12;
    const labels: string[] = [];
    while (end < query.length && query[end] !== 0) {
      const length = query[end++];
      if (length > 63 || end + length > query.length) return;
      labels.push(query.toString("ascii", end, end + length));
      end += length;
    }
    if (end + 5 > query.length) return;
    const type = query.readUInt16BE(end + 1);
    const klass = query.readUInt16BE(end + 3);
    const owned = labels.join(".").toLowerCase() === hostname && klass === 1;
    const answer = owned && type === 1;
    const header = Buffer.alloc(12);
    query.copy(header, 0, 0, 2);
    header.writeUInt16BE(0x8480 | (query.readUInt16BE(2) & 0x0100) | (owned ? 0 : 3), 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(answer ? 1 : 0, 6);
    const parts = [header, query.subarray(12, end + 5)];
    if (answer) {
      // Pointer to question, A/IN, TTL zero, four address bytes.
      parts.push(Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, ...address.split(".").map(Number)]));
      answers.push(address);
    }
    socket.send(Buffer.concat(parts), remote.port, remote.address, (error) => { if (error) errors.push(error); });
  });
  await new Promise<void>((done, reject) => {
    socket.once("error", reject);
    socket.bind(53, "127.0.0.1", done);
  });
  return {
    answers, errors,
    rebind: (ip: string) => { assert(ips.slice(0, 2).includes(ip)); address = ip; },
    close: () => new Promise<void>((done) => socket.close(() => done())),
  };
}

test("native proxy blocks private/link-local/IPv6 across fresh-process DNS answer changes", async () => {
  const scratch = await verifyIsolation();
  const sentinel = await sentinels();
  let resolver: Awaited<ReturnType<typeof dns>> | undefined;
  try {
    resolver = await dns();
    // Full process teardown between lanes flushes DNS and socket pools. The
    // same hostname/port must really resolve to each controlled address.
    for (const [index, address] of ips.slice(0, 2).entries()) {
      resolver.rebind(address);
      const control = await launch(scratch);
      try {
        await control.worker.evaluate(async () => {
          await (globalThis as ExtensionGlobal).chrome.proxy.settings.clear({ scope: "regular" });
        });
        await expect.poll(async () => (await readPolicy(control.worker)).proxy.levelOfControl)
          .not.toBe("controlled_by_this_extension");
        const cleared = (await readPolicy(control.worker)).proxy.value as { mode: string };
        expect(["direct", "system"]).toContain(cleared.mode);
        const page = control.context.pages()[0];
        for (const ip of ips) {
          const url = `http://${ip.includes(":") ? `[${ip}]` : ip}:${sentinel.port}/positive-${index}`;
          const before = sentinel.connections.get(ip)!;
          expect((await page.goto(url, { timeout: 5000 }))?.status()).toBe(200);
          expect(await page.textContent("body")).toBe(`owned sentinel ${ip}`);
          expect(sentinel.connections.get(ip)).toBeGreaterThan(before);
        }
        const beforeAnswers = resolver.answers.length;
        const response = await page.goto(`http://${hostname}:${sentinel.port}/rebind-${index}`, { timeout: 5000 });
        expect(response?.status()).toBe(200);
        expect(await page.textContent("body")).toBe(`owned sentinel ${address}`);
        expect(resolver.answers.slice(beforeAnswers)).toContain(address);
        expect(sentinel.hits).toContainEqual({ ip: address, path: `/rebind-${index}` });
      } finally { await control.close(); }

      const blocked = await launch(scratch);
      try {
        console.log(`Linux native policy: Chromium ${blocked.context.browser()?.version()}, DNS phase ${address}`);
        const connectionsBefore = [...sentinel.connections.entries()];
        const hitsBefore = [...sentinel.hits];
        const page = blocked.context.pages()[0];
        for (let retry = 0; retry < 2; retry++) {
          for (const host of [...ips, hostname]) {
            const url = `http://${host.includes(":") ? `[${host}]` : host}:${sentinel.port}/blocked-${index}-${retry}`;
            await expect(page.goto(url, { timeout: 5000 })).rejects.toThrow("ERR_PROXY_CONNECTION_FAILED");
          }
        }
        await expectPolicy(blocked.worker);
        await proveClosedProxy();
        expect([...sentinel.connections.entries()]).toEqual(connectionsBefore);
        expect(sentinel.hits).toEqual(hitsBefore);
      } finally { await blocked.close(); }
    }
    expect(resolver.answers).toContain(ips[0]);
    expect(resolver.answers).toContain(ips[1]);
    expect(resolver.errors).toEqual([]);
  } finally {
    try { await resolver?.close(); } finally { await sentinel.close(); }
  }
});
