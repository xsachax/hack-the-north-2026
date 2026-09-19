import { spawn } from "node:child_process";
import { readFile, readdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { z } from "zod";

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Offline subprocess deadline")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function portClosed(port: number): Promise<boolean> {
  return new Promise((done, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); done(false); });
    socket.once("error", (error) => {
      if ("code" in error && error.code === "ECONNREFUSED") done(true);
      else reject(error);
    });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("Port probe timeout")); });
  });
}

test("SIGTERM during actual offline UI work stops owned servers and releases the invocation lock", async () => {
  test.setTimeout(60_000);
  const root = resolve("data/advanced-rehearsal");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { chromium } from "playwright-core";
    import { main } from "./scripts/advanced-integration.ts";
    const launch = chromium.launch.bind(chromium);
    chromium.launch = async (...args) => {
      const browser = await launch(...args);
      const createContext = browser.newContext.bind(browser);
      browser.newContext = async (...options) => {
        const context = await createContext(...options);
        await context.route("**/api/v1/session", async () => {
          process.send?.({ pending: true });
          await new Promise(() => {});
        });
        return context;
      };
      return browser;
    };
    main(["--offline-preflight"]).catch(() => { process.exitCode = 1; });
  `], { cwd: process.cwd(), stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => done({ code, signal }));
  });
  let invocation: string | undefined;
  try {
    await within(new Promise<void>((done, reject) => {
      child.once("message", (message) => {
        if (z.object({ pending: z.literal(true) }).safeParse(message).success) done();
        else reject(new Error("Unexpected offline subprocess message"));
      });
      child.once("exit", () => reject(new Error("Offline subprocess exited before pending UI")));
    }), 40_000);
    const lock = z.object({ invocationId: z.uuid(), pid: z.number() }).parse(
      JSON.parse(await readFile(join(root, "integration.lock"), "utf8")),
    );
    expect(lock.pid).toBe(child.pid);
    invocation = lock.invocationId;
    child.kill("SIGTERM");
    expect(await within(exited, 15_000)).toEqual({ code: 1, signal: null });
    await expect(readFile(join(root, "integration.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await Promise.all([portClosed(4327), portClosed(4328)])).toEqual([true, true]);
    await expect(readFile(join(root, invocation, "owner-resume.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      try { await within(exited, 5000); } catch {
        child.kill("SIGKILL");
        await within(exited, 5000);
      }
    }
    if (invocation) {
      const records = (await readdir(join(root, invocation))).filter((file) => /^owned-web-[a-f0-9-]+\.json$/.test(file));
      expect(records).toHaveLength(1);
      const owned = z.object({ pid: z.number().int().positive() }).parse(
        JSON.parse(await readFile(join(root, invocation, records[0]), "utf8")),
      );
      if (!await portClosed(4327)) {
        try { process.kill(owned.pid, "SIGTERM"); } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
      await rm(join(root, invocation), { recursive: true, force: true });
    }
  }
});
