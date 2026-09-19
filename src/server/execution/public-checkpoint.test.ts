import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../../lib/config";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../../lib/public-execution";
import { PUBLIC_EXECUTION_IMPLEMENTATION_READY } from "../public-execution-readiness";
import { createNativeBrowser } from "./native-browser";
import { createPublicExecution, type PublicExecutionOptions } from "./public-cloud";

const forbidden = vi.hoisted(() => ({
  provider: vi.fn(() => { throw new Error("provider_forbidden"); }),
  archive: vi.fn(() => { throw new Error("archive_forbidden"); }),
  dns: vi.fn(() => { throw new Error("dns_forbidden"); }),
  network: vi.fn(() => { throw new Error("network_forbidden"); }),
}));
vi.mock("server-only", () => ({}));
vi.mock("@browserbasehq/sdk", () => ({
  default: class { constructor() { forbidden.provider(); } },
  toFile: forbidden.provider,
}));
vi.mock("@browserbasehq/stagehand", () => ({
  browserbase: { connect: forbidden.provider },
  Stagehand: { create: forbidden.provider },
}));
vi.mock("./composed-extension", () => ({
  COMPOSED_POLICY_VERSION: "native-public-v1", buildComposedExtension: forbidden.archive,
}));
vi.mock("../target-policy", async (original) => ({
  ...await original<typeof import("../target-policy")>(), validateTargetScope: forbidden.dns,
}));
vi.mock("./public-network", () => ({ installPublicNetwork: forbidden.network }));

function options(): PublicExecutionOptions {
  const artifact = { key: "a".repeat(64), sha256: "a".repeat(64), bytes: 0 };
  return {
    mode: "public-readonly", executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY,
    runId: "e7680f23-76b4-491e-afb3-4b33e8befce2", personaId: "careful-first-timer",
    correlationToken: "d36a6bd6-a364-4440-b7e3-0c9e5c34f8b9",
    targetUrl: "https://example.com/", scope: {
      targetUrl: "https://example.com/", pathPrefixes: ["/"], allowedSubdomains: [],
    },
    criteria: ["Read the page heading."], viewport: { width: 1280, height: 900 },
    signal: new AbortController().signal, assertActive: vi.fn(), onResource: vi.fn(), onSession: vi.fn(),
    artifacts: {
      screenshot: async () => ({ ...artifact, kind: "screenshot" }),
      json: async () => ({ ...artifact, kind: "json" }),
      telemetry: async () => ({ ...artifact, kind: "json" }),
    },
  };
}
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("actual offline checkpoint hard stop, no readiness mock", () => {
  it.each([true, false])("blocks both direct factories with ENABLE_PUBLIC_RUNS=%s", async (enabled) => {
    vi.stubEnv("ENABLE_PUBLIC_RUNS", "true");
    vi.stubEnv("PUBLIC_EXECUTION_IMPLEMENTATION_READY", "true");
    const config = { ...configSchema.parse({
      BROWSERBASE_API_KEY: "owned-offline-key",
      BROWSERBASE_PROJECT_ID: "f504cf13-49b7-4193-86ac-61c9bde4bada",
    }), ENABLE_PUBLIC_RUNS: enabled };
    const input = options();
    expect(PUBLIC_EXECUTION_IMPLEMENTATION_READY).toBe(false);
    for (const create of [createPublicExecution, createNativeBrowser]) {
      await expect(create(config, input)).rejects.toMatchObject({
        code: "unsupported", usage: { allocationAttempted: false, elapsedSeconds: 0 },
        cleanup: { status: "closed", errors: [] },
      });
    }
    for (const operation of Object.values(forbidden)) expect(operation).not.toHaveBeenCalled();
    expect(input.onResource).not.toHaveBeenCalled();
    expect(input.onSession).not.toHaveBeenCalled();
  });
});
