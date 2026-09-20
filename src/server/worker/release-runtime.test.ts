import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { releaseRuntimeEnvironment, stopReleaseProcess } from "../../../scripts/release-runtime";
import { releasePolicy } from "../../../scripts/release-proof";

afterEach(() => vi.unstubAllEnvs());

it("bounds the packaged runtime and never inherits unrelated credentials or debug settings", () => {
  vi.stubEnv("DEBUG", "true");
  vi.stubEnv("UNRELATED_CLOUD_SECRET", "must-not-be-inherited");
  const env = releaseRuntimeEnvironment({
    dataDir: "/private/release-data", accessCode: "synthetic".repeat(8), paid: true,
    provider: { apiKey: "synthetic-provider-key", projectId: "synthetic-project", replayOrigins: "https://media.example" },
  });
  expect(env.DEBUG).toBe("false");
  expect(env.UNRELATED_CLOUD_SECRET).toBeUndefined();
  expect(env.DEPLOYMENT_BIND_HOST).toBe("127.0.0.1");
  expect(env.APP_ORIGIN).toBe("https://127.0.0.1:4330");
  expect(env.MAX_CONCURRENT_SESSIONS).toBe("3");
  expect(env.SESSION_TIMEOUT_SECONDS).toBe("300");
  expect(env.LIFETIME_RESERVATION_LIMIT_SECONDS).toBe(String(releasePolicy.lifetimeReservationLimitSeconds));
  expect(env.EXTERNAL_BASELINE_SECONDS).toBe("1092");
  expect(env.ENABLE_DEMO_RUNS).toBe("true");
  expect(env.ENABLE_MANAGED_AGENTS).toBe("false");
  expect(env.DEPLOYMENT_CONFIRM_PAID).toBe("true");
});

it("offline runtime disables both admission and paid confirmation", () => {
  const env = releaseRuntimeEnvironment({
    dataDir: "/private/release-data", accessCode: "synthetic".repeat(8), paid: false,
    provider: { apiKey: "", projectId: "", replayOrigins: "" },
  });
  expect(env.ENABLE_DEMO_RUNS).toBe("false");
  expect(env.DEPLOYMENT_CONFIRM_PAID).toBe("false");
  expect(env.BROWSERBASE_API_KEY).toBe("");
  expect(env.ENABLE_MANAGED_AGENTS).toBe("false");
});

it("managed package enables only its separate explicit mode without leaking inherited environment", () => {
  const env = releaseRuntimeEnvironment({
    dataDir: "/private/release-data", accessCode: "synthetic".repeat(8), paid: true,
    provider: { apiKey: "offline-key", projectId: "offline-project", replayOrigins: "" },
  }, releasePolicy, false, { agentId: "owned-agent", allowedOrigins: ["https://www.iana.org"] });
  expect(env.ENABLE_DEMO_RUNS).toBe("false");
  expect(env.ENABLE_PUBLIC_RUNS).toBe("false");
  expect(env.ENABLE_MANAGED_AGENTS).toBe("true");
  expect(env.BROWSERBASE_MANAGED_AGENT_ID).toBe("owned-agent");
  expect(env.MANAGED_AGENT_ALLOWED_ORIGINS).toBe("https://www.iana.org");
});

it("awaits a real owned process's graceful signal cleanup and rejects abnormal exits", async () => {
  const child = spawn(process.execPath, ["-e",
    "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),30));console.log('ready');setInterval(()=>{},1000)"],
  { stdio: ["ignore", "pipe", "ignore"] });
  await once(child.stdout!, "data");
  const started = Date.now();
  await stopReleaseProcess(child);
  expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  expect(child.exitCode).toBe(0);
  const failed = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
  await once(failed, "exit");
  await expect(stopReleaseProcess(failed)).rejects.toThrow("release_packaged_process_failed");
});
