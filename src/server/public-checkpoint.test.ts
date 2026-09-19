import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunSchema } from "../lib/contracts";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../lib/public-execution";
import { capabilitiesSchema } from "../lib/ui-contracts";
import { createApi, publicExecutionCapability } from "./api";
import { PUBLIC_EXECUTION_IMPLEMENTATION_READY } from "./public-execution-readiness";
import { Repository } from "./repository";

const origin = "http://127.0.0.1:3000";
const input = createRunSchema.parse({
  authorizationAcknowledged: true,
  executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY,
  scope: { targetUrl: "https://example.com/help", allowedSubdomains: [], pathPrefixes: ["/help"] },
  assignments: [{ personaId: "careful-first-timer", goal: "Read help", criteria: ["Delivery costs are explained"] }],
});

describe("real unmocked offline checkpoint admission", () => {
  let directory: string;
  let repository: Repository;
  beforeEach(() => {
    directory = resolve(`.public-checkpoint-${randomUUID()}`);
    repository = new Repository(directory);
    vi.stubEnv("ENABLE_PUBLIC_RUNS", "true");
  });
  afterEach(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it.each([60, 80, 81, 240, 300])("cannot be enabled by env or injected readiness at TTL %s", async (publicSessionTimeoutSeconds) => {
    expect(PUBLIC_EXECUTION_IMPLEMENTATION_READY).toBe(false);
    const configuration = {
      origin, production: false, accessCode: "offline-test-access-code".repeat(2),
      allowPublicRuns: process.env.ENABLE_PUBLIC_RUNS === "true",
      publicExecutionReady: true, publicSessionTimeoutSeconds,
    };
    expect(publicExecutionCapability(configuration)).toEqual({
      publicExecutionEnabled: false, publicExecutionReason: "offline_checkpoint",
    });
    const validateScope = vi.fn(async (scope: typeof input.scope) => scope);
    const handle = createApi({ repository, configuration, validateScope });
    const owner = repository.createSession();
    const capabilities = await handle(new Request(`${origin}/api/v1/capabilities`));
    expect(capabilities.status).toBe(200);
    expect(capabilitiesSchema.parse((await capabilities.json()).data)).toMatchObject({
      publicExecutionEnabled: false, publicExecutionReason: "offline_checkpoint", websiteExecutionEnabled: false,
    });
    const key = randomUUID();
    for (let retry = 0; retry < 2; retry++) {
      const response = await handle(new Request(`${origin}/api/v1/runs`, {
        method: "POST",
        headers: { origin, cookie: `ff_owner=${owner.token}`, "x-csrf-token": owner.csrf,
          "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(input),
      }));
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe("public_execution_checkpoint_disabled");
    }
    expect(validateScope).not.toHaveBeenCalled();
    expect(repository.listRuns(owner.ownerId, { after: 0, limit: 100 }).items).toEqual([]);
    const db = new DatabaseSync(resolve(directory, "flash-flood.sqlite"));
    try {
      for (const table of ["runs", "attempts", "jobs", "launches", "usage_reservations"]) {
        expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
      }
    } finally { db.close(); }
  });
});
