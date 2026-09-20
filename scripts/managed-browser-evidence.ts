import { chromium, type Browser } from "playwright-core";
import { z } from "zod";

export const MANAGED_GOAL_URL = "https://www.iana.org/domains/reserved";
export type ManagedBrowserLog = {
  sessionId: string; pageId: number; method: string; timestamp: number;
  request: { params: Record<string, unknown> };
  response: { result: Record<string, unknown> };
};
export type ManagedObserverIdentity = {
  sessionId: string; projectId: string; runId: string; agentId: string; task: string;
};

export function assertManagedObserverIdentity(run: unknown, session: unknown, expected: ManagedObserverIdentity) {
  z.object({
    runId: z.literal(expected.runId), agentId: z.literal(expected.agentId), task: z.literal(expected.task),
    sessionId: z.literal(expected.sessionId), status: z.literal("RUNNING"),
  }).parse(run);
  z.object({
    id: z.literal(expected.sessionId), projectId: z.literal(expected.projectId), status: z.literal("RUNNING"),
  }).parse(session);
  z.uuid().parse(expected.sessionId);
}

export async function connectManagedBrowserObserver(apiKey: string, sessionId: string) {
  z.uuid().parse(sessionId);
  const url = new URL("wss://connect.browserbase.com");
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("sessionId", sessionId);
  return chromium.connectOverCDP(url.href, { timeout: 10000 });
}

async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("managed_browser_observation_timeout")), 5000);
    })]);
    signal.throwIfAborted();
    return value;
  } finally { clearTimeout(timer); }
}

/** Only observes the already-identified session. It never navigates, clicks or creates pages. */
export async function sampleManagedBrowser(browser: Browser, sessionId: string, capture: boolean, signal: AbortSignal) {
  signal.throwIfAborted();
  z.uuid().parse(sessionId);
  const pages = browser.contexts().flatMap((context) => context.pages())
    .filter((page) => !page.isClosed() && page.url() !== "about:blank");
  if (!pages.length) return [];
  if (pages.length !== 1) throw new Error("managed_browser_observation_ambiguous");
  const page = pages[0];
  const cdp = await bounded(page.context().newCDPSession(page), signal);
  const logs: ManagedBrowserLog[] = [];
  try {
    const command = async (method: "Runtime.evaluate" | "Page.captureScreenshot", params: Record<string, unknown>) => {
      signal.throwIfAborted();
      const result = z.record(z.string(), z.unknown()).parse(await bounded(cdp.send(method, params), signal));
      logs.push({ sessionId, pageId: 0, method, timestamp: Date.now(), request: { params }, response: { result } });
      return result;
    };
    const location = { expression: "window.location.href", returnByValue: true };
    const before = await command("Runtime.evaluate", location);
    const url = z.object({ result: z.object({ type: z.literal("string"), value: z.string() }) }).parse(before).result.value;
    if (capture && url === MANAGED_GOAL_URL) {
      const ready = await command("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (z.object({ result: z.object({ value: z.string() }) }).parse(ready).result.value === "complete") {
        await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        await command("Runtime.evaluate", location);
      }
    }
    return logs;
  } finally { await bounded(cdp.detach(), new AbortController().signal); }
}

export async function pollManagedBrowser(browser: Browser, sessionId: string, capture: boolean, signal: AbortSignal) {
  signal.throwIfAborted();
  z.uuid().parse(sessionId);
  try {
    return { status: "observed" as const, logs: await sampleManagedBrowser(browser, sessionId, capture, signal) };
  } catch (error) {
    signal.throwIfAborted();
    // The provider can close the browser before the worker's next terminal-status poll.
    // This is not success: the caller must still independently verify run/session closure.
    const targetClosed = error instanceof Error &&
      /^(?:cdpSession\.(?:send|detach)|browserContext\.newCDPSession): Target page, context or browser has been closed/.test(error.message);
    if (!browser.isConnected() || targetClosed) return { status: "disconnected" as const, logs: [] };
    throw error;
  }
}
