import { deploymentConfig } from "../src/server/deployment/config";
import { migrateDatabase } from "../src/server/deployment/database";

process.umask(0o077);
try {
  const config = deploymentConfig(process.env);
  migrateDatabase(config.env.DATA_DIR!, config.policy);
  console.log("deployment_migrations_valid");
} catch {
  console.error("deployment_migrations_failed_check_private_configuration");
  process.exitCode = 1;
}
