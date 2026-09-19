import "server-only";
import { assertPaidDataNotRestored } from "../src/server/deployment/database";

assertPaidDataNotRestored(process.env.DATA_DIR ?? "/data/private", true);
// IPC checks the worker event loop, not merely the continued existence of its PID.
setInterval(() => process.send?.({ type: "heartbeat" }), 1000).unref();
await import("./worker");
