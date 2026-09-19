import type { BrowserContext, Page } from "playwright-core";
import { z } from "zod";

const webRtcPreferences = z.strictObject({
  global: z.literal("disable_non_proxied_udp"),
  overrides: z.array(z.unknown()).max(0),
});

export class NativePolicyAttestationError extends Error {
  constructor(readonly code: "native_webrtc_preferences_rejected" | "native_webrtc_preferences_unavailable") {
    super(code);
  }
}

export function assertNativeWebRtcPreferences(value: unknown): void {
  if (!webRtcPreferences.safeParse(value).success) {
    throw new NativePolicyAttestationError("native_webrtc_preferences_rejected");
  }
}

/** Offline candidate only: call before any untrusted document or live-view grant. */
export async function verifyNativeWebRtcPreferences(context: Pick<BrowserContext, "newPage">): Promise<void> {
  let page: Page | undefined;
  try {
    page = await context.newPage();
    await page.goto("chrome://prefs-internals/", { waitUntil: "domcontentloaded", timeout: 5000 });
    const selected: unknown = await page.evaluate(() => {
      const access = {
        property(value: unknown, key: string): unknown {
          return value !== null && typeof value === "object" && Object.hasOwn(value, key)
            ? Reflect.get(value, key) : undefined;
        },
      };
      const root: unknown = JSON.parse(document.body.textContent ?? "");
      const webrtc = access.property(root, "webrtc");
      const global = access.property(access.property(webrtc, "ip_handling_policy"), "value");
      const overrides = access.property(access.property(webrtc, "ip_handling_url"), "value");
      // Return only validated constants, never profile data or override URLs.
      return {
        global: global === "disable_non_proxied_udp" ? global : null,
        overrides: Array.isArray(overrides) && overrides.length === 0 ? [] : null,
      };
    });
    assertNativeWebRtcPreferences(selected);
  } catch (error) {
    if (error instanceof NativePolicyAttestationError) throw error;
    throw new NativePolicyAttestationError("native_webrtc_preferences_unavailable");
  } finally {
    try { await page?.close(); }
    catch { throw new NativePolicyAttestationError("native_webrtc_preferences_unavailable"); }
  }
}
