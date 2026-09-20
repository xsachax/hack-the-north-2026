import type { BrowserContext, Page } from "playwright-core";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { attachCdpTarget } from "./cdp-target";
import { sha256 } from "./composed-extension";

const contextSchema = z.object({ context: z.object({
  id: z.int().positive(), uniqueId: z.string().min(1).max(200), origin: z.string().max(4096),
  auxData: z.object({ isDefault: z.literal(true) }).optional(),
}) });
const resultSchema = z.object({
  result: z.object({ value: z.unknown().optional() }),
  exceptionDetails: z.unknown().optional(),
});
const profilesSchema = z.strictObject({
  browserContextIds: z.array(z.string()).length(0),
  defaultBrowserContextId: z.string().min(1).max(200).optional(),
});
export type NativeWorkerControl = Awaited<ReturnType<typeof connectNativeWorkerControl>>;

/** Fixed debugger operations on the original, installed extension worker only. */
export async function connectNativeWorkerControl(options: {
  context: BrowserContext;
  workerUrl: string;
  assertActive: () => void;
  onLost?: () => void;
}) {
  const { context, workerUrl, assertActive } = options;
  const match = /^chrome-extension:\/\/([a-p]{32})\/service-worker.js$/.exec(workerUrl);
  const browser = context.browser();
  if (!match || !browser) throw new Error("native_extension_identity_rejected");
  assertActive();
  const root = await browser.newBrowserCDPSession();
  let target: Awaited<ReturnType<typeof attachCdpTarget>> | undefined;
  let wake: Page | undefined;
  let contextId: number | undefined;
  let uniqueContextId: string | undefined;
  let lost = false;
  let phase = "native_worker_attachment_failed";
  let closing: Promise<void> | undefined;
  const fail = () => {
    if (lost || closing) return;
    lost = true;
    options.onLost?.();
  };
  const active = () => {
    assertActive();
    if (lost || closing) throw new Error("native_worker_lost");
  };
  const close = () => closing ??= (async () => {
    await target?.close(browser.isConnected());
    if (browser.isConnected()) await root.detach();
  })();
  const verifyProfile = async () => {
    active();
    const profiles = await root.send("Target.getBrowserContexts");
    active();
    if (!profilesSchema.safeParse(profiles).success) {
      fail();
      throw new Error("native_profile_rejected");
    }
  };
  // Strings are fixed audited programs with JSON-encoded trusted data, not
  // serialized TSX closures or page/model-supplied JavaScript.
  const evaluate = async (program: string, awaitPromise = false): Promise<unknown> => {
    active();
    await verifyProfile();
    if (!target || contextId === undefined || uniqueContextId === undefined) throw new Error("native_worker_context_missing");
    const raw = await target.send("Runtime.evaluate", {
      uniqueContextId, awaitPromise, returnByValue: true,
      expression: `(()=>{if(self.location.href!==${JSON.stringify(workerUrl)}||chrome.runtime.id!==${JSON.stringify(match[1])})throw new Error("native_context_identity_rejected");return ${program};})()`,
    });
    active();
    const result = resultSchema.safeParse(raw);
    if (!result.success || result.data.exceptionDetails !== undefined) throw new Error("native_worker_command_failed");
    return result.data.result.value;
  };
  try {
    await verifyProfile();
    // Target discovery precedes extension activation. Use the vendor's existing,
    // trusted wake document before evaluating its worker bindings.
    wake = await context.newPage();
    active();
    await wake.goto(new URL("wake-service-worker.html", workerUrl).href, { waitUntil: "load", timeout: 5000 });
    active();
    const deadline = Date.now() + 10000;
    let targetId: string | undefined;
    while (!targetId) {
      active();
      const infos = (await root.send("Target.getTargets")).targetInfos.filter((info) =>
        info.type === "service_worker" && info.url === workerUrl);
      if (infos.length > 1 || Date.now() >= deadline) throw new Error("native_extension_identity_rejected");
      targetId = infos[0]?.targetId;
      if (!targetId) await delay(25);
    }
    active();
    target = await attachCdpTarget(root, targetId, (method, params) => {
      if (closing || lost) return;
      if (method === "Runtime.executionContextCreated") {
        const parsed = contextSchema.safeParse(params);
        if (!parsed.success || parsed.data.context.origin !== workerUrl
          || contextId !== undefined && (contextId !== parsed.data.context.id || uniqueContextId !== parsed.data.context.uniqueId)) fail();
        else {
          contextId = parsed.data.context.id;
          uniqueContextId = parsed.data.context.uniqueId;
        }
      } else if (["public.cdpFailure", "Runtime.executionContextDestroyed"].includes(method)
        || method === "Runtime.executionContextsCleared" && contextId !== undefined) {
        fail();
      }
    });
    phase = "native_worker_runtime_failed";
    await target.send("Runtime.enable");
    // Like pinned Playwright, acknowledge startup on our own target session.
    // This does not resume a Debugger.pause or stop another client's debugger.
    await target.send("Runtime.runIfWaitingForDebugger");
    active();
    while (contextId === undefined) {
      active();
      if (Date.now() >= deadline) throw new Error("native_worker_context_missing");
      await delay(25);
    }
    phase = "native_worker_readiness_failed";
    while (true) {
      active();
      const raw = await target.send("Runtime.evaluate", {
        uniqueContextId, returnByValue: true,
        expression: '({id:globalThis.chrome?.runtime?.id,native:typeof globalThis.flashFloodNativePolicy,sdk:typeof globalThis.__stagehand_runtime})',
      });
      const ready = z.object({ result: z.object({ value: z.object({
        id: z.string().regex(/^[a-p]{32}$/).optional(), native: z.enum(["object", "undefined"]), sdk: z.enum(["object", "undefined"]),
      }) }), exceptionDetails: z.never().optional() }).safeParse(raw);
      if (!ready.success || ready.data.result.value.id !== undefined && ready.data.result.value.id !== match[1]) {
        throw new Error("native_extension_identity_rejected");
      }
      const value = ready.data.result.value;
      if (value.id === match[1] && value.native === "object" && value.sdk === "object") break;
      if (Date.now() >= deadline) throw new Error("native_worker_not_ready");
      await delay(25);
    }
    await wake.close();
    wake = undefined;
    active();
    return {
      close,
      startupWaiting: target.startupWaiting,
      snapshot: () => evaluate("globalThis.flashFloodNativePolicy.snapshot()"),
      activate: () => evaluate("globalThis.flashFloodNativePolicy.activate()", true),
      verify: () => evaluate("globalThis.flashFloodNativePolicy.verify()", true),
      async verifyFiles(files: ReadonlyMap<string, Buffer>) {
        if (!files.size || files.size > 16) throw new Error("native_extension_bytes_rejected");
        const entries = [...files].map(([name, bytes]) => {
          if (!/^[a-zA-Z0-9._/-]{1,160}$/.test(name)
            || name.split("/").some((part) => !part || part === "." || part === "..")
            || bytes.length > 4 * 1024 * 1024) throw new Error("native_extension_bytes_rejected");
          return { url: new URL(name, workerUrl).href, digest: sha256(bytes) };
        });
        const matched = await evaluate(`(async()=>{
          for(const {url,digest} of ${JSON.stringify(entries)}){
            const response=await fetch(url);
            if(!response.ok)return false;
            const bytes=await response.arrayBuffer();
            if(bytes.byteLength>4*1024*1024)return false;
            const actual=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)))
              .map(byte=>byte.toString(16).padStart(2,"0")).join("");
            if(actual!==digest)return false;
          }
          return true;
        })()`, true);
        if (matched !== true) throw new Error("native_extension_bytes_rejected");
      },
    };
  } catch (error) {
    try { await wake?.close(); }
    finally { await close(); }
    const known = new Set(["public_cdp_timeout", "native_worker_not_ready", "native_worker_command_failed", "native_worker_lost", "native_worker_context_missing", "native_extension_identity_rejected", "native_profile_rejected"]);
    throw new Error(`${phase}:${error instanceof Error && known.has(error.message) ? error.message : "unconfirmed"}`);
  }
}
