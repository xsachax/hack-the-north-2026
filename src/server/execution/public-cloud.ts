import type { AppConfig } from "../../lib/config";
import { assignmentSchema } from "../../lib/contracts";
import { isLegacyCriterion, type Criterion } from "../../lib/criteria";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../../lib/public-execution";
import type { TargetScope } from "../../lib/target-scope";
import { validateTargetScope } from "../target-policy";
import { PUBLIC_EXECUTION_IMPLEMENTATION_READY } from "../public-execution-readiness";
import type { ArtifactSinks } from "./artifacts";
import { CloudStartupError, type CloudUsage } from "./cloud";
import { ScopedBrowserDriver } from "./driver";
import { GatewayBrain } from "./gateway";
import { createNativeBrowser, type NativeBrowserOptions } from "./native-browser";
import { publicExecutionPolicy } from "./public-policy";
import { installPublicNetwork } from "./public-network";
import type { Brain, BrowserDriver } from "./types";

export type PublicExecutionOptions = NativeBrowserOptions & {
  mode: "public-readonly";
  executionPolicy: typeof PUBLIC_EXECUTION_POLICY;
  assetPolicy: typeof PUBLIC_ASSET_POLICY;
  targetUrl: string;
  scope: TargetScope;
  criteria: readonly Criterion[];
  artifacts: ArtifactSinks;
  cleanupJson?: ArtifactSinks["json"];
  keyboardOnly?: boolean;
};

export async function createPublicExecution(config: AppConfig, options: PublicExecutionOptions) {
  const preallocation: CloudUsage = {
    allocationAttempted: false, reservedSeconds: Math.min(config.SESSION_TIMEOUT_SECONDS, 300), elapsedSeconds: 0,
  };
  let policy: ReturnType<typeof publicExecutionPolicy>;
  try {
    if (!PUBLIC_EXECUTION_IMPLEMENTATION_READY || !config.ENABLE_PUBLIC_RUNS
      || options.mode !== "public-readonly" || options.targetUrl !== options.scope.targetUrl
      || ["fixtures", "fixturePort", "controlledSiteId", "contextReference"].some((field) => field in options)) {
      throw new Error("public_execution_unsupported");
    }
    const criteria = assignmentSchema.shape.criteria.parse(options.criteria);
    if (criteria.some(isLegacyCriterion)) throw new Error("public_legacy_criteria_unsupported");
    options.signal.throwIfAborted();
    options.assertActive();
    policy = publicExecutionPolicy(options);
    await validateTargetScope(options.scope);
    options.signal.throwIfAborted();
    options.assertActive();
  } catch {
    throw new CloudStartupError({ status: "closed", errors: [] }, preallocation, "public_admission", "unsupported");
  }
  const native = await createNativeBrowser(config, options);
  native.usage.gatewayDispatches = 0;
  const networkDiagnostics: string[] = [];
  native.usage.networkDiagnostics = networkDiagnostics;
  let phase = "public_network";
  try {
    const driverHolder: { current?: ScopedBrowserDriver } = {};
    const gatewayHolder: { current?: GatewayBrain } = {};
    const network = await installPublicNetwork({
      context: native.context, page: native.page, extensionOrigin: native.extensionOrigin,
      authorize: policy.authorize, assertActive: native.assertActive, verifyActive: native.verifyActive,
      signal: native.signal, onSignal: (event) => driverHolder.current?.policySignal(event.url, event.code),
      onFatal: () => { void native.close(); },
      diagnostics: networkDiagnostics,
      onGatewayDispatch: () => {
        if (!gatewayHolder.current) throw new Error("gateway_operation_unavailable");
        gatewayHolder.current.authorizeGatewayRequest();
        native.usage.gatewayDispatches = (native.usage.gatewayDispatches ?? 0) + 1;
      },
    });
    try { native.attachNetwork(network.close); }
    catch (error) { await network.close(); throw error; }
    native.usage.networkDiagnostics = network.errors;
    await native.verifyActive();
    phase = "public_navigation";
    await native.page.goto(options.targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await native.verifyActive();
    if (network.errors.length) throw new Error("public_network_unsupported");
    phase = "public_stagehand_page";
    await native.sdk.selectPage(native.page.url());
    await native.verifyActive();
    const driver = new ScopedBrowserDriver({
      page: native.page, artifacts: options.artifacts, cleanupJson: options.cleanupJson,
      scope: policy.navigation, close: native.close, readOnly: true, keyboardOnly: options.keyboardOnly,
      networkErrors: network.errors, networkFailureCode: "public_transport_failed",
      assertActive: native.assertActive,
      onCleanupError: (code) => {
        native.usage.cleanupErrors ??= [];
        native.usage.cleanupErrors.push(code);
      },
    });
    driverHolder.current = driver;
    const actualDriver = driver;
    const verifiedDriver: BrowserDriver = {
      async observe(signal) {
        await native.verifyActive();
        const observation = await actualDriver.observe(signal);
        await native.verifyActive();
        return observation;
      },
      async act(action, signal) {
        await native.verifyActive();
        await actualDriver.act(action, signal);
        await native.verifyActive();
      },
      close: () => actualDriver.close(),
    };
    const rawBrain = new GatewayBrain(native.sdk.extract, undefined, { readOnly: true, wireBudget: true });
    gatewayHolder.current = rawBrain;
    native.attachBrain(rawBrain);
    const brain: Brain = {
      managesModelBudget: true,
      async decide(input, signal, budget) {
        await native.verifyActive();
        const decision = await rawBrain.decide(input, signal, budget);
        await native.verifyActive();
        return decision;
      },
      async evaluate(input, signal, budget) {
        await native.verifyActive();
        const checks = await rawBrain.evaluate(input, signal, budget);
        await native.verifyActive();
        return checks;
      },
      quiesce: () => rawBrain.quiesce(), drain: () => rawBrain.drain(),
    };
    phase = "public_live_reference";
    await native.publishLiveReference();
    native.assertActive();
    return { driver: verifiedDriver, brain, usage: native.usage, executionDeadlineMs: native.executionDeadlineMs, signal: native.signal };
  } catch {
    throw new CloudStartupError(await native.close(), native.usage, phase);
  }
}
