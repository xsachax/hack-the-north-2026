import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeSdk } from "./native-sdk";
import { decisionSchema } from "./types";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(), consumed: vi.fn(), metadataClose: vi.fn(async () => {}),
  terminate: vi.fn<() => Promise<number>>(), dispatch: vi.fn(), construct: vi.fn(),
  worker: undefined as EventEmitter | undefined,
}));
vi.mock("./native-session-metadata", () => ({ serveNativeSessionMetadata: mocks.metadata }));
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    stdout = { resume() {} };
    stderr = { resume() {} };
    constructor(...args: unknown[]) {
      super(); mocks.construct(...args); mocks.worker = this;
    }
    terminate = mocks.terminate;
    postMessage = mocks.dispatch;
  },
}));
const session = { id: "b32aa54d-748b-4c60-89e8-a0b115309a16", connectUrl: "wss://owned.invalid/cdp" };
function setup() {
  const controller = new AbortController();
  const onLost = vi.fn();
  const options = {
    session, model: "google/gemini-2.5-flash", apiKey: "owned-key", extensionId: "a".repeat(32),
    signal: controller.signal, assertActive: vi.fn(), onLost,
  };
  return { sdk: createNativeSdk(options), controller, options, onLost };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.metadata.mockResolvedValue({
    baseUrl: "http://127.0.0.1:12345", assertConsumed: mocks.consumed, close: mocks.metadataClose,
  });
  mocks.terminate.mockImplementation(async () => { mocks.worker?.emit("exit", 1); return 1; });
});
afterEach(() => { vi.useRealTimers(); });
async function connected() {
  const result = setup();
  const pending = result.sdk.connect();
  await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledOnce());
  mocks.worker!.emit("message", { id: 1, ok: true, result: { sessionId: session.id } });
  await pending;
  return result;
}
describe("SDK ownership must settle before metadata port retirement", () => {
  it("retains the metadata listener across arbitrary outer timeouts until actual worker exit", async () => {
    const { sdk } = await connected();
    let exit!: (code: number) => void;
    mocks.terminate.mockReturnValue(new Promise((resolve) => { exit = resolve; }));
    const closing = sdk.close();
    await vi.waitFor(() => expect(mocks.terminate).toHaveBeenCalledOnce());
    expect(mocks.metadataClose).not.toHaveBeenCalled();
    expect(sdk.close()).toBe(closing);
    exit(1);
    await closing;
    expect(mocks.metadataClose).toHaveBeenCalledOnce();
    expect(mocks.consumed).toHaveBeenCalledOnce();
  });
  it("does not recycle the port when terminating an owned worker is unconfirmed", async () => {
    const { sdk } = await connected();
    mocks.terminate.mockRejectedValue(new Error("owned termination rejected"));
    await expect(sdk.close()).rejects.toThrow("owned termination rejected");
    expect(mocks.metadataClose).not.toHaveBeenCalled();
  });
  it("settles the pending caller and only then retires the listener on cancellation", async () => {
    const { sdk, controller, onLost } = setup();
    const connection = expect(sdk.connect()).rejects.toThrow("native_sdk_closed");
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledOnce());
    controller.abort();
    await sdk.close();
    await connection;
    expect(onLost).not.toHaveBeenCalled();
    expect(mocks.metadataClose).toHaveBeenCalledOnce();
  });
  it.each(["error", "exit", "message"])("latches unexpected %s without trusting late success", async (event) => {
    const { sdk, onLost } = setup();
    const connection = expect(sdk.connect()).rejects.toThrow("native_sdk_closed");
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledOnce());
    mocks.worker!.emit(event, event === "error" ? new Error("private details") : null);
    await connection;
    expect(onLost).toHaveBeenCalledOnce();
    await expect(sdk.initialize()).rejects.toThrow("native_sdk_inactive");
    await sdk.close();
    expect(mocks.metadataClose).toHaveBeenCalledOnce();
  });
  it("rejects a post-await lost lease before authorizing a subsequent SDK command", async () => {
    const { sdk, options } = setup();
    const connection = expect(sdk.connect()).rejects.toThrow("lost lease");
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledOnce());
    options.assertActive.mockImplementation(() => { throw new Error("lost lease"); });
    mocks.worker!.emit("message", { id: 1, ok: true, result: { sessionId: session.id } });
    await connection;
    await expect(sdk.initialize()).rejects.toThrow("lost lease");
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    await sdk.close();
  });
  it("allows only one in-flight RPC and rejects a second extraction before dispatch", async () => {
    const { sdk } = await connected();
    const extraction = sdk.extract("owned objective", decisionSchema);
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(2));
    await expect(sdk.extract("second", decisionSchema)).rejects.toThrow("native_sdk_unavailable");
    const failed = expect(extraction).rejects.toThrow("native_sdk_closed");
    await sdk.close();
    await failed;
  });
  it("does not start an SDK worker after cancellation while local metadata setup completes", async () => {
    let finish!: (value: unknown) => void;
    mocks.metadata.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { sdk, controller } = setup();
    controller.abort();
    const closing = sdk.close();
    finish({ baseUrl: "http://127.0.0.1:12345", assertConsumed: mocks.consumed, close: mocks.metadataClose });
    await closing;
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.metadataClose).toHaveBeenCalledOnce();
  });
});
