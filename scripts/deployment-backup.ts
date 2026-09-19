import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupMarker, validateDatabase } from "../src/server/deployment/database";

process.umask(0o077);
try {
  if (process.argv[2] !== "--confirm-stopped" || process.argv.length !== 4) throw new Error("deployment_quiescence_required");
  const source = resolve(process.env.DATA_DIR ?? "/data/private");
  const destination = resolve(process.argv[3]);
  const nested = relative(source, destination);
  if (source === destination || (!nested.startsWith("..") && !isAbsolute(nested)) || existsSync(destination)) {
    throw new Error("deployment_new_external_backup_directory_required");
  }
  validateDatabase(source, true);
  const db = new DatabaseSync(join(source, "flash-flood.sqlite"));
  let snapshotReservedSeconds: number;
  try {
    db.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL");
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint?.busy !== 0) throw new Error("deployment_database_not_quiescent");
    snapshotReservedSeconds = Number(db.prepare("SELECT coalesce(sum(reserved_seconds),0) total FROM usage_reservations").get()?.total);
  } finally { db.close(); }
  const checkTree = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("deployment_unsafe_backup_entry");
    if (stat.isDirectory()) for (const entry of readdirSync(path)) checkTree(join(path, entry));
  };
  checkTree(source);
  mkdirSync(destination, { mode: 0o700 });
  cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
  chmodSync(destination, 0o700);
  writeFileSync(join(destination, backupMarker), JSON.stringify({
    version: 1, createdAt: Date.now(), snapshotReservedSeconds,
    paidRestartAllowed: false, postSnapshotHistoryPreserved: false,
  }), { mode: 0o600 });
  validateDatabase(destination, true);
  console.log("deployment_local_backup_valid");
} catch {
  console.error("deployment_backup_failed_keep_services_stopped");
  process.exitCode = 1;
}
