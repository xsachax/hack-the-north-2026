import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { buildComposedExtension, pinnedStagehandArchivePath, readPinnedStagehandArchive, sha256, STAGEHAND_ARCHIVE_SHA256 } from "./composed-extension";
import { controlled, installPolicy, readPolicy, settings } from "./native-policy-extension/policy.js";
import { assertNativePolicyState } from "./native-policy-session";

describe("audited deterministic composed extension", () => {
  it("retains vendor bytes, root worker identity and MIT license with only a bounded overlay", async () => {
    const original = await readFile(pinnedStagehandArchivePath());
    expect(sha256(original)).toBe(STAGEHAND_ARCHIVE_SHA256);
    const vendor = readPinnedStagehandArchive(original);
    const first = await buildComposedExtension();
    const second = await buildComposedExtension();
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first.sha256).toBe(second.sha256);
    expect(first.bytes.length).toBeLessThan(4 * 1024 * 1024);
    for (const [name, bytes] of vendor) {
      if (name === "manifest.json") continue;
      if (name === "service-worker.js") {
        expect(first.files.get(name)!.equals(Buffer.concat([bytes, Buffer.from('\nimport "./flash-flood/composed.js";\n')]))).toBe(true);
      } else expect(first.files.get(name)!.equals(bytes)).toBe(true);
    }
    const manifest = JSON.parse(first.files.get("manifest.json")!.toString());
    expect(manifest.permissions).toEqual(["debugger", "offscreen", "scripting", "tabs", "proxy", "privacy"]);
    expect(manifest.background).toEqual({ service_worker: "service-worker.js", type: "module" });
    expect(manifest).not.toHaveProperty("externally_connectable");
    expect(manifest).not.toHaveProperty("web_accessible_resources");
    expect(first.files.get("LICENSE.stagehand")!.toString()).toContain("Copyright (c) 2024 Browserbase Inc.");
    expect(first.provenance.stagehandVersion).toBe("4.1.0");
  });

  it("rejects any unreviewed archive bytes before decompression, including path, symlink and resource mutations", async () => {
    const original = await readFile(pinnedStagehandArchivePath());
    for (const offset of [0, 6, 18, 30, original.length - 22, original.length - 100]) {
      const tampered = Buffer.from(original);
      tampered[offset] ^= 1;
      expect(() => readPinnedStagehandArchive(tampered)).toThrow("stagehand_archive_identity_rejected");
    }
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(4 * 1024 * 1024 + 1), original.subarray(0, 50)]) {
      expect(() => readPinnedStagehandArchive(bytes)).toThrow("stagehand_archive_identity_rejected");
    }
  });

  it("defers native activation until privileged bootstrap and permanently latches drift", async () => {
    const listeners = new Set<(details: unknown) => void>();
    const setting = () => ({
      value: undefined as unknown, levelOfControl: "controllable_by_this_extension",
      onChange: { addListener: (callback: (details: unknown) => void) => listeners.add(callback) },
      async get() { return { value: this.value, levelOfControl: this.levelOfControl }; },
      async set({ value }: { value: unknown }) { this.value = value; this.levelOfControl = "controlled_by_this_extension"; },
    });
    const chrome = {
      proxy: { settings: setting(), onProxyError: { addListener() {} } },
      privacy: { network: { webRTCIPHandlingPolicy: setting(), networkPredictionEnabled: setting() } },
    };
    const source = (await readFile(new URL("./native-policy-extension/composed.js", import.meta.url), "utf8"))
      .replace(/^import .* from "\.\/policy\.js";$/m, "");
    type Control = { snapshot(): unknown; activate(): Promise<void>; verify(): Promise<unknown> };
    const sandbox = { chrome, controlled, installPolicy, readPolicy, settings, flashFloodNativePolicy: undefined as Control | undefined };
    runInNewContext(source, sandbox);
    const control = sandbox.flashFloodNativePolicy!;
    expect(control.snapshot()).toMatchObject({ ready: false, phase: "bootstrap" });
    expect(chrome.proxy.settings.value).toBeUndefined();
    await control.activate();
    assertNativePolicyState(await control.verify());
    await expect(control.activate()).rejects.toThrow("native_policy_activation_rejected");
    listeners.forEach((listener) => listener({ value: { mode: "direct" }, levelOfControl: "controlled_by_other_extensions" }));
    expect(control.snapshot()).toMatchObject({ ready: false, phase: "fault", fault: "native_policy_changed" });
    await expect(control.verify()).rejects.toThrow("native_policy_readback_failed");
    await expect(control.activate()).rejects.toThrow("native_policy_activation_rejected");
    expect(source).not.toMatch(/onMessage|onConnect|fetch\(|\.clear\(/);
  });

  it.each([null, {}, { ready: true, fault: null, proxyErrors: 0 },
    { ready: true, fault: null, proxyErrors: 0, phase: "active", extra: true },
    { ready: true, fault: "native_policy_changed", proxyErrors: 0, phase: "active" },
  ])("rejects incomplete or unknown attestation state %j", (state) => {
    expect(() => assertNativePolicyState(state)).toThrow("native_policy_state_rejected");
  });
});
