import Browserbase from "@browserbasehq/sdk";
import { browserbase, Stagehand, type StagehandBrowser } from "@browserbasehq/stagehand";
import { chromium, type Browser } from "playwright-core";
import { z } from "zod";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../../lib/config";
import { assignmentSchema, idSchema, personaIdSchema } from "../../lib/contracts";
import { DEMO_STORAGE_KEY, freshDemo, fixturesSchema, type Fixtures } from "../../lib/demo";
import type { ArtifactSinks } from "./artifacts";
import { COMPLETE_CRITERION, COUPON_CRITERION, FixtureDriver, demoVerifier } from "./driver";
import { GatewayBrain } from "./gateway";
import { installFixtureNetwork, isFixtureRequest, localFixtureSource } from "./fixture-network";
import { ExecutionError, type CleanupOutcome } from "./types";

export type PrivateSessionReference = {
  sessionId: string;
  liveViewUrl: string;
  replayUrl: string;
  timeoutSeconds: number;
};
export type CloudUsage = {
  reservedSeconds: number;
  elapsedSeconds: number;
  actualBrowserSeconds?: number;
  remoteStatus?: string;
  modelMetrics?: Awaited<ReturnType<Stagehand["metrics"]>>;
  cleanupDiagnostics?: { operation: string; category: "timeout" | "rejected" | "unconfirmed" }[];
  cleanupErrors?: string[];
  networkDiagnostics?: readonly string[];
};
export type FixtureExecutionOptions = {
  mode: "controlled-fixture";
  runId: string;
  personaId: string;
  targetUrl: string;
  criteria: readonly string[];
  fixturePort: number;
  fixtures: Fixtures;
  viewport: { width: number; height: number };
  artifacts: ArtifactSinks;
  /** Teardown evidence must permit cancellation while still enforcing lease ownership. */
  cleanupJson?: ArtifactSinks["json"];
  signal: AbortSignal;
  correlationToken?: string;
  assertActive?: () => void;
  /** Private server-only hook; never stream these URLs as public events. */
  onSession: (reference: PrivateSessionReference) => Promise<void>;
  keyboardOnly?: boolean;
  contextReference?: never;
  actor?: "agent";
};

export class CloudStartupError extends Error {
  constructor(readonly cleanup: CleanupOutcome, readonly usage: CloudUsage, readonly phase = "unknown") {
    super("cloud_startup_failed");
  }
}

async function bounded<T>(work: Promise<T>, milliseconds = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("cloud_operation_timeout")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function createFixtureExecution(config: AppConfig, options: FixtureExecutionOptions) {
  // No URL admission bypass or implicit fallback to this mode exists.
  if (options.mode !== "controlled-fixture" || !isFixtureRequest(options.targetUrl, true)
    || options.contextReference !== undefined || (options.actor && options.actor !== "agent")) {
    throw new ExecutionError("unsupported", "arbitrary_targets_contexts_and_takeover_disabled");
  }
  const fixtures = fixturesSchema.parse(options.fixtures);
  idSchema.parse(options.runId);
  personaIdSchema.parse(options.personaId);
  const criteria = assignmentSchema.shape.criteria.parse(options.criteria);
  if (new Set(criteria).size !== criteria.length) throw new ExecutionError("unsupported", "duplicate_criteria");
  if (criteria.some((criterion) => criterion !== COUPON_CRITERION && criterion !== COMPLETE_CRITERION)) {
    throw new ExecutionError("unsupported", "unknown_criterion");
  }
  if (options.correlationToken !== undefined) z.uuid().parse(options.correlationToken);
  const userMetadata = {
    runId: options.runId, personaId: options.personaId,
    purpose: options.correlationToken ? "layer04" : "layer03",
    ...(options.correlationToken ? { correlationToken: options.correlationToken } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(userMetadata), "utf8") >= 512) {
    throw new ExecutionError("unsupported", "session_metadata_limit");
  }
  z.strictObject({
    width: z.int().min(320).max(1920), height: z.int().min(320).max(1200),
  }).parse(options.viewport);
  const source = localFixtureSource(options.fixturePort);
  const assertActive = () => {
    options.signal.throwIfAborted();
    options.assertActive?.();
  };
  assertActive();
  const timeoutSeconds = Math.min(config.SESSION_TIMEOUT_SECONDS, 300);
  const started = Date.now();
  const usage: CloudUsage = { reservedSeconds: timeoutSeconds, elapsedSeconds: 0 };
  const bb = new Browserbase({ apiKey: config.BROWSERBASE_API_KEY, maxRetries: 0, timeout: 10000 });
  let browser: StagehandBrowser | undefined;
  let sessionId: string | undefined;
  let extensionId: string | undefined;
  let stagehand: Stagehand | undefined;
  let brain: GatewayBrain | undefined;
  let playwright: Browser | undefined;
  let network: Awaited<ReturnType<typeof installFixtureNetwork>> | undefined;
  let closing: Promise<CleanupOutcome> | undefined;
  let launchAttempted = false;
  let phase = "launch";
  const diagnostic = (operation: string, error: unknown, category?: "unconfirmed") => {
    usage.cleanupDiagnostics ??= [];
    usage.cleanupDiagnostics.push({
      operation, category: category ?? (error instanceof Error && error.message === "cloud_operation_timeout" ? "timeout" : "rejected"),
    });
  };
  const close = (): Promise<CleanupOutcome> => closing ??= (async () => {
    const errors: string[] = [];
    const releaseRemote = async () => {
      if (!sessionId) return;
      try {
        let session = await bb.sessions.retrieve(sessionId);
        if (session.status === "RUNNING" || session.status === "PENDING") {
          await bb.sessions.update(sessionId, { status: "REQUEST_RELEASE", projectId: session.projectId });
          session = await bb.sessions.retrieve(sessionId);
        }
        usage.remoteStatus = session.status;
        const terminal = ["COMPLETED", "ERROR", "TIMED_OUT"].includes(session.status);
        if (!terminal) {
          errors.push("remote_release_unconfirmed");
          diagnostic("remote_release_unconfirmed", undefined, "unconfirmed");
        }
        const seconds = session.endedAt ? (Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 1000 : NaN;
        if (terminal && Number.isFinite(seconds) && seconds >= 0) usage.actualBrowserSeconds = seconds;
      } catch (error) { errors.push("remote_release_unconfirmed"); diagnostic("remote_release_unconfirmed", error); }
    };
    if (launchAttempted && !sessionId) {
      errors.push("startup_session_unconfirmed");
      diagnostic("startup_session_unconfirmed", undefined, "unconfirmed");
    }
    let releasedEarly = false;
    if (brain) {
      try {
        // Extraction has a 25s deadline plus the pinned SDK's 10s RPC grace.
        // Await real settlement before metrics/close, which cannot cancel it.
        await bounded(brain.drain(), 40000);
      } catch (error) {
        errors.push("gateway_drain");
        diagnostic("gateway_drain", error);
        // A stuck RPC must not delay remote release behind more worker RPCs.
        await releaseRemote();
        releasedEarly = true;
      }
    }
    if (stagehand) {
      try { usage.modelMetrics = await bounded(stagehand.metrics(), 5000); }
      catch (error) { errors.push("metrics_unavailable"); diagnostic("metrics", error); }
    }
    for (const [name, operation] of [
      ["stagehand_close", () => stagehand?.close()],
      ["playwright_close", () => playwright?.close()],
      ["browser_close", () => browser?.close()],
      ["network_close", () => network?.close()],
    ] as const) {
      try { await bounded(Promise.resolve(operation()), 5000); }
      catch (error) {
        errors.push(name);
        diagnostic(name, error);
      }
    }
    if (!releasedEarly) await releaseRemote();
    if (extensionId) {
      try { await bounded(bb.extensions.delete(extensionId, { headers: { "Content-Type": null } }), 5000); }
      catch (error) { errors.push("extension_delete"); diagnostic("extension_delete", error); }
    }
    usage.elapsedSeconds = Math.ceil((Date.now() - started) / 1000);
    usage.networkDiagnostics = network ? [...new Set(network.errors)] : [];
    if (errors.length) usage.cleanupErrors = [...(usage.cleanupErrors ?? []), ...errors];
    return { status: errors.length ? "failed" : "closed", errors };
  })();
  try {
    phase = "extension_upload";
    assertActive();
    // Provision the pinned Stagehand extension through public SDK APIs. Stagehand
    // launch cannot configure POST retries, so it must not allocate our session.
    // Stagehand 4.1.0's dist/assets archive is an internal package artifact, not
    // a public export. SDK upgrades must verify this path; there is no fallback.
    const archive = createReadStream(fileURLToPath(new URL("./assets/stagehand-extension.zip", import.meta.resolve("@browserbasehq/stagehand"))));
    try {
      const extension = await bb.extensions.create({ file: archive });
      extensionId = extension.id;
      if (!extensionId) throw new Error("missing_extension_id");
    } finally { archive.destroy(); }
    phase = "launch";
    assertActive();
    launchAttempted = true;
    const allocated = await bb.sessions.create({
      projectId: config.BROWSERBASE_PROJECT_ID, extensionId,
      api_timeout: timeoutSeconds, keepAlive: false, proxies: false,
      browserSettings: { recordSession: true, solveCaptchas: false, viewport: options.viewport },
      userMetadata,
    });
    sessionId = allocated.id;
    if (!sessionId) throw new Error("missing_session_id");
    // Persist the paid allocation before checking cancellation or lease loss.
    phase = "session_reference";
    await bounded(options.onSession({
      sessionId, liveViewUrl: "", timeoutSeconds,
      replayUrl: `https://www.browserbase.com/sessions/${sessionId}`,
    }), 5000);
    assertActive();
    phase = "browser_connect";
    const connecting = browserbase.connect({ apiKey: config.BROWSERBASE_API_KEY, sessionId });
    void connecting.then(async (late) => {
      if (closing) await late.close();
    }).catch(() => {});
    browser = await bounded(connecting, 30000);
    assertActive();
    phase = "stagehand_create";
    const initializing = Stagehand.create({
      browser, apiKey: config.BROWSERBASE_API_KEY, model: { modelName: config.STAGEHAND_MODEL },
      cache: false, selfHeal: false, logging: { level: "off" },
    });
    void initializing.then(async (late) => {
      if (closing) await late.close();
    }).catch(() => { /* Startup/cleanup result stays failed; remote release is still attempted. */ });
    stagehand = await bounded(initializing, 30000);
    assertActive();
    phase = "cdp_connect";
    const session = await bb.sessions.retrieve(sessionId);
    if (!session.connectUrl) throw new Error("missing_cdp_connection");
    assertActive();
    playwright = await chromium.connectOverCDP(session.connectUrl, { timeout: 10000 });
    assertActive();
    const context = playwright.contexts()[0];
    const page = context.pages().find((tab) => !tab.url().startsWith("chrome-extension:")) ?? await context.newPage();
    assertActive();
    await page.setViewportSize(options.viewport);
    assertActive();
    phase = "extension_identity";
    const workers = context.serviceWorkers().filter((worker) => /^chrome-extension:\/\/[a-p]{32}\/service-worker.js$/.test(worker.url()));
    if (workers.length !== 1) throw new Error("stagehand_extension_identity_unavailable");
    const extensionOrigin = workers[0].url().slice(0, -"/service-worker.js".length);
    phase = "network_install";
    const driverHolder: { current?: FixtureDriver } = {};
    network = await installFixtureNetwork(context, page, source, (event) => driverHolder.current?.policySignal(event.url), extensionOrigin);
    assertActive();
    phase = "fixture_setup";
    await page.goto(options.targetUrl, { waitUntil: "networkidle", timeout: 10000 });
    assertActive();
    await page.evaluate(({ key, state }) => sessionStorage.setItem(key, state), {
      key: DEMO_STORAGE_KEY, state: JSON.stringify(freshDemo(fixtures)),
    });
    assertActive();
    await page.reload({ waitUntil: "networkidle", timeout: 10000 });
    assertActive();
    phase = "stagehand_page";
    const pages = await browser.context.pages();
    let stagehandPage;
    for (const candidate of pages) {
      assertActive();
      if (await candidate.url() === options.targetUrl) { stagehandPage = candidate; break; }
    }
    if (!stagehandPage) throw new Error("stagehand_page_unavailable");
    assertActive();
    await browser.context.setActivePage(stagehandPage);
    assertActive();
    phase = "live_reference";
    const debug = await bb.sessions.debug(sessionId);
    await bounded(options.onSession({
      sessionId, liveViewUrl: debug.debuggerFullscreenUrl,
      replayUrl: `https://www.browserbase.com/sessions/${sessionId}`, timeoutSeconds,
    }), 5000);
    assertActive();
    const driver = new FixtureDriver({
      page, artifacts: options.artifacts, verify: demoVerifier(criteria), close,
      networkErrors: network.errors, keyboardOnly: options.keyboardOnly,
      assertActive, cleanupJson: options.cleanupJson,
      onCleanupError: (code, error) => {
        usage.cleanupErrors ??= [];
        usage.cleanupErrors.push(code);
        diagnostic(code, error);
      },
    });
    driverHolder.current = driver;
    assertActive();
    brain = new GatewayBrain(stagehand, stagehandPage);
    return { driver, brain, usage };
  } catch {
    throw new CloudStartupError(await close(), usage, phase);
  }
}
