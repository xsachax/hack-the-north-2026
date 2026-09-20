import Browserbase, { toFile } from "@browserbasehq/sdk";
import { chromium, type Browser, type Worker } from "playwright-core";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig } from "../../lib/config";
import { idSchema, personaIdSchema } from "../../lib/contracts";
import { NATIVE_SHUTDOWN_RESERVE_SECONDS } from "../../lib/public-execution";
import { PUBLIC_EXECUTION_IMPLEMENTATION_READY } from "../public-execution-readiness";
import { CloudStartupError, type CloudUsage, type PrivateSessionReference } from "./cloud";
import { buildComposedExtension, COMPOSED_POLICY_VERSION } from "./composed-extension";
import { establishNativePolicy, assertTrustedBootstrap } from "./native-policy-session";
import { createNativeSdk } from "./native-sdk";
import { nativeSessionMetadataSchema } from "./native-session-metadata";
import { isNativeSessionRetired, NativeResources, type NativeResource, type NativeSessionClosure } from "./native-resources";
import type { Brain, CleanupOutcome } from "./types";

export { NATIVE_SHUTDOWN_RESERVE_SECONDS };

const nativeStartupCodeSchema = z.enum([
  "unknown", "native_session_identity_rejected", "native_browser_version_unavailable",
  "native_fresh_context_required", "native_extension_identity_rejected", "native_untrusted_bootstrap",
  "native_browser_version_unsupported", "native_policy_state_rejected", "native_execution_deadline",
]);
type NativeCdpStep = "session_readback" | "connection_metadata" | "cdp_attach" |
  "runtime_version" | "profile" | "extension_worker" | "trusted_bootstrap";

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
  nativeStartupFailure?: {
    step?: NativeCdpStep;
    code: z.infer<typeof nativeStartupCodeSchema>;
    browserVersion?: string;
  };
  gatewayDispatches?: number;
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
  if (!PUBLIC_EXECUTION_IMPLEMENTATION_READY || !config.ENABLE_PUBLIC_RUNS) {
    throw new CloudStartupError({ status: "closed", errors: [] }, usage, "public_checkpoint", "unsupported");
  }
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  let closing: Promise<CleanupOutcome> | undefined;
  let phase = "native_admission";
  let cdpStep: NativeCdpStep | undefined;
  let sessionId: string | undefined;
  let sdk: ReturnType<typeof createNativeSdk> | undefined;
  let initialized = false;
  let playwright: Browser | undefined;
  let worker: Worker | undefined;
  let brain: Brain | undefined;
  let resources: NativeResources | undefined;
  let cleanupNetwork: (() => Promise<void>) | undefined;
  let cleanupControl: (() => Promise<void>) | undefined;
  let nativeFault = false;
  let bb: Browserbase | undefined;
  let executionDeadlineMs: number | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const assertActive = () => {
    signal.throwIfAborted();
    options.assertActive();
    if (executionDeadlineMs !== undefined && Date.now() >= executionDeadlineMs) throw new Error("native_execution_deadline");
    if (closing || nativeFault) throw new Error("native_browser_inactive");
  };
  const diagnostic = (operation: string) => {
    usage.cleanupDiagnostics ??= [];
    usage.cleanupDiagnostics.push({ operation, category: "unconfirmed" });
  };
  const close = (): Promise<CleanupOutcome> => closing ??= (async () => {
    clearTimeout(deadlineTimer);
    stop.abort();
    const errors: string[] = [];
    const fail = (code: string) => { errors.push(code); diagnostic(code); };
    const attempt = async (code: string, operation: () => PromiseLike<unknown> | undefined, milliseconds = 5000) => {
      try { await bounded(Promise.resolve(operation()), milliseconds); }
      catch { fail(code); }
    };
    if (brain) await attempt("gateway_drain", () => brain?.drain?.(), 40000);
    if (initialized) await attempt("metrics_unavailable", async () => { usage.modelMetrics = await sdk!.metrics(); });
    let remote: NativeSessionClosure | undefined;
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
        remote = { sessionId, status: session.status, startedAt: session.startedAt, endedAt: session.endedAt };
        usage.remoteStatus = session.status;
        if (session.status === "ERROR" || session.status === "TIMED_OUT") {
          const independent = await bounded(bb.sessions.retrieve(sessionId, { timeout: 2000 }), 2500);
          if (independent.id !== sessionId || independent.projectId !== config.BROWSERBASE_PROJECT_ID
            || independent.userMetadata?.correlationToken !== options.correlationToken) {
            throw new Error("native_session_identity_rejected");
          }
          remote = { ...remote, independent: {
            sessionId: independent.id, status: independent.status, startedAt: independent.startedAt, endedAt: independent.endedAt,
          } };
        }
        if (!isNativeSessionRetired(remote)) fail("remote_release_unconfirmed");
        else if (session.status !== "COMPLETED") fail("remote_session_failed");
        if (isNativeSessionRetired(remote)) {
          const seconds = session.endedAt ? (Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 1000 : NaN;
          if (Number.isFinite(seconds) && seconds >= 0) usage.actualBrowserSeconds = seconds;
        }
      } catch { fail("remote_release_unconfirmed"); }
    }
    // Keep every attachment and the installed native policy until release readback.
    // Unconfirmed release still quarantines the extension; no settings are cleared.
    // Actual worker exit settles every SDK socket/retry before CDP attachments or
    // the metadata listener can be retired. No branded close method is invoked.
    let sdkRetired = !sdk;
    if (sdk) {
      try { await sdk.close(); sdkRetired = true; }
      catch { fail("native_sdk_close"); }
    }
    if (sdkRetired) {
      for (const [name, operation] of [
        ["network_close", () => cleanupNetwork?.()],
        ["native_control_close", () => cleanupControl?.()],
        ["playwright_close", () => playwright?.close()],
      ] as const) await attempt(name, operation);
    }
    if (resources) await attempt("native_extension_cleanup_unconfirmed", () => resources!.close(sdkRetired ? remote : undefined), 25000);
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
    if (timeoutSeconds <= NATIVE_SHUTDOWN_RESERVE_SECONDS) throw new Error("native_session_timeout_too_short");
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
    executionDeadlineMs = Date.now() + (timeoutSeconds - NATIVE_SHUTDOWN_RESERVE_SECONDS) * 1000;
    deadlineTimer = setTimeout(() => { stop.abort(); void close(); }, executionDeadlineMs - Date.now());
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
    phase = "native_cdp_connect";
    cdpStep = "session_readback";
    const session = await bb.sessions.retrieve(sessionId);
    if (session.id !== sessionId || session.projectId !== config.BROWSERBASE_PROJECT_ID
      || session.userMetadata?.correlationToken !== options.correlationToken) {
      throw new Error("native_session_identity_rejected");
    }
    assertActive();
    cdpStep = "connection_metadata";
    // Creation returns the connection capability; later readback may omit it.
    const metadata = nativeSessionMetadataSchema.parse({
      id: sessionId, connectUrl: allocated.connectUrl, region: session.region,
    });
    cdpStep = "cdp_attach";
    const attaching = chromium.connectOverCDP(metadata.connectUrl, { timeout: 10000 });
    void attaching.then(async (late) => { if (closing) await late.close(); }).catch(() => { diagnostic("late_cdp_connect"); });
    playwright = await bounded(attaching, 10000);
    assertActive();
    cdpStep = "runtime_version";
    const versionSession = await playwright.newBrowserCDPSession();
    let product: string;
    try { product = (await versionSession.send("Browser.getVersion")).product; }
    finally { await versionSession.detach(); }
    const observedVersion = /^(?:HeadlessChrome|Chrome)\/(\d{1,4}\.\d{1,4}\.\d{1,8}\.\d{1,8})$/.exec(product)?.[1];
    if (!observedVersion || observedVersion !== playwright.version()) throw new Error("native_browser_version_unavailable");
    usage.nativeObservedBrowserVersion = observedVersion;
    assertActive();
    cdpStep = "profile";
    if (playwright.contexts().length !== 1) throw new Error("native_fresh_context_required");
    const context = playwright.contexts()[0];
    cdpStep = "extension_worker";
    if (!context.serviceWorkers().length) {
      await bounded(context.waitForEvent("serviceworker", { timeout: 5000 }), 5000);
      assertActive();
    }
    const workers = context.serviceWorkers().filter((candidate) => /^chrome-extension:\/\/[a-p]{32}\/service-worker.js$/.test(candidate.url()));
    if (workers.length !== 1) throw new Error("native_extension_identity_rejected");
    worker = workers[0];
    worker.once("close", () => { nativeFault = true; stop.abort(); void close(); });
    const extensionOrigin = worker.url().slice(0, -"/service-worker.js".length);
    cdpStep = "trusted_bootstrap";
    assertTrustedBootstrap(context, extensionOrigin);
    cdpStep = undefined;
    phase = "native_browser_connect";
    sdk = createNativeSdk({
      session: metadata,
      extensionId: extensionOrigin.slice("chrome-extension://".length),
      apiKey: config.BROWSERBASE_API_KEY!, model: config.STAGEHAND_MODEL,
      signal, assertActive, onLost: () => { nativeFault = true; stop.abort(); void close(); },
    });
    await bounded(sdk.connect(), 30000);
    assertActive();
    phase = "native_stagehand_create";
    await bounded(sdk.initialize(), 30000);
    initialized = true;
    assertActive();
    phase = "native_attestation";
    const policy = await establishNativePolicy({
      context, worker, files: bundle.files, assertActive,
      onLost: () => { nativeFault = true; stop.abort(); void close(); },
    });
    cleanupControl = policy.close;
    usage.nativePolicy = { version: COMPOSED_POLICY_VERSION, browserVersion: policy.version, archiveSha256: bundle.sha256 };
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
      sdk, playwright, context, page, extensionOrigin, usage, signal, assertActive, close, executionDeadlineMs,
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
  } catch (error) {
    const code = nativeStartupCodeSchema.safeParse(error instanceof Error ? error.message : undefined);
    usage.nativeStartupFailure = {
      ...(cdpStep ? { step: cdpStep } : {}),
      code: code.success ? code.data : "unknown",
      ...(usage.nativeObservedBrowserVersion ? { browserVersion: usage.nativeObservedBrowserVersion } : {}),
    };
    throw new CloudStartupError(await close(), usage, phase);
  }
}
