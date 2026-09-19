import { lstatSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "../migrations";
import { WorkerRepository } from "../worker/repository";
import type { WorkerPolicy } from "../worker/config";

export const backupMarker = "deployment-backup.json";

export function assertPaidDataNotRestored(dataDir: string, paid: boolean): void {
  if (!paid) return;
  try {
    lstatSync(join(dataDir, backupMarker));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("deployment_restored_snapshot_paid_restart_forbidden");
}

export function validateDatabase(dataDir: string, full = false): void {
  const dir = lstatSync(dataDir);
  const file = join(dataDir, "flash-flood.sqlite");
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077)) throw new Error("deployment_data_permissions");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("deployment_database_permissions");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=1000");
    if (db.prepare("PRAGMA user_version").get()?.user_version !== migrations.length) throw new Error("deployment_schema_mismatch");
    if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") throw new Error("deployment_wal_required");
    if (full && (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length)) throw new Error("deployment_database_integrity");
    if (!db.prepare("SELECT singleton FROM worker_policy WHERE singleton=1").get()) throw new Error("deployment_policy_missing");
  } finally { db.close(); }
}

export function migrateDatabase(dataDir: string, policy: WorkerPolicy): void {
  // Uses the application's transactional migration and persisted-policy checks.
  const repository = new WorkerRepository(dataDir, policy);
  repository.close();
  validateDatabase(dataDir, true);
}
