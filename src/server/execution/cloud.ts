import Browserbase from "@browserbasehq/sdk";
import { browserbase, Stagehand, type StagehandBrowser } from "@browserbasehq/stagehand";
import { chromium, type Browser } from "playwright-core";
import { z } from "zod";
import type { AppConfig } from "../../lib/config";
import { assignmentSchema, idSchema, personaIdSchema } from "../../lib/contracts";
import { DEMO_STORAGE_KEY, freshDemo, fixturesSchema, type Fixtures } from "../../lib/demo";
import type { ArtifactSinks } from "./artifacts";
import { FixtureDriver, demoVerifier } from "./driver";
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
  cleanupDiagnostics?: { operation: string; category: "timeout" | "rejected" }[];
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
  signal: AbortSignal;
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
  z.strictObject({
    width: z.int().min(320).max(1920), height: z.int().min(320).max(1200),
  }).parse(options.viewport);
  const source = localFixtureSource(options.fixturePort);
  options.signal.throwIfAborted();
  const timeoutSeconds = Math.min(config.SESSION_TIMEOUT_SECONDS, 300);
  const started = Date.now();
  const usage: CloudUsage = { reservedSeconds: timeoutSeconds, elapsedSeconds: 0 };
  const bb = new Browserbase({ apiKey: config.BROWSERBASE_API_KEY, maxRetries: 0, timeout: 10000 });
  let browser: StagehandBrowser | undefined;
  let stagehand: Stagehand | undefined;
  let playwright: Browser | undefined;
  let network: Awaited<ReturnType<typeof installFixtureNetwork>> | undefined;
  let closing: Promise<CleanupOutcome> | undefined;
  let launchAttempted = false;
  let phase = "launch";
  const close = (): Promise<CleanupOutcome> => closing ??= (async () => {
    const errors: string[] = [];
    if (launchAttempted && !browser?.sessionId) errors.push("startup_session_unconfirmed");
    if (stagehand) {
      try { usage.modelMetrics = await bounded(stagehand.metrics(), 5000); }
      catch { errors.push("metrics_unavailable"); }
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
        usage.cleanupDiagnostics ??= [];
        usage.cleanupDiagnostics.push({ operation: name, category: error instanceof Error && error.message === "cloud_operation_timeout" ? "timeout" : "rejected" });
      }
    }
    if (browser?.sessionId) {
      try {
        let session = await bb.sessions.retrieve(browser.sessionId);
        if (session.status === "RUNNING" || session.status === "PENDING") {
          await bb.sessions.update(browser.sessionId, { status: "REQUEST_RELEASE", projectId: session.projectId });
          session = await bb.sessions.retrieve(browser.sessionId);
        }
        usage.remoteStatus = session.status;
        if (!["COMPLETED", "ERROR", "TIMED_OUT"].includes(session.status)) errors.push("remote_release_unconfirmed");
        if (session.endedAt) usage.actualBrowserSeconds = Math.max(0, (Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 1000);
      } catch { errors.push("remote_release_unconfirmed"); }
    }
    usage.elapsedSeconds = Math.ceil((Date.now() - started) / 1000);
    usage.networkDiagnostics = network ? [...new Set(network.errors)] : [];
    return { status: errors.length ? "failed" : "closed", errors };
  })();
  try {
    // Launch itself may outlive cancellation; once it returns, record its ID and
    // immediately release it before any page/model work. The remote TTL is final.
    launchAttempted = true;
    browser = await browserbase.launch({
      apiKey: config.BROWSERBASE_API_KEY, projectId: config.BROWSERBASE_PROJECT_ID,
      api_timeout: timeoutSeconds, keepAlive: false, proxies: false,
      browserSettings: { recordSession: true, solveCaptchas: false, viewport: options.viewport },
      userMetadata: { runId: options.runId, personaId: options.personaId, purpose: "layer03" },
    });
    if (!browser.sessionId) throw new Error("missing_session_id");
    phase = "session_reference";
    await bounded(options.onSession({
      sessionId: browser.sessionId, liveViewUrl: "", timeoutSeconds,
      replayUrl: `https://www.browserbase.com/sessions/${browser.sessionId}`,
    }), 5000);
    options.signal.throwIfAborted();
    phase = "stagehand_create";
    const initializing = Stagehand.create({
      browser, apiKey: config.BROWSERBASE_API_KEY, model: { modelName: config.STAGEHAND_MODEL },
      cache: false, selfHeal: false, logging: { level: "off" },
    });
    void initializing.then(async (late) => {
      if (closing) await late.close();
    }).catch(() => { /* Startup/cleanup result stays failed; remote release is still attempted. */ });
    stagehand = await bounded(initializing, 30000);
    options.signal.throwIfAborted();
    phase = "cdp_connect";
    const session = await bb.sessions.retrieve(browser.sessionId);
    if (!session.connectUrl) throw new Error("missing_cdp_connection");
    playwright = await chromium.connectOverCDP(session.connectUrl, { timeout: 10000 });
    const context = playwright.contexts()[0];
    const page = context.pages().find((tab) => !tab.url().startsWith("chrome-extension:")) ?? await context.newPage();
    await page.setViewportSize(options.viewport);
    phase = "extension_identity";
    const workers = context.serviceWorkers().filter((worker) => /^chrome-extension:\/\/[a-p]{32}\/service-worker.js$/.test(worker.url()));
    if (workers.length !== 1) throw new Error("stagehand_extension_identity_unavailable");
    const extensionOrigin = workers[0].url().slice(0, -"/service-worker.js".length);
    phase = "network_install";
    const driverHolder: { current?: FixtureDriver } = {};
    network = await installFixtureNetwork(context, page, source, (event) => driverHolder.current?.policySignal(event.url), extensionOrigin);
    options.signal.throwIfAborted();
    phase = "fixture_setup";
    await page.goto(options.targetUrl, { waitUntil: "networkidle", timeout: 10000 });
    await page.evaluate(({ key, state }) => sessionStorage.setItem(key, state), {
      key: DEMO_STORAGE_KEY, state: JSON.stringify(freshDemo(fixtures)),
    });
    await page.reload({ waitUntil: "networkidle", timeout: 10000 });
    phase = "stagehand_page";
    const pages = await browser.context.pages();
    let stagehandPage;
    for (const candidate of pages) {
      if (await candidate.url() === options.targetUrl) { stagehandPage = candidate; break; }
    }
    if (!stagehandPage) throw new Error("stagehand_page_unavailable");
    await browser.context.setActivePage(stagehandPage);
    phase = "live_reference";
    const debug = await bb.sessions.debug(browser.sessionId);
    await bounded(options.onSession({
      sessionId: browser.sessionId, liveViewUrl: debug.debuggerFullscreenUrl,
      replayUrl: `https://www.browserbase.com/sessions/${browser.sessionId}`, timeoutSeconds,
    }), 5000);
    const driver = new FixtureDriver({
      page, artifacts: options.artifacts, verify: demoVerifier(criteria), close,
      networkErrors: network.errors, keyboardOnly: options.keyboardOnly,
    });
    driverHolder.current = driver;
    options.signal.throwIfAborted();
    return { driver, brain: new GatewayBrain(stagehand, stagehandPage), usage };
  } catch {
    throw new CloudStartupError(await close(), usage, phase);
  }
}
