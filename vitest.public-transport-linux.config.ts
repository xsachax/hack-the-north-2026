import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["react-server"] },
  ssr: { resolve: { conditions: ["react-server"], externalConditions: ["react-server"] } },
  test: {
    environment: "node",
    execArgv: ["--conditions=react-server"],
    include: ["tests/public-transport-linux/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 10_000,
    retry: 0,
  },
});
