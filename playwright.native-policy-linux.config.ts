import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/native-policy-linux",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  globalTimeout: 150_000,
  expect: { timeout: 5000 },
  reporter: "list",
  outputDir: "test-results/native-policy-linux",
  use: { browserName: "chromium", channel: "chromium", headless: true, trace: "off" },
});
