import type { BrowserContext, Page, Worker } from "playwright-core";
import { z } from "zod";
import { attachCdpTarget } from "./cdp-target";
import { browserHeaderPermits, capturePublicBrowserHeaders } from "./public-browser-headers";
import { createPublicTransport, PUBLIC_TRANSPORT_LIMITS, PublicTransportError, type PublicRequestContext } from "./public-transport";
import { isGatewayControlRequest, type NetworkSignal } from "./fixture-network";
import { createGatewayTransport } from "./gateway-transport";

const pausedSchema = z.object({
  requestId: z.string().min(1).max(200), frameId: z.string().max(200),
  resourceType: z.string().max(64), networkId: z.string().max(200).optional(),
  request: z.object({
    url: z.string().max(4096), method: z.string().max(32), headers: z.record(z.string(), z.string()),
    postData: z.string().optional(), hasPostData: z.boolean().optional(),
    postDataEntries: z.array(z.unknown()).optional(),
  }),
});
type Paused = z.infer<typeof pausedSchema>;
type Target = Awaited<ReturnType<typeof attachCdpTarget>>;
type GatewayIdentity = { targetId: string; url: string; type: string };

export type PublicNetworkOptions = {
  context: BrowserContext; page: Page; extensionOrigin: string;
  authorize: (context: PublicRequestContext) => boolean;
  assertActive: () => void; verifyActive: () => Promise<void>; signal: AbortSignal;
  onSignal: (signal: NetworkSignal) => void;
  onFatal: () => void;
  /** Omit only for zero-inference probes: absent authorization denies Gateway dispatch. */
  onGatewayDispatch?: () => void;
  diagnostics?: string[];
};

export function installPublicNetwork(options: PublicNetworkOptions) {
  return installNetwork(options, createPublicTransport);
}

/** Explicit synthetic offline probe only; production admission cannot select this transport. */
export function installOfflinePublicNetworkForProbe(options: PublicNetworkOptions, fixture: typeof createPublicTransport) {
  return installNetwork(options, fixture);
}

async function installNetwork(options: PublicNetworkOptions, createTransport: typeof createPublicTransport) {
  const { context, page, extensionOrigin, assertActive, verifyActive, signal } = options;
  const browser = context.browser();
  if (!browser || !/^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin)) throw new Error("public_browser_identity_unavailable");
  const errors = options.diagnostics ?? [];
  const permits = browserHeaderPermits();
  const pending = new Set<Promise<void>>();
  const targets: Target[] = [];
  let closed = false;
  let closing: Promise<void> | undefined;
  let fatal = false;
  let installed = false;
  const identities = new Map<string, GatewayIdentity>();
  const offscreenUrl = `${extensionOrigin}/offscreen/service-worker-heartbeat.html`;
  const report = (code: string, url = "") => {
    if (errors.length >= 128) { if (!fatal) { fatal = true; options.onFatal(); } return; }
    errors.push(code);
    options.onSignal({ code, url });
  };
  const trip = (code: string) => {
    if (fatal) return;
    fatal = true;
    report(code);
    options.onFatal();
  };
  const transport = createTransport({
    authorize: options.authorize, authorizeBrowserHeaders: permits.authorize,
    assertActive, signal, limits: PUBLIC_TRANSPORT_LIMITS,
  });
  const root = await browser.newBrowserCDPSession();
  const active = () => { signal.throwIfAborted(); assertActive(); if (closed || fatal) throw new Error("public_network_closed"); };
  const gatewayTransport = createGatewayTransport({
    signal, assertActive: active,
    onDispatch: () => {
      if (!options.onGatewayDispatch) throw new Error("gateway_context_unavailable");
      return options.onGatewayDispatch();
    },
  });
  const track = (work: Promise<void>) => {
    pending.add(work);
    void work.catch(() => { if (!closed) report("public_interception_failed"); })
      .finally(() => pending.delete(work));
  };
  const abort = async (target: Target, requestId: string) => {
    try { await target.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }); }
    catch { if (!closed && browser.isConnected()) report("public_request_abort_failed"); }
  };
  const publicRequest = async (target: Target, event: Paused, mainFrameId: string) => {
    let revoke: (() => void) | undefined;
    try {
      active();
      if (pending.size > 32 || event.frameId !== mainFrameId) throw new Error("public_frame_unsupported");
      if (["EventSource", "WebSocket", "WebTransport", "Ping"].includes(event.resourceType)) throw new Error("public_channel_unsupported");
      const method = z.enum(["GET", "HEAD", "OPTIONS"]).parse(event.request.method);
      if (event.request.hasPostData || event.request.postData !== undefined || event.request.postDataEntries !== undefined) {
        throw new Error("public_body_unsupported");
      }
      const kind = event.resourceType === "Document" ? "navigation" : "asset";
      const headers = capturePublicBrowserHeaders(event.request.url, event.request.headers);
      const request: PublicRequestContext = Object.freeze({ url: event.request.url, method, kind });
      await verifyActive();
      active();
      revoke = permits.bind(request, headers);
      const result = await transport.request({ ...request, headers, signal });
      active();
      await verifyActive();
      active();
      await target.send("Fetch.fulfillRequest", {
        requestId: event.requestId, responseCode: result.status,
        responseHeaders: result.headers.map(([name, value]) => ({ name, value })),
        body: result.body.toString("base64"),
      });
      active();
    } catch (error) {
      if (!closed) report(error instanceof PublicTransportError ? error.message : "public_request_unsupported", event.request.url);
      await abort(target, event.requestId);
    } finally { revoke?.(); }
  };
  const gatewayRequest = async (target: Target, event: Paused, identity: GatewayIdentity) => {
    try {
      active();
      const current = (await root.send("Target.getTargetInfo", { targetId: identity.targetId })).targetInfo;
      active();
      if (current.url !== identity.url || current.type !== identity.type
        || !isGatewayControlRequest(event.request.url, event.request.method, current.url, extensionOrigin)) throw new Error("gateway_control_denied");
      await verifyActive();
      active();
      if (!event.networkId) throw new Error("gateway_body_identity_unavailable");
      const body = z.object({ postData: z.string() }).parse(
        await target.send("Network.getRequestPostData", { requestId: event.networkId }),
      ).postData;
      if (!body || Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error("gateway_body_unsupported");
      active();
      const response = await gatewayTransport.request(event.request.headers, Buffer.from(body));
      active();
      await verifyActive();
      active();
      await target.send("Fetch.fulfillRequest", {
        requestId: event.requestId, responseCode: response.status,
        responseHeaders: [
          { name: "content-type", value: response.contentType },
          { name: "cache-control", value: "no-store" },
        ],
        body: response.body.toString("base64"),
      });
    } catch {
      if (!closed) report("gateway_control_failed");
      await abort(target, event.requestId);
    }
  };
  const attach = async (targetId: string, handler: (target: Target, request: Paused) => Promise<void>, capturePostData = false) => {
    const holder: { target?: Target } = {};
    const target = await attachCdpTarget(root, targetId, (method, value) => {
      if (closed || fatal || signal.aborted) return;
      if (method === "public.cdpFailure") { trip("public_cdp_failed"); return; }
      if (method === "Network.webSocketCreated" || method === "Network.webTransportCreated") {
        report("public_channel_unsupported");
        return;
      }
      if (method !== "Fetch.requestPaused") return;
      if (pending.size >= 32) { trip("public_interception_limit"); return; }
      const event = pausedSchema.safeParse(value);
      if (!event.success || !holder.target) { trip("public_request_shape_unsupported"); return; }
      track(handler(holder.target, event.data));
    });
    holder.target = target;
    targets.push(target);
    await target.send("Network.enable", {
      maxPostDataSize: capturePostData ? 8 * 1024 * 1024 : 0,
      maxTotalBufferSize: 16 * 1024 * 1024, maxResourceBufferSize: 8 * 1024 * 1024,
    });
    await target.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    active();
  };
  const popup = (opened: Page) => {
    if (opened === page || opened.url() === `${extensionOrigin}/offscreen/service-worker-heartbeat.html`) return;
    report("popup_denied", opened.url());
    track(opened.close());
  };
  const frame = () => { if (page.frames().length > 1) report("public_frame_unsupported"); };
  const worker = () => report("public_worker_unsupported");
  const serviceWorker = (created: Worker) => {
    if (created.url() !== `${extensionOrigin}/service-worker.js`) report("public_worker_unsupported");
  };
  const download = (item: { cancel(): Promise<void> }) => { report("public_download_unsupported"); track(item.cancel()); };
  const targetCreated = ({ targetInfo }: { targetInfo: GatewayIdentity }) => {
    if (installed && targetInfo.url === offscreenUrl && !identities.has(targetInfo.targetId)) trip("gateway_offscreen_changed");
  };
  const targetChanged = ({ targetInfo }: { targetInfo: GatewayIdentity }) => {
    const expected = identities.get(targetInfo.targetId);
    if (installed && expected && (expected.url !== targetInfo.url || expected.type !== targetInfo.type)) trip("gateway_target_changed");
  };
  const targetDestroyed = ({ targetId }: { targetId: string }) => {
    if (installed && identities.has(targetId) && !signal.aborted) trip("gateway_target_lost");
  };
  const close = () => closing ??= (async () => {
    closed = true;
    installed = false;
    root.off("Target.targetCreated", targetCreated);
    root.off("Target.targetInfoChanged", targetChanged);
    root.off("Target.targetDestroyed", targetDestroyed);
    context.off("page", popup);
    context.off("serviceworker", serviceWorker);
    page.off("frameattached", frame);
    page.off("worker", worker);
    page.off("download", download);
    const resources = await Promise.allSettled([transport.close(), gatewayTransport.close()]);
    const results = await Promise.allSettled(targets.map((target) => target.close(browser.isConnected())));
    await Promise.allSettled([...pending]);
    permits.clear();
    if (browser.isConnected()) {
      if (browser.isConnected()) await root.detach();
      if (results.some((result) => result.status === "rejected") && browser.isConnected()) throw new Error("public_target_cleanup_failed");
    }
    if (resources.some((result) => result.status === "rejected")) throw new Error("public_transport_cleanup_failed");
  })();
  try {
    active();
    await context.clearPermissions();
    const pageSession = await context.newCDPSession(page);
    let pageTargetId: string;
    let mainFrameId: string;
    try {
      pageTargetId = (await pageSession.send("Target.getTargetInfo")).targetInfo.targetId;
      mainFrameId = (await pageSession.send("Page.getFrameTree")).frameTree.frame.id;
    } finally { await pageSession.detach(); }
    active();
    root.on("Target.targetCreated", targetCreated);
    root.on("Target.targetInfoChanged", targetChanged);
    root.on("Target.targetDestroyed", targetDestroyed);
    await root.send("Target.setDiscoverTargets", { discover: true });
    const infos = (await root.send("Target.getTargets")).targetInfos;
    const gateway = infos.filter((info) => info.type === "service_worker" && info.url === `${extensionOrigin}/service-worker.js`);
    if (gateway.length !== 1) throw new Error("gateway_worker_identity_unavailable");
    const offscreen = infos.filter((info) => info.url === offscreenUrl);
    if (offscreen.length !== 1 || offscreen[0].type !== "background_page") {
      report("gateway_offscreen_identity_unavailable");
      throw new Error("gateway_offscreen_identity_unavailable");
    }
    for (const info of [gateway[0], offscreen[0]]) {
      identities.set(info.targetId, { targetId: info.targetId, url: info.url, type: info.type });
      await attach(info.targetId, (target, request) => gatewayRequest(target, request, info), true);
    }
    await attach(pageTargetId, (target, request) => publicRequest(target, request, mainFrameId));
    context.on("page", popup);
    context.on("serviceworker", serviceWorker);
    page.on("frameattached", frame);
    page.on("worker", worker);
    page.on("download", download);
    active();
    await verifyActive();
    for (const expected of identities.values()) {
      const current = (await root.send("Target.getTargetInfo", { targetId: expected.targetId })).targetInfo;
      if (current.url !== expected.url || current.type !== expected.type) throw new Error("gateway_target_changed");
    }
    installed = true;
    active();
    return { close, errors };
  } catch {
    await close();
    throw new Error("public_network_install_failed");
  }
}
