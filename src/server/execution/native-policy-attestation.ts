import type { BrowserContext } from "playwright-core";
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
export async function verifyNativeWebRtcPreferences(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto("chrome://prefs-internals/", { waitUntil: "domcontentloaded", timeout: 5000 });
    const selected: unknown = await page.evaluate(() => {
      const property = (value: unknown, key: string): unknown =>
        value !== null && typeof value === "object" && Object.hasOwn(value, key)
          ? Reflect.get(value, key) : undefined;
      const root: unknown = JSON.parse(document.body.textContent ?? "");
      const webrtc = property(root, "webrtc");
      // Never return the complete profile: it may contain credentials or history.
      return {
        global: property(property(webrtc, "ip_handling_policy"), "value"),
        overrides: property(property(webrtc, "ip_handling_url"), "value"),
      };
    });
    assertNativeWebRtcPreferences(selected);
  } catch (error) {
    if (error instanceof NativePolicyAttestationError) throw error;
    throw new NativePolicyAttestationError("native_webrtc_preferences_unavailable");
  } finally {
    await page.close();
  }
}
