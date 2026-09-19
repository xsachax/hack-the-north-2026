import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { controlled, installPolicy, proxyValue, readPolicy, settings } from "./native-policy-extension/policy.js";
import { assertNativeWebRtcPreferences, verifyNativeWebRtcPreferences } from "./native-policy-attestation";
import { assertWorkerChannelProof } from "../../../tests/native-policy/channel-proof";

function setting(value: unknown, levelOfControl = "controllable_by_this_extension") {
  const changed = new Set<(details: unknown) => void>();
  return {
    value, levelOfControl, writes: 0,
    onChange: { addListener: (listener: (details: unknown) => void) => changed.add(listener) },
    emit: (details: unknown) => changed.forEach((listener) => listener(details)),
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
  it.each(["classic", "module", "shared", "service"] as const)("requires actual positive packets and API availability in the %s realm", (realm) => {
    expect(() => assertWorkerChannelProof(realm, "available", 3, false)).not.toThrow();
    expect(() => assertWorkerChannelProof(realm, "available", 0, true)).not.toThrow();
    for (const protectedLane of [false, true]) {
      expect(() => assertWorkerChannelProof(realm, "unavailable", 0, protectedLane)).toThrow(`native_worker_channel_unsupported:${realm}`);
      expect(() => assertWorkerChannelProof(realm, "unavailable", 3, protectedLane)).toThrow(`native_worker_channel_unsupported:${realm}`);
      expect(() => assertWorkerChannelProof(realm, "available", NaN, protectedLane)).toThrow("native_worker_channel_invalid_evidence");
    }
    expect(() => assertWorkerChannelProof(realm, "available", 0, false)).toThrow("native_worker_channel_positive_control_missing");
    expect(() => assertWorkerChannelProof(realm, "available", 3, true)).toThrow("native_worker_channel_destination_reached");
  });

  it("fails closed with a fixed code when a privileged page cannot be created", async () => {
    await expect(verifyNativeWebRtcPreferences({
      newPage: async () => { throw new Error("sensitive upstream detail"); },
    })).rejects.toThrow("native_webrtc_preferences_unavailable");
  });

  it("latches policy drift and direct-fallback faults while bounding diagnostics", async () => {
    const source = (await readFile(new URL("./native-policy-extension/background.js", import.meta.url), "utf8"))
      .replace(/^import .* from "\.\/policy\.js";$/m, "");
    for (const fault of ["native_policy_changed", "native_proxy_direct_fallback"]) {
      const chrome = api();
      const listeners = new Set<(details: { fatal: boolean }) => void>();
      const sandbox = {
        chrome: { ...chrome, proxy: { ...chrome.proxy, onProxyError: {
          addListener: (listener: (details: { fatal: boolean }) => void) => listeners.add(listener),
        } } },
        controlled, installPolicy, readPolicy, settings,
        flashFloodNativePolicy: undefined as undefined | { ready: boolean; fault: string | null; proxyErrors: number },
      };
      runInNewContext(source, sandbox);
      await vi.waitFor(() => expect(sandbox.flashFloodNativePolicy).toMatchObject({ ready: true, fault: null }));
      for (let count = 0; count < 1005; count++) listeners.forEach((listener) => listener({ fatal: true }));
      expect(sandbox.flashFloodNativePolicy).toEqual({ ready: true, fault: null, proxyErrors: 1000 });
      if (fault === "native_policy_changed") {
        chrome.proxy.settings.emit({ value: { mode: "direct" }, levelOfControl: "controlled_by_other_extensions" });
      } else listeners.forEach((listener) => listener({ fatal: false }));
      expect(sandbox.flashFloodNativePolicy).toEqual({ ready: false, fault, proxyErrors: 1000 });
      chrome.proxy.settings.emit({ value: proxyValue, levelOfControl: "controlled_by_this_extension" });
      expect(sandbox.flashFloodNativePolicy?.ready).toBe(false);
      expect(sandbox.flashFloodNativePolicy?.fault).toBe(fault);
    }
  });

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
    { ...proxyValue, rules: { ...proxyValue.rules, bypassList: { 0: "<-loopback>" } } },
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
