import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/native-policy",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 5000 },
  reporter: "list",
  use: { browserName: "chromium", channel: "chromium", headless: true, trace: "off" },
});
