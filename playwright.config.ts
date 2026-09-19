import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 5000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4317",
    browserName: "chromium",
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run start -- --port 4317",
    url: "http://127.0.0.1:4317/api/health",
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      BROWSERBASE_API_KEY: "", BROWSERBASE_PROJECT_ID: "",
      FLASH_FLOOD_ACCESS_CODE: "", APP_ORIGIN: "https://offline-demo.invalid",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
