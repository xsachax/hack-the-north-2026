import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { configSchema } from "../../lib/config";
import { PUBLIC_EXECUTION_IMPLEMENTATION_READY } from "../public-execution-readiness";
import type { NativeResource } from "../execution/native-resources";
import { createCloudRecovery } from "./cloud-recovery";

const provider = vi.hoisted(() => ({
  sessions: { list: vi.fn(), retrieve: vi.fn(), update: vi.fn(), create: vi.fn() },
  extensions: { delete: vi.fn(), retrieve: vi.fn(), create: vi.fn() },
}));
vi.mock("@browserbasehq/sdk", () => ({
  default: class { sessions = provider.sessions; extensions = provider.extensions; },
}));
beforeEach(() => vi.clearAllMocks());

it.each([false, true])("blocks direct native recovery with actual readiness=false, known resource=%s", async (known) => {
  expect(PUBLIC_EXECUTION_IMPLEMENTATION_READY).toBe(false);
  const resource: NativeResource = { version: 1, archiveSha256: "a".repeat(64), state: "quarantined",
    extensionId: randomUUID(), sessionId: randomUUID(), sessionAllocationAttempted: true };
  const onResource = vi.fn(() => undefined);
  await expect(createCloudRecovery(configSchema.parse({
    BROWSERBASE_API_KEY: "offline-unused", BROWSERBASE_PROJECT_ID: randomUUID(), ENABLE_PUBLIC_RUNS: "true",
  })).recover({
    correlationToken: randomUUID(), sessionId: resource.sessionId,
    native: { ...(known ? { resource } : {}), assertActive: vi.fn(), onResource },
  })).rejects.toThrow("public_recovery_checkpoint_disabled");
  for (const operation of [...Object.values(provider.sessions), ...Object.values(provider.extensions)]) {
    expect(operation).not.toHaveBeenCalled();
  }
  expect(onResource).not.toHaveBeenCalled();
});
