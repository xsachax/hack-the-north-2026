import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../../lib/config";
import { CloudStartupError } from "./cloud";
import { COMPOSED_POLICY_VERSION } from "./composed-extension";
import {
  createNativeBrowser, NATIVE_SHUTDOWN_RESERVE_SECONDS, type NativeBrowserOptions, type NativeCloudUsage,
} from "./native-browser";
import type { NativeResource } from "./native-resources";
import type { Brain } from "./types";

// Test-only access while hosted acceptance is pending; provider/worker bindings are mocked.
vi.mock("../public-execution-readiness", () => ({ PUBLIC_EXECUTION_IMPLEMENTATION_READY: true }));

const mocks = vi.hoisted(() => {
  class APIError extends Error {
    constructor(readonly status: number) { super("mock authenticated provider response"); }
  }
  type Session = {
    id: string; projectId: string; status: string; connectUrl?: string;
    userMetadata?: { correlationToken: string }; startedAt: string; endedAt?: string;
  };
  const page = {
    url: vi.fn<() => string>(),
    goto: vi.fn(),
    evaluate: vi.fn(),
    setViewportSize: vi.fn<() => Promise<void>>(),
  };
  const worker = {
    url: vi.fn<() => string>(),
    once: vi.fn<(event: string, callback: () => void) => void>(),
    evaluate: vi.fn(),
  };
  const context = {
    pages: vi.fn(() => [page]),
    serviceWorkers: vi.fn(() => [worker]),
    newPage: vi.fn(async () => page),
  };
  const browser = { close: vi.fn<() => Promise<void>>() };
  const versionSession = {
    send: vi.fn<(method: string) => Promise<{ product: string }>>(),
    detach: vi.fn<() => Promise<void>>(),
  };
  const playwright = {
    contexts: vi.fn(() => [context]), close: vi.fn<() => Promise<void>>(), version: vi.fn<() => string>(),
    newBrowserCDPSession: vi.fn(async () => versionSession),
  };
  const stagehand = {
    metrics: vi.fn(async () => ({ totalPromptTokens: 12, totalCompletionTokens: 3 })),
    close: vi.fn<() => Promise<void>>(),
    extract: vi.fn(), act: vi.fn(), observe: vi.fn(),
  };
  const verify = vi.fn<() => Promise<void>>();
  const policyClose = vi.fn<() => Promise<void>>();
  const bundle = {
    bytes: Buffer.from("offline mock archive"), sha256: "a".repeat(64),
    files: new Map([["manifest.json", Buffer.from("{}")]]),
  };
  return {
    APIError, page, worker, context, browser, playwright, versionSession, stagehand, verify, policyClose, bundle,
    sdk: vi.fn(), sdkWorker: vi.fn(), sdkClose: vi.fn<() => Promise<void>>(), forbiddenLaunch: vi.fn(), fetch: vi.fn(),
    delay: vi.fn<(milliseconds: number) => Promise<void>>(),
    toFile: vi.fn(async () => ({ name: "flash-flood-native.zip" })),
    build: vi.fn(async () => bundle),
    sessions: {
      create: vi.fn<(input: unknown) => Promise<{ id: string }>>(),
      retrieve: vi.fn<(id: string, options?: { timeout: number }) => Promise<Session>>(),
      update: vi.fn<(id: string, body: unknown) => Promise<void>>(),
      debug: vi.fn(async () => ({ debuggerFullscreenUrl: "https://example.invalid/private-debug" })),
    },
    extensions: {
      create: vi.fn<() => Promise<{ id: string }>>(),
      delete: vi.fn<(id: string, options: unknown) => Promise<void>>(),
      retrieve: vi.fn<(id: string) => Promise<unknown>>(),
    },
    attach: vi.fn(async () => browser),
    initialize: vi.fn(async () => stagehand),
    connect: vi.fn(async () => playwright),
    attest: vi.fn<typeof import("./native-policy-session").establishNativePolicy>(async () => ({
      extensionOrigin: `chrome-extension://${"a".repeat(32)}`,
      version: "145.0.7632.6", verify, close: policyClose,
    })),
  };
});

vi.mock("@browserbasehq/sdk", () => ({
  default: class {
    static APIError = mocks.APIError;
    sessions = mocks.sessions;
    extensions = mocks.extensions;
    constructor(options: unknown) { mocks.sdk(options); }
  },
  toFile: mocks.toFile,
}));
vi.mock("@browserbasehq/stagehand", () => ({
  browserbase: { launch: mocks.forbiddenLaunch, connect: mocks.attach },
  Stagehand: { create: mocks.initialize },
}));
vi.mock("./native-sdk", () => ({
  createNativeSdk: (options: unknown) => {
    mocks.sdkWorker(options);
    return {
      connect: mocks.attach, initialize: mocks.initialize, metrics: mocks.stagehand.metrics,
      close: mocks.sdkClose, selectPage: vi.fn(), extract: mocks.stagehand.extract,
    };
  },
}));
vi.mock("playwright-core", () => ({ chromium: { connectOverCDP: mocks.connect } }));
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:timers/promises")>(),
  setTimeout: mocks.delay,
}));
vi.mock("./composed-extension", async (importOriginal) => ({
  ...await importOriginal<typeof import("./composed-extension")>(),
  buildComposedExtension: mocks.build,
}));
vi.mock("./native-policy-session", async (importOriginal) => ({
  ...await importOriginal<typeof import("./native-policy-session")>(),
  establishNativePolicy: mocks.attest,
}));

const config = configSchema.parse({
  BROWSERBASE_API_KEY: "unit-test-native-key",
  BROWSERBASE_PROJECT_ID: "00000000-0000-4000-8000-000000000001",
});
const sessionId = "00000000-0000-4000-8000-000000000002";
const extensionId = "00000000-0000-4000-8000-000000000003";
const correlationToken = "00000000-0000-4000-8000-000000000004";
const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;
const running = {
  id: sessionId, projectId: config.BROWSERBASE_PROJECT_ID!, status: "RUNNING",
  connectUrl: "wss://example.invalid/offline-cdp", userMetadata: { correlationToken },
  startedAt: "2026-01-01T00:00:00Z",
};
const completed = { ...running, status: "COMPLETED", endedAt: "2026-01-01T00:00:08Z" };

function options(overrides: Partial<NativeBrowserOptions> = {}): NativeBrowserOptions {
  return {
    runId: "00000000-0000-4000-8000-000000000005", personaId: "careful",
    correlationToken, viewport: { width: 1280, height: 720 },
    signal: new AbortController().signal, assertActive: vi.fn(),
    onSession: vi.fn(async () => {}), onResource: vi.fn(() => undefined),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function startupError(input = options(), settings = config): Promise<CloudStartupError> {
  try {
    const execution = await createNativeBrowser(settings, input);
    await execution.close();
    throw new Error("Expected native startup failure");
  } catch (error) {
    expect(error).toBeInstanceOf(CloudStartupError);
    return error as CloudStartupError;
  }
}

function resource(error: CloudStartupError) {
  return (error.usage as NativeCloudUsage).nativeResource;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  mocks.delay.mockImplementation((milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); }));
  vi.stubGlobal("fetch", mocks.fetch.mockRejectedValue(new Error("network forbidden in offline tests")));
  mocks.build.mockResolvedValue(mocks.bundle);
  mocks.toFile.mockResolvedValue({ name: "flash-flood-native.zip" });
  mocks.extensions.create.mockResolvedValue({ id: extensionId });
  mocks.extensions.delete.mockResolvedValue(undefined);
  mocks.extensions.retrieve.mockRejectedValue(new mocks.APIError(404));
  mocks.sessions.create.mockResolvedValue({ id: sessionId });
  mocks.sessions.retrieve.mockResolvedValue(completed);
  mocks.sessions.update.mockResolvedValue(undefined);
  mocks.sessions.debug.mockResolvedValue({ debuggerFullscreenUrl: "https://example.invalid/private-debug" });
  mocks.attach.mockResolvedValue(mocks.browser);
  mocks.initialize.mockResolvedValue(mocks.stagehand);
  mocks.connect.mockResolvedValue(mocks.playwright);
  mocks.browser.close.mockResolvedValue(undefined);
  mocks.sdkClose.mockResolvedValue(undefined);
  mocks.stagehand.close.mockResolvedValue(undefined);
  mocks.playwright.close.mockResolvedValue(undefined);
  mocks.playwright.version.mockReturnValue("145.0.7632.6");
  mocks.playwright.newBrowserCDPSession.mockResolvedValue(mocks.versionSession);
  mocks.versionSession.send.mockResolvedValue({ product: "Chrome/145.0.7632.6" });
  mocks.versionSession.detach.mockResolvedValue(undefined);
  mocks.stagehand.metrics.mockResolvedValue({ totalPromptTokens: 12, totalCompletionTokens: 3 });
  mocks.playwright.contexts.mockReturnValue([mocks.context]);
  mocks.context.pages.mockReturnValue([mocks.page]);
  mocks.context.serviceWorkers.mockReturnValue([mocks.worker]);
  mocks.context.newPage.mockResolvedValue(mocks.page);
  mocks.worker.url.mockReturnValue(`${extensionOrigin}/service-worker.js`);
  mocks.page.url.mockReturnValue("about:blank");
  mocks.page.setViewportSize.mockResolvedValue(undefined);
  mocks.verify.mockResolvedValue(undefined);
  mocks.policyClose.mockResolvedValue(undefined);
  mocks.attest.mockResolvedValue({
    extensionOrigin, version: "145.0.7632.6", verify: mocks.verify, close: mocks.policyClose,
  });
});

afterEach(() => {
  expect(mocks.forbiddenLaunch).not.toHaveBeenCalled();
  expect(mocks.browser.close).not.toHaveBeenCalled();
  expect(mocks.stagehand.close).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.page.goto).not.toHaveBeenCalled();
  expect(mocks.stagehand.extract).not.toHaveBeenCalled();
  expect(mocks.stagehand.act).not.toHaveBeenCalled();
  expect(mocks.stagehand.observe).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("offline fresh native browser admission", () => {
  it("uses exact no-retry SDK and fresh correlated session settings", async () => {
    const input = options();
    const execution = await createNativeBrowser(config, input);
    expect(mocks.sdk).toHaveBeenCalledExactlyOnceWith({
      apiKey: "unit-test-native-key", maxRetries: 0, timeout: 10000,
    });
    expect(mocks.toFile).toHaveBeenCalledExactlyOnceWith(
      mocks.bundle.bytes, "flash-flood-native.zip", { type: "application/zip" },
    );
    expect(mocks.sessions.create).toHaveBeenCalledExactlyOnceWith({
      projectId: config.BROWSERBASE_PROJECT_ID, extensionId, keepAlive: false, proxies: false,
      api_timeout: Math.min(config.SESSION_TIMEOUT_SECONDS, 300),
      browserSettings: { recordSession: true, solveCaptchas: false, viewport: input.viewport },
      userMetadata: {
        runId: input.runId, personaId: input.personaId, correlationToken, purpose: COMPOSED_POLICY_VERSION,
      },
    });
    expect(mocks.sdkWorker).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      session: { id: sessionId, connectUrl: running.connectUrl, region: undefined },
      apiKey: "unit-test-native-key", model: config.STAGEHAND_MODEL,
      assertActive: expect.any(Function), signal: expect.any(AbortSignal), onLost: expect.any(Function),
    }));
    expect(mocks.attach).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.initialize).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.connect).toHaveBeenCalledExactlyOnceWith(running.connectUrl, { timeout: 10000 });
    expect(mocks.attest).toHaveBeenCalledWith({
      context: mocks.context, worker: mocks.worker, files: mocks.bundle.files,
      assertActive: expect.any(Function), onLost: expect.any(Function),
    });
    expect(execution.usage.nativePolicy).toEqual({
      version: COMPOSED_POLICY_VERSION, browserVersion: "145.0.7632.6", archiveSha256: mocks.bundle.sha256,
    });
    expect(execution.usage.nativeObservedBrowserVersion).toBe("145.0.7632.6");
    expect(mocks.playwright.version).toHaveBeenCalledOnce();
    expect(mocks.versionSession.send).toHaveBeenCalledExactlyOnceWith("Browser.getVersion");
    expect(mocks.versionSession.detach).toHaveBeenCalledOnce();
    expect(mocks.sessions.debug).not.toHaveBeenCalled();
    expect(await execution.close()).toEqual({ status: "closed", errors: [] });
  });

  it.each([120, 900])("reserves bounded timeout for configured %s seconds", async (seconds) => {
    const execution = await createNativeBrowser({ ...config, SESSION_TIMEOUT_SECONDS: seconds }, options());
    expect(execution.usage.reservedSeconds).toBe(Math.min(seconds, 300));
    expect(mocks.sessions.create.mock.calls[0][0]).toHaveProperty("api_timeout", Math.min(seconds, 300));
    await execution.close();
  });

  it.each([30, 80])("rejects a %s-second session timeout before provider construction", async (seconds) => {
    const error = await startupError(options(), { ...config, SESSION_TIMEOUT_SECONDS: seconds });
    expect(error.phase).toBe("native_admission");
    expect(error.usage.allocationAttempted).toBe(false);
    expect(mocks.sdk).not.toHaveBeenCalled();
  });

  it.each([
    { runId: "bad" }, { personaId: "" }, { correlationToken: "bad" },
    { viewport: { width: 319, height: 720 } }, { viewport: { width: 1280, height: 1201 } },
    { contextReference: undefined }, { context: undefined }, { persist: false },
  ])("rejects invalid or reused-context input before provider dispatch: %j", async (invalid) => {
    const error = await startupError(Object.assign(options(), invalid));
    expect(error).toMatchObject({
      phase: "native_admission", usage: { allocationAttempted: false }, cleanup: { status: "closed", errors: [] },
    });
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.sdk).not.toHaveBeenCalled();
    expect(mocks.sessions.create).not.toHaveBeenCalled();
  });

  it("rejects invalid project before constructing SDK", async () => {
    await startupError(options(), { ...config, BROWSERBASE_PROJECT_ID: "invalid-project" });
    expect(mocks.sdk).not.toHaveBeenCalled();
  });

  it("honors preexisting cancellation and lease loss before provider construction", async () => {
    const controller = new AbortController();
    controller.abort();
    await startupError(options({ signal: controller.signal }));
    await startupError(options({ assertActive: () => { throw new Error("lease lost"); } }));
    expect(mocks.sdk).not.toHaveBeenCalled();
  });

  it("durably journals resource intent and session identity before any attachment", async () => {
    const events: string[] = [];
    const snapshots: Readonly<NativeResource>[] = [];
    const input = options({
      onResource: (value) => {
        expect(Object.isFrozen(value)).toBe(true);
        snapshots.push(value);
        events.push(value.sessionId ? "session-resource" : value.state);
        return undefined;
      },
      onSession: async (reference) => {
        events.push("session-reference");
        expect(reference).toEqual({
          sessionId, liveViewUrl: "", replayUrl: `https://www.browserbase.com/sessions/${sessionId}`,
          timeoutSeconds: Math.min(config.SESSION_TIMEOUT_SECONDS, 300),
        });
        expect(mocks.attach).not.toHaveBeenCalled();
        expect(mocks.sessions.debug).not.toHaveBeenCalled();
      },
    });
    mocks.extensions.create.mockImplementation(async () => {
      expect(events).toEqual(["upload_intent"]);
      return { id: extensionId };
    });
    mocks.sessions.create.mockImplementation(async () => {
      expect(events).toEqual(["upload_intent", "uploaded", "allocated"]);
      return { id: sessionId };
    });
    const execution = await createNativeBrowser(config, input);
    expect(events).toEqual(["upload_intent", "uploaded", "allocated", "session-resource", "session-reference"]);
    expect(snapshots[0]).not.toHaveProperty("extensionId");
    await execution.close();
  });

  it("does not upload when the first durable journal write fails", async () => {
    const error = await startupError(options({ onResource: () => { throw new Error("disk unavailable"); } }));
    expect(error.phase).toBe("native_extension_upload");
    expect(mocks.extensions.create).not.toHaveBeenCalled();
    expect(mocks.sessions.create).not.toHaveBeenCalled();
  });

  it("rejects an asynchronous resource journal before dispatching an upload", async () => {
    const onResource = (async () => {}) as unknown as NativeBrowserOptions["onResource"];
    const error = await startupError(options({ onResource }));
    expect(error.phase).toBe("native_extension_upload");
    expect(error.cleanup).toEqual({ status: "closed", errors: [] });
    expect(mocks.extensions.create).not.toHaveBeenCalled();
    expect(mocks.sessions.create).not.toHaveBeenCalled();
  });

  it("rechecks cancellation after bundle creation and before provider construction", async () => {
    const controller = new AbortController();
    const bundle = deferred<typeof mocks.bundle>();
    mocks.build.mockReturnValue(bundle.promise);
    const result = startupError(options({ signal: controller.signal }));
    controller.abort();
    bundle.resolve(mocks.bundle);
    expect((await result).usage.allocationAttempted).toBe(false);
    expect(mocks.sdk).not.toHaveBeenCalled();
  });

  it("does not dispatch upload when its durable intent callback synchronously cancels", async () => {
    const controller = new AbortController();
    const snapshots: Readonly<NativeResource>[] = [];
    const input = options({
      signal: controller.signal,
      onResource: (value) => {
        snapshots.push(value);
        if (value.state === "upload_intent") {
          expect(mocks.toFile).toHaveBeenCalledOnce();
          expect(mocks.extensions.create).not.toHaveBeenCalled();
          controller.abort();
        }
        return undefined;
      },
    });
    const error = await startupError(input);
    expect(error.phase).toBe("native_extension_upload");
    expect(error.cleanup).toEqual({ status: "closed", errors: [] });
    expect(error.usage.allocationAttempted).toBe(false);
    expect(snapshots.map(({ state }) => state)).toEqual(["upload_intent", "not_dispatched"]);
    expect(resource(error)).toMatchObject({ state: "not_dispatched", sessionAllocationAttempted: false });
    expect(resource(error)).not.toHaveProperty("extensionId");
    expect(mocks.extensions.create).not.toHaveBeenCalled();
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
    expect(mocks.extensions.retrieve).not.toHaveBeenCalled();
    expect(mocks.sessions.create).not.toHaveBeenCalled();
    expect(mocks.sessions.retrieve).not.toHaveBeenCalled();
    expect(input.onSession).not.toHaveBeenCalled();
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it("restores predispatch ownership when the allocation intent callback synchronously cancels", async () => {
    const controller = new AbortController();
    const snapshots: Readonly<NativeResource>[] = [];
    const input = options({
      signal: controller.signal,
      onResource: (value) => {
        snapshots.push(value);
        if (value.state === "allocated") {
          expect(mocks.sessions.create).not.toHaveBeenCalled();
          controller.abort();
        }
        return undefined;
      },
    });
    const error = await startupError(input);
    expect(error.phase).toBe("native_launch");
    expect(error.cleanup).toEqual({ status: "closed", errors: [] });
    expect(error.usage.allocationAttempted).toBe(false);
    expect(snapshots.map(({ state, sessionAllocationAttempted }) => [state, sessionAllocationAttempted])).toEqual([
      ["upload_intent", false], ["uploaded", false], ["allocated", true],
      ["uploaded", false], ["delete_intent", false], ["deleted", false],
    ]);
    expect(resource(error)).toMatchObject({ state: "deleted", extensionId, sessionAllocationAttempted: false });
    expect(resource(error)).not.toHaveProperty("sessionId");
    expect(mocks.extensions.create).toHaveBeenCalledOnce();
    expect(mocks.extensions.delete).toHaveBeenCalledExactlyOnceWith(extensionId, {
      headers: { "Content-Type": null },
    });
    expect(mocks.extensions.retrieve).toHaveBeenCalledExactlyOnceWith(extensionId);
    expect(mocks.sessions.create).not.toHaveBeenCalled();
    expect(mocks.sessions.retrieve).not.toHaveBeenCalled();
    expect(mocks.sessions.update).not.toHaveBeenCalled();
    expect(input.onSession).not.toHaveBeenCalled();
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it("cancellation while upload resolves deletes only the unallocated extension", async () => {
    const controller = new AbortController();
    const upload = deferred<{ id: string }>();
    mocks.extensions.create.mockReturnValue(upload.promise);
    const result = startupError(options({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    upload.resolve({ id: extensionId });
    const error = await result;
    expect(error.usage.allocationAttempted).toBe(false);
    expect(resource(error)?.state).toBe("deleted");
    expect(mocks.sessions.create).not.toHaveBeenCalled();
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
  });

  it("records a late allocated session even when cancellation arrives during create", async () => {
    const controller = new AbortController();
    const allocation = deferred<{ id: string }>();
    const input = options({ signal: controller.signal });
    mocks.sessions.create.mockReturnValue(allocation.promise);
    const result = startupError(input);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    allocation.resolve({ id: sessionId });
    const error = await result;
    expect(input.onSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId, liveViewUrl: "" }));
    expect(resource(error)).toMatchObject({ sessionId, state: "deleted", sessionAllocationAttempted: true });
    expect(mocks.attach).not.toHaveBeenCalled();
  });
});

describe("offline native absolute execution deadline", () => {
  it("charges slow allocation and bootstrap against the original budget and closes 80 seconds before provider TTL", async () => {
    expect(NATIVE_SHUTDOWN_RESERVE_SECONDS).toBe(80);
    const start = Date.now();
    const allocation = deferred<{ id: string }>();
    const attachment = deferred<typeof mocks.browser>();
    mocks.sessions.create.mockImplementation(() => {
      expect(Date.now()).toBe(start);
      expect(vi.getTimerCount()).toBe(1);
      return allocation.promise;
    });
    mocks.attach.mockReturnValue(attachment.promise);
    const startup = createNativeBrowser({ ...config, SESSION_TIMEOUT_SECONDS: 120 }, options());
    await vi.advanceTimersByTimeAsync(5000);
    allocation.resolve({ id: sessionId });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.attach).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10000);
    attachment.resolve(mocks.browser);
    const execution = await startup;
    expect(execution.executionDeadlineMs).toBe(start + 40000);
    expect(execution.executionDeadlineMs! - Date.now()).toBe(25000);
    expect(vi.getTimerCount()).toBe(1);
    const drain = vi.fn(async () => {});
    const networkClose = vi.fn(async () => {});
    execution.attachBrain({ decide: vi.fn<Brain["decide"]>(), drain });
    execution.attachNetwork(networkClose);
    mocks.sessions.retrieve.mockResolvedValueOnce(running).mockResolvedValueOnce(completed);
    await vi.advanceTimersByTimeAsync(24999);
    expect(() => execution.assertActive()).not.toThrow();
    expect(execution.signal.aborted).toBe(false);
    expect(drain).not.toHaveBeenCalled();
    expect(networkClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(execution.signal.aborted).toBe(true);
    expect(() => execution.assertActive()).toThrow();
    expect(drain).toHaveBeenCalledOnce();
    expect(await execution.close()).toEqual({ status: "closed", errors: [] });
    expect(networkClose).toHaveBeenCalledOnce();
    expect(mocks.sessions.update).toHaveBeenCalledExactlyOnceWith(sessionId, {
      status: "REQUEST_RELEASE", projectId: config.BROWSERBASE_PROJECT_ID,
    });
    expect(start + 120000 - Date.now()).toBe(NATIVE_SHUTDOWN_RESERVE_SECONDS * 1000);
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fences wall-clock expiry even before the timer callback executes", async () => {
    const execution = await createNativeBrowser({ ...config, SESSION_TIMEOUT_SECONDS: 120 }, options());
    expect(execution.executionDeadlineMs).toBeDefined();
    vi.setSystemTime(execution.executionDeadlineMs! - 1);
    expect(() => execution.assertActive()).not.toThrow();
    vi.setSystemTime(execution.executionDeadlineMs!);
    expect(execution.signal.aborted).toBe(false);
    expect(() => execution.assertActive()).toThrow("native_execution_deadline");
    expect(() => execution.attachNetwork(vi.fn(async () => {}))).toThrow("native_execution_deadline");
    await execution.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts one second of execution budget and clears its deadline on early close", async () => {
    const start = Date.now();
    const execution = await createNativeBrowser({
      ...config, SESSION_TIMEOUT_SECONDS: NATIVE_SHUTDOWN_RESERVE_SECONDS + 1,
    }, options());
    expect(execution.executionDeadlineMs).toBe(start + 1000);
    expect(vi.getTimerCount()).toBe(1);
    const closing = execution.close();
    expect(await closing).toEqual({ status: "closed", errors: [] });
    expect(vi.getTimerCount()).toBe(0);
    const retrieveCalls = mocks.sessions.retrieve.mock.calls.length;
    await vi.advanceTimersByTimeAsync(81000);
    expect(execution.close()).toBe(closing);
    expect(mocks.sessions.retrieve).toHaveBeenCalledTimes(retrieveCalls);
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
  });

  it.each(["browser", "stagehand"])("terminates SDK ownership without closing a late %s handle after the deadline", async (kind) => {
    const late = deferred<typeof mocks.stagehand>();
    const attachment = { ...mocks.stagehand, close: vi.fn(async () => {}) };
    if (kind === "browser") mocks.attach.mockReturnValue(late.promise);
    else mocks.initialize.mockReturnValue(late.promise);
    const result = startupError(options(), { ...config, SESSION_TIMEOUT_SECONDS: 90 });
    await vi.advanceTimersByTimeAsync(9999);
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
    expect(attachment.close).not.toHaveBeenCalled();
    late.resolve(attachment);
    const error = await result;
    await vi.advanceTimersByTimeAsync(0);
    expect(error.phase).toBe(kind === "browser" ? "native_browser_connect" : "native_stagehand_create");
    expect(attachment.close).not.toHaveBeenCalled();
    expect(mocks.sdkClose).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.sessions.debug).not.toHaveBeenCalled();
    expect(mocks.sessions.create).toHaveBeenCalledOnce();
  });

  it("closes a late CDP connector after the execution deadline initiates cleanup", async () => {
    const late = deferred<typeof mocks.playwright>();
    mocks.connect.mockReturnValue(late.promise);
    const result = startupError(options(), { ...config, SESSION_TIMEOUT_SECONDS: 85 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
    expect(mocks.playwright.close).not.toHaveBeenCalled();
    late.resolve(mocks.playwright);
    const error = await result;
    await vi.advanceTimersByTimeAsync(0);
    expect(error.phase).toBe("native_cdp_connect");
    expect(mocks.playwright.close).toHaveBeenCalledOnce();
    expect(mocks.attest).not.toHaveBeenCalled();
    expect(mocks.sessions.debug).not.toHaveBeenCalled();
  });
});

describe("offline native startup failures", () => {
  it.each(["Chrome", "HeadlessChrome"])("preserves the observed %s runtime when version attestation rejects it", async (product) => {
    const actualVersion = "146.0.8000.42";
    mocks.playwright.version.mockReturnValue(actualVersion);
    mocks.versionSession.send.mockResolvedValue({ product: `${product}/${actualVersion}` });
    mocks.attest.mockImplementation(async () => {
      expect(mocks.playwright.version).toHaveBeenCalledOnce();
      expect(mocks.versionSession.detach).toHaveBeenCalledOnce();
      throw new Error("native_browser_version_unsupported");
    });
    const input = options();
    const error = await startupError(input);
    expect(error.phase).toBe("native_attestation");
    expect((error.usage as NativeCloudUsage).nativeObservedBrowserVersion).toBe(actualVersion);
    expect((error.usage as NativeCloudUsage).nativePolicy).toBeUndefined();
    expect(input.onSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ liveViewUrl: "" }));
    expect(mocks.sessions.debug).not.toHaveBeenCalled();
    expect(mocks.versionSession.send).toHaveBeenCalledExactlyOnceWith("Browser.getVersion");
    expect(mocks.versionSession.detach).toHaveBeenCalledOnce();
  });

  it.each([
    "", "Chrome/145.0.7632", "Chrome/145.0.7632.6.1", "Chrome/145.0.7632.x",
    "Chrome/145.0.7632.6-beta", "Chrome/145.0.7632.6\n", "Firefox/145.0.7632.6",
    "Chrome/10000.0.7632.6", "Chrome/145.0.123456789.6",
  ])("does not infer an observed version from malformed runtime product %j", async (product) => {
    mocks.versionSession.send.mockResolvedValue({ product });
    const input = options();
    const error = await startupError(input);
    expect(error.phase).toBe("native_cdp_connect");
    expect((error.usage as NativeCloudUsage).nativeObservedBrowserVersion).toBeUndefined();
    expect((error.usage as NativeCloudUsage).nativePolicy).toBeUndefined();
    expect(mocks.attest).not.toHaveBeenCalled();
    expect(input.onSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ liveViewUrl: "" }));
    expect(mocks.sessions.debug).not.toHaveBeenCalled();
    expect(mocks.versionSession.detach).toHaveBeenCalledOnce();
    expect(mocks.playwright.close).toHaveBeenCalledOnce();
  });

  it("rejects inconsistent CDP and Playwright runtime versions without fabricating metadata", async () => {
    mocks.versionSession.send.mockResolvedValue({ product: "Chrome/146.0.8000.42" });
    const error = await startupError();
    expect(error.phase).toBe("native_cdp_connect");
    expect((error.usage as NativeCloudUsage).nativeObservedBrowserVersion).toBeUndefined();
    expect(mocks.attest).not.toHaveBeenCalled();
    expect(mocks.versionSession.detach).toHaveBeenCalledOnce();
  });

  it("detaches the version CDP session if the runtime query fails without falling back to Playwright", async () => {
    mocks.versionSession.send.mockRejectedValue(new Error("runtime query unavailable"));
    const error = await startupError();
    expect(error.phase).toBe("native_cdp_connect");
    expect((error.usage as NativeCloudUsage).nativeObservedBrowserVersion).toBeUndefined();
    expect(mocks.playwright.version).not.toHaveBeenCalled();
    expect(mocks.attest).not.toHaveBeenCalled();
    expect(mocks.versionSession.detach).toHaveBeenCalledOnce();
    expect(mocks.playwright.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["bundle", "native_admission"],
    ["upload", "native_extension_upload"],
    ["launch", "native_launch"],
    ["session-reference", "native_session_reference"],
    ["browser", "native_browser_connect"],
    ["stagehand", "native_stagehand_create"],
    ["cdp", "native_cdp_connect"],
    ["attestation", "native_attestation"],
  ])("reports %s failure at the right startup phase", async (failure, phase) => {
    const rejection = new Error("offline injected failure");
    const input = options();
    if (failure === "bundle") mocks.build.mockRejectedValue(rejection);
    if (failure === "upload") mocks.extensions.create.mockRejectedValue(rejection);
    if (failure === "launch") mocks.sessions.create.mockRejectedValue(rejection);
    if (failure === "session-reference") input.onSession = vi.fn(async () => { throw rejection; });
    if (failure === "browser") mocks.attach.mockRejectedValue(rejection);
    if (failure === "stagehand") mocks.initialize.mockRejectedValue(rejection);
    if (failure === "cdp") mocks.connect.mockRejectedValue(rejection);
    if (failure === "attestation") mocks.attest.mockRejectedValue(rejection);
    const error = await startupError(input);
    expect(error.phase).toBe(phase);
    expect(mocks.sessions.debug).not.toHaveBeenCalled();
    expect(input.onSession).not.toHaveBeenCalledWith(expect.objectContaining({
      liveViewUrl: expect.stringMatching(/^https:/),
    }));
    expect(mocks.extensions.create.mock.calls.length).toBeLessThanOrEqual(1);
    expect(mocks.sessions.create.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it.each([
    { projectId: "00000000-0000-4000-8000-000000000099" },
    { id: "00000000-0000-4000-8000-000000000099" },
    { userMetadata: { correlationToken: "00000000-0000-4000-8000-000000000099" } },
    { userMetadata: undefined },
  ])("quarantines wrong session identity without attaching or requesting release: %j", async (invalid) => {
    mocks.sessions.retrieve.mockResolvedValue({ ...running, ...invalid });
    const error = await startupError();
    expect(error.phase).toBe("native_cdp_connect");
    expect(error.cleanup.status).toBe("failed");
    expect(resource(error)?.state).toBe("quarantined");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.sessions.update).not.toHaveBeenCalled();
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
  });

  it.each(["contexts", "workers", "untrusted-page", "foreign-worker"])("rejects nonfresh bootstrap: %s", async (kind) => {
    if (kind === "contexts") mocks.playwright.contexts.mockReturnValue([mocks.context, mocks.context]);
    if (kind === "workers") mocks.context.serviceWorkers.mockReturnValue([]);
    if (kind === "untrusted-page") mocks.page.url.mockReturnValue("https://untrusted.example/");
    if (kind === "foreign-worker") {
      mocks.context.serviceWorkers.mockReturnValue([
        mocks.worker, { ...mocks.worker, url: vi.fn(() => "https://untrusted.example/sw.js") },
      ]);
    }
    const error = await startupError();
    expect(error.phase).toBe("native_cdp_connect");
    expect(mocks.attest).not.toHaveBeenCalled();
    expect(mocks.sessions.debug).not.toHaveBeenCalled();
  });

  it("never publishes a live reference after attestation fails", async () => {
    mocks.attest.mockRejectedValue(new Error("native_policy_state_rejected"));
    const input = options();
    const error = await startupError(input);
    expect(error.phase).toBe("native_attestation");
    expect(input.onSession).toHaveBeenCalledTimes(1);
    expect(input.onSession).toHaveBeenCalledWith(expect.objectContaining({ liveViewUrl: "" }));
    expect(mocks.sessions.debug).not.toHaveBeenCalled();
    expect(mocks.page.setViewportSize).not.toHaveBeenCalled();
    expect((error.usage as NativeCloudUsage).nativePolicy).toBeUndefined();
  });

  it.each(["worker-close", "control-lost"])("rejects %s at the final attestation handoff before publishing ownership", async (fault) => {
    mocks.attest.mockImplementation(async ({ onLost }) => {
      const workerClose = mocks.worker.once.mock.calls.find(([event]) => event === "close")?.[1];
      expect(workerClose).toBeTypeOf("function");
      expect(onLost).toBeTypeOf("function");
      await Promise.resolve();
      if (fault === "worker-close") workerClose!();
      else onLost!();
      return { extensionOrigin, version: "145.0.7632.6", verify: mocks.verify, close: mocks.policyClose };
    });
    const input = options();
    const error = await startupError(input);
    expect(error.phase).toBe("native_attestation");
    expect(input.onSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ liveViewUrl: "" }));
    expect(mocks.sessions.debug).not.toHaveBeenCalled();
    expect(mocks.worker.once).toHaveBeenCalledExactlyOnceWith("close", expect.any(Function));
    expect(mocks.policyClose).toHaveBeenCalledOnce();
    expect(mocks.sdkClose).toHaveBeenCalledOnce();
    expect(mocks.playwright.close).toHaveBeenCalledOnce();
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
  });

  it.each([false, true])("bounds CDP startup at 10000ms and handles a late attachment (close rejects=%s)", async (closeRejects) => {
    const late = deferred<typeof mocks.playwright>();
    mocks.connect.mockReturnValue(late.promise);
    const result = startupError();
    await vi.advanceTimersByTimeAsync(9999);
    expect(mocks.connect).toHaveBeenCalledExactlyOnceWith(running.connectUrl, { timeout: 10000 });
    expect(mocks.stagehand.close).not.toHaveBeenCalled();
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;
    expect(error.phase).toBe("native_cdp_connect");
    expect(mocks.playwright.close).not.toHaveBeenCalled();
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
    if (closeRejects) mocks.playwright.close.mockRejectedValue(new Error("late CDP close rejected"));
    late.resolve(mocks.playwright);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.playwright.close).toHaveBeenCalledOnce();
    expect(mocks.playwright.newBrowserCDPSession).not.toHaveBeenCalled();
    expect(mocks.attest).not.toHaveBeenCalled();
    expect(mocks.sessions.debug).not.toHaveBeenCalled();
    if (closeRejects) {
      expect(error.usage.cleanupDiagnostics).toContainEqual({ operation: "late_cdp_connect", category: "unconfirmed" });
    }
  });

  it.each(["browser", "stagehand"])("terminates SDK work without closing a %s handle resolving after timeout", async (kind) => {
    const late = deferred<typeof mocks.browser>();
    if (kind === "browser") mocks.attach.mockReturnValue(late.promise);
    else mocks.initialize.mockReturnValue(late.promise as Promise<typeof mocks.stagehand>);
    const result = startupError();
    await vi.advanceTimersByTimeAsync(30001);
    const error = await result;
    expect(error.phase).toBe(kind === "browser" ? "native_browser_connect" : "native_stagehand_create");
    const attachment = { close: vi.fn(async () => {}) };
    late.resolve(attachment);
    await vi.advanceTimersByTimeAsync(0);
    expect(attachment.close).not.toHaveBeenCalled();
    expect(mocks.sdkClose).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.sessions.debug).not.toHaveBeenCalled();
  });

  it("does not resume startup when a timed-out durable session callback resolves late", async () => {
    const callback = deferred<void>();
    const result = startupError(options({ onSession: () => callback.promise }));
    await vi.advanceTimersByTimeAsync(5001);
    const error = await result;
    expect(error.phase).toBe("native_session_reference");
    callback.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(resource(error)?.state).toBe("deleted");
  });
});

describe("offline native ownership and cleanup", () => {
  it("retains network, policy and Playwright attachments until actual SDK worker settlement", async () => {
    const execution = await createNativeBrowser(config, options());
    const exit = deferred<void>();
    mocks.sdkClose.mockReturnValue(exit.promise);
    const networkClose = vi.fn(async () => {});
    execution.attachNetwork(networkClose);
    const closing = execution.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.sdkClose).toHaveBeenCalledOnce();
    expect(networkClose).not.toHaveBeenCalled();
    expect(mocks.policyClose).not.toHaveBeenCalled();
    expect(mocks.playwright.close).not.toHaveBeenCalled();
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
    exit.resolve(undefined);
    expect(await closing).toEqual({ status: "closed", errors: [] });
    expect(networkClose).toHaveBeenCalledOnce();
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
  });

  it("quarantines and retains attachments if local SDK retirement is unconfirmed", async () => {
    const execution = await createNativeBrowser(config, options());
    mocks.sdkClose.mockRejectedValue(new Error("worker termination failed"));
    const networkClose = vi.fn(async () => {});
    execution.attachNetwork(networkClose);
    expect((await execution.close()).errors).toContain("native_sdk_close");
    expect(execution.usage.nativeResource?.state).toBe("quarantined");
    expect(networkClose).not.toHaveBeenCalled();
    expect(mocks.policyClose).not.toHaveBeenCalled();
    expect(mocks.playwright.close).not.toHaveBeenCalled();
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
  });

  it("drains Gateway and reads metrics before remote release while all attachments remain installed", async () => {
    const execution = await createNativeBrowser(config, options());
    const events: string[] = [];
    const networkClose = vi.fn(async () => { events.push("network"); });
    const drain = deferred<void>();
    execution.attachNetwork(networkClose);
    execution.attachBrain({
      decide: vi.fn<Brain["decide"]>(),
      drain: vi.fn(async () => { events.push("drain"); await drain.promise; }),
    });
    mocks.stagehand.metrics.mockImplementation(async () => {
      events.push("metrics");
      return { totalPromptTokens: 12, totalCompletionTokens: 3 };
    });
    mocks.sessions.retrieve.mockImplementationOnce(async () => {
      events.push("retrieve-running");
      return running;
    }).mockImplementationOnce(async () => {
      events.push("retrieve-completed");
      expect(networkClose).not.toHaveBeenCalled();
      expect(mocks.policyClose).not.toHaveBeenCalled();
      expect(mocks.stagehand.close).not.toHaveBeenCalled();
      expect(mocks.playwright.close).not.toHaveBeenCalled();
      expect(mocks.browser.close).not.toHaveBeenCalled();
      expect(mocks.extensions.delete).not.toHaveBeenCalled();
      expect(mocks.worker.evaluate).not.toHaveBeenCalled();
      return completed;
    });
    mocks.sessions.update.mockImplementation(async () => { events.push("request-release"); });
    mocks.policyClose.mockImplementation(async () => { events.push("native-control"); });
    mocks.sdkClose.mockImplementation(async () => { events.push("sdk-worker-exit"); });
    mocks.playwright.close.mockImplementation(async () => { events.push("playwright"); });
    mocks.extensions.delete.mockImplementation(async () => { events.push("delete-extension"); });
    mocks.extensions.retrieve.mockImplementation(async () => {
      events.push("confirm-404"); throw new mocks.APIError(404);
    });
    const closing = execution.close();
    expect(execution.close()).toBe(closing);
    expect(execution.signal.aborted).toBe(true);
    expect(events).toEqual(["drain"]);
    drain.resolve(undefined);
    expect(await closing).toEqual({ status: "closed", errors: [] });
    expect(events).toEqual([
      "drain", "metrics", "retrieve-running", "request-release", "retrieve-completed",
      "sdk-worker-exit", "network", "native-control", "playwright", "delete-extension", "confirm-404",
    ]);
    expect(mocks.sessions.update).toHaveBeenCalledExactlyOnceWith(sessionId, {
      status: "REQUEST_RELEASE", projectId: config.BROWSERBASE_PROJECT_ID,
    });
    expect(mocks.extensions.delete).toHaveBeenCalledExactlyOnceWith(extensionId, {
      headers: { "Content-Type": null },
    });
    expect(mocks.extensions.retrieve).toHaveBeenCalledExactlyOnceWith(extensionId);
    expect(mocks.policyClose).toHaveBeenCalledOnce();
    expect(execution.usage).toMatchObject({
      actualBrowserSeconds: 8, remoteStatus: "COMPLETED",
      modelMetrics: { totalPromptTokens: 12, totalCompletionTokens: 3 }, nativeResource: { state: "deleted" },
    });
  });

  it.each(["RUNNING", "PENDING", "REQUEST_RELEASE"])(
    "does not treat %s as confirmed COMPLETED or delete the extension", async (status) => {
      const execution = await createNativeBrowser(config, options());
      mocks.sessions.retrieve.mockResolvedValue({ ...completed, status });
      const closing = execution.close();
      await vi.advanceTimersByTimeAsync(750);
      const cleanup = await closing;
      expect(cleanup.status).toBe("failed");
      expect(cleanup.errors).toContain("remote_release_unconfirmed");
      expect(execution.usage.nativeResource?.state).toBe("quarantined");
      expect(mocks.extensions.delete).not.toHaveBeenCalled();
      expect(mocks.worker.evaluate).not.toHaveBeenCalled();
    },
  );

  describe.each(["ERROR", "TIMED_OUT"])("%s remote retirement", (status) => {
    beforeEach(() => {
      vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
    });

    it.each([false, true])("deletes only after independent matching retirement proof, retaining a failed outcome (release requested=%s)", async (requestRelease) => {
      const execution = await createNativeBrowser(config, options());
      const failed = { ...completed, status };
      const proof = deferred<typeof failed>();
      const networkClose = vi.fn(async () => {});
      execution.attachNetwork(networkClose);
      mocks.sessions.retrieve.mockClear();
      if (requestRelease) mocks.sessions.retrieve.mockResolvedValueOnce(running);
      mocks.sessions.retrieve.mockResolvedValueOnce(failed).mockReturnValueOnce(proof.promise);
      const closing = execution.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.sessions.retrieve.mock.calls).toEqual(requestRelease ? [
        [sessionId], [sessionId, { timeout: 2000 }], [sessionId, { timeout: 2000 }],
      ] : [[sessionId], [sessionId, { timeout: 2000 }]]);
      expect(networkClose).not.toHaveBeenCalled();
      expect(mocks.stagehand.close).not.toHaveBeenCalled();
      expect(mocks.playwright.close).not.toHaveBeenCalled();
      expect(mocks.browser.close).not.toHaveBeenCalled();
      expect(mocks.extensions.delete).not.toHaveBeenCalled();
      expect(mocks.worker.evaluate).not.toHaveBeenCalled();
      proof.resolve({ ...failed });
      expect(await closing).toEqual({ status: "failed", errors: ["remote_session_failed"] });
      expect(execution.usage).toMatchObject({
        remoteStatus: status, actualBrowserSeconds: 8,
        cleanupErrors: ["remote_session_failed"], nativeResource: { state: "deleted" },
      });
      expect(mocks.extensions.delete).toHaveBeenCalledExactlyOnceWith(extensionId, {
        headers: { "Content-Type": null },
      });
      expect(mocks.extensions.retrieve).toHaveBeenCalledExactlyOnceWith(extensionId);
      expect(mocks.sessions.update).toHaveBeenCalledTimes(requestRelease ? 1 : 0);
      expect(networkClose).toHaveBeenCalledOnce();
      expect(mocks.sessions.create).toHaveBeenCalledOnce();
      expect(mocks.extensions.create).toHaveBeenCalledOnce();
      expect(execution.close()).toBe(closing);
    });

    it.each([
      { id: "00000000-0000-4000-8000-000000000099" },
      { projectId: "00000000-0000-4000-8000-000000000099" },
      { userMetadata: { correlationToken: "00000000-0000-4000-8000-000000000099" } },
      { userMetadata: undefined },
      { status: "COMPLETED" },
      { status: "RUNNING" },
      { startedAt: "2026-01-01T00:00:01Z" },
      { endedAt: "2026-01-01T00:00:09Z" },
      { endedAt: undefined },
    ])("quarantines conflicting or incomplete independent proof: %j", async (conflict) => {
      const execution = await createNativeBrowser(config, options());
      const failed = { ...completed, status };
      mocks.sessions.retrieve.mockClear();
      mocks.sessions.retrieve.mockResolvedValueOnce(failed).mockResolvedValueOnce({ ...failed, ...conflict });
      expect(await execution.close()).toEqual({
        status: "failed", errors: ["remote_release_unconfirmed", "native_extension_cleanup_unconfirmed"],
      });
      expect(execution.usage.nativeResource?.state).toBe("quarantined");
      expect(execution.usage.actualBrowserSeconds).toBeUndefined();
      expect(mocks.sessions.retrieve).toHaveBeenCalledTimes(2);
      expect(mocks.sessions.update).not.toHaveBeenCalled();
      expect(mocks.extensions.delete).not.toHaveBeenCalled();
      expect(mocks.extensions.retrieve).not.toHaveBeenCalled();
    });

    it.each([
      { endedAt: undefined },
      { endedAt: "not-an-iso-timestamp" },
      { startedAt: "" },
      { endedAt: "2026-01-01T00:00:11Z" },
      { endedAt: "2025-12-31T23:59:59Z" },
    ])("quarantines even matching proof with missing, invalid, future, or reversed timestamps: %j", async (timestamps) => {
      const execution = await createNativeBrowser(config, options());
      mocks.sessions.retrieve.mockClear();
      mocks.sessions.retrieve.mockResolvedValue({ ...completed, status, ...timestamps });
      const cleanup = await execution.close();
      expect(cleanup.status).toBe("failed");
      expect(cleanup.errors).toContain("remote_release_unconfirmed");
      expect(cleanup.errors).not.toContain("remote_session_failed");
      expect(execution.usage.nativeResource?.state).toBe("quarantined");
      expect(execution.usage.actualBrowserSeconds).toBeUndefined();
      expect(mocks.sessions.retrieve.mock.calls).toEqual([[sessionId], [sessionId, { timeout: 2000 }]]);
      expect(mocks.extensions.delete).not.toHaveBeenCalled();
    });

    it("quarantines when independent proof cannot be retrieved", async () => {
      const execution = await createNativeBrowser(config, options());
      mocks.sessions.retrieve.mockClear();
      mocks.sessions.retrieve.mockResolvedValueOnce({ ...completed, status })
        .mockRejectedValueOnce(new Error("independent readback unavailable"));
      const cleanup = await execution.close();
      expect(cleanup.errors).toContain("remote_release_unconfirmed");
      expect(execution.usage.nativeResource?.state).toBe("quarantined");
      expect(execution.usage.actualBrowserSeconds).toBeUndefined();
      expect(mocks.sessions.retrieve).toHaveBeenCalledTimes(2);
      expect(mocks.extensions.delete).not.toHaveBeenCalled();
    });
  });

  it.each([2, 3, 4])("retains attachments until matching COMPLETED on readback %s", async (completedReadback) => {
    const execution = await createNativeBrowser(config, options());
    const networkClose = vi.fn(async () => {});
    execution.attachNetwork(networkClose);
    mocks.sessions.retrieve.mockClear();
    mocks.sessions.retrieve.mockResolvedValueOnce(running);
    for (let readback = 1; readback <= completedReadback; readback++) {
      mocks.sessions.retrieve.mockImplementationOnce(async () => {
        expect(networkClose).not.toHaveBeenCalled();
        expect(mocks.stagehand.close).not.toHaveBeenCalled();
        expect(mocks.playwright.close).not.toHaveBeenCalled();
        expect(mocks.browser.close).not.toHaveBeenCalled();
        expect(mocks.extensions.delete).not.toHaveBeenCalled();
        expect(mocks.worker.evaluate).not.toHaveBeenCalled();
        return readback === completedReadback
          ? completed : { ...running, status: readback % 2 ? "PENDING" : "RUNNING" };
      });
    }
    const closing = execution.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.sessions.retrieve).toHaveBeenCalledTimes(2);
    for (let readback = 2; readback <= completedReadback; readback++) {
      await vi.advanceTimersByTimeAsync(249);
      expect(mocks.sessions.retrieve).toHaveBeenCalledTimes(readback);
      expect(networkClose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.sessions.retrieve).toHaveBeenCalledTimes(readback + 1);
    }
    expect(await closing).toEqual({ status: "closed", errors: [] });
    expect(mocks.sessions.update).toHaveBeenCalledExactlyOnceWith(sessionId, {
      status: "REQUEST_RELEASE", projectId: config.BROWSERBASE_PROJECT_ID,
    });
    expect(mocks.sessions.retrieve.mock.calls).toEqual([
      [sessionId],
      ...Array.from({ length: completedReadback }, () => [sessionId, { timeout: 2000 }]),
    ]);
    expect(mocks.delay.mock.calls).toEqual(Array.from({ length: completedReadback - 1 }, () => [250]));
    expect(networkClose).toHaveBeenCalledOnce();
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
    expect(mocks.sessions.create).toHaveBeenCalledOnce();
    expect(mocks.extensions.create).toHaveBeenCalledOnce();
    expect(execution.usage).toMatchObject({
      remoteStatus: "COMPLETED", actualBrowserSeconds: 8, nativeResource: { state: "deleted" },
    });
  });

  it.each(["RUNNING", "PENDING"])("quarantines after exactly four %s release readbacks without another release request", async (status) => {
    const execution = await createNativeBrowser(config, options());
    const networkClose = vi.fn(async () => {});
    execution.attachNetwork(networkClose);
    mocks.sessions.retrieve.mockClear();
    mocks.sessions.retrieve.mockImplementation(async () => {
      expect(networkClose).not.toHaveBeenCalled();
      expect(mocks.stagehand.close).not.toHaveBeenCalled();
      expect(mocks.playwright.close).not.toHaveBeenCalled();
      expect(mocks.browser.close).not.toHaveBeenCalled();
      expect(mocks.extensions.delete).not.toHaveBeenCalled();
      return { ...running, status };
    });
    const closing = execution.close();
    await vi.advanceTimersByTimeAsync(749);
    expect(mocks.sessions.retrieve).toHaveBeenCalledTimes(4);
    expect(networkClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await closing).errors).toContain("remote_release_unconfirmed");
    expect(mocks.sessions.retrieve.mock.calls).toEqual([
      [sessionId], ...Array.from({ length: 4 }, () => [sessionId, { timeout: 2000 }]),
    ]);
    expect(mocks.delay.mock.calls).toEqual([[250], [250], [250]]);
    expect(mocks.sessions.update).toHaveBeenCalledOnce();
    expect(mocks.sessions.create).toHaveBeenCalledOnce();
    expect(mocks.extensions.create).toHaveBeenCalledOnce();
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
    expect(mocks.worker.evaluate).not.toHaveBeenCalled();
    expect(networkClose).toHaveBeenCalledOnce();
    expect(execution.usage.nativeResource?.state).toBe("quarantined");
    await vi.advanceTimersByTimeAsync(10000);
    expect(execution.close()).toBe(closing);
    expect(mocks.sessions.retrieve).toHaveBeenCalledTimes(5);
    expect(mocks.sessions.update).toHaveBeenCalledOnce();
  });

  it("bounds a release readback at 2500ms and ignores late completion", async () => {
    const execution = await createNativeBrowser(config, options());
    const readback = deferred<typeof completed>();
    const networkClose = vi.fn(async () => {});
    execution.attachNetwork(networkClose);
    mocks.sessions.retrieve.mockClear();
    mocks.sessions.retrieve.mockResolvedValueOnce(running).mockReturnValueOnce(readback.promise);
    const closing = execution.close();
    await vi.advanceTimersByTimeAsync(2499);
    expect(networkClose).not.toHaveBeenCalled();
    expect(mocks.playwright.close).not.toHaveBeenCalled();
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
    expect(mocks.sessions.retrieve).toHaveBeenLastCalledWith(sessionId, { timeout: 2000 });
    await vi.advanceTimersByTimeAsync(1);
    expect((await closing).errors).toContain("remote_release_unconfirmed");
    expect(execution.usage.nativeResource?.state).toBe("quarantined");
    readback.resolve(completed);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.sessions.retrieve).toHaveBeenCalledTimes(2);
    expect(mocks.sessions.update).toHaveBeenCalledOnce();
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
    expect(execution.usage.actualBrowserSeconds).toBeUndefined();
  });

  it("does not trust COMPLETED returned for a different correlation after release request", async () => {
    const execution = await createNativeBrowser(config, options());
    mocks.sessions.retrieve.mockResolvedValueOnce(running).mockResolvedValueOnce({
      ...completed, userMetadata: { correlationToken: "00000000-0000-4000-8000-000000000099" },
    });
    expect((await execution.close()).status).toBe("failed");
    expect(mocks.sessions.update).toHaveBeenCalledOnce();
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
    expect(execution.usage.nativeResource?.state).toBe("quarantined");
    expect(execution.usage.actualBrowserSeconds).toBeUndefined();
  });

  it("quarantines uncertain release requests instead of deleting an in-use extension", async () => {
    const execution = await createNativeBrowser(config, options());
    mocks.sessions.retrieve.mockResolvedValue(running);
    mocks.sessions.update.mockRejectedValue(new Error("release response lost"));
    const cleanup = await execution.close();
    expect(cleanup.errors).toContain("remote_release_unconfirmed");
    expect(execution.usage.nativeResource?.state).toBe("quarantined");
    expect(mocks.sessions.update).toHaveBeenCalledOnce();
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
    expect(mocks.playwright.close).toHaveBeenCalledOnce();
  });

  it("retains attachments until bounded release readback times out and ignores its late COMPLETED result", async () => {
    const execution = await createNativeBrowser(config, options());
    const remote = deferred<typeof completed>();
    mocks.sessions.retrieve.mockReturnValue(remote.promise);
    const networkClose = vi.fn(async () => {});
    execution.attachNetwork(networkClose);
    const closing = execution.close();
    await vi.advanceTimersByTimeAsync(9999);
    expect(networkClose).not.toHaveBeenCalled();
    expect(mocks.playwright.close).not.toHaveBeenCalled();
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect((await closing).errors).toContain("remote_release_unconfirmed");
    expect(networkClose).toHaveBeenCalledOnce();
    expect(execution.usage.nativeResource?.state).toBe("quarantined");
    remote.resolve(completed);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.extensions.delete).not.toHaveBeenCalled();
    expect(execution.usage.actualBrowserSeconds).toBeUndefined();
  });

  it.each(["upload-rejected", "upload-invalid", "create-rejected", "create-invalid"])(
    "quarantines uncertain %s without retry or destructive deletion", async (kind) => {
      if (kind === "upload-rejected") mocks.extensions.create.mockRejectedValue(new Error("lost upload response"));
      if (kind === "upload-invalid") mocks.extensions.create.mockResolvedValue({ id: "invalid" });
      if (kind === "create-rejected") mocks.sessions.create.mockRejectedValue(new Error("lost create response"));
      if (kind === "create-invalid") mocks.sessions.create.mockResolvedValue({ id: "invalid" });
      const error = await startupError();
      expect(resource(error)?.state).toBe("quarantined");
      expect(mocks.extensions.create).toHaveBeenCalledOnce();
      expect(mocks.sessions.create.mock.calls.length).toBe(kind.startsWith("create") ? 1 : 0);
      expect(mocks.extensions.delete).not.toHaveBeenCalled();
      expect(error.cleanup.status).toBe("failed");
      if (kind.startsWith("create")) expect(error.cleanup.errors).toContain("startup_session_unconfirmed");
    },
  );

  it.each(["delete-rejected", "still-present", "plain-404", "authenticated-403"])(
    "requires authenticated exact-ID 404 after deletion: %s", async (kind) => {
      const execution = await createNativeBrowser(config, options());
      if (kind === "delete-rejected") mocks.extensions.delete.mockRejectedValue(new Error("lost delete response"));
      if (kind === "still-present") mocks.extensions.retrieve.mockResolvedValue({ id: extensionId });
      if (kind === "plain-404") mocks.extensions.retrieve.mockRejectedValue({ status: 404 });
      if (kind === "authenticated-403") mocks.extensions.retrieve.mockRejectedValue(new mocks.APIError(403));
      const cleanup = await execution.close();
      expect(cleanup.errors).toContain("native_extension_cleanup_unconfirmed");
      expect(execution.usage.nativeResource?.state).toBe("delete_unconfirmed");
      expect(mocks.extensions.delete).toHaveBeenCalledOnce();
      await execution.close();
      expect(mocks.extensions.delete).toHaveBeenCalledOnce();
    },
  );

  it("continues remote containment and teardown after drain or metrics failure", async () => {
    const execution = await createNativeBrowser(config, options());
    execution.attachBrain({
      decide: vi.fn<Brain["decide"]>(), drain: vi.fn(async () => { throw new Error("gateway failed"); }),
    });
    mocks.stagehand.metrics.mockRejectedValue(new Error("metrics failed"));
    const cleanup = await execution.close();
    expect(cleanup).toEqual({ status: "failed", errors: ["gateway_drain", "metrics_unavailable"] });
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
    expect(mocks.playwright.close).toHaveBeenCalledOnce();
    expect(execution.usage.nativeResource?.state).toBe("deleted");
  });

  it("native control loss aborts ownership and closes control only after remote retirement", async () => {
    const execution = await createNativeBrowser(config, options());
    const network = vi.fn(async () => {});
    execution.attachNetwork(network);
    const remote = deferred<typeof completed>();
    mocks.sessions.retrieve.mockReturnValue(remote.promise);
    const onLost = mocks.attest.mock.calls[0][0].onLost;
    expect(onLost).toBeTypeOf("function");
    onLost!();
    expect(execution.signal.aborted).toBe(true);
    expect(() => execution.assertActive()).toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.policyClose).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(mocks.stagehand.close).not.toHaveBeenCalled();
    const closing = execution.close();
    onLost!();
    remote.resolve(completed);
    expect(await closing).toEqual({ status: "closed", errors: [] });
    expect(mocks.policyClose).toHaveBeenCalledOnce();
    expect(network).toHaveBeenCalledOnce();
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
    expect(execution.close()).toBe(closing);
  });

  it("reports native control close failure but continues SDK and extension cleanup", async () => {
    const execution = await createNativeBrowser(config, options());
    mocks.policyClose.mockRejectedValue(new Error("native control detach failed"));
    expect(await execution.close()).toEqual({ status: "failed", errors: ["native_control_close"] });
    expect(mocks.policyClose).toHaveBeenCalledOnce();
    expect(mocks.sdkClose).toHaveBeenCalledOnce();
    expect(mocks.playwright.close).toHaveBeenCalledOnce();
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
    expect(execution.usage.nativeResource?.state).toBe("deleted");
  });

  it("native worker closure revokes activity and closes ownership exactly once", async () => {
    const execution = await createNativeBrowser(config, options());
    const network = vi.fn(async () => {});
    execution.attachNetwork(network);
    expect(mocks.worker.once).toHaveBeenCalledWith("close", expect.any(Function));
    const callback = mocks.worker.once.mock.calls.find(([event]) => event === "close")![1];
    callback();
    expect(execution.signal.aborted).toBe(true);
    expect(() => execution.assertActive()).toThrow();
    expect(await execution.close()).toEqual({ status: "closed", errors: [] });
    expect(network).toHaveBeenCalledOnce();
    expect(mocks.extensions.delete).toHaveBeenCalledOnce();
  });

  it("requires an attached network and fresh verification before live publication", async () => {
    const input = options();
    const execution = await createNativeBrowser(config, input);
    await expect(execution.publishLiveReference()).rejects.toThrow("native_network_not_installed");
    expect(mocks.sessions.debug).not.toHaveBeenCalled();
    execution.attachNetwork(vi.fn(async () => {}));
    await execution.publishLiveReference();
    expect(mocks.verify).toHaveBeenCalledTimes(2);
    expect(mocks.sessions.debug).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(input.onSession).toHaveBeenLastCalledWith({
      sessionId, liveViewUrl: "https://example.invalid/private-debug",
      replayUrl: `https://www.browserbase.com/sessions/${sessionId}`,
      timeoutSeconds: Math.min(config.SESSION_TIMEOUT_SECONDS, 300),
    });
    await execution.close();
  });

  it("cannot publish when re-attestation fails", async () => {
    const input = options();
    const execution = await createNativeBrowser(config, input);
    execution.attachNetwork(vi.fn(async () => {}));
    mocks.verify.mockRejectedValue(new Error("native policy changed"));
    await expect(execution.publishLiveReference()).rejects.toThrow("native_policy_lost");
    expect(mocks.sessions.debug).not.toHaveBeenCalled();
    expect(input.onSession).toHaveBeenCalledTimes(1);
    expect(execution.signal.aborted).toBe(true);
    await execution.close();
  });

  it("does not publish a debugger response resolving after cancellation", async () => {
    const input = options();
    const execution = await createNativeBrowser(config, input);
    execution.attachNetwork(vi.fn(async () => {}));
    const debug = deferred<{ debuggerFullscreenUrl: string }>();
    mocks.sessions.debug.mockReturnValue(debug.promise);
    const publication = execution.publishLiveReference();
    const rejected = expect(publication).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    await execution.close();
    debug.resolve({ debuggerFullscreenUrl: "https://example.invalid/late-debug" });
    await rejected;
    expect(input.onSession).toHaveBeenCalledTimes(1);
  });

  it("rejects a live-reference callback that completes after ownership closes", async () => {
    const publication = deferred<void>();
    const input = options({
      onSession: vi.fn(async (reference) => {
        if (reference.liveViewUrl) await publication.promise;
      }),
    });
    const execution = await createNativeBrowser(config, input);
    execution.attachNetwork(vi.fn(async () => {}));
    const publishing = execution.publishLiveReference();
    const rejected = expect(publishing).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(input.onSession).toHaveBeenCalledTimes(2);
    await execution.close();
    publication.resolve(undefined);
    await rejected;
    expect(execution.signal.aborted).toBe(true);
    expect(mocks.sessions.debug).toHaveBeenCalledOnce();
  });

  it("rejects duplicate attachments and new ownership after closure", async () => {
    const execution = await createNativeBrowser(config, options());
    const brain = { decide: vi.fn<Brain["decide"]>() };
    execution.attachBrain(brain);
    execution.attachNetwork(vi.fn(async () => {}));
    expect(() => execution.attachBrain(brain)).toThrow("native_brain_already_attached");
    expect(() => execution.attachNetwork(vi.fn(async () => {}))).toThrow("native_network_already_attached");
    await execution.close();
    expect(() => execution.attachBrain(brain)).toThrow();
    expect(() => execution.attachNetwork(vi.fn(async () => {}))).toThrow();
  });
});
