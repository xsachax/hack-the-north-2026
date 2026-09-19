import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // SQLite and artifact suites exercise real fsync; isolate their disk load.
    fileParallelism: false,
    clearMocks: true,
  },
});
