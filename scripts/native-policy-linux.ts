import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// No host networking is modified. The outer process owns cleanup; only the
// verified child namespace may run ip/mount or start the acceptance runner.
const script = resolve("scripts/native-policy-linux.ts");
const tsx = resolve("node_modules/tsx/dist/cli.mjs");
const playwright = resolve("node_modules/@playwright/test/cli.js");
const vitest = resolve("node_modules/vitest/vitest.mjs");
const addresses = ["10.77.0.1/32", "169.254.77.1/32", "fd00::1/128"];
const publicAliases = ["93.184.216.34/32", "2606:4700:4700::1111/128", "2606:4700:4700::1112/128"];

function command(binary: string, args: string[]) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${binary} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function inside(args: string[]) {
  const [hostNet, hostMount, scratch, uid, gid, home, suite] = args;
  assert(hostNet && hostMount && scratch && uid && gid && home, "Missing namespace launch arguments");
  assert(suite === "native" || suite === "public-transport", "Unknown fixed namespace suite");
  assert.notEqual(readlinkSync("/proc/self/ns/net"), hostNet, "Refusing host network namespace");
  assert.notEqual(readlinkSync("/proc/self/ns/mnt"), hostMount, "Refusing host mount namespace");
  assert(scratch.startsWith(`${resolve(".native-policy-linux-")}`), "Unexpected scratch directory");
  assert.equal(statSync(scratch).mode & 0o777, 0o700, "Scratch directory must be private");
  const interfaces = JSON.parse(command("ip", ["-j", "link", "show"])) as { ifname: string }[];
  assert.deepEqual(interfaces.map((entry) => entry.ifname), ["lo"], "Namespace must have only loopback");
  command("mount", ["--make-rprivate", "/"]);
  command("ip", ["link", "set", "lo", "up"]);
  for (const address of addresses) command("ip", ["address", "add", address, "dev", "lo"]);
  if (suite === "public-transport") {
    for (const address of publicAliases) command("ip", ["address", "add", address, "dev", "lo"]);
  }
  // This sysctl is network-namespaced; the unprivileged test user needs DNS/53.
  command("sysctl", ["-w", "net.ipv4.ip_unprivileged_port_start=0"]);
  command("mount", ["--bind", join(scratch, "resolv.conf"), "/etc/resolv.conf"]);
  assert.equal(readFileSync("/etc/resolv.conf", "utf8"), "nameserver 127.0.0.1\noptions timeout:1 attempts:1\n");
  // Chromium's process-singleton AF_UNIX socket cannot use the long hosted
  // checkout path. Alias only our checkout-owned scratch in this private mount
  // namespace; /mnt's host contents and the actual backing files are unchanged.
  // Do not overlay /run: /etc/resolv.conf may resolve to a path beneath it.
  const browserScratch = "/mnt";
  command("mount", ["--bind", scratch, browserScratch]);
  const backing = statSync(scratch);
  const alias = statSync(browserScratch);
  assert.equal(alias.dev, backing.dev);
  assert.equal(alias.ino, backing.ino, "Browser scratch must alias the owned directory");
  const singletonSocketBytes = Buffer.byteLength(join(browserScratch, ".org.chromium.Chromium.XXXXXX/SingletonSocket"));
  assert(singletonSocketBytes < 108, "Chromium process-singleton socket exceeds Linux sockaddr_un.sun_path");
  console.log(`Namespace setup: pid=${process.pid}, test uid=${uid}, gid=${gid}, scratch socket path=${singletonSocketBytes} bytes`);
  const environment = {
    ...process.env,
    HOME: home,
    TMPDIR: browserScratch,
    TMP: browserScratch,
    TEMP: browserScratch,
    NATIVE_POLICY_LINUX_SCRATCH: browserScratch,
    NATIVE_POLICY_LINUX_HOST_NET: hostNet,
    NATIVE_POLICY_LINUX_HOST_MOUNT: hostMount,
  };
  // In the sudo lane, run Chromium as the invoking user, not host root.
  const runner = suite === "native"
    ? [playwright, "test", "--config=playwright.native-policy-linux.config.ts"]
    : ["--conditions=react-server", vitest, "run", "--config=vitest.public-transport-linux.config.ts"];
  const child = spawnSync(process.execPath, runner, {
    stdio: "inherit",
    env: environment,
    uid: Number(uid),
    gid: Number(gid),
    timeout: 180_000,
    killSignal: "SIGKILL",
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, `Linux acceptance failed (${child.signal ?? child.status})`);
}

function main() {
  assert.equal(process.platform, "linux", "Linux network/mount namespaces are required; this test never skips");
  const args = process.argv.slice(2);
  if (args[0] === "--inside") return inside(args.slice(1));
  assert(args.length <= 2 && new Set(args).size === args.length && args.every((arg) => ["--ci-sudo", "--public-transport"].includes(arg)),
    "Usage: tsx scripts/native-policy-linux.ts [--ci-sudo] [--public-transport]");
  const sudo = args.includes("--ci-sudo");
  const suite = args.includes("--public-transport") ? "public-transport" : "native";
  assert(!sudo || process.env.CI === "true", "--ci-sudo is reserved for an explicit CI=true invocation");
  const hostNet = readlinkSync("/proc/self/ns/net");
  const hostMount = readlinkSync("/proc/self/ns/mnt");
  const scratch = mkdtempSync(resolve(".native-policy-linux-"));
  chmodSync(scratch, 0o700);
  try {
    writeFileSync(join(scratch, "resolv.conf"), "nameserver 127.0.0.1\noptions timeout:1 attempts:1\n", { mode: 0o600 });
    const namespaceArgs = [
      ...(sudo ? [] : ["--user", "--map-root-user"]),
      "--net", "--mount", "--pid", "--mount-proc", "--fork", "--kill-child=SIGKILL",
      process.execPath, tsx, script, "--inside", hostNet, hostMount, scratch,
      String(sudo ? process.getuid!() : 0), String(sudo ? process.getgid!() : 0),
      process.env.HOME ?? scratch,
      suite,
    ];
    const result = spawnSync(sudo ? "sudo" : "unshare", sudo ? ["--non-interactive", "unshare", ...namespaceArgs] : namespaceArgs, {
      stdio: "inherit",
      timeout: 210_000,
      killSignal: "SIGKILL",
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `Namespace acceptance failed (${result.signal ?? result.status}); install iproute2/util-linux and permit namespaces or use the explicit CI sudo lane`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
