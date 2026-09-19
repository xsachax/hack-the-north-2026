import { describe, expect, it } from "vitest";
import { createRunSchema, runSchema } from "./contracts";
import { readConfig } from "./config";
import { readPendingLaunch } from "./launch-request";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "./public-execution";

const ownerId = "11111111-1111-4111-8111-111111111111";
const legacy = {
  authorizationAcknowledged: true,
  scope: { targetUrl: "https://example.com/help", allowedSubdomains: [], pathPrefixes: ["/help"] },
  assignments: [{ personaId: "careful-first-timer", goal: "Read help", criteria: [
    { id: "help", kind: "semantic", semantics: "current", description: "The help page explains delivery costs" },
  ] }],
};
const policies = { executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY };

describe("canonical public policy contracts", () => {
  it("preserves both explicit policies in pending retries without upgrading legacy saved requests", () => {
    for (const body of [legacy, { ...legacy, ...policies }]) {
      const pending = { ownerId, key: ownerId, path: "/runs", body };
      expect(readPendingLaunch(JSON.stringify(pending), ownerId).body).toEqual(createRunSchema.parse(body));
    }
    expect(readPendingLaunch(JSON.stringify({ ownerId, key: ownerId, path: "/runs", body: legacy }), ownerId).body)
      .not.toHaveProperty("executionPolicy");
  });

  it("rejects noncanonical mode/policy combinations in stored and transport snapshots", () => {
    const run = { id: ownerId, cursor: 1, status: "queued", authorizationAcknowledged: true,
      scope: legacy.scope, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z", cancelRequestedAt: null };
    expect(runSchema.parse({ ...run, executionMode: "public-readonly", ...policies }).executionMode).toBe("public-readonly");
    for (const fields of [
      { executionMode: "public-readonly" },
      { executionMode: "website", ...policies },
      { executionMode: "controlled-fixture", ...policies },
      { executionMode: "public-readonly", ...policies, controlledSiteId: "store" },
      { executionMode: "public-readonly", ...policies, assetPolicy: "latest" },
    ]) expect(runSchema.safeParse({ ...run, ...fields }).success).toBe(false);
  });

  it("requires an exact operator flag and defaults off", () => {
    const env = { BROWSERBASE_API_KEY: "offline-placeholder" };
    expect(readConfig(env).ENABLE_PUBLIC_RUNS).toBe(false);
    expect(readConfig({ ...env, ENABLE_PUBLIC_RUNS: "false" }).ENABLE_PUBLIC_RUNS).toBe(false);
    expect(readConfig({ ...env, ENABLE_PUBLIC_RUNS: "true" }).ENABLE_PUBLIC_RUNS).toBe(true);
    for (const value of ["1", "yes", "TRUE", ""]) expect(() => readConfig({ ...env, ENABLE_PUBLIC_RUNS: value })).toThrow("ENABLE_PUBLIC_RUNS");
  });
});
