import type { BrowserContext, Worker } from "playwright-core";
import { z } from "zod";
import { sha256 } from "./composed-extension";
import { verifyNativeWebRtcPreferences } from "./native-policy-attestation";
import { verifyNativeProxyRefusal } from "./native-proxy-attestation";

export const PROVED_CHROMIUM_VERSION = "145.0.7632.6";
const stateSchema = z.strictObject({
  ready: z.literal(true), fault: z.null(), proxyErrors: z.int().min(0).max(1000),
  phase: z.literal("active"),
});
type NativeControl = typeof globalThis & {
  flashFloodNativePolicy: {
    activate(): Promise<void>;
    verify(): Promise<unknown>;
    snapshot(): unknown;
  };
};

export function assertTrustedBootstrap(context: BrowserContext, extensionOrigin: string): void {
  const allowed = new Set([
    "about:blank", `${extensionOrigin}/blank.html`, `${extensionOrigin}/wake-service-worker.html`,
    `${extensionOrigin}/offscreen/service-worker-heartbeat.html`,
  ]);
  if (context.pages().some((page) => !allowed.has(page.url()))
    || context.serviceWorkers().some((worker) => worker.url() !== `${extensionOrigin}/service-worker.js`)) {
    throw new Error("native_untrusted_bootstrap");
  }
}

export function assertNativePolicyState(value: unknown): void {
  if (!stateSchema.safeParse(value).success) throw new Error("native_policy_state_rejected");
}

export async function verifyComposedExtension(
  worker: Worker, files: ReadonlyMap<string, Buffer>,
): Promise<void> {
  const expected = [...files].map(([name, bytes]) => ({ name, digest: sha256(bytes) }));
  const matched = await worker.evaluate(async (entries) => {
    for (const { name, digest } of entries) {
      const response = await fetch(new URL(name, self.location.href));
      if (!response.ok) return false;
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 4 * 1024 * 1024) return false;
      const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (actual !== digest) return false;
    }
    return true;
  }, expected);
  if (matched !== true) throw new Error("native_extension_bytes_rejected");
}

/** Must run after trusted SDK initialization, before interception or untrusted navigation. */
export async function establishNativePolicy(options: {
  context: BrowserContext;
  worker: Worker;
  files: ReadonlyMap<string, Buffer>;
  assertActive: () => void;
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
  await verifyComposedExtension(worker, files);
  assertActive();
  assertTrustedBootstrap(context, extensionOrigin);
  await worker.evaluate(() => (globalThis as NativeControl).flashFloodNativePolicy.activate());
  assertActive();
  const verify = async () => {
    assertActive();
    assertNativePolicyState(await worker.evaluate(() => (globalThis as NativeControl).flashFloodNativePolicy.verify()));
    assertActive();
  };
  await verify();
  await verifyNativeWebRtcPreferences(context);
  assertActive();
  await verifyNativeProxyRefusal(context, assertActive);
  await verify();
  assertTrustedBootstrap(context, extensionOrigin);
  return { extensionOrigin, version, verify };
}
