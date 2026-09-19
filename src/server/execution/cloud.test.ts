import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { StagehandMetrics } from "@browserbasehq/stagehand";
import { configSchema } from "../../lib/config";
import { DEMO_STORAGE_KEY, fixedFixtures, freshDemo } from "../../lib/demo";
import { CloudStartupError, createFixtureExecution, type FixtureExecutionOptions } from "./cloud";
import { FIXTURE_ORIGIN } from "./fixture-network";
import type { ArtifactSinks } from "./artifacts";
import { COMPLETE_CRITERION, COUPON_CRITERION, FixtureDriver } from "./driver";
import type { Page } from "playwright-core";
import { personas } from "../../lib/personas";
import { controlledSite } from "../../lib/controlled-sites";
import type { BrainInput } from "./types";

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
    get id() { return this.sessionId; },
    get context() { return contextAccess(); },
    close: vi.fn<() => Promise<void>>(),
  };
  const playwright = {
    contexts: vi.fn(() => [context]),
    close: vi.fn<() => Promise<void>>(),
  };
  const stagehand = {
    extract: vi.fn<() => Promise<{ data: { action: "give_up"; candidateId: null; value: null; commentary: string } }>>(),
    metrics: vi.fn<() => Promise<StagehandMetrics>>(),
    close: vi.fn<() => Promise<void>>(),
  };
  const network = { errors: [], close: vi.fn<() => Promise<void>>() };
  type Session = {
    status: string; projectId: string; connectUrl?: string; startedAt: string; endedAt?: string;
  };
  const sessions = {
    create: vi.fn<(params: unknown) => Promise<typeof browser>>(async () => browser),
    retrieve: vi.fn<(id: string) => Promise<Session>>(),
    update: vi.fn<(id: string, body: { status: string; projectId: string }) => Promise<void>>(),
    debug: vi.fn(async () => ({ debuggerFullscreenUrl: "https://example.invalid/private-debug" })),
  };
  return {
    page, context, stagehandPage, stagehandContext, contextAccess, browser, playwright, stagehand,
    network, sessions,
    sdk: vi.fn(),
    launch: sessions.create,
    forbiddenLaunch: vi.fn(),
    attach: vi.fn(async () => browser),
    extensions: { create: vi.fn(async () => ({ id: "fake-extension" })), delete: vi.fn() },
    create: vi.fn(async () => stagehand),
    connect: vi.fn(async () => playwright),
    install: vi.fn(async () => network),
  };
});

vi.mock("@browserbasehq/sdk", () => ({
  default: class {
    sessions = mocks.sessions;
    extensions = mocks.extensions;
    constructor(options: unknown) { mocks.sdk(options); }
  },
}));
vi.mock("@browserbasehq/stagehand", () => ({
  browserbase: { launch: mocks.forbiddenLaunch, connect: mocks.attach },
  Stagehand: { create: mocks.create },
}));
vi.mock("playwright-core", () => ({ chromium: { connectOverCDP: mocks.connect } }));
vi.mock("./fixture-network", async (importOriginal) => ({
  ...await importOriginal<typeof import("./fixture-network")>(),
  installControlledNetwork: mocks.install,
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
    targetUrl: `${FIXTURE_ORIGIN}/demo`, criteria: [COMPLETE_CRITERION],
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

function brainInput(): BrainInput {
  return {
    persona: personas[0], goal: "Complete the fixture", criteria: [COMPLETE_CRITERION], history: [],
    observation: { id: "fixture", url: `${FIXTURE_ORIGIN}/demo`, title: "Fixture", text: "", candidates: [], checks: [], signals: [] },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  mocks.browser.sessionId = "session-fixture";
  mocks.launch.mockResolvedValue(mocks.browser);
  mocks.attach.mockResolvedValue(mocks.browser);
  mocks.extensions.create.mockResolvedValue({ id: "fake-extension" });
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
  expect(mocks.forbiddenLaunch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("fixture-only cloud admission", () => {
  it.each([false, true])("passes only the worker-resolved context and explicit persist=%s", async (persist) => {
    const contextReference = { id: "00000000-0000-4000-8000-000000000055", persist };
    const execution = await createFixtureExecution(config, options({ contextReference }));
    expect(mocks.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      browserSettings: expect.objectContaining({ context: contextReference }),
    }));
    await execution.driver.close();
  });

  it("omits provider context settings entirely for default fresh sessions", async () => {
    const execution = await createFixtureExecution(config, options());
    const input = mocks.sessions.create.mock.calls[0][0];
    expect(input).toHaveProperty("browserSettings");
    expect(input).not.toHaveProperty("browserSettings.context");
    await execution.driver.close();
  });

  it.each([COUPON_CRITERION, COMPLETE_CRITERION])("rejects store-only legacy criterion on the board before allocation: %s", async (criterion) => {
    const site = controlledSite("project-board");
    await expect(createFixtureExecution(config, options({
      controlledSiteId: site.id, targetUrl: site.origin + site.entryPath,
      fixtures: undefined, criteria: [criterion],
    }))).rejects.toMatchObject({
      code: "unsupported", phase: "admission",
      usage: { allocationAttempted: false }, cleanup: { status: "closed", errors: [] },
    });
    expect(mocks.sdk).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("allows the same wording as an explicitly semantic board criterion", async () => {
    const site = controlledSite("project-board");
    const targetUrl = site.origin + site.entryPath;
    mocks.page.url.mockReturnValue(targetUrl);
    mocks.stagehandPage.url.mockResolvedValue(targetUrl);
    const execution = await createFixtureExecution(config, options({
      controlledSiteId: site.id, targetUrl, fixtures: undefined,
      criteria: [{ id: "explicit-semantic", kind: "semantic", description: COMPLETE_CRITERION, semantics: "current" }],
    }));
    expect(mocks.launch).toHaveBeenCalledOnce();
    expect(await execution.driver.close()).toEqual({ status: "closed", errors: [] });
  });

  it("accepts novel criteria for both controlled sites without requiring a demo seed", async () => {
    for (const id of ["store", "project-board"] as const) {
      const site = controlledSite(id);
      const targetUrl = site.origin + site.entryPath;
      mocks.page.url.mockReturnValue(targetUrl);
      mocks.stagehandPage.url.mockResolvedValue(targetUrl);
      const execution = await createFixtureExecution(config, options({
        controlledSiteId: id, targetUrl, fixtures: undefined,
        criteria: [
          "The visitor can find the creation or shopping journey.",
          { id: "entry", kind: "url", description: "At the entry", semantics: "current", path: site.entryPath },
        ],
      }));
      expect(execution.usage.allocationAttempted).toBe(true);
      expect(mocks.page.evaluate).not.toHaveBeenCalled();
      expect(mocks.page.reload).not.toHaveBeenCalled();
      expect(await execution.driver.close()).toEqual({ status: "closed", errors: [] });
    }
  });

  it.each([
    { controlledSiteId: "project-board", targetUrl: `${FIXTURE_ORIGIN}/demo` },
    { controlledSiteId: "store", targetUrl: "https://board.flash-flood.invalid/project-board" },
    { controlledSiteId: "project-board", targetUrl: "https://example.com/project-board" },
    { controlledSiteId: "unknown" },
    { controlledSiteId: "project-board", targetUrl: "https://board.flash-flood.invalid/project-board", fixtures: fixedFixtures },
    { scope: { targetUrl: `${FIXTURE_ORIGIN}/demo`, allowedSubdomains: [], pathPrefixes: ["/demo/cart"] } },
    { criteria: [
      { id: "same", kind: "url", description: "one", semantics: "current", path: "/demo" },
      { id: "same", kind: "url", description: "two", semantics: "milestone", path: "/demo/cart" },
    ] },
  ])("fails controlled-target mismatches before allocation %j", async (overrides) => {
    await expect(createFixtureExecution(config, Object.assign(options({ fixtures: undefined }), overrides))).rejects.toMatchObject({
      phase: "admission", usage: { allocationAttempted: false },
    });
    expect(mocks.sdk).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });

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
    { criteria: [COUPON_CRITERION, COUPON_CRITERION] },
    { correlationToken: "not-a-uuid" },
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
      .rejects.toMatchObject({ phase: "admission", cleanup: { status: "closed", errors: [] }, usage: { allocationAttempted: false } });
    expect(mocks.sdk).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("provides no-allocation proof when local SDK construction fails", async () => {
    mocks.sdk.mockImplementationOnce(() => { throw new Error("offline_client_configuration"); });
    const error = await startupError();
    expect(error.phase).toBe("client_initialization");
    expect(error.usage.allocationAttempted).toBe(false);
    expect(error.cleanup).toEqual({ status: "closed", errors: [] });
    expect(mocks.extensions.create).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});

describe("startup and private session setup", () => {
  it.each(["lost response", "server failure"])("does not retry allocation after %s using the actual SDK transport", async (failure) => {
    const { default: ActualBrowserbase } = await vi.importActual<typeof import("@browserbasehq/sdk")>("@browserbasehq/sdk");
    let outgoingCreationPosts = 0;
    const transport = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(url)).pathname).toBe("/v1/sessions");
      expect(init?.method).toBe("POST");
      outgoingCreationPosts++;
      // The provider may already have allocated a session when its reply is lost.
      if (failure === "lost response") throw new Error("offline lost response");
      return new Response("{}", { status: 500, headers: { "content-type": "application/json", "retry-after-ms": "1" } });
    });
    mocks.sessions.create.mockImplementationOnce(async (allocation) => {
      const clientOptions = mocks.sdk.mock.calls[0][0] as ConstructorParameters<typeof ActualBrowserbase>[0];
      const actual = new ActualBrowserbase({ ...clientOptions, fetch: transport });
      return await actual.sessions.create(allocation as Parameters<typeof actual.sessions.create>[0]) as unknown as typeof mocks.browser;
    });
    const input = options();
    const error = await startupError(input);
    expect(error.cleanup).toEqual({ status: "failed", errors: ["startup_session_unconfirmed"] });
    expect(error.usage.reservedSeconds).toBe(120);
    expect(error.usage.allocationAttempted).toBe(true);
    expect(error.usage.actualBrowserSeconds).toBeUndefined();
    expect(input.onSession).not.toHaveBeenCalled();
    expect(outgoingCreationPosts).toBe(1);
    expect(transport).toHaveBeenCalledOnce();
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
  });

  it("uploads the pinned extension and deletes it after remote cleanup", async () => {
    const execution = await createFixtureExecution(config, options());
    expect(mocks.extensions.create).toHaveBeenCalledWith({ file: expect.objectContaining({ path: expect.stringContaining("dist/assets/stagehand-extension.zip") }) });
    expect(mocks.extensions.create.mock.invocationCallOrder[0]).toBeLessThan(mocks.launch.mock.invocationCallOrder[0]);
    await execution.driver.close();
    expect(mocks.extensions.delete).toHaveBeenCalledExactlyOnceWith("fake-extension", { headers: { "Content-Type": null } });
    expect(mocks.extensions.delete.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.sessions.retrieve.mock.invocationCallOrder.at(-1)!);
  });

  it("records and releases allocation before any browser connection when the lease is lost during allocation", async () => {
    let active = true;
    const onSession = vi.fn(async () => {});
    mocks.launch.mockImplementationOnce(async () => { active = false; return mocks.browser; });
    mocks.sessions.retrieve.mockResolvedValueOnce({ ...completed, status: "RUNNING", endedAt: undefined }).mockResolvedValueOnce(completed);
    const result = await startupError(options({
      onSession, assertActive: () => { if (!active) throw new Error("lease_lost"); },
    }));
    expect(onSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: mocks.browser.sessionId }));
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.sessions.update).toHaveBeenCalledWith(mocks.browser.sessionId, { projectId: completed.projectId, status: "REQUEST_RELEASE" });
    expect(result.cleanup.status).toBe("closed");
  });

  it("does not allocate a session after lease loss during extension upload", async () => {
    let active = true;
    mocks.extensions.create.mockImplementationOnce(async () => { active = false; return { id: "fake-extension" }; });
    const result = await startupError(options({ assertActive: () => { if (!active) throw new Error("lease_lost"); } }));
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
    expect(result.cleanup.status).toBe("closed");
    expect(result.usage.allocationAttempted).toBe(false);
  });

  it("provides explicit zero-allocation proof for cancellation during extension upload", async () => {
    const controller = new AbortController();
    mocks.extensions.create.mockImplementationOnce(async () => {
      controller.abort();
      return { id: "fake-extension" };
    });
    const result = await startupError(options({ signal: controller.signal }));
    expect(result.usage).toMatchObject({ allocationAttempted: false, reservedSeconds: 120 });
    expect(result.usage.remoteStatus).toBeUndefined();
    expect(result.cleanup).toEqual({ status: "closed", errors: [] });
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
  });

  it("attaches bounded layer04 correlation metadata without changing layer03 defaults", async () => {
    const correlationToken = "00000000-0000-4000-8000-000000000003";
    const input = options({ correlationToken, criteria: [COUPON_CRITERION, COMPLETE_CRITERION] });
    const execution = await createFixtureExecution(config, input);
    const metadata = mocks.launch.mock.calls[0] as unknown as [{ userMetadata: unknown }];
    expect(metadata[0].userMetadata).toEqual({
      purpose: "layer04", correlationToken, runId: input.runId, personaId: input.personaId,
    });
    expect(Buffer.byteLength(JSON.stringify(metadata[0].userMetadata))).toBeLessThan(512);
    await execution.driver.close();
  });

  it("does not spend on a synchronously revoked launch", async () => {
    await expect(createFixtureExecution(config, options({ assertActive: () => { throw new Error("lease_lost"); } })))
      .rejects.toMatchObject({ phase: "admission", usage: { allocationAttempted: false } });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("rechecks ownership immediately before paid launch", async () => {
    const assertActive = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error("lease_lost"); });
    const error = await startupError(options({ assertActive }));
    expect(error.cleanup).toEqual({ status: "closed", errors: [] });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it.each([
    ["launch", mocks.launch, mocks.attach],
    ["browser connection", mocks.attach, mocks.create],
    ["Stagehand initialization", mocks.create, mocks.connect],
    ["session retrieval", mocks.sessions.retrieve, mocks.connect],
    ["CDP connection", mocks.connect, mocks.page.setViewportSize],
    ["viewport", mocks.page.setViewportSize, mocks.install],
    ["network installation", mocks.install, mocks.page.goto],
    ["navigation", mocks.page.goto, mocks.page.evaluate],
    ["fixture seed", mocks.page.evaluate, mocks.page.reload],
    ["fixture reload", mocks.page.reload, mocks.stagehandContext.pages],
    ["page listing", mocks.stagehandContext.pages, mocks.stagehandPage.url],
    ["candidate URL", mocks.stagehandPage.url, mocks.stagehandContext.setActivePage],
    ["active page", mocks.stagehandContext.setActivePage, mocks.sessions.debug],
  ] as const)("fences startup after ownership is lost during %s", async (_name, previous, next) => {
    let active = true;
    const operation = previous as unknown as Mock<(...args: unknown[]) => unknown>;
    const original = operation.getMockImplementation();
    operation.mockImplementationOnce(async (...args) => {
      const result = await original?.(...args);
      active = false;
      return result;
    });
    const error = await startupError(options({ assertActive: () => { if (!active) throw new Error("lease_lost"); } }));
    expect(error.message).toBe("cloud_startup_failed");
    expect(next).not.toHaveBeenCalled();
    expect(mocks.browser.close).toHaveBeenCalledTimes(_name === "launch" ? 0 : 1);
  });

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
      projectId: config.BROWSERBASE_PROJECT_ID, extensionId: "fake-extension",
      api_timeout: 120, keepAlive: false, proxies: false,
      browserSettings: { recordSession: true, solveCaptchas: false, viewport: input.viewport },
      userMetadata: { runId: input.runId, personaId: input.personaId, purpose: "layer03" },
    });
    expect(mocks.attach).toHaveBeenCalledWith({ apiKey: config.BROWSERBASE_API_KEY, sessionId: mocks.browser.sessionId });
    expect(mocks.create).toHaveBeenCalledWith({
      browser: mocks.browser, apiKey: config.BROWSERBASE_API_KEY,
      model: { modelName: config.STAGEHAND_MODEL }, cache: false, selfHeal: false,
      logging: { level: "off" },
    });
    expect(mocks.connect).toHaveBeenCalledWith(completed.connectUrl, { timeout: 10000 });
    expect(mocks.install).toHaveBeenCalledWith(
      mocks.context, mocks.page, expect.any(Function), expect.any(Function), expect.any(Function), `chrome-extension://${"a".repeat(32)}`,
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
      mocks.context, mocks.page, expect.any(Function), expect.any(Function), expect.any(Function), origin,
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
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.sessions.retrieve).toHaveBeenCalledWith(mocks.browser.sessionId);
    expect(mocks.browser.close).not.toHaveBeenCalled();
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
  it("does not allocate after failed extension provisioning", async () => {
    mocks.extensions.create.mockRejectedValueOnce(failure);
    const error = await startupError();
    expect(error.cleanup).toEqual({ status: "closed", errors: [] });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("releases the paid allocation if connection to Stagehand fails before a browser handle exists", async () => {
    mocks.attach.mockRejectedValueOnce(failure);
    mocks.sessions.retrieve.mockResolvedValueOnce({ ...completed, status: "RUNNING", endedAt: undefined }).mockResolvedValueOnce(completed);
    const error = await startupError();
    expect(error.cleanup).toEqual({ status: "closed", errors: [] });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.sessions.update).toHaveBeenCalledOnce();
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
  });

  it("bounds browser connection and closes a handle returned after timeout", async () => {
    let resolve!: (browser: typeof mocks.browser) => void;
    mocks.attach.mockImplementationOnce(() => new Promise((yes) => { resolve = yes; }));
    const pending = startupError();
    await vi.advanceTimersByTimeAsync(30001);
    expect((await pending).cleanup.status).toBe("closed");
    expect(mocks.sessions.retrieve).toHaveBeenCalledWith(mocks.browser.sessionId);
    resolve(mocks.browser);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.browser.close).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("reports launch failure without attempting nonexistent owner cleanup", async () => {
    mocks.launch.mockRejectedValueOnce(failure);
    const error = await startupError();
    expect(error.message).toBe("cloud_startup_failed");
    expect(error.cleanup).toEqual({ status: "failed", errors: ["startup_session_unconfirmed"] });
    expect(error.usage).toMatchObject({ reservedSeconds: 120, elapsedSeconds: 0 });
    expect(mocks.browser.close).not.toHaveBeenCalled();
    expect(mocks.launch).toHaveBeenCalledOnce();
  });

  describe("driver synchronous ownership fence", () => {
    it("rejects action dispatch when ownership changes during candidate checks", async () => {
      let active = true;
      const locator = {
        isVisible: vi.fn(async () => true), isEnabled: vi.fn(async () => true),
        boundingBox: vi.fn(async () => { active = false; return { y: 0, height: 20 }; }),
        click: vi.fn(),
      };
      const page = {
        ...mocks.page, frames: () => [{}], screenshot: vi.fn(async () => Buffer.from("fixture")),
        evaluate: vi.fn(async () => ({ title: "fixture", text: "", candidates: [{ id: "c0", kind: "button", label: "Next" }] })),
        locator: () => locator, viewportSize: () => ({ width: 1280, height: 720 }),
      };
      const driver = new FixtureDriver({
        page: page as unknown as Page, artifacts: options().artifacts, verify: async () => [],
        close: async () => ({ status: "closed", errors: [] }), networkErrors: [],
        assertActive: () => { if (!active) throw new Error("lease_lost"); },
      });
      await driver.observe(new AbortController().signal);
      await expect(driver.act({ actor: "agent", action: "click", candidateId: "c0", value: null, commentary: "" }, new AbortController().signal))
        .rejects.toThrow("lease_lost");
      expect(locator.click).not.toHaveBeenCalled();
      await driver.close();
    });

    it("propagates the cloud fence to the returned driver without requiring cancellation", async () => {
      let active = true;
      const execution = await createFixtureExecution(config, options({
        assertActive: () => { if (!active) throw new Error("lease_lost"); },
      }));
      mocks.page.evaluate.mockClear();
      active = false;
      await expect(execution.driver.observe(new AbortController().signal)).rejects.toThrow("lease_lost");
      expect(mocks.page.evaluate).not.toHaveBeenCalled();
      expect(await execution.driver.close()).toEqual({ status: "closed", errors: [] });
    });
  });

  it("reports unknown remote cleanup when the SDK returns no session ID", async () => {
    mocks.browser.sessionId = "";
    const error = await startupError();
    expect(error.cleanup).toEqual({ status: "failed", errors: ["startup_session_unconfirmed"] });
    expect(mocks.browser.close).not.toHaveBeenCalled();
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
    expect(mocks.browser.close).toHaveBeenCalledTimes(hookNumber - 1);
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
    expect(mocks.browser.close).toHaveBeenCalledTimes(hookNumber - 1);
    expect(mocks.stagehand.close).toHaveBeenCalledTimes(hookNumber - 1);
  });
});

describe("cleanup fences, accounting, and bounded failures", () => {
  it("drains a cancelled pending extraction before metrics/close and awaits every resource release", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    let resolveExtract!: (value: Awaited<ReturnType<typeof mocks.stagehand.extract>>) => void;
    const extraction = new Promise<Awaited<ReturnType<typeof mocks.stagehand.extract>>>((resolve) => { resolveExtract = resolve; });
    mocks.stagehand.extract.mockReturnValueOnce(extraction);
    const resources = { stagehand: false, playwright: false, browser: false, network: false, extension: false };
    mocks.stagehand.metrics.mockImplementation(async () => { await extraction; return metrics; });
    mocks.stagehand.close.mockImplementation(async () => {
      await extraction;
      await new Promise((resolve) => setTimeout(resolve, 250));
      resources.stagehand = true;
    });
    mocks.playwright.close.mockImplementation(async () => { resources.playwright = true; });
    mocks.browser.close.mockImplementation(async () => { resources.browser = true; });
    mocks.network.close.mockImplementation(async () => { resources.network = true; });
    mocks.extensions.delete.mockImplementation(async () => { resources.extension = true; });
    const artifacts = options().artifacts;
    const cleanupJson = artifacts.json;
    const ordinaryJson = vi.fn<ArtifactSinks["json"]>(async (value) => {
      controller.signal.throwIfAborted();
      return cleanupJson(value);
    });
    const execution = await createFixtureExecution(config, options({
      signal: controller.signal, artifacts: { ...artifacts, json: ordinaryJson }, cleanupJson,
    }));
    execution.driver.policySignal(`${FIXTURE_ORIGIN}/demo`);
    const deciding = expect(execution.brain.decide(brainInput(), controller.signal)).rejects.toBe(reason);
    controller.abort(reason);
    let cleanupReturned = false;
    const closing = execution.driver.close().then((outcome) => { cleanupReturned = true; return outcome; });
    setTimeout(() => resolveExtract({ data: { action: "give_up", candidateId: null, value: null, commentary: "Stopped." } }), 12000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.stagehand.metrics).not.toHaveBeenCalled();
    expect(mocks.stagehand.close).not.toHaveBeenCalled();
    expect(cleanupReturned).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.stagehand.metrics).toHaveBeenCalledOnce();
    expect(mocks.stagehand.close).toHaveBeenCalledOnce();
    expect(cleanupReturned).toBe(false);
    expect(resources.stagehand).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(await closing).toEqual({ status: "closed", errors: [] });
    await deciding;
    expect(resources).toEqual({ stagehand: true, playwright: true, browser: true, network: true, extension: true });
    expect(execution.usage).toMatchObject({ modelMetrics: metrics, remoteStatus: "COMPLETED", actualBrowserSeconds: 8 });
    expect(execution.usage.cleanupDiagnostics).toBeUndefined();
    expect(execution.usage.cleanupErrors).toBeUndefined();
    expect(ordinaryJson).not.toHaveBeenCalled();
    expect(cleanupJson).toHaveBeenCalledExactlyOnceWith({ telemetry: [expect.objectContaining({ code: "POLICY_BLOCK" })] });
    expect(mocks.stagehand.extract).toHaveBeenCalledOnce();
    await expect(execution.brain.decide(brainInput(), new AbortController().signal)).rejects.toThrow("gateway_closed");
    expect(mocks.stagehand.extract).toHaveBeenCalledOnce();
  });

  it("reproduces cancellation-rejected telemetry persistence and records the previously missing cleanup code", async () => {
    const controller = new AbortController();
    const artifacts = options().artifacts;
    artifacts.json = vi.fn(async () => { controller.signal.throwIfAborted(); throw new Error("unexpected write"); });
    const execution = await createFixtureExecution(config, options({ signal: controller.signal, artifacts }));
    execution.driver.policySignal(`${FIXTURE_ORIGIN}/demo`);
    controller.abort();
    expect(await execution.driver.close()).toEqual({ status: "failed", errors: ["telemetry_write_failed"] });
    expect(execution.usage.cleanupErrors).toEqual(["telemetry_write_failed"]);
    expect(execution.usage.cleanupDiagnostics).toEqual([{ operation: "telemetry_write_failed", category: "rejected" }]);
    expect(execution.usage.remoteStatus).toBe("COMPLETED");
    expect(mocks.stagehand.close).toHaveBeenCalledOnce();
    expect(mocks.browser.close).toHaveBeenCalledOnce();
  });

  it("preserves a genuine ownership/write failure in the cancellation-permitted teardown sink", async () => {
    const controller = new AbortController();
    let owned = true;
    const write = options().artifacts.json;
    const cleanupJson = vi.fn<ArtifactSinks["json"]>(async (value) => {
      if (!owned) throw new Error("private lease details");
      const artifact = await write(value);
      if (!owned) throw new Error("private lease details");
      return artifact;
    });
    const execution = await createFixtureExecution(config, options({ signal: controller.signal, cleanupJson }));
    execution.driver.policySignal(`${FIXTURE_ORIGIN}/demo`);
    controller.abort();
    owned = false;
    expect(await execution.driver.close()).toEqual({ status: "failed", errors: ["telemetry_write_failed"] });
    expect(write).not.toHaveBeenCalled();
    expect(execution.usage.cleanupErrors).toEqual(["telemetry_write_failed"]);
    expect(JSON.stringify(execution.usage)).not.toContain("private lease details");
    expect(mocks.browser.close).toHaveBeenCalledOnce();
  });

  it("preserves a real drain timeout and releases remote work before further worker RPCs", async () => {
    let rejectExtract!: (error: Error) => void;
    mocks.stagehand.extract.mockImplementationOnce(() => new Promise((_, reject) => { rejectExtract = reject; }));
    const execution = await createFixtureExecution(config, options());
    const deciding = expect(execution.brain.decide(brainInput(), new AbortController().signal)).rejects.toThrow("remote_released");
    mocks.sessions.retrieve.mockResolvedValueOnce({ ...completed, status: "RUNNING", endedAt: undefined }).mockResolvedValueOnce(completed);
    mocks.sessions.update.mockImplementationOnce(async () => { rejectExtract(new Error("remote_released")); });
    const closing = execution.driver.close();
    await vi.advanceTimersByTimeAsync(40001);
    expect(await closing).toEqual({ status: "failed", errors: ["gateway_drain"] });
    await deciding;
    expect(mocks.sessions.update.mock.invocationCallOrder[0]).toBeLessThan(mocks.stagehand.metrics.mock.invocationCallOrder[0]);
    expect(mocks.stagehand.close).toHaveBeenCalledOnce();
    expect(execution.usage.cleanupDiagnostics).toEqual([{ operation: "gateway_drain", category: "timeout" }]);
    expect(execution.usage.remoteStatus).toBe("COMPLETED");
  });

  it("reports extension deletion failure without losing release accounting", async () => {
    mocks.extensions.delete.mockRejectedValueOnce(new Error("private details"));
    const execution = await createFixtureExecution(config, options());
    expect(await execution.driver.close()).toEqual({ status: "failed", errors: ["extension_delete"] });
    expect(execution.usage.actualBrowserSeconds).toBe(8);
    expect(execution.usage.cleanupErrors).toEqual(["extension_delete"]);
    expect(execution.usage.cleanupDiagnostics).toEqual([{ operation: "extension_delete", category: "rejected" }]);
  });

  it("bounds extension deletion", async () => {
    mocks.extensions.delete.mockImplementationOnce(() => new Promise(() => {}));
    const execution = await createFixtureExecution(config, options());
    const closing = execution.driver.close();
    await vi.advanceTimersByTimeAsync(5001);
    expect(await closing).toEqual({ status: "failed", errors: ["extension_delete"] });
    expect(execution.usage.cleanupDiagnostics).toEqual([{ operation: "extension_delete", category: "timeout" }]);
  });

  it.each([undefined, "invalid", "2025-12-31T23:59:59Z"])("leaves unavailable duration uncharged as actual usage: %s", async (endedAt) => {
    mocks.sessions.retrieve.mockResolvedValue({ ...completed, endedAt });
    const execution = await createFixtureExecution(config, options());
    expect(await execution.driver.close()).toEqual({ status: "closed", errors: [] });
    expect(execution.usage.actualBrowserSeconds).toBeUndefined();
  });

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
      allocationAttempted: true,
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
    expect(execution.usage.cleanupErrors).toEqual(["remote_release_unconfirmed"]);
    expect(execution.usage.cleanupDiagnostics).toEqual([{ operation: "remote_release_unconfirmed", category: "unconfirmed" }]);
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
    expect(execution.usage.cleanupErrors).toEqual(["remote_release_unconfirmed"]);
    expect(execution.usage.cleanupDiagnostics).toEqual([{ operation: "remote_release_unconfirmed", category: "rejected" }]);
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
      { operation: "metrics", category: "rejected" },
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
    expect(execution.usage.cleanupDiagnostics).toEqual([{ operation: code === "metrics_unavailable" ? "metrics" : code, category: "timeout" }]);
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
