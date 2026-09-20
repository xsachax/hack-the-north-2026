import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { publicPreflight } from "../../../scripts/public-integration";
import { OfflineNativeProbeError } from "../../../scripts/public-native-offline";

vi.mock("server-only", () => ({}));

describe("maintained public CLI preallocation boundary", () => {
  it("keeps offline probe diagnostics to fixed stages and codes, never raw errors", () => {
    const error = new OfflineNativeProbeError("sdk-initialize", new Error("wss://private.invalid/?apiKey=private-value"));
    expect(error.message).toBe("offline_native_probe_failed");
    expect(error.code).toBe("unknown");
    expect(JSON.stringify(error)).not.toMatch(/private-value|private.invalid|wss:/);
    expect(new OfflineNativeProbeError("native-attestation", new Error("native_proxy_endpoint_unconfirmed")).code)
      .toBe("native_proxy_endpoint_unconfirmed");
  });

  it("reports a safe browser-launch failure from the real offline CLI and still exits unsuccessfully", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ff-native-cli-missing-browser-"));
    try {
      const result = spawnSync(process.execPath, [
        "--conditions=react-server", "--disable-warning=ExperimentalWarning", "--import", "tsx",
        "scripts/public-integration.ts", "--offline-native-probe",
      ], {
        cwd: process.cwd(), timeout: 15000, encoding: "utf8",
        env: { PATH: process.env.PATH, NODE_ENV: "test", TSX_DISABLE_CACHE: "1",
          PLAYWRIGHT_BROWSERS_PATH: directory, BROWSERBASE_API_KEY: "", BROWSERBASE_PROJECT_ID: "" },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim().split("\n")).toEqual([
        JSON.stringify({ phase: "offline-native-probe-failure", step: "browser", code: "unknown" }),
        "Public integration failed closed; inspect the private plan, configuration and resource ledger.",
      ]);
      expect(result.stderr).not.toContain(directory);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([{ args: [] }, { args: ["--confirm-paid"] }, { args: ["--offline-preflight", "--confirm-paid"] }])("rejects unauthorised mode %j", async ({ args }) => {
    await expect(publicPreflight(args)).rejects.toThrow("public_checkpoint_disabled");
  });

  it.each([
    ["--offline-preflight"], ["--confirm-paid"], ["--paid"],
    ["--confirm-paid", "missing-plan.json", "missing-approval.json"],
    ["--prepare-plan", "missing-input.json", "plan.json"],
    ["--ledger-preflight", "missing-existing-ledger"],
  ])("runs the real CLI loader without outbound connections and rejects %j before allocation", async (...args) => {
    const directory = await mkdtemp(join(tmpdir(), "ff-public-cli-"));
    const guard = join(directory, "offline.cjs");
    try {
      await mkdir(join(directory, "empty-package"), { mode: 0o700 });
      await writeFile(guard, `
        const deny = () => {
          process.stderr.write('OFFLINE_NETWORK_ATTEMPT\\n');
          throw Error('offline_network_forbidden');
        };
        globalThis.fetch = deny;
        require('node:http').request = deny;
        require('node:https').request = deny;
        const net = require('node:net'), connect = net.Socket.prototype.connect;
        net.Socket.prototype.connect = function(...args) {
          const options = Array.isArray(args[0]) ? args[0][0] : args[0];
          if (options && typeof options === 'object' && typeof options.path === 'string') return connect.apply(this,args);
          return deny();
        };
      `, { mode: 0o600 });
      const result = spawnSync(process.execPath, [
        "--conditions=react-server", "--disable-warning=ExperimentalWarning", "--require", guard,
        "--import", resolve("node_modules/tsx/dist/loader.mjs"),
        resolve("scripts/public-integration.ts"), ...args,
      ], {
        cwd: join(directory, "empty-package"), timeout: 15000, encoding: "utf8",
        env: {
          PATH: process.env.PATH, NODE_ENV: "test", TSX_DISABLE_CACHE: "1",
          ENABLE_PUBLIC_RUNS: "true", PUBLIC_EXECUTION_IMPLEMENTATION_READY: "true",
          BROWSERBASE_API_KEY: "owned-offline-key",
          BROWSERBASE_PROJECT_ID: "82f48adf-37dc-443b-a93b-a4458d416c36",
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("Public integration failed closed; inspect the private plan, configuration and resource ledger.");
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("offline_network_forbidden");
      expect(result.stderr).not.toContain("OFFLINE_NETWORK_ATTEMPT");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
