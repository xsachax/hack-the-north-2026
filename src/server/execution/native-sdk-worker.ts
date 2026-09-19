import { parentPort, workerData } from "node:worker_threads";
import { browserbase, Stagehand, type StagehandBrowser, type Page } from "@browserbasehq/stagehand";
import { decisionSchema } from "./types";
import { semanticResponseSchema } from "./evaluator";
import { nativeSdkCommandSchema, nativeSdkOptionsSchema } from "./native-sdk-protocol";

const port = parentPort;
if (!port) throw new Error("native_sdk_worker_required");
const options = nativeSdkOptionsSchema.parse(workerData);
let browser: StagehandBrowser | undefined;
let stagehand: Stagehand | undefined;
let page: Page | undefined;
let initialized = false;
let busy = false;

port.on("message", async (message: unknown) => {
  const parsed = nativeSdkCommandSchema.safeParse(message);
  if (!parsed.success || busy) {
    // A protocol violation cannot leave an unowned SDK operation running.
    process.exit(1);
  }
  const command = parsed.data;
  busy = true;
  try {
    let result: unknown = null;
    if (command.operation === "connect") {
      if (initialized) throw new Error("native_sdk_already_initialized");
      initialized = true;
      browser = await browserbase.connect({
        apiKey: options.apiKey, baseUrl: options.baseUrl, sessionId: options.sessionId, extensionId: options.extensionId,
      });
      if (browser.provider !== "browserbase" || browser.origin !== "connected" || browser.sessionId !== options.sessionId) {
        throw new Error("native_sdk_session_identity_rejected");
      }
      result = { sessionId: browser.sessionId };
    } else if (command.operation === "initialize") {
      if (!browser || stagehand) throw new Error("native_sdk_initialization_rejected");
      stagehand = await Stagehand.create({
        browser, apiKey: options.apiKey, model: { modelName: options.model },
        cache: false, selfHeal: false, logging: { level: "off" },
      });
    } else {
      if (!stagehand || !browser) throw new Error("native_sdk_uninitialized");
      if (command.operation === "selectPage") {
        if (page) throw new Error("native_sdk_page_already_selected");
        const matches: Page[] = [];
        for (const candidate of await browser.context.pages()) {
          if (await candidate.url() === command.url) matches.push(candidate);
        }
        if (matches.length !== 1) throw new Error("native_sdk_page_identity_rejected");
        page = matches[0];
        await browser.context.setActivePage(page);
      } else if (command.operation === "metrics") {
        result = await stagehand.metrics();
      } else {
        if (!page) throw new Error("native_sdk_page_unavailable");
        const schema = command.schema === "decision" ? decisionSchema : semanticResponseSchema;
        result = (await stagehand.extract(command.prompt, schema, {
          page, screenshot: true, timeout: 25000,
        })).data;
      }
    }
    port.postMessage({ id: command.id, ok: true, result });
  } catch {
    port.postMessage({ id: command.id, ok: false, code: "native_sdk_operation_failed" });
  } finally {
    busy = false;
  }
});

// No SDK handle.close(): only the parent releases the remote session. Terminating
// this exclusively owned thread settles its sockets, HTTP retries and RPC timers.
