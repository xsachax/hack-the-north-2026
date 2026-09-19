import { Worker } from "node:worker_threads";
import { z } from "zod";
import { decisionSchema } from "./types";
import { semanticResponseSchema } from "./evaluator";
import type { GatewayExtraction } from "./gateway";
import { nativeSdkMetricsSchema, nativeSdkReplySchema, type NativeSdkRequest } from "./native-sdk-protocol";
import { serveNativeSessionMetadata } from "./native-session-metadata";

type MetadataOptions = Parameters<typeof serveNativeSessionMetadata>[0];

/** Owns all SDK work until actual thread exit, including otherwise hidden retries. */
export function createNativeSdk(options: MetadataOptions & { model: string; extensionId: string; onLost: () => void }) {
  let metadata: Awaited<ReturnType<typeof serveNativeSessionMetadata>> | undefined;
  let worker: Worker | undefined;
  let closing: Promise<void> | undefined;
  let stopping = false;
  let failed = false;
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const rejectPending = () => {
    for (const entry of pending.values()) entry.reject(new Error("native_sdk_closed"));
    pending.clear();
  };
  const lost = () => {
    if (stopping || failed) return;
    failed = true;
    rejectPending();
    options.onLost();
  };
  const active = () => {
    options.signal.throwIfAborted();
    options.assertActive();
    if (stopping || failed) throw new Error("native_sdk_inactive");
  };
  const ready = (async () => {
    active();
    metadata = await serveNativeSessionMetadata(options);
    active();
    const entry = new URL("./native-sdk-worker.ts", import.meta.url).href;
    // tsImport is the maintained tsx worker loader. No page/source text is evaluated.
    worker = new Worker(`
      const { workerData } = require("node:worker_threads");
      import("tsx/esm/api").then(({ tsImport }) => tsImport(${JSON.stringify(entry)}, ${JSON.stringify(import.meta.url)}))
        .catch(() => process.exit(1));
    `, {
      eval: true, stdout: true, stderr: true,
      workerData: {
        apiKey: options.apiKey, sessionId: options.session.id, baseUrl: metadata.baseUrl, model: options.model,
        extensionId: options.extensionId,
      },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
    });
    // SDK diagnostics must never print keys, connection URLs or page evidence.
    worker.stdout.resume();
    worker.stderr.resume();
    worker.on("error", lost);
    worker.on("exit", lost);
    worker.on("message", (message: unknown) => {
      const reply = nativeSdkReplySchema.safeParse(message);
      const entry = reply.success ? pending.get(reply.data.id) : undefined;
      if (!reply.success || !entry) { lost(); return; }
      pending.delete(reply.data.id);
      if (reply.data.ok) entry.resolve(reply.data.result);
      else entry.reject(new Error(reply.data.code));
    });
  })();
  // setup may fail before initialize() is awaited; retain rejection for that caller.
  void ready.catch(() => { lost(); });
  const request = async (input: NativeSdkRequest, cleanup = false): Promise<unknown> => {
    await ready;
    if (!cleanup) active();
    if (!worker || stopping || failed || pending.size || nextId >= 1000) throw new Error("native_sdk_unavailable");
    const id = ++nextId;
    const result = await new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker!.postMessage({ ...input, id });
    });
    if (!cleanup) active();
    return result;
  };
  const close = () => closing ??= (async () => {
    stopping = true;
    rejectPending();
    // Wait only for local setup, never for an SDK initialization/RPC timeout.
    await ready.catch(() => undefined);
    if (worker) {
      await worker.terminate();
      worker.removeAllListeners();
    }
    // The port and its key remain owned until no SDK retry can outlive this thread.
    await metadata?.close();
  })();
  const extract: GatewayExtraction = async (prompt, schema) => {
    const kind = schema === decisionSchema ? "decision" : schema === semanticResponseSchema ? "evaluation" : undefined;
    if (!kind) throw new Error("native_sdk_schema_unsupported");
    return { data: await request({ operation: "extract", schema: kind, prompt }) };
  };
  return {
    async connect() {
      const result = z.strictObject({ sessionId: z.literal(options.session.id) })
        .parse(await request({ operation: "connect" }));
      metadata!.assertConsumed();
      return result;
    },
    async initialize() { await request({ operation: "initialize" }); },
    async selectPage(url: string) { await request({ operation: "selectPage", url }); },
    extract,
    async metrics() { return nativeSdkMetricsSchema.parse(await request({ operation: "metrics" }, true)); },
    close,
  };
}
