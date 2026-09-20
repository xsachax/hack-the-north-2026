import { createServer } from "node:net";
import { once } from "node:events";
import { createNativeSdk } from "../src/server/execution/native-sdk";

let connections = 0;
let lost = false;
const stub = createServer((socket) => { connections++; socket.destroy(); });
stub.listen(0, "127.0.0.1");
await once(stub, "listening");
const address = stub.address();
if (!address || typeof address === "string") throw new Error("deployment_sdk_stub_missing");
const sdk = createNativeSdk({
  session: {
    id: "b32aa54d-748b-4c60-89e8-a0b115309a16",
    connectUrl: `wss://127.0.0.1:${address.port}/owned-offline`,
    region: "us-west-2",
  },
  apiKey: "owned-offline-key", model: "google/gemini-2.5-flash", extensionId: "a".repeat(32),
  signal: new AbortController().signal, assertActive() {}, onLost() { lost = true; },
});
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  let rejected = false;
  try {
    await Promise.race([sdk.connect(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("deployment_sdk_probe_timeout")), 10000);
    })]);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "native_sdk_operation_failed") throw error;
    rejected = true;
  }
  if (!rejected || !connections || lost) throw new Error("deployment_sdk_loading_or_transport_failed");
} finally {
  clearTimeout(timer);
  await sdk.close();
  await new Promise<void>((resolve, reject) => stub.close((error) => error ? reject(error) : resolve()));
}
console.log("offline_packaged_sdk_worker_loading_and_retirement_pass");
