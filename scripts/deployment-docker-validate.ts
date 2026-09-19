import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isolatedValidationCompose, offlineReadinessPassed } from "../src/server/deployment/docker-validation";

// This offline gate owns only its random Compose project, images and local files.
// In particular it never repairs/restarts the daemon or prunes shared resources.
const id = `ff-validation-${randomUUID().slice(0, 12)}`;
const root = process.cwd();
const directory = resolve("data/deployment-validation", id);
const envSentinel = resolve(`.env.${id}`);
const image = `flash-flood:${id}`;
const auditImage = `flash-flood-context:${id}`;
const restoreName = `${id}-restore`;
const sentinel = `PRIVATE_BUILD_SENTINEL_${randomBytes(24).toString("hex")}`;
const environment = { ...process.env, RELEASE_TAG: id };
const composeFile = resolve(directory, "compose.yaml");
const composeArgs = ["compose", "--project-name", id, "--file", composeFile];
let provisioned = false;
let restoreCreated = false;
let success = false;
const builtImages: string[] = [];
const transientContainers = new Set<string>();

function docker(args: string[], timeout = 120000): string {
  return execFileSync("docker", args, {
    cwd: root, env: environment, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function compose(args: string[], timeout = 120000) {
  return docker([...composeArgs, ...args], timeout);
}
function transientRun(name: string, args: string[], timeout = 120000) {
  transientContainers.add(name);
  const output = docker(["run", "--name", name, ...args], timeout);
  transientContainers.delete(name);
  return output;
}
function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
async function waitReady(container: string) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const output = docker(["exec", container, "node", "--import", "tsx", "scripts/deployment-health.ts", "readiness"], 10000);
      check(offlineReadinessPassed(output), "release_boundary_incorrect");
      if (docker(["inspect", "--format", "{{.State.Health.Status}}", container], 10000) !== "healthy") {
        await delay(1000);
        continue;
      }
      return;
    } catch {
      check(docker(["inspect", "--format", "{{.State.Running}}", container], 10000) === "true", "container_exited_before_ready");
      await delay(500);
    }
  }
  throw new Error("offline_startup_timeout");
}
function inspectExit(container: string) {
  check(docker(["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", container]) === "false 0", "unclean_container_stop");
}

try {
  check(Number(process.versions.node.split(".")[0]) === 22, "validation_requires_node22");
  // These read-only probes deliberately fail rather than trying to repair Docker.
  docker(["version"], 30000);
  docker(["compose", "version"], 30000);
  mkdirSync(resolve(directory, "secrets"), { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(envSentinel, sentinel, { mode: 0o600, flag: "wx" });
  writeFileSync(resolve(directory, "private-output"), sentinel, { mode: 0o600 });
  writeFileSync(resolve(directory, "secrets/access-code"), randomBytes(32).toString("hex"), { mode: 0o600 });
  writeFileSync(resolve(directory, "secrets/browserbase-api-key"), "", { mode: 0o600 });
  writeFileSync(resolve(directory, "runtime.env"), [
    "APP_ORIGIN=https://offline-validation.example.invalid",
    "ENABLE_DEMO_RUNS=false", "DEPLOYMENT_CONFIRM_PAID=false",
    "SESSION_TIMEOUT_SECONDS=120", "MAX_STEPS_PER_PERSONA=12",
  ].join("\n") + "\n", { mode: 0o600 });
  writeFileSync(composeFile, isolatedValidationCompose(readFileSync("compose.yaml", "utf8"), root, directory), { mode: 0o600 });
  compose(["config", "--quiet"]);
  console.log("offline_docker_build_start");
  docker(["build", "--pull", "--tag", image, "."], 600000);
  builtImages.push(image);

  // COPY from the actual root context also catches a broken .dockerignore even
  // when the production Dockerfile would not itself copy a leaked root .env.
  const auditDockerfile = resolve(directory, "Dockerfile.context");
  writeFileSync(auditDockerfile, `FROM ${image}\nCOPY . /validation-context\n`, { mode: 0o600 });
  docker(["build", "--file", auditDockerfile, "--tag", auditImage, "."], 120000);
  builtImages.push(auditImage);
  transientRun(`${id}-audit`, ["--rm", "--network", "none", "--read-only", "--memory", "2g", "--cpus", "2",
    "--pids-limit", "128", "--entrypoint", "node", auditImage, "-e", `
    const fs = require('node:fs'), path = require('node:path');
    const sentinel = process.argv[1];
    function walk(root) {
      for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
        const file = path.join(root,entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && fs.readFileSync(file).includes(sentinel)) throw Error('private_build_content_detected');
      }
    }
    walk('/validation-context'); walk('/app');
    for (const forbidden of ['.git','.env.local','node_modules','data','artifacts','.stagehand']) {
      if(fs.existsSync('/validation-context/'+forbidden)) throw Error('private_build_context_entry');
    }
    console.log('context_and_image_sentinel_scan_pass');
  `, sentinel], 120000);
  console.log("offline_context_and_image_scan_pass");

  // Linux CI hosts need file-backed secret ownership matching the nonroot UID.
  // This root helper only touches the two generated offline secret files.
  transientRun(`${id}-secrets`, ["--rm", "--network", "none", "--read-only", "--user", "0:0",
    "--memory", "256m", "--cpus", "1", "--pids-limit", "64",
    "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
    "--mount", `type=bind,src=${directory},dst=/validation`,
    "--entrypoint", "node", image, "-e", `
      const fs=require('node:fs');
      for(const name of ['access-code','browserbase-api-key']) {
        const path='/validation/secrets/'+name; fs.chownSync(path,1000,1000); fs.chmodSync(path,0o600);
      }
    `]);
  provisioned = true;
  compose(["up", "--detach", "--no-build", "app"]);
  const container = compose(["ps", "--quiet", "app"]);
  check(container, "app_container_missing");
  await waitReady(container);
  check(docker(["inspect", "--format", "{{.HostConfig.ReadonlyRootfs}} {{.Config.User}}", container]) === "true 1000:1000",
    "runtime_sandbox_configuration_incorrect");
  for (const probe of ["startup", "liveness"]) {
    docker(["exec", container, "node", "--import", "tsx", "scripts/deployment-health.ts", probe], 10000);
  }
  docker(["exec", container, "node", "--import", "tsx", "--input-type=module", "-e", `
    import fs from 'node:fs';
    import {DatabaseSync} from 'node:sqlite';
    import {validateDatabase} from './src/server/deployment/database.ts';
    import {assertReleaseBuild} from './src/server/deployment/build.ts';
    if(process.getuid()!==1000 || process.getgid()!==1000) throw Error('runtime_is_not_nonroot');
    for(const [path,mode] of [['/data/private',0o700],['/data/private/flash-flood.sqlite',0o600]]) {
      const st=fs.lstatSync(path);
      if(st.isSymbolicLink() || (st.mode&0o777)!==mode || st.uid!==1000) throw Error('private_modes_invalid');
    }
    for(const suffix of ['-wal','-shm']) {
      const path='/data/private/flash-flood.sqlite'+suffix;
      if(fs.existsSync(path) && (fs.statSync(path).mode&0o077)) throw Error('private_sidecar_modes_invalid');
    }
    if(process.env.ENABLE_DEMO_RUNS!=='false' || process.env.DEPLOYMENT_CONFIRM_PAID!=='false' ||
      process.env.BROWSERBASE_API_KEY || process.env.BROWSERBASE_PROJECT_ID ||
      fs.readFileSync('/run/secrets/browserbase_api_key','utf8')!=='') throw Error('offline_gate_not_offline');
    await assertReleaseBuild();
    validateDatabase('/data/private',true);
    const db=new DatabaseSync('/data/private/flash-flood.sqlite');
    db.exec("CREATE TABLE deployment_validation(value TEXT); INSERT INTO deployment_validation VALUES ('persisted')");
    db.close();
    const response=await fetch('http://127.0.0.1:4321/demo/category/home');
    if(!response.ok) throw Error('fixture_unavailable');
    await response.body?.cancel();
    console.log('nonroot_private_volume_migrations_fixture_pass');
  `]);
  check(!docker(["top", container]).includes("deployment-worker.ts"), "paid_worker_started_offline");
  console.log("offline_nonroot_volume_migrations_health_pass");
  compose(["stop", "--timeout", "90", "app"]);
  inspectExit(container);
  compose(["run", "--rm", "--no-deps", "-T", "--entrypoint", "node", "app",
    "--import", "tsx", "scripts/deployment-backup.ts", "--confirm-stopped", "/data/backups/offline"]);
  const backupReadback = `
    import {DatabaseSync} from 'node:sqlite';
    import {validateDatabase} from './src/server/deployment/database.ts';
    validateDatabase('/data/backups/offline',true);
    const db=new DatabaseSync('/data/backups/offline/flash-flood.sqlite',{readOnly:true});
    if(db.prepare('SELECT value FROM deployment_validation').get()?.value!=='persisted') throw Error('backup_data_missing');
    db.close(); console.log('quiescent_backup_readback_pass');
  `;
  compose(["run", "--rm", "--no-deps", "-T", "--entrypoint", "node", "app",
    "--import", "tsx", "--input-type=module", "-e", backupReadback]);
  restoreCreated = true;
  compose(["run", "--detach", "--no-deps", "--name", restoreName, "-e", "DATA_DIR=/data/backups/offline", "app"]);
  await waitReady(restoreName);
  docker(["stop", "--time", "90", restoreName]);
  inspectExit(restoreName);
  console.log("offline_sigterm_backup_restore_pass");
  success = true;
} catch (error) {
  // Never print subprocess buffers: Docker/Next errors can include environment.
  const code = error instanceof Error ? error.message.split("\n")[0] : "unknown";
  console.error(`offline_docker_validation_failed: ${code.startsWith("Command failed:") ? "docker_command_failed_see_daemon_or_ci" : code}`);
  process.exitCode = 1;
} finally {
  let cleaned = true;
  for (const name of transientContainers) {
    try { docker(["rm", "--force", name]); } catch { cleaned = false; }
  }
  if (restoreCreated) {
    try { docker(["rm", "--force", restoreName]); } catch { cleaned = false; }
  }
  if (provisioned) {
    try { compose(["down", "--volumes", "--timeout", "90"]); } catch { cleaned = false; }
  }
  for (const tag of builtImages.reverse()) {
    try { docker(["image", "rm", tag], 30000); } catch { cleaned = false; }
  }
  rmSync(envSentinel, { force: true });
  if (cleaned) rmSync(directory, { recursive: true, force: true });
  else {
    console.error(`offline_validation_cleanup_required_project=${id}`);
    process.exitCode = 1;
  }
  if (success && cleaned) console.log("offline_docker_validation_pass_product_release_blocked_issue8");
}
