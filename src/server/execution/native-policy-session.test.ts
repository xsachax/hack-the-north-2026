import type { BrowserContext, Worker } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertNativePolicyState, assertTrustedBootstrap, establishNativePolicy, NativeBootstrapError, PROVED_CHROMIUM_VERSION,
} from "./native-policy-session";
import type { NativeWorkerControl } from "./native-worker-control";

const attest = vi.hoisted(() => ({ preferences: vi.fn(), proxy: vi.fn(), connect: vi.fn() }));
vi.mock("./native-policy-attestation", () => ({ verifyNativeWebRtcPreferences: attest.preferences }));
vi.mock("./native-proxy-attestation", () => ({ verifyNativeProxyRefusal: attest.proxy }));
vi.mock("./native-worker-control", () => ({ connectNativeWorkerControl: attest.connect }));
const origin = `chrome-extension://${"a".repeat(32)}`;
const active = { phase: "active", ready: true, fault: null, proxyErrors: 0 };

function harness(options: { version?: string; workerUrl?: string; pages?: readonly string[]; bytes?: boolean } = {}) {
  const order: string[] = [];
  let pages = options.pages ?? ["about:blank"];
  const url = options.workerUrl ?? `${origin}/service-worker.js`;
  const evaluate = vi.fn(() => { throw new Error("playwright_worker_evaluation_forbidden"); });
  const control = {
    startupWaiting: false,
    snapshot: vi.fn(async () => ({ ...active })),
    verifyFiles: vi.fn<NativeWorkerControl["verifyFiles"]>(async () => {
      order.push("bytes");
      if (options.bytes === false) throw new Error("native_extension_bytes_rejected");
    }),
    activate: vi.fn(async () => { order.push("activate"); }),
    verify: vi.fn(async () => { order.push("verify"); return { ...active }; }),
    close: vi.fn(async () => { order.push("close"); }),
  } satisfies NativeWorkerControl;
  attest.connect.mockImplementation(async () => { order.push("connect"); return control; });
  const worker = { url: () => url, evaluate } as unknown as Worker;
  const context = {
    browser: () => ({ version: () => options.version ?? PROVED_CHROMIUM_VERSION }),
    pages: () => pages.map((page) => ({ url: () => page })),
    serviceWorkers: () => [worker],
  } as unknown as BrowserContext;
  attest.preferences.mockImplementation(async () => { order.push("preferences"); });
  attest.proxy.mockImplementation(async () => { order.push("proxy"); });
  return {
    context, worker, order, evaluate, control,
    files: new Map([["service-worker.js", Buffer.from("owned")]]),
    assertActive: vi.fn(),
    setPages(value: string[]) { pages = value; },
  };
}

beforeEach(() => { vi.resetAllMocks(); });

describe("composed bootstrap trust boundary", () => {
  it("reports only fixed bootstrap categories without granting new trust or exposing URLs", () => {
    const fake = harness({ pages: [
      "about:blank", "chrome://newtab/", "chrome://settings/",
      `${origin}/unexpected.html?credential=private-value`, "https://private-value.example/path?token=private-value",
      "http://private-value.example/", "data:text/html,private-value",
    ], workerUrl: `chrome-extension://${"b".repeat(32)}/private-value.js` });
    let failure: NativeBootstrapError | undefined;
    try { assertTrustedBootstrap(fake.context, origin); }
    catch (error) {
      expect(error).toBeInstanceOf(NativeBootstrapError);
      if (error instanceof NativeBootstrapError) failure = error;
    }
    expect(failure?.bootstrap).toEqual({
      pages: { trusted: 1, newTab: 1, internal: 1, extension: 1, http: 1, https: 1, other: 1 },
      workers: { trusted: 0, newTab: 0, internal: 0, extension: 1, http: 0, https: 0, other: 0 },
    });
    expect(JSON.stringify(failure)).not.toMatch(/private-value|chrome:|https:|credential|token/);
    expect(() => assertTrustedBootstrap(fake.context, origin)).toThrow("native_untrusted_bootstrap");
  });
  it("accepts only blank and the exact composed extension bootstrap documents", () => {
    const fake = harness({ pages: [
      "about:blank", `${origin}/blank.html`, `${origin}/wake-service-worker.html`,
      `${origin}/offscreen/service-worker-heartbeat.html`,
    ] });
    expect(() => assertTrustedBootstrap(fake.context, origin)).not.toThrow();
  });

  it.each([
    "about:blank#fragment", "data:text/html,untrusted", "https://example.com/",
    `${origin}/blank.html?extra=1`, `${origin}/unexpected.html`,
    `chrome-extension://${"b".repeat(32)}/blank.html`,
  ])("rejects untrusted bootstrap page %s", (url) => {
    const fake = harness({ pages: [url] });
    expect(() => assertTrustedBootstrap(fake.context, origin)).toThrow("native_untrusted_bootstrap");
  });

  it.each([
    "https://example.com/service-worker.js", `${origin}/other-worker.js`,
    `chrome-extension://${"b".repeat(32)}/service-worker.js`,
  ])("rejects another worker %s", (workerUrl) => {
    const fake = harness({ workerUrl });
    expect(() => assertTrustedBootstrap(fake.context, origin)).toThrow("native_untrusted_bootstrap");
  });

  it.each([
    undefined, null, {}, { ...active, ready: false }, { ...active, phase: "bootstrap" },
    { ...active, phase: "fault" }, { ...active, fault: "native_policy_changed" },
    { ...active, proxyErrors: -1 }, { ...active, proxyErrors: 1001 },
    { ...active, proxyErrors: 0.5 }, { ...active, unknown: true },
  ])("rejects unknown, stale or malformed policy state %#", (value) => {
    expect(() => assertNativePolicyState(value)).toThrow("native_policy_state_rejected");
  });

  it.each([0, 1, 1000])("allows a bounded count of fatal proxy failures: %s", (proxyErrors) => {
    expect(() => assertNativePolicyState({ ...active, proxyErrors })).not.toThrow();
  });
});

describe("composed native handshake sequencing", () => {
  it("attests bytes before activation, effective preferences and TCP refusal before returning", async () => {
    const fake = harness();
    const native = await establishNativePolicy(fake);
    expect(fake.order).toEqual(["connect", "bytes", "activate", "verify", "preferences", "proxy", "verify"]);
    expect(attest.connect).toHaveBeenCalledWith({
      context: fake.context, workerUrl: `${origin}/service-worker.js`, assertActive: fake.assertActive, onLost: undefined,
    });
    expect(fake.control.verifyFiles).toHaveBeenCalledWith(fake.files);
    expect(fake.evaluate).not.toHaveBeenCalled();
    expect(native).toMatchObject({ extensionOrigin: origin, version: PROVED_CHROMIUM_VERSION });
    await native.verify();
    expect(fake.order.at(-1)).toBe("verify");
    await native.close();
    expect(fake.control.close).toHaveBeenCalledOnce();
  });

  it.each([
    [{ version: "unknown" }, "native_browser_version_unsupported"],
    [{ workerUrl: "https://example.com/service-worker.js" }, "native_extension_identity_rejected"],
    [{ workerUrl: `chrome-extension://${"a".repeat(31)}/service-worker.js` }, "native_extension_identity_rejected"],
    [{ pages: ["data:text/html,untrusted"] }, "native_untrusted_bootstrap"],
    [{ bytes: false }, "native_extension_bytes_rejected"],
  ] as const)("rejects before activation %#", async (options, error) => {
    const fake = harness(options);
    await expect(establishNativePolicy(fake)).rejects.toThrow(error);
    expect(fake.order).not.toContain("activate");
    expect(attest.preferences).not.toHaveBeenCalled();
    expect(attest.proxy).not.toHaveBeenCalled();
    if ("bytes" in options) expect(fake.control.close).toHaveBeenCalledOnce();
    else expect(attest.connect).not.toHaveBeenCalled();
  });

  it("rechecks bootstrap trust after async byte verification", async () => {
    const fake = harness();
    fake.control.verifyFiles.mockImplementationOnce(async () => {
      fake.setPages(["data:text/html,untrusted"]);
    });
    await expect(establishNativePolicy(fake)).rejects.toThrow("native_untrusted_bootstrap");
    expect(fake.control.verifyFiles).toHaveBeenCalledOnce();
    expect(fake.control.activate).not.toHaveBeenCalled();
    expect(fake.control.close).toHaveBeenCalledOnce();
  });

  it("rechecks bootstrap trust after trace attestation", async () => {
    const fake = harness();
    attest.proxy.mockImplementationOnce(async () => { fake.setPages(["data:text/html,untrusted"]); });
    await expect(establishNativePolicy(fake)).rejects.toThrow("native_untrusted_bootstrap");
    expect(fake.control.close).toHaveBeenCalledOnce();
  });

  it("does not start tracing after effective preference rejection", async () => {
    const fake = harness();
    attest.preferences.mockRejectedValueOnce(new Error("native_webrtc_preferences_rejected"));
    await expect(establishNativePolicy(fake)).rejects.toThrow("native_webrtc_preferences_rejected");
    expect(attest.proxy).not.toHaveBeenCalled();
    expect(fake.control.close).toHaveBeenCalledOnce();
  });

  it("never returns a native handle after TCP attestation rejection", async () => {
    const fake = harness();
    attest.proxy.mockRejectedValueOnce(new Error("native_proxy_endpoint_unconfirmed"));
    await expect(establishNativePolicy(fake)).rejects.toThrow("native_proxy_endpoint_unconfirmed");
    expect(fake.control.close).toHaveBeenCalledOnce();
  });

  it("checks the original worker on every verification and rejects stale handles", async () => {
    const fake = harness();
    const native = await establishNativePolicy(fake);
    fake.control.verify.mockRejectedValueOnce(new Error("native_worker_lost"));
    await expect(native.verify()).rejects.toThrow("native_worker_lost");
    expect(fake.evaluate).not.toHaveBeenCalled();
  });

  it("checks the session lifetime before any browser operation", async () => {
    const fake = harness();
    fake.assertActive.mockImplementation(() => { throw new Error("session_closed"); });
    await expect(establishNativePolicy(fake)).rejects.toThrow("session_closed");
    expect(fake.evaluate).not.toHaveBeenCalled();
    expect(attest.connect).not.toHaveBeenCalled();
  });

  it("passes through worker-loss notification without creating another control", async () => {
    const fake = harness();
    const onLost = vi.fn();
    await establishNativePolicy({ ...fake, onLost });
    expect(attest.connect).toHaveBeenCalledExactlyOnceWith({
      context: fake.context, workerUrl: `${origin}/service-worker.js`, assertActive: fake.assertActive, onLost,
    });
  });

  it("does not activate or attest after original-worker attachment failure", async () => {
    const fake = harness();
    attest.connect.mockRejectedValueOnce(new Error("native_worker_context_missing"));
    await expect(establishNativePolicy(fake)).rejects.toThrow("native_worker_context_missing");
    expect(fake.control.activate).not.toHaveBeenCalled();
    expect(attest.preferences).not.toHaveBeenCalled();
    expect(attest.proxy).not.toHaveBeenCalled();
  });
});
