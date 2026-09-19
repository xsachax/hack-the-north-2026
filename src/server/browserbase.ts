import Browserbase from "@browserbasehq/sdk";
import { browserbase, Stagehand, type StagehandBrowser } from "@browserbasehq/stagehand";
import type { AppConfig } from "../lib/config";

export type BrowserSession = {
  browser: StagehandBrowser;
  stagehand: Stagehand;
  sessionId: string;
  liveViewUrl: string;
  replayUrl: string;
};

export type SessionOptions = {
  runId: string;
  personaId: string;
  viewport?: { width: number; height: number };
};

export async function withBrowserSession<T>(
  config: AppConfig,
  options: SessionOptions,
  work: (session: BrowserSession) => Promise<T>,
): Promise<T> {
  const metadata = { runId: options.runId, personaId: options.personaId };
  if (JSON.stringify(metadata).length >= 512) {
    throw new Error("Browserbase session metadata must be shorter than 512 characters.");
  }

  const browser = await browserbase.launch({
    apiKey: config.BROWSERBASE_API_KEY,
    projectId: config.BROWSERBASE_PROJECT_ID,
    api_timeout: config.SESSION_TIMEOUT_SECONDS,
    keepAlive: false,
    proxies: false,
    browserSettings: {
      recordSession: true,
      solveCaptchas: false,
      viewport: options.viewport ?? { width: 1280, height: 800 },
    },
    userMetadata: metadata,
  });

  let stagehand: Stagehand | undefined;
  const execute = async () => {
    if (!browser.sessionId) throw new Error("Browserbase returned no session ID.");
    stagehand = await Stagehand.create({
      browser,
      apiKey: config.BROWSERBASE_API_KEY,
      model: { modelName: config.STAGEHAND_MODEL },
      cache: false,
      selfHeal: false,
      logging: { level: "off" },
    });
    const bb = new Browserbase({ apiKey: config.BROWSERBASE_API_KEY, maxRetries: 0, timeout: 15_000 });
    const debug = await bb.sessions.debug(browser.sessionId);
    const liveView = new URL(debug.debuggerFullscreenUrl);
    liveView.searchParams.set("navbar", "false");

    return work({
      browser,
      stagehand,
      sessionId: browser.sessionId,
      liveViewUrl: liveView.toString(),
      replayUrl: `https://www.browserbase.com/sessions/${browser.sessionId}`,
    });
  };

  // Preserve the operation error and still attempt every cleanup operation.
  const [result] = await Promise.allSettled([execute()]);
  const errors: unknown[] = result.status === "rejected" ? [result.reason] : [];
  for (const close of [() => stagehand?.close(), () => browser.close()]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Browserbase operation or cleanup failed.");
  if (result.status === "rejected") throw result.reason;
  return result.value;
}
