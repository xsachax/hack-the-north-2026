import { EventEmitter } from "node:events";
import type { BrowserContext } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { assertNativeProxyRefusalTrace, verifyNativeProxyRefusal } from "./native-proxy-attestation";

function evidence(osError = 61, source = "0x1", timestamp = 100) {
  const base = { cat: "netlog", pid: 42, tid: 7, id2: { local: source } };
  return [
    { ...base, ts: timestamp, name: "TCP_CONNECT", ph: "b", args: { source_type: "SOCKET", params: {
      address_list: ["127.0.0.1:65534"], net_error: -102,
    } } },
    { ...base, ts: timestamp + 1, name: "TCP_CONNECT_ATTEMPT", ph: "b", args: { source_type: "SOCKET", params: {
      address: "127.0.0.1:65534", os_error: osError,
    } } },
    { ...base, ts: timestamp + 2, name: "TCP_CONNECT_ATTEMPT", ph: "e", args: {} },
    { ...base, ts: timestamp + 3, name: "TCP_CONNECT", ph: "e", args: {} },
  ];
}

describe("strict native TCP refusal evidence", () => {
  it.each([61, 111])("accepts only the fixed refusal verdict for OS error %s", (osError) => {
    expect(assertNativeProxyRefusalTrace({ traceEvents: evidence(osError) })).toBe("tcp_connection_refused");
  });

  it("allows bounded independent refused retries and unrelated trace metadata", () => {
    expect(assertNativeProxyRefusalTrace({
      traceEvents: [{ name: "process_name", ph: "M" }, ...evidence(), ...evidence(111, "0x2")],
    })).toBe("tcp_connection_refused");
  });

  it("rejects duplicated complete evidence for the same source", () => {
    const records = evidence();
    expect(() => assertNativeProxyRefusalTrace({ traceEvents: [...records, ...records] }))
      .toThrow("native_proxy_trace_rejected");
  });

  it("accepts bounded sequential retries reusing the original socket source", () => {
    expect(assertNativeProxyRefusalTrace({
      traceEvents: Array.from({ length: 8 }, (_, index) => evidence(61, "0x1", 100 + index * 10)).flat(),
    })).toBe("tcp_connection_refused");
  });

  it("accepts interleaved complete independent socket sources", () => {
    const first = evidence();
    const second = evidence(111, "0x2");
    expect(assertNativeProxyRefusalTrace({
      traceEvents: first.flatMap((event, index) => [event, second[index]]),
    })).toBe("tcp_connection_refused");
  });

  it.each([
    ["too many same-source retries", () => Array.from({ length: 9 }, (_, index) => evidence(61, "0x1", index * 10)).flat()],
    ["truncated second cycle", () => [...evidence(), ...evidence(61, "0x1", 200).slice(0, 3)]],
    ["overlapping cycles", () => [...evidence().slice(0, 2), ...evidence(61, "0x1", 200), ...evidence().slice(2)]],
    ["backward retry timestamp", () => [...evidence(), ...evidence(61, "0x1", 90)]],
    ["end before begin", () => evidence().toReversed()],
    ["swapped end phases", () => { const events = evidence(); return [events[0], events[1], events[3], events[2]]; }],
  ] as const)("rejects %s", (_name, records) => {
    expect(() => assertNativeProxyRefusalTrace({ traceEvents: records() })).toThrow("native_proxy_trace_rejected");
  });

  const malformed: [string, () => unknown][] = [
    ["undefined", () => undefined],
    ["null", () => null],
    ["string", () => "unknown"],
    ["missing events", () => ({})],
    ["non-array events", () => ({ traceEvents: {} })],
    ["empty events", () => ({ traceEvents: [] })],
    ["unknown events only", () => ({ traceEvents: [{ name: "UNKNOWN" }] })],
    ["null record", () => ({ traceEvents: [...evidence(), null] })],
    ["primitive record", () => ({ traceEvents: [...evidence(), 5] })],
    ["oversized event list", () => ({ traceEvents: Array.from({ length: 10001 }, () => ({ name: "other" })) })],
    ["too many sources", () => ({ traceEvents: Array.from({ length: 9 }, (_, i) => evidence(61, `0x${i}`)).flat() })],
  ];
  it.each(malformed)("rejects %s", (_name, input) => {
    expect(() => assertNativeProxyRefusalTrace(input())).toThrow("native_proxy_trace_rejected");
  });

  for (let index = 0; index < 4; index++) {
    it(`rejects missing record ${index}`, () => {
      expect(() => assertNativeProxyRefusalTrace({
        traceEvents: evidence().filter((_, i) => i !== index),
      })).toThrow("native_proxy_trace_rejected");
    });
    it(`rejects duplicate record ${index}`, () => {
      const events = evidence();
      expect(() => assertNativeProxyRefusalTrace({
        traceEvents: [...events, events[index]],
      })).toThrow("native_proxy_trace_rejected");
    });
  }

  const mutations: [string, number, Record<string, unknown>][] = [
    ["wrong category", 0, { cat: "other" }],
    ["wrong phase", 0, { ph: "X" }],
    ["unknown connection name", 0, { name: "TCP_CONNECT_UNKNOWN" }],
    ["negative PID", 0, { pid: -1 }],
    ["fractional PID", 0, { pid: 1.5 }],
    ["string PID", 0, { pid: "42" }],
    ["missing thread", 0, { tid: undefined }],
    ["negative thread", 0, { tid: -1 }],
    ["different thread for same source", 1, { tid: 8 }],
    ["missing timestamp", 0, { ts: undefined }],
    ["negative timestamp", 0, { ts: -1 }],
    ["non-finite timestamp", 0, { ts: Number.POSITIVE_INFINITY }],
    ["NaN timestamp", 0, { ts: Number.NaN }],
    ["unsafe timestamp", 0, { ts: Number.MAX_SAFE_INTEGER + 1 }],
    ["backward event timestamp", 1, { ts: 99 }],
    ["missing local source", 0, { id2: {} }],
    ["global source", 0, { id2: { global: "0x1" } }],
    ["ambiguous source namespace", 0, { id2: { local: "0x1", global: "0x1" } }],
    ["non-hex source", 0, { id2: { local: "socket" } }],
    ["unpaired source", 1, { id2: { local: "0x2" } }],
    ["same source in different process", 1, { pid: 43 }],
    ["missing args", 0, { args: undefined }],
    ["missing parameters", 0, { args: { source_type: "SOCKET" } }],
    ["wrong source type", 0, { args: { source_type: "URL_REQUEST", params: { address_list: ["127.0.0.1:65534"], net_error: -102 } } }],
    ["success", 0, { args: { source_type: "SOCKET", params: { address_list: ["127.0.0.1:65534"], net_error: 0 } } }],
    ["reset", 0, { args: { source_type: "SOCKET", params: { address_list: ["127.0.0.1:65534"], net_error: -101 } } }],
    ["no network error", 0, { args: { source_type: "SOCKET", params: { address_list: ["127.0.0.1:65534"] } } }],
    ["string network error", 0, { args: { source_type: "SOCKET", params: { address_list: ["127.0.0.1:65534"], net_error: "-102" } } }],
    ["different connect endpoint", 0, { args: { source_type: "SOCKET", params: { address_list: ["127.0.0.1:65533"], net_error: -102 } } }],
    ["multiple connect endpoints", 0, { args: { source_type: "SOCKET", params: { address_list: ["127.0.0.1:65534", "127.0.0.1:65533"], net_error: -102 } } }],
    ["empty connect endpoints", 0, { args: { source_type: "SOCKET", params: { address_list: [], net_error: -102 } } }],
    ["no OS error", 1, { args: { source_type: "SOCKET", params: { address: "127.0.0.1:65534" } } }],
    ["OS success", 1, { args: { source_type: "SOCKET", params: { address: "127.0.0.1:65534", os_error: 0 } } }],
    ["Darwin reset", 1, { args: { source_type: "SOCKET", params: { address: "127.0.0.1:65534", os_error: 54 } } }],
    ["Linux reset", 1, { args: { source_type: "SOCKET", params: { address: "127.0.0.1:65534", os_error: 104 } } }],
    ["OS timeout", 1, { args: { source_type: "SOCKET", params: { address: "127.0.0.1:65534", os_error: 110 } } }],
    ["string OS error", 1, { args: { source_type: "SOCKET", params: { address: "127.0.0.1:65534", os_error: "61" } } }],
    ["different attempt endpoint", 1, { args: { source_type: "SOCKET", params: { address: "127.0.0.1:65533", os_error: 61 } } }],
    ["IPv6 alias", 1, { args: { source_type: "SOCKET", params: { address: "[::1]:65534", os_error: 61 } } }],
    ["conflicting end parameters", 3, { args: { params: { net_error: 0 } } }],
    ["wrong end source type", 3, { args: { source_type: "URL_REQUEST" } }],
  ];
  it.each(mutations)("rejects %s", (_name, index, patch) => {
    const events: unknown[] = evidence();
    events[index] = { ...evidence()[index], ...patch };
    expect(() => assertNativeProxyRefusalTrace({ traceEvents: events })).toThrow("native_proxy_trace_rejected");
  });
});

function harness(options: {
  competing?: boolean;
  navigation?: "success" | "reset";
  loss?: boolean;
  missingStream?: boolean;
  data?: string;
  base64?: boolean;
  noEof?: boolean;
} = {}) {
  const session = new EventEmitter();
  const close = vi.fn(async () => {});
  const detach = vi.fn(async () => {});
  const send = vi.fn(async (method: string) => {
    if (method === "Tracing.start" && options.competing) throw new Error("already tracing");
    if (method === "Tracing.end") {
      queueMicrotask(() => session.emit("Tracing.tracingComplete", {
        stream: options.missingStream ? undefined : "owned", dataLossOccurred: !!options.loss,
      }));
    }
    if (method === "IO.read") {
      const data = options.data ?? JSON.stringify({ traceEvents: evidence() });
      return { data: options.base64 ? Buffer.from(data).toString("base64") : data,
        base64Encoded: !!options.base64, eof: !options.noEof };
    }
    return {};
  });
  Object.assign(session, { send, detach });
  const newPage = vi.fn(async () => ({
    close,
    goto: vi.fn(async () => {
      if (options.navigation === "success") return;
      throw new Error(`page.goto: net::${options.navigation === "reset" ? "ERR_CONNECTION_RESET" : "ERR_PROXY_CONNECTION_FAILED"} at https://example.com/\nCall log:`);
    }),
  }));
  const context = {
    browser: () => ({ newBrowserCDPSession: async () => session }), newPage,
  } as unknown as BrowserContext;
  return { context, send, close, detach, newPage };
}

describe("bounded refusal trace acquisition", () => {
  it.each([false, true])("discards the owned stream and closes resources (base64=%s)", async (base64) => {
    const fake = harness({ base64 });
    await expect(verifyNativeProxyRefusal(fake.context, () => {})).resolves.toBeUndefined();
    expect(fake.send).toHaveBeenCalledWith("IO.read", { handle: "owned", size: 65536 });
    expect(fake.send).toHaveBeenCalledWith("IO.close", { handle: "owned" });
    expect(fake.close).toHaveBeenCalledOnce();
    expect(fake.detach).toHaveBeenCalledOnce();
  });

  it("does not stop another caller's trace or open a page", async () => {
    const fake = harness({ competing: true });
    await expect(verifyNativeProxyRefusal(fake.context, () => {})).rejects.toThrow("native_proxy_endpoint_unconfirmed");
    expect(fake.send.mock.calls.map(([method]) => method)).toEqual(["Tracing.start"]);
    expect(fake.newPage).not.toHaveBeenCalled();
    expect(fake.detach).toHaveBeenCalledOnce();
  });

  it.each([
    ["success despite refusal-shaped evidence", { navigation: "success" as const }],
    ["reset navigation", { navigation: "reset" as const }],
    ["trace data loss", { loss: true }],
    ["missing stream", { missingStream: true }],
    ["truncated JSON", { data: '{"traceEvents":[' }],
    ["unknown JSON", { data: "{}" }],
    ["oversized decoded stream", { data: " ".repeat(1024 * 1024 + 1) }],
    ["oversized base64 stream", { data: " ".repeat(1024 * 1024 + 1), base64: true }],
    ["unterminated stream", { noEof: true }],
  ])("rejects %s and still closes resources", async (_name, options) => {
    const fake = harness(options);
    await expect(verifyNativeProxyRefusal(fake.context, () => {})).rejects.toThrow("native_proxy_endpoint_unconfirmed");
    expect(fake.close).toHaveBeenCalledOnce();
    expect(fake.detach).toHaveBeenCalledOnce();
    expect(fake.send.mock.calls.filter(([method]) => method === "IO.read").length).toBeLessThanOrEqual(32);
    if (!("missingStream" in options)) expect(fake.send).toHaveBeenCalledWith("IO.close", { handle: "owned" });
  });

  it("stops its own trace when cancellation happens after start", async () => {
    const fake = harness();
    const assertActive = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => {
      throw new Error("cancelled");
    });
    await expect(verifyNativeProxyRefusal(fake.context, assertActive)).rejects.toThrow("native_proxy_endpoint_unconfirmed");
    expect(fake.send.mock.calls.map(([method]) => method)).toEqual(["Tracing.start", "Tracing.end"]);
    expect(fake.newPage).not.toHaveBeenCalled();
    expect(fake.detach).toHaveBeenCalledOnce();
  });
});
