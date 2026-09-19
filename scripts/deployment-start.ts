import { assertReleaseBuild } from "../src/server/deployment/build";
import { deploymentConfig } from "../src/server/deployment/config";
import { migrateDatabase } from "../src/server/deployment/database";
import { supervise } from "../src/server/deployment/supervisor";

process.umask(0o077);
try {
  if (Number(process.versions.node.split(".")[0]) !== 22 || process.getuid?.() === 0) throw new Error("deployment_runtime_invalid");
  const config = deploymentConfig(process.env);
  await assertReleaseBuild();
  migrateDatabase(config.env.DATA_DIR!, config.policy);
  process.exitCode = await supervise(config.env, config.paid, config.shutdownMs);
} catch {
  console.error("deployment_failed_check_private_configuration_build_and_database");
  process.exitCode = 1;
}
