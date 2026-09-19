// IPC checks the worker event loop, not merely the continued existence of its PID.
export {};
setInterval(() => process.send?.({ type: "heartbeat" }), 1000).unref();
await import("./worker");
