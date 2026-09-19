import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StagehandMetrics } from "@browserbasehq/stagehand";
import { configSchema } from "../../lib/config";
import { DEMO_STORAGE_KEY, fixedFixtures, freshDemo } from "../../lib/demo";
import { CloudStartupError, createFixtureExecution, type FixtureExecutionOptions } from "./cloud";
import { FIXTURE_ORIGIN } from "./fixture-network";
import type { ArtifactSinks } from "./artifacts";

const mocks = vi.hoisted(() => {
  const page = {
    url: vi.fn(() => "https://fixture.flash-flood.invalid/demo"),
    setViewportSize: vi.fn<() => Promise<void>>(),
    goto: vi.fn<() => Promise<void>>(),
    evaluate: vi.fn<() => Promise<void>>(),
    reload: vi.fn<() => Promise<void>>(),
    close: vi.fn<() => Promise<void>>(),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    on: vi.fn(),
  };
  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    serviceWorkers: vi.fn(() => [{
      url: () => `chrome-extension://${"a".repeat(32)}/service-worker.js`,
    }]),
  };
  const stagehandPage = { url: vi.fn(async () => "https://fixture.flash-flood.invalid/demo") };
  const stagehandContext = {
    pages: vi.fn(async () => [stagehandPage]),
    setActivePage: vi.fn<() => Promise<void>>(),
  };
  const contextAccess = vi.fn(() => stagehandContext);
  const browser = {
    sessionId: "session-fixture",
    get context() { return contextAccess(); },
    close: vi.fn<() => Promise<void>>(),
  };
  const playwright = {
    contexts: vi.fn(() => [context]),
    close: vi.fn<() => Promise<void>>(),
  };
  const stagehand = {
    metrics: vi.fn<() => Promise<StagehandMetrics>>(),
    close: vi.fn<() => Promise<void>>(),
  };
  const network = { errors: [], close: vi.fn<() => Promise<void>>() };
  type Session = {
    status: string; projectId: string; connectUrl?: string; startedAt: string; endedAt?: string;
  };
  const sessions = {
    retrieve: vi.fn<(id: string) => Promise<Session>>(),
    update: vi.fn<(id: string, body: { status: string; projectId: string }) => Promise<void>>(),
    debug: vi.fn(async () => ({ debuggerFullscreenUrl: "https://example.invalid/private-debug" })),
  };
  return {
    page, context, stagehandPage, stagehandContext, contextAccess, browser, playwright, stagehand,
    network, sessions,
    sdk: vi.fn(),
    launch: vi.fn(async () => browser),
    create: vi.fn(async () => stagehand),
    connect: vi.fn(async () => playwright),
    install: vi.fn(async () => network),
  };
});

vi.mock("@browserbasehq/sdk", () => ({
  default: class {
    sessions = mocks.sessions;
    constructor(options: unknown) { mocks.sdk(options); }
  },
}));
vi.mock("@browserbasehq/stagehand", () => ({
  browserbase: { launch: mocks.launch },
  Stagehand: { create: mocks.create },
}));
vi.mock("playwright-core", () => ({ chromium: { connectOverCDP: mocks.connect } }));
vi.mock("./fixture-network", async (importOriginal) => ({
  ...await importOriginal<typeof import("./fixture-network")>(),
  installFixtureNetwork: mocks.install,
}));

const config = configSchema.parse({
  BROWSERBASE_API_KEY: "unit-test-key",
  BROWSERBASE_PROJECT_ID: "00000000-0000-4000-8000-000000000001",
});
const metrics: StagehandMetrics = {
  actPromptTokens: 0, actCompletionTokens: 0, actReasoningTokens: 0,
  actCachedInputTokens: 0, actInferenceTimeMs: 0,
  extractPromptTokens: 12, extractCompletionTokens: 3, extractReasoningTokens: 0,
  extractCachedInputTokens: 0, extractInferenceTimeMs: 25,
  observePromptTokens: 0, observeCompletionTokens: 0, observeReasoningTokens: 0,
  observeCachedInputTokens: 0, observeInferenceTimeMs: 0,
  totalPromptTokens: 12, totalCompletionTokens: 3, totalReasoningTokens: 0,
  totalCachedInputTokens: 0, totalInferenceTimeMs: 25,
};
const completed = {
  status: "COMPLETED", projectId: config.BROWSERBASE_PROJECT_ID!,
  connectUrl: "wss://example.invalid/test-cdp",
  startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:08Z",
};

function options(overrides: Partial<FixtureExecutionOptions> = {}): FixtureExecutionOptions {
  const artifact = { key: "test", kind: "json" as const, bytes: 0, sha256: "test" };
  const artifacts: ArtifactSinks = {
    screenshot: vi.fn<ArtifactSinks["screenshot"]>(async () => ({ ...artifact, kind: "screenshot" })),
    json: vi.fn<ArtifactSinks["json"]>(async () => artifact),
    telemetry: vi.fn<ArtifactSinks["telemetry"]>(async () => artifact),
  };
  return {
    mode: "controlled-fixture",
    runId: "00000000-0000-4000-8000-000000000002", personaId: "careful",
    targetUrl: `${FIXTURE_ORIGIN}/demo`, criteria: ["Complete the demo order"],
    fixturePort: 3000, fixtures: fixedFixtures, viewport: { width: 1280, height: 720 },
    artifacts, signal: new AbortController().signal, onSession: vi.fn(async () => {}),
    ...overrides,
  };
}

async function startupError(input = options()): Promise<CloudStartupError> {
  try {
    const execution = await createFixtureExecution(config, input);
    await execution.driver.close();
    throw new Error("Expected startup to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CloudStartupError);
    if (!(error instanceof CloudStartupError)) throw error;
    return error;
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  mocks.browser.sessionId = "session-fixture";
  mocks.launch.mockResolvedValue(mocks.browser);
  mocks.create.mockResolvedValue(mocks.stagehand);
  mocks.connect.mockResolvedValue(mocks.playwright);
  mocks.install.mockResolvedValue(mocks.network);
  mocks.playwright.contexts.mockReturnValue([mocks.context]);
  mocks.context.pages.mockReturnValue([mocks.page]);
  mocks.context.newPage.mockResolvedValue(mocks.page);
  mocks.context.serviceWorkers.mockReturnValue([{
    url: () => `chrome-extension://${"a".repeat(32)}/service-worker.js`,
  }]);
  mocks.contextAccess.mockReturnValue(mocks.stagehandContext);
  mocks.stagehandContext.pages.mockResolvedValue([mocks.stagehandPage]);
  mocks.stagehandPage.url.mockResolvedValue(`${FIXTURE_ORIGIN}/demo`);
  mocks.page.url.mockReturnValue(`${FIXTURE_ORIGIN}/demo`);
  mocks.page.close.mockResolvedValue(undefined);
  mocks.stagehand.metrics.mockResolvedValue(metrics);
  mocks.sessions.retrieve.mockResolvedValue(completed);
  mocks.sessions.debug.mockResolvedValue({ debuggerFullscreenUrl: "https://example.invalid/private-debug" });
});
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("fixture-only cloud admission", () => {
  it.each([
    { targetUrl: "https://example.com/demo" },
    { targetUrl: `${FIXTURE_ORIGIN}/demo?redirect=https://example.com` },
    { targetUrl: `${FIXTURE_ORIGIN}/_next/static/app.js` },
    { mode: "arbitrary-url" },
    { contextReference: "saved-user-context" },
    { actor: "human" },
  ])("rejects unsupported runtime input before creating any cloud client: %j", async (override) => {
    await expect(createFixtureExecution(config, Object.assign(options(), override)))
      .rejects.toMatchObject({ code: "unsupported" });
    expect(mocks.sdk).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    { fixtures: { ...fixedFixtures, phoneFold: "yes" } },
    { fixtures: { ...fixedFixtures, unexpected: true } },
    { fixturePort: 80 },
    { fixturePort: 65536 },
    { fixturePort: 3000.5 },
    { runId: "" },
    { runId: "not-a-run-uuid" },
    { personaId: "../private" },
    { personaId: "" },
    { personaId: "a".repeat(65) },
    { criteria: [] },
    { criteria: [""] },
    { criteria: ["criterion".repeat(100)] },
    { criteria: ["Same criterion", " Same criterion "] },
    { viewport: { width: 0, height: 720 } },
    { viewport: { width: 1280, height: 10000 } },
    { viewport: { width: 1280.5, height: 720 } },
  ])("rejects invalid fixture setup before launch: %j", async (override) => {
    await expect(createFixtureExecution(config, Object.assign(options(), override))).rejects.toThrow();
    expect(mocks.sdk).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("spends zero SDK/browser/model calls for a pre-aborted signal", async () => {
    const reason = new Error("cancelled before launch");
    await expect(createFixtureExecution(config, options({ signal: AbortSignal.abort(reason) })))
      .rejects.toBe(reason);
    expect(mocks.sdk).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});

describe("startup and private session setup", () => {
  it("does not access either context while Stagehand.create is still pending", async () => {
    let resolve!: (stagehand: typeof mocks.stagehand) => void;
    mocks.create.mockImplementationOnce(() => new Promise((yes) => { resolve = yes; }));
    const starting = createFixtureExecution(config, options());
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.contextAccess).not.toHaveBeenCalled();
    expect(mocks.playwright.contexts).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    resolve(mocks.stagehand);
    const execution = await starting;
    await execution.driver.close();
  });

  it("initializes Stagehand before reading its context and binds both clients to the fixture page", async () => {
    const input = options();
    const execution = await createFixtureExecution(config, input);
    expect(mocks.create.mock.invocationCallOrder[0]).toBeLessThan(mocks.contextAccess.mock.invocationCallOrder[0]);
    expect(mocks.launch).toHaveBeenCalledWith({
      apiKey: config.BROWSERBASE_API_KEY, projectId: config.BROWSERBASE_PROJECT_ID,
      api_timeout: 120, keepAlive: false, proxies: false,
      browserSettings: { recordSession: true, solveCaptchas: false, viewport: input.viewport },
      userMetadata: { runId: input.runId, personaId: input.personaId, purpose: "layer03" },
    });
    expect(mocks.create).toHaveBeenCalledWith({
      browser: mocks.browser, apiKey: config.BROWSERBASE_API_KEY,
      model: { modelName: config.STAGEHAND_MODEL }, cache: false, selfHeal: false,
      logging: { level: "off" },
    });
    expect(mocks.connect).toHaveBeenCalledWith(completed.connectUrl, { timeout: 10000 });
    expect(mocks.install).toHaveBeenCalledWith(
      mocks.context, mocks.page, expect.any(Function), expect.any(Function), `chrome-extension://${"a".repeat(32)}`,
    );
    expect(mocks.install.mock.invocationCallOrder[0]).toBeLessThan(mocks.page.goto.mock.invocationCallOrder[0]);
    expect(mocks.page.evaluate).toHaveBeenCalledWith(expect.any(Function), {
      key: DEMO_STORAGE_KEY, state: JSON.stringify(freshDemo(input.fixtures)),
    });
    expect(mocks.stagehandContext.setActivePage).toHaveBeenCalledWith(mocks.stagehandPage);
    expect(input.onSession).toHaveBeenNthCalledWith(1, {
      sessionId: "session-fixture", liveViewUrl: "", timeoutSeconds: 120,
      replayUrl: "https://www.browserbase.com/sessions/session-fixture",
    });
    expect(input.onSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      liveViewUrl: "https://example.invalid/private-debug",
    }));
    await execution.driver.close();
  });

  it("opens a page when only extension tabs exist", async () => {
    mocks.page.url.mockReturnValue(`chrome-extension://${"a".repeat(32)}/blank.html`);
    const execution = await createFixtureExecution(config, options());
    expect(mocks.context.newPage).toHaveBeenCalledOnce();
    await execution.driver.close();
  });

  it.each([
    [`chrome-extension://${"q".repeat(32)}/service-worker.js`],
    [`chrome-extension://${"a".repeat(31)}/service-worker.js`],
    [`chrome-extension://${"a".repeat(32)}/other-worker.js`],
    [`chrome-extension://${"a".repeat(32)}/service-worker.js?spoof=true`],
    [`https://${"a".repeat(32)}/service-worker.js`],
    [
      `chrome-extension://${"a".repeat(32)}/service-worker.js`,
      `chrome-extension://${"b".repeat(32)}/service-worker.js`,
    ],
  ])("rejects missing or ambiguous extension identity: %j", async (...urls) => {
    mocks.context.serviceWorkers.mockReturnValue(urls.map((url) => ({ url: () => url })));
    const error = await startupError();
    expect(error.cleanup).toEqual({ status: "closed", errors: [] });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.page.goto).not.toHaveBeenCalled();
    expect(mocks.stagehand.close).toHaveBeenCalledOnce();
    expect(mocks.browser.close).toHaveBeenCalledOnce();
  });

  it("derives the extension origin from the sole matching worker rather than a fixed ID", async () => {
    const origin = `chrome-extension://${"b".repeat(32)}`;
    mocks.context.serviceWorkers.mockReturnValue([
      { url: () => "https://example.invalid/service-worker.js" },
      { url: () => `${origin}/service-worker.js` },
    ]);
    const execution = await createFixtureExecution(config, options());
    expect(mocks.install).toHaveBeenCalledWith(
      mocks.context, mocks.page, expect.any(Function), expect.any(Function), origin,
    );
    await execution.driver.close();
  });

  it("releases a browser returned after cancellation before any Stagehand work", async () => {
    const controller = new AbortController();
    mocks.launch.mockImplementationOnce(async () => {
      controller.abort();
      return mocks.browser;
    });
    const error = await startupError(options({ signal: controller.signal }));
    expect(error.cleanup.status).toBe("closed");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.browser.close).toHaveBeenCalledOnce();
  });

  it("closes both owners if cancellation occurs during Stagehand initialization", async () => {
    const controller = new AbortController();
    mocks.create.mockImplementationOnce(async () => {
      controller.abort();
      return mocks.stagehand;
    });
    await startupError(options({ signal: controller.signal }));
    expect(mocks.stagehand.close).toHaveBeenCalledOnce();
    expect(mocks.browser.close).toHaveBeenCalledOnce();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});

describe("startup failure cleanup", () => {
  const failure = new Error("private provider details must not escape");
  it("reports launch failure without attempting nonexistent owner cleanup", async () => {
    mocks.launch.mockRejectedValueOnce(failure);
    const error = await startupError();
    expect(error.message).toBe("cloud_startup_failed");
    expect(error.cleanup).toEqual({ status: "failed", errors: ["startup_session_unconfirmed"] });
    expect(error.usage).toMatchObject({ reservedSeconds: 120, elapsedSeconds: 0 });
    expect(mocks.browser.close).not.toHaveBeenCalled();
  });

  it("reports unknown remote cleanup when the SDK returns no session ID", async () => {
    mocks.browser.sessionId = "";
    const error = await startupError();
    expect(error.cleanup).toEqual({ status: "failed", errors: ["startup_session_unconfirmed"] });
    expect(mocks.browser.close).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([1, 2])("bounds hanging private session hook %i and releases acquired owners", async (hookNumber) => {
    let calls = 0;
    const input = options({
      onSession: async () => {
        if (++calls === hookNumber) await new Promise<void>(() => {});
      },
    });
    const pending = startupError(input);
    await vi.advanceTimersByTimeAsync(5001);
    const error = await pending;
    expect(error.cleanup.status).toBe("closed");
    expect(mocks.browser.close).toHaveBeenCalledOnce();
    expect(mocks.stagehand.close).toHaveBeenCalledTimes(hookNumber - 1);
  });

  it("closes the browser if Stagehand.create itself fails", async () => {
    mocks.create.mockRejectedValueOnce(failure);
    const error = await startupError();
    expect(error.cleanup.status).toBe("closed");
    expect(mocks.browser.close).toHaveBeenCalledOnce();
    expect(mocks.stagehand.close).not.toHaveBeenCalled();
  });

  it.each([
    ["session retrieval", () => mocks.sessions.retrieve.mockRejectedValueOnce(failure), false, false],
    ["missing CDP URL", () => mocks.sessions.retrieve.mockResolvedValueOnce({ ...completed, connectUrl: undefined }), false, false],
    ["CDP connection", () => mocks.connect.mockRejectedValueOnce(failure), false, false],
    ["missing browser context", () => mocks.playwright.contexts.mockReturnValueOnce([]), true, false],
    ["page initialization", () => mocks.page.setViewportSize.mockRejectedValueOnce(failure), true, false],
    ["missing extension worker", () => mocks.context.serviceWorkers.mockReturnValueOnce([]), true, false],
    ["network initialization", () => mocks.install.mockRejectedValueOnce(failure), true, false],
    ["fixture navigation", () => mocks.page.goto.mockRejectedValueOnce(failure), true, true],
    ["fixture seed", () => mocks.page.evaluate.mockRejectedValueOnce(failure), true, true],
    ["fixture reload", () => mocks.page.reload.mockRejectedValueOnce(failure), true, true],
    ["Stagehand page lookup", () => mocks.stagehandContext.pages.mockRejectedValueOnce(failure), true, true],
    ["missing Stagehand page", () => mocks.stagehandContext.pages.mockResolvedValueOnce([]), true, true],
    ["active page", () => mocks.stagehandContext.setActivePage.mockRejectedValueOnce(failure), true, true],
    ["debug URL retrieval", () => mocks.sessions.debug.mockRejectedValueOnce(failure), true, true],
    ["driver hooks", () => mocks.page.on.mockImplementationOnce(() => { throw failure; }), true, true],
  ] as const)("closes every acquired owner after %s fails", async (_name, fail, hasPlaywright, hasNetwork) => {
    fail();
    const error = await startupError();
    expect(error.message).toBe("cloud_startup_failed");
    expect(error.cleanup).toEqual({ status: "closed", errors: [] });
    expect(error.usage.modelMetrics).toEqual(metrics);
    expect(error.usage.actualBrowserSeconds).toBe(8);
    expect(mocks.stagehand.close).toHaveBeenCalledOnce();
    expect(mocks.browser.close).toHaveBeenCalledOnce();
    expect(mocks.playwright.close).toHaveBeenCalledTimes(Number(hasPlaywright));
    expect(mocks.network.close).toHaveBeenCalledTimes(Number(hasNetwork));
  });

  it.each([1, 2])("cleans up when private onSession hook %i fails", async (hookNumber) => {
    let calls = 0;
    const error = await startupError(options({
      onSession: async () => { if (++calls === hookNumber) throw failure; },
    }));
    expect(error.cleanup.status).toBe("closed");
    expect(mocks.browser.close).toHaveBeenCalledOnce();
    expect(mocks.stagehand.close).toHaveBeenCalledTimes(hookNumber - 1);
  });
});

describe("cleanup fences, accounting, and bounded failures", () => {
  it("closes once, captures metrics before closing, and exposes updated usage", async () => {
    const execution = await createFixtureExecution(config, options());
    vi.setSystemTime(new Date("2026-01-01T00:00:03.250Z"));
    const outcomes = await Promise.all([execution.driver.close(), execution.driver.close()]);
    expect(outcomes).toEqual([{ status: "closed", errors: [] }, { status: "closed", errors: [] }]);
    expect(mocks.stagehand.metrics).toHaveBeenCalledOnce();
    expect(mocks.stagehand.metrics.mock.invocationCallOrder[0]).toBeLessThan(mocks.stagehand.close.mock.invocationCallOrder[0]);
    const cleanupOrder = [
      mocks.stagehand.metrics, mocks.stagehand.close, mocks.playwright.close,
      mocks.browser.close, mocks.network.close,
    ].map((operation) => operation.mock.invocationCallOrder[0]);
    expect(cleanupOrder).toEqual([...cleanupOrder].sort((a, b) => a - b));
    for (const close of [mocks.stagehand.close, mocks.playwright.close, mocks.browser.close, mocks.network.close]) {
      expect(close).toHaveBeenCalledOnce();
    }
    expect(execution.usage).toEqual({
      reservedSeconds: 120, elapsedSeconds: 4, actualBrowserSeconds: 8,
      remoteStatus: "COMPLETED", modelMetrics: metrics, networkDiagnostics: [],
    });
  });

  it.each(["RUNNING", "PENDING"])("uses the SDK release fallback for a still-%s remote session", async (status) => {
    mocks.sessions.retrieve.mockResolvedValueOnce(completed)
      .mockResolvedValueOnce({ ...completed, status, endedAt: undefined })
      .mockResolvedValueOnce(completed);
    const execution = await createFixtureExecution(config, options());
    expect(await execution.driver.close()).toEqual({ status: "closed", errors: [] });
    expect(mocks.sessions.update).toHaveBeenCalledWith("session-fixture", {
      status: "REQUEST_RELEASE", projectId: completed.projectId,
    });
    expect(mocks.sessions.retrieve).toHaveBeenCalledTimes(3);
  });

  it("does not pretend an unconfirmed release is successful", async () => {
    mocks.sessions.retrieve.mockResolvedValue({ ...completed, status: "RUNNING", endedAt: undefined });
    const execution = await createFixtureExecution(config, options());
    expect(await execution.driver.close()).toEqual({ status: "failed", errors: ["remote_release_unconfirmed"] });
    expect(execution.usage.remoteStatus).toBe("RUNNING");
    expect(execution.usage.actualBrowserSeconds).toBeUndefined();
  });

  it.each(["ERROR", "TIMED_OUT"])("recognizes terminal remote status %s without releasing twice", async (status) => {
    mocks.sessions.retrieve.mockResolvedValue({ ...completed, status });
    const execution = await createFixtureExecution(config, options());
    expect(await execution.driver.close()).toEqual({ status: "closed", errors: [] });
    expect(mocks.sessions.update).not.toHaveBeenCalled();
    expect(execution.usage.remoteStatus).toBe(status);
  });

  it.each(["retrieve", "update"] as const)("reports a failed remote %s without losing local cleanup or metrics", async (method) => {
    const execution = await createFixtureExecution(config, options());
    mocks.sessions.retrieve.mockResolvedValue({ ...completed, status: "RUNNING" });
    mocks.sessions[method].mockRejectedValueOnce(new Error("SDK failure"));
    expect(await execution.driver.close()).toEqual({ status: "failed", errors: ["remote_release_unconfirmed"] });
    expect(mocks.browser.close).toHaveBeenCalledOnce();
    expect(execution.usage.modelMetrics).toEqual(metrics);
  });

  it("continues all lifecycle closes and remote verification after Stagehand.close rejects", async () => {
    mocks.stagehand.close.mockRejectedValueOnce(new Error("close failed"));
    const execution = await createFixtureExecution(config, options());
    expect(await execution.driver.close()).toEqual({ status: "failed", errors: ["stagehand_close"] });
    expect(mocks.playwright.close).toHaveBeenCalledOnce();
    expect(mocks.browser.close).toHaveBeenCalledOnce();
    expect(mocks.network.close).toHaveBeenCalledOnce();
    expect(execution.usage.remoteStatus).toBe("COMPLETED");
    expect(execution.usage.cleanupDiagnostics).toEqual([
      { operation: "stagehand_close", category: "rejected" },
    ]);
  });

  it("accumulates independent cleanup failures without skipping later owners", async () => {
    mocks.stagehand.metrics.mockRejectedValueOnce(new Error("metrics failed"));
    mocks.stagehand.close.mockRejectedValueOnce(new Error("stagehand failed"));
    mocks.playwright.close.mockRejectedValueOnce(new Error("playwright failed"));
    mocks.browser.close.mockRejectedValueOnce(new Error("browser failed"));
    mocks.network.close.mockRejectedValueOnce(new Error("network failed"));
    const execution = await createFixtureExecution(config, options());
    expect(await execution.driver.close()).toEqual({
      status: "failed",
      errors: ["metrics_unavailable", "stagehand_close", "playwright_close", "browser_close", "network_close"],
    });
    expect(execution.usage.remoteStatus).toBe("COMPLETED");
    expect(execution.usage.modelMetrics).toBeUndefined();
    expect(execution.usage.cleanupDiagnostics).toEqual([
      { operation: "stagehand_close", category: "rejected" },
      { operation: "playwright_close", category: "rejected" },
      { operation: "browser_close", category: "rejected" },
      { operation: "network_close", category: "rejected" },
    ]);
  });

  it("preserves cleanup failure details and usage on startup errors", async () => {
    mocks.page.evaluate.mockRejectedValueOnce(new Error("seed failed"));
    mocks.stagehand.close.mockRejectedValueOnce(new Error("close failed"));
    const error = await startupError();
    expect(error.cleanup).toEqual({ status: "failed", errors: ["stagehand_close"] });
    expect(error.usage).toMatchObject({ modelMetrics: metrics, remoteStatus: "COMPLETED", actualBrowserSeconds: 8 });
    expect(mocks.browser.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["metrics_unavailable", () => mocks.stagehand.metrics.mockImplementationOnce(() => new Promise(() => {}))],
    ["stagehand_close", () => mocks.stagehand.close.mockImplementationOnce(() => new Promise(() => {}))],
    ["playwright_close", () => mocks.playwright.close.mockImplementationOnce(() => new Promise(() => {}))],
    ["browser_close", () => mocks.browser.close.mockImplementationOnce(() => new Promise(() => {}))],
    ["network_close", () => mocks.network.close.mockImplementationOnce(() => new Promise(() => {}))],
  ] as const)("bounds a hanging %s operation and continues cleanup", async (code, hang) => {
    const execution = await createFixtureExecution(config, options());
    hang();
    const closing = execution.driver.close();
    await vi.advanceTimersByTimeAsync(5001);
    expect(await closing).toEqual({ status: "failed", errors: [code] });
    expect(mocks.browser.close).toHaveBeenCalledOnce();
    expect(mocks.network.close).toHaveBeenCalledOnce();
    if (code !== "metrics_unavailable") {
      expect(execution.usage.cleanupDiagnostics).toEqual([{ operation: code, category: "timeout" }]);
    }
  });

  it("bounds Stagehand initialization timeout and releases the known browser", async () => {
    mocks.create.mockImplementationOnce(() => new Promise(() => {}));
    const failed = startupError();
    await vi.advanceTimersByTimeAsync(30001);
    expect((await failed).cleanup.status).toBe("closed");
    expect(mocks.browser.close).toHaveBeenCalledOnce();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("closes a Stagehand handle that arrives after its startup deadline", async () => {
    let resolve!: (stagehand: typeof mocks.stagehand) => void;
    mocks.create.mockImplementationOnce(() => new Promise((yes) => { resolve = yes; }));
    const failed = startupError();
    await vi.advanceTimersByTimeAsync(30001);
    await failed;
    expect(mocks.browser.close).toHaveBeenCalledOnce();
    expect(mocks.stagehand.close).not.toHaveBeenCalled();
    resolve(mocks.stagehand);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.stagehand.close).toHaveBeenCalledOnce();
    expect(mocks.contextAccess).not.toHaveBeenCalled();
  });
});
