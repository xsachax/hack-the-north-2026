import "server-only";
import nextEnv from "@next/env";
import { z } from "zod";
import { readConfig } from "../src/lib/config";
import { readWorkerPolicy } from "../src/server/worker/config";
import { WorkerRepository } from "../src/server/worker/repository";
import { DurableWorker, productionDependencies } from "../src/server/worker/runtime";

nextEnv.loadEnvConfig(process.cwd());

async function main() {
  const [confirmation, jobId, ...rest] = process.argv.slice(2);
  if (confirmation !== "--confirm-release" || rest.length) throw new Error("explicit_release_confirmation_required");
  z.uuid().parse(jobId);
  const config = readConfig(process.env);
  const repository = new WorkerRepository(config.DATA_DIR, readWorkerPolicy(process.env));
  try {
    const worker = new DurableWorker(repository, productionDependencies(config), 4321);
    const claim = repository.claimQuarantined(jobId, worker.id);
    await worker.executeClaim(claim, new AbortController().signal);
    const summaries = repository.attemptSummaries(claim.ownerId, claim.runId);
    const settled = summaries.find((summary) => summary.attemptId === claim.attempt.id)?.launchState === "settled";
    console.log(settled ? "orphan_release_confirmed" : "orphan_still_unconfirmed_reservation_retained");
    if (!settled) process.exitCode = 1;
  } finally { repository.close(); }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error && error.message === "public_recovery_checkpoint_disabled"
    ? "public_recovery_checkpoint_disabled_reservation_retained" : "worker_reconciliation_failed");
  process.exitCode = 1;
});
