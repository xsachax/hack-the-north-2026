import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { publicPreflight } from "../../../scripts/public-integration";

describe("maintained public CLI preallocation boundary", () => {
  it.each([{ args: [] }, { args: ["--confirm-paid"] }, { args: ["--offline-preflight", "--confirm-paid"] }])("rejects unauthorised mode %j", async ({ args }) => {
    await expect(publicPreflight(args)).rejects.toThrow("public_paid_approval_required");
  });

  it("runs the real CLI loader with all outbound connections disabled and fails a missing package before allocation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ff-public-cli-"));
    const guard = join(directory, "offline.cjs");
    try {
      await mkdir(join(directory, "empty-package"), { mode: 0o700 });
      await writeFile(guard, `
        const deny = () => { throw Error('offline_network_forbidden'); };
        globalThis.fetch = deny;
        require('node:http').request = deny;
        require('node:https').request = deny;
        const net = require('node:net'), connect = net.Socket.prototype.connect;
        net.Socket.prototype.connect = function(...args) {
          const options = Array.isArray(args[0]) ? args[0][0] : args[0];
          if (options && typeof options === 'object' && typeof options.path === 'string') return connect.apply(this,args);
          throw Error('offline_network_forbidden');
        };
      `, { mode: 0o600 });
      const result = spawnSync(process.execPath, [
        "--conditions=react-server", "--require", guard,
        "--import", resolve("node_modules/tsx/dist/loader.mjs"),
        resolve("scripts/public-integration.ts"), "--offline-preflight",
      ], {
        cwd: join(directory, "empty-package"), timeout: 15000, encoding: "utf8",
        env: { PATH: process.env.PATH, NODE_ENV: "test", TSX_DISABLE_CACHE: "1" },
      });
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("Public browser preflight failed closed; no provider allocation authorized.");
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("offline_network_forbidden");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
