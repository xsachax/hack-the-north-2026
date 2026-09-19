import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { configSchema } from "../../lib/config";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../../lib/public-execution";
import { personas } from "../../lib/personas";
import { productionDependencies } from "./runtime";
import { CloudStartupError } from "../execution/cloud";

vi.mock("server-only", () => ({}));
afterEach(() => vi.unstubAllGlobals());

it("production launchPublic reaches the genuine public factory and refuses aborted allocation offline", async () => {
  const outbound = vi.fn(() => { throw new Error("offline_network_forbidden"); });
  vi.stubGlobal("fetch", outbound);
  const dependencies = productionDependencies(configSchema.parse({
    BROWSERBASE_API_KEY: "offline-never-used", BROWSERBASE_PROJECT_ID: randomUUID(), ENABLE_PUBLIC_RUNS: "true",
  }));
  const journal = vi.fn(() => undefined);
  const onSession = vi.fn(async () => {});
  const assertActive = vi.fn(() => { throw new DOMException("offline_stop", "AbortError"); });
  const result = dependencies.launchPublic!({
    mode: "public-readonly", executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY,
    runId: randomUUID(), personaId: personas[0].id, correlationToken: randomUUID(),
    viewport: { width: 1280, height: 900 }, signal: AbortSignal.abort(), assertActive, onSession, onResource: journal,
    targetUrl: "https://example.com/docs",
    scope: { targetUrl: "https://example.com/docs", allowedSubdomains: [], pathPrefixes: ["/docs"] },
    criteria: [{ id: "heading", kind: "visible_text", description: "Read documentation heading",
      semantics: "current", match: "exact", text: "Documentation" }],
    artifacts: { screenshot: vi.fn(), json: vi.fn(), telemetry: vi.fn() },
  });
  await expect(result).rejects.toBeInstanceOf(CloudStartupError);
  await expect(result).rejects.toMatchObject({ usage: { allocationAttempted: false }, cleanup: { status: "closed" } });
  expect(journal).not.toHaveBeenCalled();
  expect(onSession).not.toHaveBeenCalled();
  expect(outbound).not.toHaveBeenCalled();
});
