import Browserbase from "@browserbasehq/sdk";
import { request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serveNativeSessionMetadata } from "./native-session-metadata";

const session = {
  id: "b32aa54d-748b-4c60-89e8-a0b115309a16",
  connectUrl: "wss://owned-cdp.invalid/session",
  region: "us-west-2",
} as const;
const apiKey = "owned-offline-key";
const adapters: Awaited<ReturnType<typeof serveNativeSessionMetadata>>[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  vi.useRealTimers();
});
async function setup(signal = new AbortController().signal, assertActive = () => {}) {
  const adapter = await serveNativeSessionMetadata({ session, apiKey, signal, assertActive });
  adapters.push(adapter);
  return adapter;
}

describe("one-use native connection metadata, no provider forwarding", () => {
  it("caps simultaneous sockets at four and bounds incomplete headers without releasing the listener", async () => {
    const adapter = await setup();
    const port = Number(new URL(adapter.baseUrl).port);
    const open = () => new Promise<Socket>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port });
      sockets.push(socket);
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
    const held = await Promise.all(Array.from({ length: 4 }, open));
    for (const socket of held) socket.write("GET / HTTP/1.1\r\nHost: ");
    const extra = await open();
    await vi.waitFor(() => expect(extra.destroyed).toBe(true), { timeout: 500 });
    expect(held.every((socket) => !socket.destroyed)).toBe(true);
    await vi.waitFor(() => expect(held.every((socket) => socket.destroyed)).toBe(true), { timeout: 2500 });
    const denied = await fetch(`${adapter.baseUrl}/wrong`, { headers: { "x-bb-api-key": apiKey } });
    expect(denied.status).toBe(403);
  });

  it("supplies the exact previously validated metadata to the actual pinned Browserbase SDK", async () => {
    const adapter = await setup();
    const client = new Browserbase({ apiKey, baseURL: adapter.baseUrl, maxRetries: 0 });
    expect(await client.sessions.retrieve(session.id)).toEqual(session);
    adapter.assertConsumed();
    await expect(client.sessions.retrieve(session.id)).rejects.toMatchObject({ status: 403 });
    expect(() => adapter.assertConsumed()).toThrow("native_metadata_unconfirmed");
  });

  it.each([
    ["method", { method: "POST" }],
    ["origin", { headers: { origin: "https://untrusted.invalid" } }],
    ["cookie", { headers: { cookie: "owner=not-authority" } }],
    ["cookie2", { headers: { cookie2: "owner=not-authority" } }],
    ["authorization", { headers: { authorization: "Bearer not-app-authority" } }],
    ["referer", { headers: { referer: "https://untrusted.invalid" } }],
    ["key", { headers: { "x-bb-api-key": "wrong" } }],
  ])("rejects %s without returning metadata", async (_name, request) => {
    const adapter = await setup();
    const response = await fetch(`${adapter.baseUrl}/v1/sessions/${session.id}`, {
      ...request, headers: { "x-bb-api-key": apiKey, ...("headers" in request ? request.headers : {}) },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
    expect(() => adapter.assertConsumed()).toThrow("native_metadata_unconfirmed");
  });

  it("rejects a mismatched actual HTTP Host header", async () => {
    const adapter = await setup();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${adapter.baseUrl}/v1/sessions/${session.id}`, {
        headers: { host: "untrusted.invalid", "x-bb-api-key": apiKey }, agent: false,
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
        response.once("error", reject);
      });
      request.once("error", reject);
      request.end();
    });
    expect(status).toBe(403);
    expect(() => adapter.assertConsumed()).toThrow("native_metadata_unconfirmed");
  });

  it("denies another session and every provider write instead of forwarding", async () => {
    const adapter = await setup();
    const client = new Browserbase({ apiKey, baseURL: adapter.baseUrl, maxRetries: 0 });
    await expect(client.sessions.update(session.id, { status: "REQUEST_RELEASE" })).rejects.toMatchObject({ status: 403 });
    await expect(client.sessions.retrieve("83ec7517-c556-4b40-b91d-fa3873487fda")).rejects.toMatchObject({ status: 403 });
    expect(() => adapter.assertConsumed()).toThrow("native_metadata_unconfirmed");
  });

  it("requires successful consumption before it can attest the local exchange", async () => {
    const adapter = await setup();
    expect(() => adapter.assertConsumed()).toThrow("native_metadata_unconfirmed");
    const response = await fetch(`${adapter.baseUrl}/v1/sessions/${session.id}`, { headers: { "x-bb-api-key": apiKey } });
    expect(await response.json()).toEqual(session);
    adapter.assertConsumed();
    await adapter.close();
    adapter.assertConsumed();
    await expect(fetch(`${adapter.baseUrl}/v1/sessions/${session.id}`)).rejects.toThrow();
  });

  it("fences lease loss immediately before serving metadata", async () => {
    let active = true;
    const adapter = await setup(undefined, () => { if (!active) throw new Error("lease lost"); });
    active = false;
    const response = await fetch(`${adapter.baseUrl}/v1/sessions/${session.id}`, { headers: { "x-bb-api-key": apiKey } });
    expect(response.status).toBe(403);
    expect(() => adapter.assertConsumed()).toThrow("native_metadata_unconfirmed");
  });

  it("denies cancellation without recycling the port before explicit cleanup", async () => {
    const controller = new AbortController();
    const adapter = await setup(controller.signal);
    controller.abort();
    const denied = await fetch(`${adapter.baseUrl}/v1/sessions/${session.id}`, { headers: { "x-bb-api-key": apiKey } });
    expect(denied.status).toBe(403);
    await adapter.close();
    expect(() => adapter.assertConsumed()).toThrow("native_metadata_unconfirmed");
    await expect(fetch(`${adapter.baseUrl}/v1/sessions/${session.id}`)).rejects.toThrow();
    await expect(setup(controller.signal)).rejects.toThrow("native_metadata_unavailable");
  });

  it("rejects non-TLS or excessive connection metadata before listening", async () => {
    for (const connectUrl of ["http://127.0.0.1", "ws://owned-cdp.invalid", `wss://owned-cdp.invalid/${"a".repeat(4096)}`]) {
      await expect(serveNativeSessionMetadata({
        session: { ...session, connectUrl }, apiKey, signal: new AbortController().signal, assertActive() {},
      })).rejects.toThrow();
    }
  });

  it.each([false, true])("expires admission but retains the port for settled-work cleanup (consumed=%s)", async (consumed) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const adapter = await setup();
    if (consumed) {
      const response = await fetch(`${adapter.baseUrl}/v1/sessions/${session.id}`, { headers: { "x-bb-api-key": apiKey } });
      expect(await response.json()).toEqual(session);
    }
    await vi.advanceTimersByTimeAsync(5000);
    if (consumed) adapter.assertConsumed();
    else {
      expect(() => adapter.assertConsumed()).toThrow("native_metadata_unconfirmed");
      const denied = await fetch(`${adapter.baseUrl}/v1/sessions/${session.id}`, { headers: { "x-bb-api-key": apiKey } });
      expect(denied.status).toBe(403);
    }
    expect(vi.getTimerCount()).toBe(0);
    await adapter.close();
    await expect(fetch(`${adapter.baseUrl}/v1/sessions/${session.id}`)).rejects.toThrow();
  });
});
