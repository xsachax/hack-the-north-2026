import Browserbase, { toFile } from "@browserbasehq/sdk";
import { browserbase, Stagehand, type StagehandBrowser } from "@browserbasehq/stagehand";
import { chromium, type Browser, type Worker } from "playwright-core";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig } from "../../lib/config";
import { idSchema, personaIdSchema } from "../../lib/contracts";
import { CloudStartupError, type CloudUsage, type PrivateSessionReference } from "./cloud";
import { buildComposedExtension, COMPOSED_POLICY_VERSION } from "./composed-extension";
import { establishNativePolicy, assertTrustedBootstrap } from "./native-policy-session";
import { NativeResources, type NativeResource } from "./native-resources";
import type { Brain, CleanupOutcome } from "./types";

export type NativeBrowserOptions = {
  runId: string;
  personaId: string;
  correlationToken: string;
  viewport: { width: number; height: number };
  signal: AbortSignal;
  assertActive: () => void;
  onSession: (reference: PrivateSessionReference) => Promise<void>;
  onResource: (resource: Readonly<NativeResource>) => undefined;
};
export type NativeCloudUsage = CloudUsage & {
  nativeResource?: Readonly<NativeResource>;
  nativePolicy?: { version: string; browserVersion: string; archiveSha256: string };
  nativeObservedBrowserVersion?: string;
};

async function bounded<T>(work: PromiseLike<T>, milliseconds = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("native_browser_timeout")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** Fresh trusted bootstrap only. This alone never enables public navigation. */
export async function createNativeBrowser(config: AppConfig, options: NativeBrowserOptions) {
  const started = Date.now();
  const timeoutSeconds = Math.min(config.SESSION_TIMEOUT_SECONDS, 300);
  const usage: NativeCloudUsage = { allocationAttempted: false, reservedSeconds: timeoutSeconds, elapsedSeconds: 0 };
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  let closing: Promise<CleanupOutcome> | undefined;
  let phase = "native_admission";
  let sessionId: string | undefined;
  let browser: StagehandBrowser | undefined;
  let playwright: Browser | undefined;
  let stagehand: Stagehand | undefined;
  let worker: Worker | undefined;
  let brain: Brain | undefined;
  let resources: NativeResources | undefined;
  let cleanupNetwork: (() => Promise<void>) | undefined;
  let nativeFault = false;
  let bb: Browserbase | undefined;
  const assertActive = () => {
    signal.throwIfAborted();
    options.assertActive();
    if (closing || nativeFault) throw new Error("native_browser_inactive");
  };
  const diagnostic = (operation: string) => {
    usage.cleanupDiagnostics ??= [];
    usage.cleanupDiagnostics.push({ operation, category: "unconfirmed" });
  };
  const close = (): Promise<CleanupOutcome> => closing ??= (async () => {
    stop.abort();
    const errors: string[] = [];
    const fail = (code: string) => { errors.push(code); diagnostic(code); };
    const attempt = async (code: string, operation: () => PromiseLike<unknown> | undefined, milliseconds = 5000) => {
      try { await bounded(Promise.resolve(operation()), milliseconds); }
      catch { fail(code); }
    };
    if (brain) await attempt("gateway_drain", () => brain?.drain?.(), 40000);
    if (stagehand) await attempt("metrics_unavailable", async () => { usage.modelMetrics = await stagehand!.metrics(); });
    let remote: { sessionId: string; status: string } | undefined;
    if (usage.allocationAttempted && !sessionId) fail("startup_session_unconfirmed");
    if (sessionId && bb) {
      try {
        let session = await bounded(bb.sessions.retrieve(sessionId));
        const valid = () => session.id === sessionId
          && session.projectId === config.BROWSERBASE_PROJECT_ID
          && session.userMetadata?.correlationToken === options.correlationToken;
        if (!valid()) throw new Error("native_session_identity_rejected");
        if (session.status === "RUNNING" || session.status === "PENDING") {
          await bounded(bb.sessions.update(sessionId, { status: "REQUEST_RELEASE", projectId: session.projectId }));
          for (let readback = 0; readback < 4; readback++) {
            session = await bounded(bb.sessions.retrieve(sessionId, { timeout: 2000 }), 2500);
            if (!valid()) throw new Error("native_session_identity_rejected");
            if (session.status !== "RUNNING" && session.status !== "PENDING") break;
            if (readback < 3) await delay(250);
          }
        }
        remote = { sessionId, status: session.status };
        usage.remoteStatus = session.status;
        if (session.status !== "COMPLETED") fail("remote_release_unconfirmed");
        if (["COMPLETED", "ERROR", "TIMED_OUT"].includes(session.status)) {
          const seconds = session.endedAt ? (Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 1000 : NaN;
          if (Number.isFinite(seconds) && seconds >= 0) usage.actualBrowserSeconds = seconds;
        }
      } catch { fail("remote_release_unconfirmed"); }
    }
    // Keep every attachment and the installed native policy until release readback.
    // Unconfirmed release still quarantines the extension; no settings are cleared.
    for (const [name, operation] of [
      ["network_close", () => cleanupNetwork?.()],
      ["stagehand_close", () => stagehand?.close()],
      ["playwright_close", () => playwright?.close()],
      ["browser_close", () => browser?.close()],
    ] as const) await attempt(name, operation);
    if (resources) await attempt("native_extension_cleanup_unconfirmed", () => resources!.close(remote), 25000);
    usage.elapsedSeconds = Math.ceil((Date.now() - started) / 1000);
    if (errors.length) usage.cleanupErrors = [...new Set(errors)];
    return { status: errors.length ? "failed" : "closed", errors };
  })();
  try {
    idSchema.parse(options.runId);
    personaIdSchema.parse(options.personaId);
    z.uuid().parse(options.correlationToken);
    z.uuid().parse(config.BROWSERBASE_PROJECT_ID);
    z.strictObject({ width: z.int().min(320).max(1920), height: z.int().min(320).max(1200) }).parse(options.viewport);
    if ("contextReference" in options || "context" in options || "persist" in options) throw new Error("native_fresh_context_required");
    assertActive();
    const bundle = await buildComposedExtension();
    assertActive();
    const file = await toFile(bundle.bytes, "flash-flood-native.zip", { type: "application/zip" });
    assertActive();
    bb = new Browserbase({ apiKey: config.BROWSERBASE_API_KEY, maxRetries: 0, timeout: 10000 });
    resources = new NativeResources(bundle.sha256, {
      upload: async () => bb!.extensions.create({ file }),
      delete: async (id) => { await bb!.extensions.delete(id, { headers: { "Content-Type": null } }); },
      deleted: async (id) => {
        try { await bb!.extensions.retrieve(id); return false; }
        catch (error) {
          if (error instanceof Browserbase.APIError && error.status === 404) return true;
          throw new Error("native_extension_delete_unconfirmed");
        }
      },
    }, (resource) => {
      usage.nativeResource = resource;
      return options.onResource(resource);
    });
    phase = "native_extension_upload";
    const extensionId = await resources.upload(assertActive);
    assertActive();
    phase = "native_launch";
    resources.allocationAttempted(assertActive);
    usage.allocationAttempted = true;
    const allocated = await bb.sessions.create({
      projectId: config.BROWSERBASE_PROJECT_ID, extensionId, keepAlive: false, proxies: false,
      api_timeout: timeoutSeconds,
      browserSettings: { recordSession: true, solveCaptchas: false, viewport: options.viewport },
      userMetadata: { runId: options.runId, personaId: options.personaId, correlationToken: options.correlationToken, purpose: COMPOSED_POLICY_VERSION },
    });
    sessionId = z.uuid().parse(allocated.id);
    resources.sessionAllocated(sessionId);
    phase = "native_session_reference";
    await bounded(options.onSession({
      sessionId, liveViewUrl: "", replayUrl: `https://www.browserbase.com/sessions/${sessionId}`, timeoutSeconds,
    }), 5000);
    assertActive();
    phase = "native_browser_connect";
    const connecting = browserbase.connect({ apiKey: config.BROWSERBASE_API_KEY, sessionId });
    void connecting.then(async (late) => { if (closing) await late.close(); }).catch(() => { diagnostic("late_browser_connect"); });
    browser = await bounded(connecting, 30000);
    assertActive();
    phase = "native_stagehand_create";
    const initializing = Stagehand.create({
      browser, apiKey: config.BROWSERBASE_API_KEY, model: { modelName: config.STAGEHAND_MODEL },
      cache: false, selfHeal: false, logging: { level: "off" },
    });
    void initializing.then(async (late) => { if (closing) await late.close(); }).catch(() => { diagnostic("late_stagehand_create"); });
    stagehand = await bounded(initializing, 30000);
    assertActive();
    phase = "native_cdp_connect";
    const session = await bb.sessions.retrieve(sessionId);
    if (session.id !== sessionId || session.projectId !== config.BROWSERBASE_PROJECT_ID
      || session.userMetadata?.correlationToken !== options.correlationToken || !session.connectUrl) {
      throw new Error("native_session_identity_rejected");
    }
    assertActive();
    playwright = await chromium.connectOverCDP(session.connectUrl, { timeout: 10000 });
    const observedVersion = playwright.version();
    if (/^\d{1,4}\.\d{1,4}\.\d{1,8}\.\d{1,8}$/.test(observedVersion)) {
      usage.nativeObservedBrowserVersion = observedVersion;
    }
    assertActive();
    if (playwright.contexts().length !== 1) throw new Error("native_fresh_context_required");
    const context = playwright.contexts()[0];
    const workers = context.serviceWorkers().filter((candidate) => /^chrome-extension:\/\/[a-p]{32}\/service-worker.js$/.test(candidate.url()));
    if (workers.length !== 1) throw new Error("native_extension_identity_rejected");
    worker = workers[0];
    const extensionOrigin = worker.url().slice(0, -"/service-worker.js".length);
    assertTrustedBootstrap(context, extensionOrigin);
    phase = "native_attestation";
    const policy = await establishNativePolicy({ context, worker, files: bundle.files, assertActive });
    usage.nativePolicy = { version: COMPOSED_POLICY_VERSION, browserVersion: policy.version, archiveSha256: bundle.sha256 };
    worker.once("close", () => { nativeFault = true; stop.abort(); void close(); });
    const verifyActive = async () => {
      try { await policy.verify(); }
      catch {
        nativeFault = true;
        stop.abort();
        void close();
        throw new Error("native_policy_lost");
      }
    };
    const page = context.pages().find((candidate) => candidate.url() === "about:blank" || candidate.url() === `${extensionOrigin}/blank.html`)
      ?? await context.newPage();
    await page.setViewportSize(options.viewport);
    assertActive();
    return {
      browser, stagehand, playwright, context, page, extensionOrigin, usage, signal, assertActive, close,
      verifyActive,
      attachBrain(value: Brain) { assertActive(); if (brain) throw new Error("native_brain_already_attached"); brain = value; },
      attachNetwork(value: () => Promise<void>) { assertActive(); if (cleanupNetwork) throw new Error("native_network_already_attached"); cleanupNetwork = value; },
      async publishLiveReference() {
        await verifyActive();
        if (!cleanupNetwork) throw new Error("native_network_not_installed");
        const debug = await bb!.sessions.debug(sessionId!);
        assertActive();
        await bounded(options.onSession({
          sessionId: sessionId!, liveViewUrl: debug.debuggerFullscreenUrl,
          replayUrl: `https://www.browserbase.com/sessions/${sessionId}`, timeoutSeconds,
        }), 5000);
        assertActive();
      },
    };
  } catch {
    throw new CloudStartupError(await close(), usage, phase);
  }
}
