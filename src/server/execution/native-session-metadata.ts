import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";

const sessionSchema = z.strictObject({
  id: z.uuid(),
  connectUrl: z.string().max(4096).url().refine((value) => new URL(value).protocol === "wss:"),
  region: z.enum(["us-west-2", "us-east-1", "eu-central-1", "ap-southeast-1"]).optional(),
});

/** One-use local metadata, not a proxy: no request can dispatch provider traffic. */
export async function serveNativeSessionMetadata(options: {
  session: z.infer<typeof sessionSchema>;
  apiKey: string;
  signal: AbortSignal;
  assertActive: () => void;
}) {
  const session = sessionSchema.parse(options.session);
  const key = Buffer.from(z.string().min(1).max(2048).parse(options.apiKey));
  const payload = Buffer.from(JSON.stringify(session));
  let consumed = false;
  let failed = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const server = createServer({
    maxHeaderSize: 4096, requestTimeout: 1000, headersTimeout: 1000,
    connectionsCheckingInterval: 100, keepAliveTimeout: 1,
  }, (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("connection", "close");
    try {
      options.signal.throwIfAborted();
      options.assertActive();
      const supplied = request.headers["x-bb-api-key"];
      const auth = typeof supplied === "string" ? Buffer.from(supplied) : Buffer.alloc(0);
      const names = request.rawHeaders.filter((_value, index) => index % 2 === 0).map((name) => name.toLowerCase());
      if (closed || failed || consumed || request.method !== "GET"
        || names.length > 24 || new Set(names).size !== names.length
        || request.url !== `/v1/sessions/${session.id}`
        || request.headers.host !== `127.0.0.1:${port}`
        || request.headers.origin !== undefined || request.headers.cookie !== undefined
        || request.headers.cookie2 !== undefined || request.headers.authorization !== undefined
        || request.headers.referer !== undefined
        || request.headers["transfer-encoding"] !== undefined
        || request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0"
        || auth.length !== key.length || !timingSafeEqual(auth, key)) {
        throw new Error("native_metadata_request_denied");
      }
      consumed = true;
      response.writeHead(200, { "content-type": "application/json", "content-length": payload.length });
      response.end(payload);
    } catch {
      failed = true;
      response.writeHead(403, { "content-length": "0" });
      response.end();
    }
  });
  server.maxHeadersCount = 0;
  server.maxRequestsPerSocket = 1;
  server.maxConnections = 4;
  server.on("connection", (socket) => {
    const deadline = setTimeout(() => socket.destroy(), 2000);
    socket.setTimeout(1000, () => socket.destroy());
    socket.once("close", () => clearTimeout(deadline));
  });
  server.on("clientError", (_error, socket) => {
    failed = true;
    socket.destroy();
  });
  const close = () => closing ??= (async () => {
    closed = true;
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(new Error("native_metadata_close_failed")) : resolve());
    });
    key.fill(0);
    payload.fill(0);
  })();
  const abort = () => { failed = true; };
  let port = 0;
  try {
    options.signal.throwIfAborted();
    options.assertActive();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("native_metadata_address_unavailable");
    port = address.port;
    server.removeAllListeners("error");
    server.on("error", abort);
    options.signal.addEventListener("abort", abort, { once: true });
    options.signal.throwIfAborted();
    options.assertActive();
    timer = setTimeout(() => { if (!consumed) failed = true; }, 5000);
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      assertConsumed() {
        if (!consumed || failed) throw new Error("native_metadata_unconfirmed");
      },
      // Caller must first settle SDK GET/connect/retry work; never recycle its port early.
      close,
    };
  } catch {
    await close();
    throw new Error("native_metadata_unavailable");
  }
}
