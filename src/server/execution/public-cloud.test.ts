import { beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../../lib/config";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../../lib/public-execution";
import { createPublicExecution, type PublicExecutionOptions } from "./public-cloud";
import { CloudStartupError } from "./cloud";
import { ModelBudget } from "./budget";
import { personas } from "../../lib/personas";
import type { PublicNetworkOptions } from "./public-network";


const mocks = vi.hoisted(() => {
  const order: string[] = [];
  const page = { goto: vi.fn(async () => { order.push("navigate"); }), url: () => "https://example.com/" };
  const native = {
    page, context: {}, sdk: { selectPage: vi.fn(async () => {}), extract: vi.fn() },
    extensionOrigin: `chrome-extension://${"a".repeat(32)}`,
    usage: { allocationAttempted: true, reservedSeconds: 120, elapsedSeconds: 0 },
    signal: new AbortController().signal,
    assertActive: vi.fn(),
    verifyActive: vi.fn(async () => { order.push("verify"); }),
    close: vi.fn(async () => ({ status: "closed" as const, errors: [] })),
    attachBrain: vi.fn(), attachNetwork: vi.fn(),
    publishLiveReference: vi.fn(async () => { order.push("live"); }),
  };
  return {
    order, native, createNative: vi.fn(async () => native), validateScope: vi.fn(async () => {}),
    network: { errors: new Array<string>(), close: vi.fn(async () => {}) },
    install: vi.fn(), driverOptions: vi.fn(),
    observe: vi.fn(async () => ({ id: "observation", url: "https://example.com/", title: "Example", text: "Documentation", candidates: [], signals: [], checks: [] })),
    act: vi.fn(async () => {}),
    decide: vi.fn(async () => ({ action: "give_up" as const, candidateId: null, value: null, commentary: "" })),
    evaluate: vi.fn(async () => []), brainOptions: vi.fn(), gatewayDispatch: vi.fn(),
  };
});
vi.mock("./native-browser", () => ({ createNativeBrowser: mocks.createNative }));
vi.mock("./public-network", () => ({ installPublicNetwork: mocks.install }));
vi.mock("../target-policy", async (original) => ({
  ...await original<typeof import("../target-policy")>(), validateTargetScope: mocks.validateScope,
}));
vi.mock("./driver", () => ({
  ScopedBrowserDriver: class {
    constructor(options: unknown) { mocks.driverOptions(options); }
    observe = mocks.observe;
    act = mocks.act;
    close = mocks.native.close;
    policySignal() {}
  },
}));
vi.mock("./gateway", () => ({
  GatewayBrain: class {
    constructor(_stagehand: unknown, _page: unknown, options: unknown) { mocks.brainOptions(options); }
    decide = mocks.decide;
    evaluate = mocks.evaluate;
    authorizeGatewayRequest = mocks.gatewayDispatch;
    async quiesce() {}
    async drain() {}
  },
}));

const baseConfig = configSchema.parse({
  BROWSERBASE_API_KEY: "offline-native-unit", BROWSERBASE_PROJECT_ID: "00000000-0000-4000-8000-000000000001",
});
const config = { ...baseConfig, ENABLE_PUBLIC_RUNS: true };
function options(): PublicExecutionOptions {
  const artifact = { key: "a".repeat(64), sha256: "a".repeat(64), bytes: 0, kind: "json" as const };
  return {
    mode: "public-readonly", executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY,
    runId: "00000000-0000-4000-8000-000000000002", personaId: "careful",
    correlationToken: "00000000-0000-4000-8000-000000000003",
    targetUrl: "https://example.com/", scope: { targetUrl: "https://example.com/", pathPrefixes: ["/"], allowedSubdomains: [] },
    criteria: ["The page explains whether it is suitable for documentation examples."],
    viewport: { width: 1280, height: 900 }, signal: new AbortController().signal,
    assertActive() {}, onResource() {}, onSession: async () => {},
    artifacts: {
      screenshot: async () => ({ ...artifact, kind: "screenshot" as const }),
      json: async () => artifact, telemetry: async () => artifact,
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.network.errors.length = 0;
  mocks.createNative.mockResolvedValue(mocks.native);
  mocks.validateScope.mockResolvedValue(undefined);
  mocks.native.page.goto.mockImplementation(async () => { mocks.order.push("navigate"); });
  mocks.native.verifyActive.mockImplementation(async () => { mocks.order.push("verify"); });
  mocks.install.mockImplementation(async () => { mocks.order.push("network"); return mocks.network; });
});

describe("real public factory composition, mocked provider boundary only", () => {
  it("requires the operator gate before DNS, native upload or browser allocation", async () => {
    await expect(createPublicExecution({ ...config, ENABLE_PUBLIC_RUNS: false }, options())).rejects.toMatchObject({
      phase: "public_admission", usage: { allocationAttempted: false }, code: "unsupported",
    });
    expect(mocks.validateScope).not.toHaveBeenCalled();
    expect(mocks.createNative).not.toHaveBeenCalled();
  });
  it("rejects invalid scope, native policy versions, fixture/context substitution and legacy oracles before allocation", async () => {
    for (const change of [
      { targetUrl: "https://other.example/" }, { executionPolicy: "website" }, { assetPolicy: "implicit" },
      { fixtures: {} }, { fixturePort: 4317 }, { contextReference: {} },
      { criteria: ["Both advertised coupons apply and the mug total is CA$21.60."] },
    ]) {
      const value = Object.assign(options(), change);
      await expect(createPublicExecution(config, value)).rejects.toMatchObject({ phase: "public_admission", usage: { allocationAttempted: false } });
    }
    expect(mocks.createNative).not.toHaveBeenCalled();
  });
  it("does not install interception, navigate or publish a viewer when native startup fails", async () => {
    mocks.createNative.mockRejectedValue(new CloudStartupError({ status: "closed", errors: [] }, {
      allocationAttempted: true, reservedSeconds: 120, elapsedSeconds: 1,
    }, "native_attestation"));
    await expect(createPublicExecution(config, options())).rejects.toMatchObject({ phase: "native_attestation" });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.native.page.goto).not.toHaveBeenCalled();
    expect(mocks.native.publishLiveReference).not.toHaveBeenCalled();
  });
  it("installs the actual policy/network boundary before target navigation and the live reference", async () => {
    const input = options();
    const result = await createPublicExecution(config, input);
    expect(mocks.createNative).toHaveBeenCalledExactlyOnceWith(config, input);
    expect(mocks.order.indexOf("network")).toBeLessThan(mocks.order.indexOf("navigate"));
    expect(mocks.order.indexOf("navigate")).toBeLessThan(mocks.order.indexOf("live"));
    expect(mocks.native.attachNetwork).toHaveBeenCalledExactlyOnceWith(mocks.network.close);
    expect(mocks.driverOptions).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true, networkFailureCode: "public_transport_failed" }));
    expect(mocks.driverOptions.mock.calls[0][0]).not.toHaveProperty("verify");
    expect(mocks.brainOptions).toHaveBeenCalledExactlyOnceWith({ readOnly: true, wireBudget: true });
    expect(result.usage).toBe(mocks.native.usage);
    await result.driver.close();
  });
  it("requires an attached active Gateway operation and counts only authorized dispatch attempts", async () => {
    let networkOptions: PublicNetworkOptions | undefined;
    mocks.install.mockImplementation(async (value: PublicNetworkOptions) => {
      networkOptions = value;
      expect(() => value.onGatewayDispatch!()).toThrow("gateway_operation_unavailable");
      return mocks.network;
    });
    const result = await createPublicExecution(config, options());
    mocks.gatewayDispatch.mockImplementationOnce(() => { throw new Error("budget-denied"); });
    expect(() => networkOptions!.onGatewayDispatch!()).toThrow("budget-denied");
    expect(result.usage.gatewayDispatches).toBe(0);
    networkOptions!.onGatewayDispatch!();
    expect(result.usage.gatewayDispatches).toBe(1);
  });
  it("closes a native browser on failed target navigation without labeling a target bug", async () => {
    mocks.native.page.goto.mockRejectedValue(new Error("upstream private details"));
    await expect(createPublicExecution(config, options())).rejects.toMatchObject({ phase: "public_navigation" });
    expect(mocks.native.close).toHaveBeenCalledOnce();
    expect(mocks.native.publishLiveReference).not.toHaveBeenCalled();
  });
  it("fences driver and inference operations on both sides without adding hidden model calls", async () => {
    const result = await createPublicExecution(config, options());
    mocks.native.verifyActive.mockClear();
    const signal = new AbortController().signal;
    const observation = await result.driver.observe(signal);
    expect(mocks.native.verifyActive).toHaveBeenCalledTimes(2);
    const budget = new ModelBudget(2, signal);
    const input = { persona: personas[0], goal: "Read the purpose", criteria: ["Documentation purpose"], observation, history: [] };
    await result.brain.decide(input, signal, budget);
    expect(mocks.decide).toHaveBeenCalledExactlyOnceWith(input, signal, budget);
    expect(mocks.native.verifyActive).toHaveBeenCalledTimes(4);
    mocks.native.verifyActive.mockRejectedValueOnce(new Error("native_policy_lost"));
    await expect(result.brain.decide(input, signal, budget)).rejects.toThrow("native_policy_lost");
    expect(mocks.decide).toHaveBeenCalledTimes(1);
    await result.driver.close();
  });
});
