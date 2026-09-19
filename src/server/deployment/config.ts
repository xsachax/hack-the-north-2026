import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { readConfig } from "../../lib/config";
import { readWorkerPolicy, workerExecutionModes } from "../worker/config";

export function deploymentBindHost(input: string | undefined): "127.0.0.1" | "0.0.0.0" {
  const host = input ?? "0.0.0.0";
  if (host !== "127.0.0.1" && host !== "0.0.0.0") throw new Error("deployment_bind_host_invalid");
  return host;
}

export function deploymentConfig(input: NodeJS.ProcessEnv) {
  const env = { ...input };
  for (const name of ["FLASH_FLOOD_ACCESS_CODE", "BROWSERBASE_API_KEY"]) {
    if (env[`${name}_FILE`]) {
      if (env[name]) throw new Error("deployment_ambiguous_secret");
      env[name] = readFileSync(env[`${name}_FILE`]!, "utf8").trim();
    }
  }
  const origin = new URL(env.APP_ORIGIN ?? "");
  if (origin.protocol !== "https:" || origin.origin !== env.APP_ORIGIN || origin.username || origin.password) {
    throw new Error("deployment_https_origin_required");
  }
  if ((env.FLASH_FLOOD_ACCESS_CODE?.trim().length ?? 0) < 32) throw new Error("deployment_access_code_required");
  if (!env.DATA_DIR || !isAbsolute(env.DATA_DIR) || env.DATA_DIR === "/") throw new Error("deployment_private_data_required");
  for (const name of ["ENABLE_DEMO_RUNS", "ENABLE_PUBLIC_RUNS", "DEPLOYMENT_CONFIRM_PAID"]) {
    if (!["true", "false"].includes(env[name] ?? "false")) throw new Error("deployment_invalid_paid_flag");
  }
  const modes = workerExecutionModes(env);
  const paid = modes.controlled || modes.public;
  if (paid !== (env.DEPLOYMENT_CONFIRM_PAID === "true")) throw new Error("deployment_paid_confirmation_required");
  if (paid) {
    readConfig(env);
    if (!env.BROWSERBASE_PROJECT_ID) throw new Error("deployment_explicit_project_required");
  }
  if (env.FIXTURE_PORT && env.FIXTURE_PORT !== "4321") throw new Error("deployment_fixture_port_fixed");
  env.DEPLOYMENT_BIND_HOST = deploymentBindHost(env.DEPLOYMENT_BIND_HOST);
  const shutdownMs = Number(env.WORKER_SHUTDOWN_MS ?? 60000);
  if (!Number.isInteger(shutdownMs) || shutdownMs < 10000 || shutdownMs > 60000) throw new Error("deployment_shutdown_budget_invalid");
  env.NODE_ENV = "production";
  env.FIXTURE_PORT = "4321";
  env.WORKER_SHUTDOWN_MS = String(shutdownMs);
  env.NEXT_TELEMETRY_DISABLED = "1";
  env.SESSION_TIMEOUT_SECONDS ??= "120";
  env.MAX_STEPS_PER_PERSONA ??= "12";
  env.EXTERNAL_BASELINE_SECONDS ??= "1092";
  env.LIFETIME_RESERVATION_LIMIT_SECONDS ??= "3600";
  return { env, paid, shutdownMs, policy: readWorkerPolicy(env) };
}
