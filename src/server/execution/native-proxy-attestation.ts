import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { z } from "zod";

const endpoint = "127.0.0.1:65534";
const eventSchema = z.object({
  name: z.enum(["TCP_CONNECT", "TCP_CONNECT_ATTEMPT"]),
  cat: z.literal("netlog"), ph: z.enum(["b", "e"]),
  pid: z.int().nonnegative(), tid: z.int().nonnegative(),
  ts: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
  id2: z.strictObject({ local: z.string().regex(/^0x[0-9a-f]+$/) }),
  args: z.object({ params: z.record(z.string(), z.unknown()).optional(), source_type: z.string().optional() }),
});

/** Raw tracing data is discarded; callers may retain only this constant verdict. */
export function assertNativeProxyRefusalTrace(value: unknown): "tcp_connection_refused" {
  const root = z.object({ traceEvents: z.array(z.unknown()).max(10000) }).safeParse(value);
  if (!root.success) throw new Error("native_proxy_trace_rejected");
  const connections = new Map<string, { stage: number; thread: number; timestamp: number }>();
  const seen = new Set<string>();
  const sequence = ["TCP_CONNECT:b", "TCP_CONNECT_ATTEMPT:b", "TCP_CONNECT_ATTEMPT:e", "TCP_CONNECT:e"];
  let cycles = 0;
  for (const item of root.data.traceEvents) {
    if (!item || typeof item !== "object") throw new Error("native_proxy_trace_rejected");
    const name: unknown = Reflect.get(item, "name");
    if (name !== "TCP_CONNECT" && name !== "TCP_CONNECT_ATTEMPT") continue;
    const parsed = eventSchema.safeParse(item);
    if (!parsed.success) throw new Error("native_proxy_trace_rejected");
    const event = parsed.data;
    const key = `${event.pid}/${event.id2.local}`;
    const connection = connections.get(key) ?? { stage: 0, thread: event.tid, timestamp: event.ts };
    connections.set(key, connection);
    const step = `${event.name}:${event.ph}`;
    const identity = `${key}/${event.tid}/${event.ts}/${step}`;
    if (connections.size > 8 || seen.size >= 32 || seen.has(identity)
      || connection.thread !== event.tid || event.ts < connection.timestamp
      || sequence[connection.stage] !== step) throw new Error("native_proxy_trace_rejected");
    seen.add(identity);
    connection.timestamp = event.ts;
    connection.stage = (connection.stage + 1) % sequence.length;
    if (connection.stage === 0 && ++cycles > 8) throw new Error("native_proxy_trace_rejected");
    const params = event.args.params;
    if (event.args.source_type !== undefined && event.args.source_type !== "SOCKET") throw new Error("native_proxy_trace_rejected");
    if (event.ph === "e") {
      if (params && Object.keys(params).length) throw new Error("native_proxy_trace_rejected");
      continue;
    }
    if (event.args.source_type !== "SOCKET" || !params) throw new Error("native_proxy_trace_rejected");
    if (event.name === "TCP_CONNECT") {
      if (params.net_error !== -102 || !Array.isArray(params.address_list)
        || params.address_list.length !== 1 || params.address_list[0] !== endpoint) {
        throw new Error("native_proxy_trace_rejected");
      }
    } else {
      // ECONNREFUSED on the measured Darwin/Linux hosts; no reset/timeout success.
      if (params.address !== endpoint || (params.os_error !== 61 && params.os_error !== 111)) {
        throw new Error("native_proxy_trace_rejected");
      }
    }
  }
  if (!cycles || [...connections.values()].some((connection) => connection.stage !== 0)) throw new Error("native_proxy_trace_rejected");
  return "tcp_connection_refused";
}

async function bounded<T>(work: Promise<T>, milliseconds = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("native_proxy_attestation_timeout")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function verifyNativeProxyRefusal(context: BrowserContext, assertActive: () => void): Promise<void> {
  let tracing: CDPSession | undefined;
  let page: Page | undefined;
  let started = false;
  let ended = false;
  let stream: string | undefined;
  let phase = "session";
  try {
    assertActive();
    const browser = context.browser();
    if (!browser) throw new Error("native_proxy_trace_unavailable");
    tracing = await bounded(browser.newBrowserCDPSession());
    // Chrome rejects a competing trace. Never stop a trace this caller did not start.
    phase = "trace_start";
    await bounded(tracing.send("Tracing.start", {
      transferMode: "ReturnAsStream", streamFormat: "json",
      traceConfig: { recordMode: "recordUntilFull", includedCategories: ["netlog"] },
    }).then(() => { started = true; }));
    assertActive();
    phase = "page";
    page = await bounded(context.newPage());
    phase = "navigation";
    let refused = false;
    try {
      await page.goto("https://example.com/", { waitUntil: "commit", timeout: 5000 });
    } catch (error) {
      refused = error instanceof Error && /^page\.goto: net::ERR_PROXY_CONNECTION_FAILED at https:\/\/example\.com\/(?:\n|$)/.test(error.message);
    }
    assertActive();
    phase = "probe_close";
    await bounded(page.close());
    page = undefined;
    assertActive();
    phase = "trace_end";
    const complete = new Promise<{ stream?: string; dataLossOccurred?: boolean }>((resolve) => tracing!.once("Tracing.tracingComplete", resolve));
    await bounded(tracing.send("Tracing.end"));
    ended = true;
    phase = "trace_complete";
    const result = await bounded(complete);
    stream = result.stream;
    if (!stream || result.dataLossOccurred) throw new Error("native_proxy_trace_unavailable");
    const chunks: Buffer[] = [];
    let bytes = 0;
    let eof = false;
    phase = "trace_read";
    for (let index = 0; index < 32 && !eof; index++) {
      assertActive();
      const chunk = await bounded(tracing.send("IO.read", { handle: stream, size: 65536 }));
      const buffer = Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
      bytes += buffer.length;
      if (bytes > 1024 * 1024) throw new Error("native_proxy_trace_limit");
      chunks.push(buffer);
      eof = chunk.eof;
    }
    if (!eof || !refused) throw new Error("native_proxy_endpoint_unconfirmed");
    phase = "trace_validate";
    assertNativeProxyRefusalTrace(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    assertActive();
  } catch (error) {
    const known = new Set(["native_proxy_trace_rejected", "native_proxy_attestation_timeout",
      "native_proxy_trace_unavailable", "native_proxy_trace_limit", "native_proxy_endpoint_unconfirmed"]);
    const reason = error instanceof Error && known.has(error.message) ? error.message : "unconfirmed";
    throw new Error("native_proxy_endpoint_unconfirmed", { cause: new Error(`${phase}:${reason}`) });
  } finally {
    try {
      if (started && !ended && tracing) await bounded(tracing.send("Tracing.end"));
      if (stream && tracing) await bounded(tracing.send("IO.close", { handle: stream }));
    } finally {
      try { await bounded(Promise.resolve(page?.close())); }
      finally { await bounded(Promise.resolve(tracing?.detach())); }
    }
  }
}
