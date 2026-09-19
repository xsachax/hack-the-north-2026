import { describe, expect, it } from "vitest";
import { readConfig } from "./config";

const env = { BROWSERBASE_API_KEY: "unit-test-placeholder" };

describe("server configuration", () => {
  it("uses conservative limits and does not need a second API key", () => {
    expect(readConfig(env)).toMatchObject({
      MAX_CONCURRENT_SESSIONS: 3,
      MAX_STEPS_PER_PERSONA: 12,
      SESSION_TIMEOUT_SECONDS: 120,
      STAGEHAND_MODEL: "google/gemini-2.5-flash",
    });
  });

  it("accepts an omitted or blank project ID", () => {
    expect(readConfig({ ...env, BROWSERBASE_PROJECT_ID: "" }).BROWSERBASE_PROJECT_ID).toBeUndefined();
  });

  it.each([
    ["MAX_CONCURRENT_SESSIONS", "0"],
    ["MAX_CONCURRENT_SESSIONS", "13"],
    ["MAX_CONCURRENT_SESSIONS", "1.5"],
    ["MAX_STEPS_PER_PERSONA", "31"],
    ["SESSION_TIMEOUT_SECONDS", "59"],
    ["SESSION_TIMEOUT_SECONDS", "301"],
    ["SESSION_TIMEOUT_SECONDS", ""],
    ["SESSION_TIMEOUT_SECONDS", "not-a-number"],
    ["BROWSERBASE_PROJECT_ID", "invalid"],
    ["STAGEHAND_MODEL", "unsupported-model"],
    ["DATA_DIR", ""],
  ])("rejects invalid %s=%s", (field, value) => {
    expect(() => readConfig({ ...env, [field]: value })).toThrow(field);
  });

  it("reports missing configuration without including secrets or input values", () => {
    expect(() => readConfig({})).toThrow("BROWSERBASE_API_KEY");
    expect(() => readConfig({ ...env, BROWSERBASE_PROJECT_ID: "private-value" })).not.toThrow("private-value");
  });
});
