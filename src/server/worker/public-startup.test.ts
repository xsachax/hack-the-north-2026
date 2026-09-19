import { describe, expect, it, vi } from "vitest";
import { workerExecutionModes } from "./config";
import { deploymentConfig } from "../deployment/config";

// Future-path coverage only; real CLI tests keep the source checkpoint disabled.
vi.mock("../public-execution-readiness", () => ({ PUBLIC_EXECUTION_IMPLEMENTATION_READY: true }));

describe("future public-only worker startup", () => {
  it("keeps public and controlled authorization separate", () => {
    expect(workerExecutionModes({ NODE_ENV: "test" })).toEqual({ controlled: false, public: false });
    expect(workerExecutionModes({ NODE_ENV: "test", ENABLE_PUBLIC_RUNS: "true" })).toEqual({ controlled: false, public: true });
    expect(workerExecutionModes({ NODE_ENV: "test", ENABLE_DEMO_RUNS: "true" })).toEqual({ controlled: true, public: false });
  });

  it("requires explicit paid confirmation for public-only deployment", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      APP_ORIGIN: "https://example.com", FLASH_FLOOD_ACCESS_CODE: "a".repeat(32), DATA_DIR: "/private/data",
      ENABLE_PUBLIC_RUNS: "true", ENABLE_DEMO_RUNS: "false",
      BROWSERBASE_API_KEY: "offline-unused", BROWSERBASE_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
    };
    expect(() => deploymentConfig(env)).toThrow("deployment_paid_confirmation_required");
    const result = deploymentConfig({ ...env, DEPLOYMENT_CONFIRM_PAID: "true" });
    expect(result.paid).toBe(true);
    expect(result.env.ENABLE_DEMO_RUNS).toBe("false");
  });
});
