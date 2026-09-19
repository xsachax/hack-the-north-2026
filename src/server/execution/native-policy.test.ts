import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { controlled, installPolicy, proxyValue, readPolicy } from "./native-policy-extension/policy.js";
import { assertNativeWebRtcPreferences } from "./native-policy-attestation";

function setting(value: unknown, levelOfControl = "controllable_by_this_extension") {
  return {
    value, levelOfControl, writes: 0,
    async get() { return { value: this.value, levelOfControl: this.levelOfControl }; },
    async set(options: { value: unknown; scope: string }) {
      expect(options.scope).toBe("regular");
      this.value = options.value; this.levelOfControl = "controlled_by_this_extension"; this.writes++;
    },
  };
}

function api() {
  return {
    proxy: { settings: setting({ mode: "system" }) },
    privacy: { network: {
      webRTCIPHandlingPolicy: setting("default"),
      networkPredictionEnabled: setting(true),
    } },
  };
}

describe("native policy candidate (not public execution admission)", () => {
  it("requires the native global preference and an explicitly empty override list", () => {
    expect(() => assertNativeWebRtcPreferences({ global: "disable_non_proxied_udp", overrides: [] })).not.toThrow();
    for (const input of [
      undefined, {}, { global: "disable_non_proxied_udp" },
      { global: "default", overrides: [] },
      { global: "disable_non_proxied_udp", overrides: null },
      { global: "disable_non_proxied_udp", overrides: [{ url: "https://native-probe.invalid", handling: "default" }] },
      { global: "disable_non_proxied_udp", overrides: [], extra: true },
    ]) {
      expect(() => assertNativeWebRtcPreferences(input)).toThrow("native_webrtc_preferences_rejected");
    }
  });
  it("installs explicit protocol/fallback proxies, subtractive bypass and native privacy settings", async () => {
    const chrome = api();
    await installPolicy(chrome);
    expect(await readPolicy(chrome)).toBe(true);
    expect(chrome.proxy.settings.value).toEqual(proxyValue);
    expect(proxyValue.rules.bypassList).toEqual(["<-loopback>"]);
    expect(proxyValue.rules).not.toHaveProperty("singleProxy");
    expect(chrome.privacy.network.webRTCIPHandlingPolicy.value).toBe("disable_non_proxied_udp");
    expect(chrome.privacy.network.networkPredictionEnabled.value).toBe(false);
  });

  for (const level of ["not_controllable", "controlled_by_other_extensions", undefined]) {
    it(`rejects competing/unavailable control (${level}) even with the correct value`, async () => {
      const chrome = api();
      chrome.proxy.settings.levelOfControl = level ?? "";
      chrome.proxy.settings.value = proxyValue;
      await expect(installPolicy(chrome)).rejects.toThrow("native_policy_not_controllable");
      expect(chrome.proxy.settings.writes).toBe(0);
      expect(await readPolicy(chrome)).toBe(false);
    });
  }

  it("does not trust set success without actual readback", async () => {
    const chrome = api();
    chrome.proxy.settings.set = async () => {};
    await expect(installPolicy(chrome)).rejects.toThrow("native_policy_readback_failed");
  });

  it("propagates native API failures", async () => {
    const chrome = api();
    chrome.privacy.network.webRTCIPHandlingPolicy.set = async () => { throw new Error("api_failure"); };
    await expect(installPolicy(chrome)).rejects.toThrow("api_failure");
  });

  for (const value of [
    { ...proxyValue, pacScript: { data: "DIRECT" } },
    { mode: "direct" },
    { ...proxyValue, rules: { ...proxyValue.rules, bypassList: ["<local>"] } },
    { ...proxyValue, rules: { ...proxyValue.rules, fallbackProxy: { ...proxyValue.rules.fallbackProxy, scheme: "socks4" } } },
    { ...proxyValue, rules: { ...proxyValue.rules, fallbackProxy: undefined } },
  ]) {
    it(`rejects drift or lossy native normalization ${JSON.stringify(value)}`, () => {
      expect(controlled({ value, levelOfControl: "controlled_by_this_extension" }, proxyValue)).toBe(false);
    });
  }

  it("accepts object key reordering but not unknown fields", () => {
    const value = { rules: structuredClone(proxyValue.rules), mode: "fixed_servers" };
    expect(controlled({ value, levelOfControl: "controlled_by_this_extension" }, proxyValue)).toBe(true);
    expect(controlled({ value: { ...value, unknown: true }, levelOfControl: "controlled_by_this_extension" }, proxyValue)).toBe(false);
  });

  it("exposes no page entry point, host access, content scripts or resources", async () => {
    const manifest = JSON.parse(await readFile(new URL("./native-policy-extension/manifest.json", import.meta.url), "utf8"));
    expect(manifest).toEqual({
      manifest_version: 3, name: "Flash Flood native egress policy probe", version: "0.1.0",
      permissions: ["proxy", "privacy"], background: { service_worker: "background.js", type: "module" },
    });
    const source = await readFile(new URL("./native-policy-extension/background.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/onMessage|onConnect|externally_connectable|fetch\(/);
  });
});
