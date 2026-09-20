import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertManagedObserverIdentity, connectManagedBrowserObserver, MANAGED_GOAL_URL, pollManagedBrowser, sampleManagedBrowser,
} from "../../../scripts/managed-browser-evidence";

const SESSION = "73fc5c99-765f-4a77-93d0-3daec118f69c";
const mocks = vi.hoisted(() => ({
  connect: vi.fn(), attach: vi.fn(), send: vi.fn(), detach: vi.fn(), pages: vi.fn(), connected: vi.fn(),
}));
vi.mock("playwright-core", () => ({ chromium: { connectOverCDP: mocks.connect } }));

beforeEach(() => {
  vi.resetAllMocks();
  const cdp = { send: mocks.send, detach: mocks.detach };
  const context = { newCDPSession: mocks.attach, pages: mocks.pages };
  const page = { isClosed: () => false, url: () => MANAGED_GOAL_URL, context: () => context };
  mocks.connect.mockResolvedValue({ contexts: () => [context], isConnected: mocks.connected });
  mocks.connected.mockReturnValue(true);
  mocks.attach.mockResolvedValue(cdp);
  mocks.detach.mockResolvedValue(undefined);
  mocks.pages.mockReturnValue([page]);
  mocks.send.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === "Page.captureScreenshot") return { data: "private-real-pixels-in-hosted-proof" };
    return { result: { type: "string", value: params.expression === "document.readyState" ? "complete" : MANAGED_GOAL_URL } };
  });
});

describe("independent managed browser observer", () => {
  it("requires the exact running task, agent, project and session before attachment", () => {
    const expected = { runId: "run", agentId: "agent", projectId: "project", task: "exact-task", sessionId: SESSION };
    const run = { ...expected, status: "RUNNING" };
    const session = { id: SESSION, projectId: expected.projectId, status: "RUNNING" };
    expect(() => assertManagedObserverIdentity(run, session, expected)).not.toThrow();
    for (const field of ["runId", "agentId", "task", "sessionId", "status"]) {
      expect(() => assertManagedObserverIdentity({ ...run, [field]: "wrong" }, session, expected)).toThrow();
    }
    for (const field of ["id", "projectId", "status"]) {
      expect(() => assertManagedObserverIdentity(run, { ...session, [field]: "wrong" }, expected)).toThrow();
    }
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("attaches only to an existing session and brackets real screenshot commands with browser URL reads", async () => {
    const browser = await connectManagedBrowserObserver("offline-key", SESSION);
    const endpoint = new URL(mocks.connect.mock.calls[0][0]);
    expect(endpoint.origin).toBe("wss://connect.browserbase.com");
    expect(endpoint.searchParams.get("sessionId")).toBe(SESSION);
    expect(endpoint.searchParams.get("apiKey")).toBe("offline-key");
    const logs = await sampleManagedBrowser(browser, SESSION, true, new AbortController().signal);
    expect(logs.map((log) => log.method)).toEqual([
      "Runtime.evaluate", "Runtime.evaluate", "Page.captureScreenshot", "Runtime.evaluate",
    ]);
    expect(logs.every((log) => log.sessionId === SESSION && log.pageId === 0)).toBe(true);
    expect(logs[0].request.params.expression).toBe("window.location.href");
    expect(logs[3].request.params.expression).toBe("window.location.href");
    expect(logs[2].response.result.data).toBe("private-real-pixels-in-hosted-proof");
    expect(mocks.detach).toHaveBeenCalledOnce();
    expect(JSON.stringify(logs)).not.toContain("offline-key");
  });

  it("records non-goal URLs without taking goal screenshots", async () => {
    mocks.send.mockResolvedValue({ result: { type: "string", value: "https://www.iana.org/help/example-domains" } });
    const browser = await connectManagedBrowserObserver("offline-key", SESSION);
    const logs = await sampleManagedBrowser(browser, SESSION, true, new AbortController().signal);
    expect(logs).toHaveLength(1);
    expect(logs[0].response.result).toEqual({ result: { type: "string", value: "https://www.iana.org/help/example-domains" } });
    expect(mocks.send).not.toHaveBeenCalledWith("Page.captureScreenshot", expect.anything());
  });

  it("rejects ambiguous pages, invalid identity, aborted reads and malformed browser replies", async () => {
    await expect(connectManagedBrowserObserver("offline-key", "bad-id")).rejects.toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
    const browser = await connectManagedBrowserObserver("offline-key", SESSION);
    await expect(sampleManagedBrowser(browser, SESSION, true, AbortSignal.abort())).rejects.toThrow();
    expect(mocks.attach).not.toHaveBeenCalled();
    const page = mocks.pages()[0];
    mocks.pages.mockReturnValue([page, page]);
    await expect(sampleManagedBrowser(browser, SESSION, true, new AbortController().signal))
      .rejects.toThrow("managed_browser_observation_ambiguous");
    mocks.pages.mockReturnValue([page]);
    mocks.send.mockResolvedValue({ result: { type: "object", value: {} } });
    await expect(sampleManagedBrowser(browser, SESSION, true, new AbortController().signal)).rejects.toThrow();
    expect(mocks.detach).toHaveBeenCalledOnce();
  });

  it("does not suppress protocol errors or fabricate screenshot success", async () => {
    const browser = await connectManagedBrowserObserver("offline-key", SESSION);
    mocks.send.mockRejectedValue(new Error("protocol failure"));
    await expect(sampleManagedBrowser(browser, SESSION, true, new AbortController().signal))
      .rejects.toThrow("protocol failure");
    expect(mocks.detach).toHaveBeenCalledOnce();
  });

  it("reports a normal remote disconnect without cancelling the still-settling worker or inventing evidence", async () => {
    const browser = await connectManagedBrowserObserver("offline-key", SESSION);
    mocks.send.mockImplementation(async () => {
      mocks.connected.mockReturnValue(false);
      throw new Error("Target page, context or browser has been closed");
    });
    expect(await pollManagedBrowser(browser, SESSION, true, new AbortController().signal))
      .toEqual({ status: "disconnected", logs: [] });
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.detach).toHaveBeenCalledOnce();
  });

  it("still rejects connected protocol failures and cancellation rather than treating them as normal closure", async () => {
    const browser = await connectManagedBrowserObserver("offline-key", SESSION);
    mocks.send.mockRejectedValue(new Error("Unexpected protocol failure"));
    await expect(pollManagedBrowser(browser, SESSION, true, new AbortController().signal))
      .rejects.toThrow("Unexpected protocol failure");
    mocks.connected.mockReturnValue(false);
    await expect(pollManagedBrowser(browser, SESSION, true, AbortSignal.abort())).rejects.toThrow();
  });

  it("handles the exact hosted page-detach race even before the browser reports disconnection", async () => {
    const browser = await connectManagedBrowserObserver("offline-key", SESSION);
    mocks.detach.mockRejectedValue(new Error("cdpSession.detach: Target page, context or browser has been closed"));
    expect(await pollManagedBrowser(browser, SESSION, true, new AbortController().signal))
      .toEqual({ status: "disconnected", logs: [] });
    expect(mocks.connected()).toBe(true);
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledTimes(4);
  });
});
