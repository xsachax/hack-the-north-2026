import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { personas } from "../../lib/personas";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../../lib/public-execution";
import { WorkerRepository } from "./repository";

let directory: string;
let guard: string;
beforeEach(() => {
  directory = join(process.cwd(), `.worker-cli-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  guard = join(directory, "offline.cjs");
  writeFileSync(guard, `
    const fs = require('node:fs'), path = require('node:path');
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (typeof file === 'string' && /^\\.env(?:\\.|$)/.test(path.basename(file))) {
        const error = new Error('offline_env_file_absent'); error.code = 'ENOENT'; throw error;
      }
      return read.call(this, file, ...args);
    };
    const deny = () => { throw Error('offline_network_forbidden'); };
    globalThis.fetch = deny;
    for (const module of ['node:http', 'node:https']) {
      require(module).request = deny; require(module).get = deny;
    }
    const net = require('node:net'), connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function(...args) {
      const options = Array.isArray(args[0]) ? args[0][0] : args[0];
      if (options && typeof options === 'object' && typeof options.path === 'string') {
        return connect.apply(this, args);
      }
      return deny();
    };
    require('node:tls').connect = deny;
    const dns = require('node:dns');
    dns.lookup = deny; dns.resolve = deny;
    dns.promises.lookup = deny; dns.promises.resolve = deny;
  `, { mode: 0o600 });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("maintained worker startup entrypoints (offline, no provider allocation)", () => {
  it.each(["worker", "worker:reconcile"] as const)("runs %s through configuration validation under react-server", (script) => {
    const result = spawnSync("npm", ["run", script, "--",
      ...(script === "worker" ? ["--confirm-paid"] : ["--confirm-release", randomUUID()])], {
      env: {
        PATH: process.env.PATH, NODE_ENV: "test", TSX_DISABLE_CACHE: "1", TMPDIR: directory,
        NODE_OPTIONS: `--require ${JSON.stringify(guard)}`,
        NPM_CONFIG_UPDATE_NOTIFIER: "false", DATA_DIR: directory, ENABLE_PUBLIC_RUNS: "true",
      },
      encoding: "utf8", timeout: 20000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(script === "worker"
      ? "worker_failed_check_private_configuration_and_database" : "worker_reconciliation_failed");
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/offline_network_forbidden|Client Component|server-only.*Error/);
    const files = readFileSync(join(process.cwd(), "scripts", script === "worker" ? "worker.ts" : "worker-reconcile.ts"), "utf8");
    expect(files).toContain('import "server-only"');
  });

  it("rejects deployment worker configuration before starting a worker or allocating providers", () => {
    const result = spawnSync(process.execPath, [
      "--conditions=react-server", "--require", guard, "--import", "tsx", "scripts/deployment-worker.ts", "--confirm-paid",
    ], {
      env: { PATH: process.env.PATH, NODE_ENV: "test", TSX_DISABLE_CACHE: "1", TMPDIR: directory,
        DATA_DIR: directory, ENABLE_PUBLIC_RUNS: "true" },
      encoding: "utf8", timeout: 20000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("worker_failed_check_private_configuration_and_database");
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/offline_network_forbidden|Client Component|worker_ready/);
  });

  it("refuses restored native reconciliation through the maintained command without provider I/O or false cleanup", () => {
    const repository = new WorkerRepository(directory);
    let runId: string;
    try {
      const owner = repository.createSession().ownerId;
      runId = repository.createRun(owner, randomUUID(), {
        authorizationAcknowledged: true, executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY,
        scope: { targetUrl: "https://example.com/docs", allowedSubdomains: [], pathPrefixes: ["/docs"] },
        assignments: [{ personaId: personas[0].id, goal: "Read documentation", criteria: ["Documentation is understandable"] }],
      }).run.id;
    } finally { repository.close(); }
    const database = new DatabaseSync(join(directory, "flash-flood.sqlite"));
    try {
      const jobId = String(database.prepare("SELECT id FROM jobs WHERE run_id=?").get(runId)!.id);
      const sessionId = randomUUID(), extensionId = randomUUID(), now = new Date().toISOString();
      const resource = JSON.stringify({ version: 1, archiveSha256: "a".repeat(64), state: "quarantined",
        extensionId, sessionAllocationAttempted: true, sessionId });
      database.prepare("INSERT INTO launches(job_id,correlation_token,state,recovery_count,created_at) VALUES(?,?,'quarantined',4,?)")
        .run(jobId, randomUUID(), now);
      database.prepare("UPDATE usage_reservations SET reserved_seconds=240 WHERE job_id=?").run(jobId);
      database.prepare("INSERT INTO native_resources(job_id,extension_id,resource,updated_at) VALUES(?,?,?,?)")
        .run(jobId, extensionId, resource, now);
      database.prepare("INSERT INTO native_resource_events(job_id,resource,created_at) VALUES(?,?,?)").run(jobId, resource, now);
      const before = database.prepare("SELECT state,recovery_count,recovery_after,usage FROM launches WHERE job_id=?").get(jobId);
      const result = spawnSync("npm", ["run", "worker:reconcile", "--", "--confirm-release", jobId], {
        env: {
          PATH: process.env.PATH, NODE_ENV: "test", TSX_DISABLE_CACHE: "1", TMPDIR: directory,
          NODE_OPTIONS: `--require ${JSON.stringify(guard)}`, NPM_CONFIG_UPDATE_NOTIFIER: "false",
          DATA_DIR: directory, ENABLE_PUBLIC_RUNS: "true", BROWSERBASE_API_KEY: "offline-unused",
          BROWSERBASE_PROJECT_ID: randomUUID(),
        },
        encoding: "utf8", timeout: 20000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("public_recovery_checkpoint_disabled_reservation_retained");
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/offline_network_forbidden|orphan_release_confirmed/);
      expect(`${result.stdout}${result.stderr}`).not.toContain(extensionId);
      expect(`${result.stdout}${result.stderr}`).not.toContain(sessionId);
      expect(database.prepare("SELECT state,recovery_count,recovery_after,usage FROM launches WHERE job_id=?").get(jobId)).toEqual(before);
      expect(database.prepare("SELECT resource FROM native_resources WHERE job_id=?").get(jobId)?.resource).toBe(resource);
      expect(database.prepare("SELECT count(*) AS n FROM native_resource_events WHERE job_id=?").get(jobId)?.n).toBe(1);
      expect(database.prepare("SELECT reserved_seconds,consumed_seconds,released_seconds FROM usage_reservations WHERE job_id=?").get(jobId))
        .toMatchObject({ reserved_seconds: 240, consumed_seconds: 0, released_seconds: 0 });
    } finally { database.close(); }
  });
});
