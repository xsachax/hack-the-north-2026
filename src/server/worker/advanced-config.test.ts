import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("loads paid/resume configuration inside the actual tsx harness module without provider calls", () => {
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import Browserbase from "@browserbasehq/sdk";
    import { loadAdvancedConfig } from "./scripts/advanced-integration.ts";
    Browserbase.prototype.request = function () { throw new Error("provider_request_forbidden"); };
    const config = loadAdvancedConfig();
    if (config.BROWSERBASE_API_KEY !== "offline-only-placeholder" ||
        config.BROWSERBASE_PROJECT_ID !== "00000000-0000-4000-8000-000000000001")
      throw new Error("unexpected_configuration");
    console.log("configuration-loaded-without-provider-calls");
  `], {
    cwd: process.cwd(),
    env: {
      ...process.env, NODE_ENV: "test", DEBUG: "false",
      BROWSERBASE_API_KEY: "offline-only-placeholder",
      BROWSERBASE_PROJECT_ID: "00000000-0000-4000-8000-000000000001",
    },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000,
  });
  expect(output.trim()).toBe("configuration-loaded-without-provider-calls");
});
