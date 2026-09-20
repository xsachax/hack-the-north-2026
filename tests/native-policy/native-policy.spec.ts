import { test, expect, chromium, type BrowserContext, type Frame, type Page, type Worker as PlaywrightWorker } from "@playwright/test";
import { createServer } from "node:http";
import { createServer as createTcpServer,type AddressInfo,type Socket } from "node:net";
import { createSocket } from "node:dgram";
import type { Duplex } from "node:stream";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { createHash,X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve,join } from "node:path";
import { proxyValue } from "../../src/server/execution/native-policy-extension/policy.js";
import { verifyNativeWebRtcPreferences } from "../../src/server/execution/native-policy-attestation";

type PolicyState={ ready: boolean; fault: string|null; proxyErrors: number };
type ProbeWindow = typeof globalThis & { nativeWorkerProbe: () => Promise<boolean[]> };
type ExtensionGlobal=typeof globalThis&{
  flashFloodNativePolicy: PolicyState;
  chrome: {
    proxy: {
      settings: {
        clear(options: { scope: string }): Promise<void>;
        set(options: { scope: string; value: typeof proxyValue }): Promise<void>;
      }
    };
    privacy: {
      network: {
        webRTCIPHandlingPolicy: { clear(options: { scope: string }): Promise<void> };
        networkPredictionEnabled: { clear(options: { scope: string }): Promise<void> };
      }
    };
  };
};

const cleanup = new Set<() => Promise<void>>();
test.afterEach(async () => {
  const results = await Promise.allSettled([...cleanup].map((close) => close()));
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, "native_probe_cleanup_failed");
});

async function state(worker: PlaywrightWorker): Promise<PolicyState> {
  return worker.evaluate(() => (globalThis as ExtensionGlobal).flashFloodNativePolicy);
}

async function fixture() {
  const sockets=new Set<Socket>();
  const hits: string[]=[];
  let connections=0;
  const server=createServer((request,response) => {
    hits.push(request.url??"");
    response.setHeader("cache-control","no-store");
    response.setHeader("content-type",request.url?.endsWith(".js")? "text/javascript":"text/html");
    if(request.url==="/worker.js") response.end("fetch('/worker-fetch');");
    else if(request.url==="/shared.js") response.end("onconnect = () => fetch('/shared-fetch');");
    else if(request.url==="/sw.js") response.end("self.addEventListener('install', event => event.waitUntil(fetch('/sw-fetch')));");
    else if(request.url==="/active-sw.js") response.end(`
      self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('message', event => event.waitUntil(
        fetch('/active-sw-fetch').then(() => event.ports[0].postMessage(true), () => event.ports[0].postMessage(false))
      ));
    `);
    else if(request.url==="/redirect") { response.writeHead(302,{ location: "/redirect-destination" }); response.end(); }
    else response.end("<!doctype html><title>Owned policy sentinel</title><body>Owned policy sentinel</body>");
  });
  server.on("connection",(socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close",() => sockets.delete(socket));
  });
  server.on("upgrade",(request,socket) => { hits.push(request.url??""); socket.destroy(); });
  await new Promise<void>((done) => server.listen(0,"127.0.0.1",done));
  const port=(server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    } finally { cleanup.delete(close); }
  })();
  cleanup.add(close);
  return {
    origin: `http://127.0.0.1:${port}`,port,hits,
    connections: () => connections,
    reset: () => { hits.length=0; connections=0; },
    close,
  };
}

async function launch(extraArguments: string[] = [], preferences?: object) {
  // Refuse to run if our intentionally closed endpoint is already occupied.
  const guard=createTcpServer();
  await new Promise<void>((done,reject) => {
    guard.once("error",reject);
    guard.listen(proxyValue.rules.proxyForHttp.port,"127.0.0.1",done);
  });
  await new Promise<void>((done) => guard.close(() => done()));
  const directory=await mkdtemp(join(tmpdir(),"flash-flood-native-"));
  const extension=resolve("src/server/execution/native-policy-extension");
  let context: BrowserContext|undefined;
  try {
    if (preferences) {
      await mkdir(join(directory, "Default"), { mode: 0o700 });
      await writeFile(join(directory, "Default", "Preferences"), JSON.stringify(preferences), { mode: 0o600 });
    }
    context = await chromium.launchPersistentContext(directory, {
      channel: "chromium",headless: true,
      args: [`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,...extraArguments],
      serviceWorkers: "allow",
    });
    const worker=context.serviceWorkers()[0]??await context.waitForEvent("serviceworker");
    await expect.poll(() => state(worker)).toMatchObject({ ready: true,fault: null });
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      try {
        await context!.close();
        await rm(directory,{ recursive: true,force: true });
      } finally { cleanup.delete(close); }
    })();
    cleanup.add(close);
    return {
      context, worker, close,
    };
  } catch(error) {
    await context?.close();
    await rm(directory,{ recursive: true,force: true });
    throw error;
  }
}

async function clearForPositiveControl(worker: PlaywrightWorker) {
  await worker.evaluate(async () => {
    const api=(globalThis as ExtensionGlobal).chrome;
    await api.proxy.settings.clear({ scope: "regular" });
    await api.privacy.network.webRTCIPHandlingPolicy.clear({ scope: "regular" });
    await api.privacy.network.networkPredictionEnabled.clear({ scope: "regular" });
  });
}

test("native proxy alone blocks navigation, aliases and fallback after repeated failures",async () => {
  const sentinel=await fixture();
  const browser=await launch();
  try {
    const page=browser.context.pages()[0];
    console.log(`Native policy browser: ${browser.context.browser()?.version()}`);
    for(const hostname of ["127.0.0.1","127.1","2130706433","0x7f000001","[::ffff:127.0.0.1]","localhost"]) {
      const url=`http://${hostname}:${sentinel.port}/redirect`;
      await expect(page.goto(url,{ timeout: 5000 })).rejects.toThrow("ERR_PROXY_CONNECTION_FAILED");
    }
    expect(sentinel.connections()).toBe(0);
    expect(sentinel.hits).toEqual([]);
    expect(await state(browser.worker)).toMatchObject({ ready: true,fault: null });
    // A rejected goto can still commit Chrome's error document; settle that page first.
    await page.close();
    await clearForPositiveControl(browser.worker);
    const positive=await browser.context.newPage();
    for(const hostname of ["127.0.0.1","127.1","2130706433","0x7f000001","[::ffff:127.0.0.1]","localhost"]) {
      await positive.goto(`http://${hostname}:${sentinel.port}/redirect`);
    }
    expect(sentinel.hits.filter((path) => path==="/redirect-destination")).toHaveLength(6);
    expect(sentinel.connections()).toBeGreaterThan(0);
    await expect.poll(() => state(browser.worker)).toMatchObject({ ready: false,fault: "native_policy_changed" });
  } finally { await browser.close(); await sentinel.close(); }
});

test("preloaded page frames, fetch, WS, workers and preconnect cannot escape native proxy",async () => {
  const sentinel=await fixture();
  const browser=await launch();
  try {
    await clearForPositiveControl(browser.worker);
    const page=browser.context.pages()[0];
    await page.goto(sentinel.origin);
    const probe=async () => page.evaluate(async () => {
      const paths=["/fetch","/redirect"];
      await Promise.all(paths.map((path) => fetch(path).catch(() => null)));
      const image=new Image(); image.src="/image"; document.body.append(image);
      const frame=document.createElement("iframe"); frame.src="/frame"; document.body.append(frame);
      const srcdoc=document.createElement("iframe");
      srcdoc.srcdoc="<img src='/srcdoc-image'>"; document.body.append(srcdoc);
      const classic=new Worker("/worker.js");
      const moduleWorker=new Worker("/worker.js",{ type: "module" });
      const shared=new SharedWorker("/shared.js"); shared.port.start();
      const socket=new WebSocket(location.origin.replace("http:","ws:")+"/ws");
      socket.onerror=() => { };
      await navigator.serviceWorker.register("/sw.js").catch(() => null);
      const preconnect=document.createElement("link");
      preconnect.rel="preconnect"; preconnect.href=location.origin; document.head.append(preconnect);
      await new Promise((done) => setTimeout(done,1500));
      classic.terminate(); moduleWorker.terminate(); shared.port.close(); socket.close();
      for(const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
      document.querySelectorAll("iframe,img,link").forEach((element) => element.remove());
    });
    await probe();
    for(const path of ["/fetch","/redirect-destination","/image","/frame","/srcdoc-image",
      "/worker.js","/worker-fetch","/shared.js","/shared-fetch","/sw.js","/sw-fetch","/ws"]) {
      expect(sentinel.hits,`positive control ${path}`).toContain(path);
    }
    await browser.worker.evaluate(async (value) => {
      await (globalThis as ExtensionGlobal).chrome.proxy.settings.set({ value,scope: "regular" });
    },proxyValue);
    const readiness = await browser.context.newPage();
    try {
      await expect(readiness.goto(`${sentinel.origin}/policy-ready`, { timeout: 5000 }))
        .rejects.toThrow("ERR_PROXY_CONNECTION_FAILED");
      expect(sentinel.hits).not.toContain("/policy-ready");
    } finally { await readiness.close(); }
    sentinel.reset();
    await probe();
    expect(sentinel.hits).toEqual([]);
    expect(sentinel.connections()).toBe(0);
  } finally { await browser.close(); await sentinel.close(); }
});

test("HTTPS, WSS and WebTransport cannot escape, with positive TLS and QUIC packet controls",async () => {
  const directory=await mkdtemp(join(tmpdir(),"flash-flood-native-tls-"));
  const keyPath=join(directory,"key.pem");
  const certPath=join(directory,"cert.pem");
  let browser: Awaited<ReturnType<typeof launch>>|undefined;
  const sockets=new Set<Duplex>();
  const hits: string[]=[];
  let connections=0;
  let datagrams=0;
  const udp=createSocket("udp4");
  let udpBound=false;
  let server: ReturnType<typeof createHttpsServer>|undefined;
  try {
    execFileSync("openssl",[
      "req","-x509","-newkey","ec","-pkeyopt","ec_paramgen_curve:P-256",
      "-nodes","-days","1","-subj","/CN=127.0.0.1",
      "-addext","subjectAltName=IP:127.0.0.1","-keyout",keyPath,"-out",certPath,
    ],{ stdio: "ignore" });
    const [key,cert]=await Promise.all([readFile(keyPath),readFile(certPath)]);
    const certificate=new X509Certificate(cert);
    const spki=createHash("sha256").update(certificate.publicKey.export({ type: "spki",format: "der" })).digest("base64");
    const certificateHash=Array.from(createHash("sha256").update(certificate.raw).digest());
    server=createHttpsServer({ key,cert },(request,response) => {
      hits.push(request.url??"");
      response.setHeader("cache-control","no-store");
      if(request.url==="/redirect") { response.writeHead(302,{ location: "/destination" }); response.end(); }
      else response.end("<!doctype html><body>Owned TLS sentinel</body>");
    });
    server.on("connection",(socket) => {
      connections++; sockets.add(socket); socket.on("close",() => sockets.delete(socket));
    });
    server.on("upgrade",(request,socket) => { hits.push(request.url??""); socket.destroy(); });
    await new Promise<void>((done) => server!.listen(0,"127.0.0.1",done));
    udp.on("message",() => { datagrams++; });
    await new Promise<void>((done) => udp.bind(0,"127.0.0.1",done));
    udpBound=true;
    const origin=`https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const transportUrl=`https://127.0.0.1:${udp.address().port}/owned-transport`;
    // Trust only this ephemeral test certificate, not arbitrary invalid TLS.
    browser=await launch([`--ignore-certificate-errors-spki-list=${spki}`]);
    await clearForPositiveControl(browser.worker);
    let page=browser.context.pages()[0];
    await page.goto(origin+"/redirect");
    expect(hits).toContain("/destination");
    expect(await page.evaluate(() => isSecureContext)).toBe(true);
    const probe=() => page.evaluate(async ({ origin,transportUrl,certificateHash }) => {
      await fetch(origin+"/fetch").catch(() => null);
      const image=new Image(); image.src=origin+"/image"; document.body.append(image);
      const frame=document.createElement("iframe"); frame.src=origin+"/frame"; document.body.append(frame);
      const socket=new WebSocket(origin.replace("https:","wss:")+"/wss"); socket.onerror=() => { };
      const transport=new WebTransport(transportUrl,{
        serverCertificateHashes: [{ algorithm: "sha-256",value: new Uint8Array(certificateHash) }],
      });
      const errors: string[]=[];
      void transport.closed.catch(() => { });
      void transport.ready.catch((error: Error) => errors.push(error.message));
      await new Promise((done) => setTimeout(done,1800));
      transport.close(); socket.close();
      document.querySelectorAll("iframe,img").forEach((element) => element.remove());
      return errors;
    },{ origin,transportUrl,certificateHash });
    await probe();
    for(const path of ["/fetch","/image","/frame","/wss"]) expect(hits,`TLS positive ${path}`).toContain(path);
    expect(datagrams,"positive WebTransport actually sends QUIC to the owned UDP listener").toBeGreaterThan(0);
    // Closing a connecting WebTransport is asynchronous. End the positive
    // browser so its outstanding QUIC retries cannot contaminate negatives.
    await browser.close();
    browser=await launch([`--ignore-certificate-errors-spki-list=${spki}`]);
    await clearForPositiveControl(browser.worker);
    page=browser.context.pages()[0];
    await page.goto(origin);
    await browser.worker.evaluate(async (value) => {
      await (globalThis as ExtensionGlobal).chrome.proxy.settings.set({ value,scope: "regular" });
    },proxyValue);
    hits.length=0; connections=0; datagrams=0;
    const errors=await probe();
    expect(errors).toHaveLength(1);
    expect(hits).toEqual([]);
    expect(connections).toBe(0);
    expect(datagrams).toBe(0);
    await expect(page.goto(origin+"/redirect",{ timeout: 5000 })).rejects.toThrow("ERR_PROXY_CONNECTION_FAILED");
    expect(connections).toBe(0);
  } finally {
    await browser?.close();
    for(const socket of sockets) socket.destroy();
    if(server?.listening) await new Promise<void>((done) => server!.close(() => done()));
    if(udpBound) await new Promise<void>((done) => udp.close(done));
    await rm(directory,{ recursive: true,force: true });
  }
});

test("policy remains in the native network stack after extension worker termination",async () => {
  const sentinel=await fixture();
  const browser=await launch();
  try {
    const page=browser.context.pages()[0];
    const cdp=await browser.context.newCDPSession(page);
    let runningStatus="";
    cdp.on("ServiceWorker.workerVersionUpdated",({ versions }) => {
      const version=versions.find((candidate) => candidate.scriptURL===browser.worker.url());
      if(version) runningStatus=version.runningStatus;
    });
    await cdp.send("ServiceWorker.enable");
    await expect.poll(() => runningStatus).toBe("running");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await expect.poll(() => runningStatus).toBe("stopped");
    await expect(page.goto(sentinel.origin,{ timeout: 5000 })).rejects.toThrow("ERR_PROXY_CONNECTION_FAILED");
    expect(sentinel.connections()).toBe(0);
    await cdp.send("ServiceWorker.startWorker",{ scopeURL: new URL("./",browser.worker.url()).href });
    await expect.poll(() => runningStatus).toBe("running");
    await expect(page.goto(sentinel.origin,{ timeout: 5000 })).rejects.toThrow("ERR_PROXY_CONNECTION_FAILED");
    expect(sentinel.connections()).toBe(0);
    await cdp.detach();
  } finally { await browser.close(); await sentinel.close(); }
});
test("page and srcdoc WebRTC STUN and TURN UDP/TCP have reachable positive controls", async () => {
  const sentinel=await fixture();
  const udp=createSocket("udp4");
  let datagrams=0;
  udp.on("message",() => { datagrams++; });
  await new Promise<void>((done) => udp.bind(0,"127.0.0.1",done));
  const udpPort=udp.address().port;
  let browser: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    browser = await launch();
    const page=browser.context.pages()[0];
    await page.goto("about:blank");
    await page.setContent("<!doctype html><iframe srcdoc='<!doctype html><body>Owned child frame</body>'></iframe>");
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (!frame) throw new Error("native_probe_frame_missing");
    const probe = async (url: string, realm: Page | Frame) => realm.evaluate(async (address) => {
      const connection=new RTCPeerConnection({
        iceServers: [{ urls: address,username: "owned-probe",credential: "not-a-secret" }],
      });
      connection.createDataChannel("owned");
      await connection.setLocalDescription(await connection.createOffer());
      await new Promise<void>((done) => {
        const timeout=setTimeout(done,2200);
        connection.onicegatheringstatechange=() => {
          if(connection.iceGatheringState==="complete") { clearTimeout(timeout); done(); }
        };
      });
      connection.close();
    },url);
    const urls=[
      `stun:127.0.0.1:${udpPort}`,
      `turn:127.0.0.1:${udpPort}?transport=udp`,
      `turn:127.0.0.1:${sentinel.port}?transport=tcp`,
    ];
    for (const realm of [page, frame]) for (const url of urls) await probe(url, realm);
    expect(datagrams).toBe(0);
    expect(sentinel.connections()).toBe(0);
    await clearForPositiveControl(browser.worker);
    for (const realm of [page, frame]) for (const url of urls) {
      const before=url.endsWith("tcp")? sentinel.connections():datagrams;
      await probe(url, realm);
      expect(url.endsWith("tcp")? sentinel.connections():datagrams,`positive control ${url}`).toBeGreaterThan(before);
    }
  } finally {
    await browser?.close(); await sentinel.close();
    await new Promise<void>((done) => udp.close(done));
  }
});

test("already running classic, module, shared and service workers remain behind the native proxy",async () => {
  const sentinel=await fixture();
  const browser=await launch();
  try {
    await clearForPositiveControl(browser.worker);
    const page=browser.context.pages()[0];
    await page.goto(sentinel.origin);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/active-sw.js");
      await navigator.serviceWorker.ready;
    });
    await page.evaluate(async () => {
      const workers: Worker[] = [];
      for (const type of ["classic", "module"] as const) {
        const source = `onmessage = () => fetch('${location.origin}/active-${type}-fetch').then(() => postMessage(true), () => postMessage(false));`;
        const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const worker = new Worker(url, { type });
        workers.push(worker);
      }
      const url = URL.createObjectURL(new Blob([
        `onconnect = event => { const port = event.ports[0]; port.onmessage = () => fetch('${location.origin}/active-shared-fetch').then(() => port.postMessage(true), () => port.postMessage(false)); };`,
      ], { type: "text/javascript" }));
      const shared = new SharedWorker(url);
      const registration = await navigator.serviceWorker.ready;
      (globalThis as ProbeWindow).nativeWorkerProbe = async () => {
        const outcomes: boolean[] = [];
        for (const worker of [...workers, shared.port]) {
          outcomes.push(await new Promise<boolean>((done, reject) => {
            const timer = setTimeout(() => reject(new Error("worker_probe_timeout")), 4000);
            worker.onmessage = (event) => { clearTimeout(timer); done(event.data); };
            worker.postMessage("probe");
          }));
        }
        const channel = new MessageChannel();
        try {
          outcomes.push(await new Promise<boolean>((done, reject) => {
            const timer = setTimeout(() => reject(new Error("sw_probe_timeout")), 4000);
            channel.port1.onmessage = (event) => { clearTimeout(timer); done(event.data); };
            registration.active!.postMessage("probe", [channel.port2]);
          }));
        } finally { channel.port1.close(); }
        return outcomes;
      };
    });
    const probe = () => page.evaluate(() => (globalThis as ProbeWindow).nativeWorkerProbe());
    expect(await probe()).toEqual([true,true,true,true]);
    for(const path of ["/active-classic-fetch","/active-module-fetch","/active-shared-fetch","/active-sw-fetch"]) {
      expect(sentinel.hits).toContain(path);
    }
    await browser.worker.evaluate(async (value) => {
      await (globalThis as ExtensionGlobal).chrome.proxy.settings.set({ value,scope: "regular" });
    },proxyValue);
    sentinel.reset();
    expect(await probe()).toEqual([false,false,false,false]);
    expect(sentinel.connections()).toBe(0);
    expect(sentinel.hits).toEqual([]);
  } finally { await browser.close(); await sentinel.close(); }
});

test("native preference attestation rejects effective per-origin WebRTC overrides", async () => {
  const source = await fixture();
  const udp = createSocket("udp4");
  let packets = 0;
  udp.on("message", () => { packets++; });
  await new Promise<void>((done) => udp.bind(0, "127.0.0.1", done));
  try {
    for (const overrides of [[], [{ url: source.origin, handling: "default" }]]) {
      const browser = await launch([], { webrtc: { ip_handling_url: overrides } });
      try {
        // The extension's global readback alone misses this effective override.
        expect(await state(browser.worker)).toMatchObject({ ready: true, fault: null });
        for (let read = 0; read < 2; read++) {
          if (overrides.length) {
            await expect(verifyNativeWebRtcPreferences(browser.context)).rejects.toThrow("native_webrtc_preferences_rejected");
          } else await verifyNativeWebRtcPreferences(browser.context);
          expect(browser.context.pages()).toHaveLength(1);
        }
        await browser.worker.evaluate(async () => {
          await (globalThis as ExtensionGlobal).chrome.proxy.settings.clear({ scope: "regular" });
        });
        const page = browser.context.pages()[0];
        await page.goto(source.origin);
        await browser.worker.evaluate(async (value) => {
          await (globalThis as ExtensionGlobal).chrome.proxy.settings.set({ value, scope: "regular" });
        }, proxyValue);
        packets = 0;
        await page.evaluate(async (port) => {
          if (!isSecureContext) throw new Error("probe_requires_secure_context");
          const connection = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
          try {
            connection.createDataChannel("owned");
            await connection.setLocalDescription(await connection.createOffer());
            await new Promise((done) => setTimeout(done, 1800));
          } finally { connection.close(); }
        }, udp.address().port);
        if (overrides.length) expect(packets, "matching override bypasses the global WebRTC preference").toBeGreaterThan(0);
        else expect(packets).toBe(0);
      } finally { await browser.close(); }
    }
  } finally {
    await source.close();
    await new Promise<void>((done) => udp.close(done));
  }
});

test("page-initiated preconnect has an independent reachable TCP sentinel", async () => {
  const source = await fixture();
  const sentinel=await fixture();
  const browser=await launch();
  try {
    await clearForPositiveControl(browser.worker);
    const page=browser.context.pages()[0];
    await page.goto(source.origin);
    await page.evaluate((origin) => {
      const link=document.createElement("link"); link.rel="preconnect"; link.href=origin;
      document.head.append(link);
    },sentinel.origin);
    await expect.poll(sentinel.connections).toBeGreaterThan(0);
    expect(sentinel.hits).toEqual([]);
    await browser.close();
    const negative=await launch();
    try {
      await clearForPositiveControl(negative.worker);
      const page=negative.context.pages()[0];
      await page.goto(source.origin);
      await negative.worker.evaluate(async (value) => {
        await (globalThis as ExtensionGlobal).chrome.proxy.settings.set({ value,scope: "regular" });
      },proxyValue);
      sentinel.reset();
      await page.evaluate((origin) => {
        const link=document.createElement("link"); link.rel="preconnect"; link.href=origin;
        document.head.append(link);
      },sentinel.origin);
      await new Promise((done) => setTimeout(done,1500));
      expect(sentinel.connections()).toBe(0);
    } finally { await negative.close(); }
  } finally { await browser.close(); await source.close(); await sentinel.close(); }
});
