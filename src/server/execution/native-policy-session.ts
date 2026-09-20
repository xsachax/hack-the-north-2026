import type { BrowserContext, Worker } from "playwright-core";
import { z } from "zod";
import { verifyNativeWebRtcPreferences } from "./native-policy-attestation";
import { verifyNativeProxyRefusal } from "./native-proxy-attestation";
import { connectNativeWorkerControl, type NativeWorkerControl } from "./native-worker-control";

export const PROVED_CHROMIUM_VERSION = "145.0.7632.6";
const stateSchema = z.strictObject({
  ready: z.literal(true), fault: z.null(), proxyErrors: z.int().min(0).max(1000),
  phase: z.literal("active"),
});

function bootstrapCounts(urls: readonly string[], trusted: ReadonlySet<string>) {
  const counts = { trusted: 0, newTab: 0, internal: 0, extension: 0, http: 0, https: 0, other: 0 };
  for (const url of urls) {
    if (trusted.has(url)) counts.trusted++;
    else if (url === "chrome://newtab/" || url === "chrome://new-tab-page/") counts.newTab++;
    else if (url.startsWith("chrome:") || url.startsWith("chrome-untrusted:")) counts.internal++;
    else if (url.startsWith("chrome-extension:")) counts.extension++;
    else if (url.startsWith("https:")) counts.https++;
    else if (url.startsWith("http:")) counts.http++;
    else counts.other++;
  }
  return counts;
}

export class NativeBootstrapError extends Error {
  readonly bootstrap;
  constructor(context: BrowserContext, trustedPages: ReadonlySet<string>, trustedWorker: string) {
    super("native_untrusted_bootstrap");
    this.bootstrap = {
      pages: bootstrapCounts(context.pages().map((page) => page.url()), trustedPages),
      workers: bootstrapCounts(context.serviceWorkers().map((worker) => worker.url()), new Set([trustedWorker])),
    };
  }
}

export function assertTrustedBootstrap(context: BrowserContext, extensionOrigin: string): void {
  const allowed = new Set([
    "about:blank", `${extensionOrigin}/blank.html`, `${extensionOrigin}/wake-service-worker.html`,
    `${extensionOrigin}/offscreen/service-worker-heartbeat.html`,
  ]);
  if (context.pages().some((page) => !allowed.has(page.url()))
    || context.serviceWorkers().some((worker) => worker.url() !== `${extensionOrigin}/service-worker.js`)) {
    throw new NativeBootstrapError(context, allowed, `${extensionOrigin}/service-worker.js`);
  }
}

export function assertNativePolicyState(value: unknown): void {
  if (!stateSchema.safeParse(value).success) throw new Error("native_policy_state_rejected");
}

export async function verifyComposedExtension(
  control: NativeWorkerControl, files: ReadonlyMap<string, Buffer>,
): Promise<void> {
  await control.verifyFiles(files);
}

/** Must run after trusted SDK initialization, before interception or untrusted navigation. */
export async function establishNativePolicy(options: {
  context: BrowserContext;
  worker: Worker;
  files: ReadonlyMap<string, Buffer>;
  assertActive: () => void;
  onLost?: () => void;
}) {
  const { context, worker, files, assertActive } = options;
  const version = context.browser()?.version();
  if (version !== PROVED_CHROMIUM_VERSION) throw new Error("native_browser_version_unsupported");
  if (!/^chrome-extension:\/\/[a-p]{32}\/service-worker.js$/.test(worker.url())) {
    throw new Error("native_extension_identity_rejected");
  }
  const extensionOrigin = worker.url().slice(0, -"/service-worker.js".length);
  assertActive();
  assertTrustedBootstrap(context, extensionOrigin);
  const control = await connectNativeWorkerControl({ context, workerUrl: worker.url(), assertActive, onLost: options.onLost });
  try {
    await verifyComposedExtension(control, files);
    assertActive();
    assertTrustedBootstrap(context, extensionOrigin);
    await control.activate();
    assertActive();
    const verify = async () => {
      assertActive();
      assertNativePolicyState(await control.verify());
      assertActive();
    };
    await verify();
    await verifyNativeWebRtcPreferences(context);
    assertActive();
    await verifyNativeProxyRefusal(context, assertActive);
    await verify();
    assertTrustedBootstrap(context, extensionOrigin);
    return { extensionOrigin, version, verify, close: control.close };
  } catch (error) {
    await control.close();
    throw error;
  }
}
