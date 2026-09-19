import "server-only";
import nextEnv from "@next/env";
import { z } from "zod";
import { readConfig } from "../src/lib/config";
import { readWorkerPolicy } from "../src/server/worker/config";
import { WorkerRepository } from "../src/server/worker/repository";
import { DurableWorker, productionDependencies } from "../src/server/worker/runtime";

nextEnv.loadEnvConfig(process.cwd());

async function main() {
  if (process.argv.slice(2).join(" ") !== "--confirm-paid" ||
    (process.env.ENABLE_DEMO_RUNS !== "true" && process.env.ENABLE_PUBLIC_RUNS !== "true")) {
    throw new Error("worker_requires_explicit_paid_confirmation");
  }
  const policy = readWorkerPolicy(process.env);
  const config = { ...readConfig(process.env), SESSION_TIMEOUT_SECONDS: policy.sessionSeconds };
  const port = z.coerce.number().int().min(1).max(65535).parse(process.env.FIXTURE_PORT ?? 4321);
  const shutdownMs = z.coerce.number().int().min(10000).max(120000).parse(process.env.WORKER_SHUTDOWN_MS ?? 60000);
  if (process.env.ENABLE_DEMO_RUNS === "true") {
    const fixture = await fetch(`http://127.0.0.1:${port}/demo/category/home`, {
      signal: AbortSignal.timeout(5000), redirect: "error",
    });
    if (!fixture.ok) throw new Error("fixture_source_unavailable");
    await fixture.body?.cancel();
  }
  const repository = new WorkerRepository(config.DATA_DIR, policy);
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    controller.abort();
    deadline ??= setTimeout(() => {
      console.error("worker_shutdown_deadline_recovery_required");
      process.exit(1);
    }, shutdownMs);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    console.log("worker_ready");
    await new DurableWorker(repository, productionDependencies(config), port).run(controller.signal);
  } finally {
    clearTimeout(deadline);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    repository.close();
  }
}
main().catch(() => {
  console.error("worker_failed_check_private_configuration_and_database");
  process.exitCode = 1;
});
