import { createNativeSdk } from "../src/server/execution/native-sdk";
import { decisionSchema } from "../src/server/execution/types";

const sessionId = "b32aa54d-748b-4c60-89e8-a0b115309a16";
const mode = process.argv[3];
const controller = new AbortController();
let lost = false;
const sdk = createNativeSdk({
  session: { id: sessionId, connectUrl: process.argv[2], region: "us-west-2" },
  apiKey: "owned-offline-key", model: "google/gemini-2.5-flash",
  extensionId: process.argv[5] ?? "a".repeat(32),
  signal: controller.signal, assertActive() {}, onLost() { lost = true; },
});
let settled = false;
let rejected = false;
let phase = "connect";
const operation = (async () => {
  await sdk.connect();
  phase = "initialize";
  if (mode !== "connect") await sdk.initialize();
  process.send?.("ready");
})().catch(() => {
  rejected = true;
  if (mode === "extract" && !controller.signal.aborted) process.send?.({ failed: phase });
}).finally(() => { settled = true; });
process.on("message", async (message: unknown) => {
  if (message === "extract" && mode === "extract") {
    try {
      await sdk.selectPage(process.argv[4]);
      const result = await sdk.extract("Read the heading, then give up without taking any action.", decisionSchema);
      process.send?.({ result: result.data, metrics: await sdk.metrics() });
    } catch { process.send?.({ code: "offline_sdk_extract_failed" }); }
    return;
  }
  if (message !== "close") process.exit(2);
  controller.abort();
  try {
    const closing = sdk.close();
    if (sdk.close() !== closing) throw new Error("non-idempotent-close");
    await closing;
    await operation;
    process.send?.({ settled, rejected, lost });
    process.disconnect?.();
  } catch {
    process.exitCode = 1;
    process.disconnect?.();
  }
});
