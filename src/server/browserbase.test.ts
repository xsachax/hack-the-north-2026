import { beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../lib/config";
import { withBrowserSession } from "./browserbase";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  create: vi.fn(),
  debug: vi.fn(),
  closeBrowser: vi.fn(),
  closeStagehand: vi.fn(),
}));

vi.mock("@browserbasehq/stagehand", () => ({
  browserbase: { launch: mocks.launch },
  Stagehand: { create: mocks.create },
}));
vi.mock("@browserbasehq/sdk", () => ({
  default: class {
    sessions = { debug: mocks.debug };
  },
}));

const config = readConfig({ BROWSERBASE_API_KEY: "unit-test-placeholder" });
const options = { runId: "run-1", personaId: "dana" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.launch.mockResolvedValue({ sessionId: "session-1", close: mocks.closeBrowser });
  mocks.create.mockResolvedValue({ close: mocks.closeStagehand });
  mocks.debug.mockResolvedValue({ debuggerFullscreenUrl: "https://example.invalid/live?session=test" });
  mocks.closeBrowser.mockResolvedValue(undefined);
  mocks.closeStagehand.mockResolvedValue(undefined);
});

describe("Browserbase lifecycle", () => {
  it("creates a bounded, recorded session with metadata and gateway-only credentials", async () => {
    const result = await withBrowserSession(config, options, async (session) => {
      expect(session.liveViewUrl).toBe("https://example.invalid/live?session=test&navbar=false");
      expect(session.replayUrl).toBe("https://www.browserbase.com/sessions/session-1");
      return "done";
    });
    expect(result).toBe("done");
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({
      api_timeout: 120,
      keepAlive: false,
      userMetadata: { runId: "run-1", personaId: "dana" },
      browserSettings: { recordSession: true, solveCaptchas: false, viewport: { width: 1280, height: 800 } },
    }));
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { modelName: "google/gemini-2.5-flash" },
      selfHeal: false,
    }));
    expect(mocks.closeStagehand).toHaveBeenCalledOnce();
    expect(mocks.closeBrowser).toHaveBeenCalledOnce();
  });

  it("releases the browser when Stagehand initialization fails", async () => {
    mocks.create.mockRejectedValue(new Error("Gateway unavailable"));
    await expect(withBrowserSession(config, options, vi.fn())).rejects.toThrow(AggregateError);
    expect(mocks.closeBrowser).toHaveBeenCalledOnce();
  });

  it("releases both resources when debug URL retrieval fails", async () => {
    mocks.debug.mockRejectedValue(new Error("Debug unavailable"));
    await expect(withBrowserSession(config, options, vi.fn())).rejects.toThrow();
    expect(mocks.closeStagehand).toHaveBeenCalledOnce();
    expect(mocks.closeBrowser).toHaveBeenCalledOnce();
  });

  it("preserves all failures and still releases the browser if Stagehand close fails", async () => {
    const actionError = new Error("Action failed");
    const closeError = new Error("Stagehand close failed");
    mocks.closeStagehand.mockRejectedValue(closeError);
    await expect(withBrowserSession(config, options, async () => {
      throw actionError;
    })).rejects.toMatchObject({ errors: [actionError, closeError] });
    expect(mocks.closeBrowser).toHaveBeenCalledOnce();
  });

  it("does not report success if browser release fails", async () => {
    mocks.closeBrowser.mockRejectedValue(new Error("Release failed"));
    await expect(withBrowserSession(config, options, async () => "done")).rejects.toThrow(AggregateError);
  });

  it("does not run actions after a launch failure", async () => {
    const work = vi.fn();
    mocks.launch.mockRejectedValue(new Error("No credits"));
    await expect(withBrowserSession(config, options, work)).rejects.toThrow("No credits");
    expect(work).not.toHaveBeenCalled();
  });

  it("rejects oversized metadata before allocating a browser", async () => {
    await expect(withBrowserSession(config, { ...options, runId: "x".repeat(512) }, vi.fn())).rejects.toThrow("metadata");
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});
