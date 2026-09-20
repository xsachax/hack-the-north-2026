import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const sessionId = "b32aa54d-748b-4c60-89e8-a0b115309a16";
const commandSchema = z.object({
  id: z.number(), method: z.string(), params: z.record(z.string(), z.unknown()).optional(), sessionId: z.string().optional(),
});
let directory: string;
let key: Buffer;
let cert: Buffer;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ff-sdk-wss-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=owned-sdk",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
  ], { stdio: "ignore" });
  key = await readFile(join(directory, "key.pem"));
  cert = await readFile(join(directory, "cert.pem"));
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe("actual pinned branded SDK in an exclusively owned worker", () => {
  it("loads and retires the worker through the maintained package/container probe with outbound traffic disabled", () => {
    const output = execFileSync(process.execPath, [
      "--conditions=react-server", "--require", resolve("tests/native-sdk-offline-guard.cjs"),
      "--import", "tsx", "scripts/deployment-sdk-check.ts",
    ], {
      encoding: "utf8", timeout: 20000,
      env: { PATH: process.env.PATH, NODE_ENV: "test", TMPDIR: directory, TSX_DISABLE_CACHE: "1" },
    });
    expect(output).toBe("offline_packaged_sdk_worker_loading_and_retirement_pass\n");
  }, 25000);

  it.each(["connect", "initialize", "ready"] as const)("settles WSS and SDK work when terminating during %s, without any browser close", async (mode) => {
    const sockets = new Set<Duplex>();
    const methods: string[] = [];
    const errors: unknown[] = [];
    let init: unknown;
    let held!: () => void;
    const waiting = new Promise<void>((resolve) => { held = resolve; });
    let upgraded = 0;
    const server = createServer({ key, cert }, (_request, response) => {
      errors.push("unexpected-http"); response.writeHead(403).end();
    });
    function send(socket: Duplex, value: unknown) {
      const bytes = Buffer.from(JSON.stringify(value));
      const header = bytes.length < 126 ? Buffer.from([0x81, bytes.length]) : Buffer.alloc(4);
      if (bytes.length >= 126) {
        header[0] = 0x81; header[1] = 126; header.writeUInt16BE(bytes.length, 2);
      }
      socket.write(Buffer.concat([header, bytes]));
    }
    server.on("upgrade", (request, socket) => {
      upgraded++;
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      const nonce = request.headers["sec-websocket-key"];
      if (typeof nonce !== "string") { socket.destroy(); return; }
      const accept = createHash("sha1").update(nonce + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      let buffered = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        try {
          while (buffered.length >= 2) {
            const opcode = buffered[0] & 15;
            let length = buffered[1] & 127;
            let offset = 2;
            if (length === 126) {
              if (buffered.length < 4) return;
              length = buffered.readUInt16BE(2); offset = 4;
            }
            if (!(buffered[1] & 128) || length === 127) throw new Error("unsupported-frame");
            if (buffered.length < offset + 4 + length) return;
            const mask = buffered.subarray(offset, offset + 4);
            const bytes = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
            for (let index = 0; index < bytes.length; index++) bytes[index] ^= mask[index % 4];
            buffered = buffered.subarray(offset + 4 + length);
            if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
            if (opcode !== 1) throw new Error("unsupported-opcode");
            const command = commandSchema.parse(JSON.parse(bytes.toString("utf8")));
            methods.push(command.method);
            let result: unknown = {};
            if (command.method === "Extensions.getExtensions") {
              result = { extensions: [{
                id: "a".repeat(32), name: "Stagehand Runtime", version: "1.0.2", path: "/owned/extension", enabled: true,
              }] };
            } else if (command.method === "Target.getTargets") {
              if (mode === "connect") { held(); continue; }
              result = { targetInfos: [{
                targetId: "owned", type: "service_worker", title: "Stagehand Runtime",
                url: `chrome-extension://${"a".repeat(32)}/service-worker.js`,
              }] };
            } else if (command.method === "Target.attachToTarget") result = { sessionId: "owned-session" };
            else if (["Runtime.enable", "Runtime.addBinding"].includes(command.method)) result = {};
            else if (command.method === "Runtime.evaluate") {
              const expression = z.string().parse(command.params?.expression);
              if (expression.includes("__stagehand_runtime")) result = { result: { value: {
                marker: { protocolVersion: "2.0.0", serverInfo: { name: "stagehand", version: "4.1.0" } }, hasReceiver: true,
              } } };
              else {
                const prefix = "void globalThis.__stagehandReceiveFromHost(";
                if (!expression.startsWith(prefix) || !expression.endsWith("); true")) throw new Error("unexpected-expression");
                const rpc = z.object({ id: z.number(), method: z.literal("stagehand.init"), params: z.unknown() })
                  .parse(JSON.parse(JSON.parse(expression.slice(prefix.length, -"); true".length))));
                init = rpc.params;
                if (mode === "initialize") { held(); continue; }
                send(socket, { method: "Runtime.bindingCalled", sessionId: command.sessionId, params: {
                  name: "__stagehandSendToHost", executionContextId: 1,
                  payload: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { initialized: true, pages: [] } }),
                } });
                result = { result: { value: true } };
              }
            } else throw new Error("unexpected-command");
            send(socket, { id: command.id, sessionId: command.sessionId, result });
          }
        } catch (error) { errors.push(error); socket.destroy(); held(); }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing-owned-address");
    const url = `wss://127.0.0.1:${address.port}/devtools/browser/owned`;
    const child = spawn(process.execPath, [
      "--conditions=react-server", "--require", resolve("tests/native-sdk-offline-guard.cjs"),
      "--import", "tsx", resolve("tests/native-sdk-runner.ts"), url, mode,
    ], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { PATH: process.env.PATH, NODE_ENV: "test", NODE_EXTRA_CA_CERTS: join(directory, "cert.pem"), TSX_DISABLE_CACHE: "1" },
    });
    let output = "";
    child.stdout!.on("data", (chunk) => { output += chunk; });
    child.stderr!.on("data", (chunk) => { output += chunk; });
    const done = once(child, "exit");
    const receipt = new Promise<unknown>((resolve) => child.on("message", (value) => {
      if (value === "ready") { if (mode === "ready") held(); }
      else resolve(value);
    }));
    try {
      await Promise.race([waiting, done.then(() => { throw new Error(`sdk-child-exited:${output}`); })]);
      expect(upgraded).toBe(1);
      expect(sockets.size).toBe(1);
      child.send("close");
      expect(await receipt).toEqual({ settled: true, rejected: mode !== "ready", lost: false });
      expect(await done).toEqual([0, null]);
      expect(sockets.size).toBe(0);
      expect(methods).not.toContain("Browser.close");
      expect(output).toBe("");
      expect(errors).toEqual([]);
      if (mode !== "connect") expect(init).toMatchObject({
        api_key: "owned-offline-key", browser: { session_id: sessionId, region: "us-west-2" },
        browser_cdp_url: url, model: { model_name: "google/gemini-2.5-flash" },
      });
    } finally {
      if (child.exitCode === null) { child.kill("SIGKILL"); await done; }
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);
});
