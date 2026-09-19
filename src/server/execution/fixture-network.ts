import { request } from "node:http";
import type { BrowserContext, Page } from "playwright-core";

export const FIXTURE_ORIGIN = "https://fixture.flash-flood.invalid";
export const fixtureRoutes = new Set([
  "/demo", "/demo/category/home", "/demo/category/paper", "/demo/product/mug",
  "/demo/product/candle", "/demo/product/journal", "/demo/cart", "/demo/checkout",
  "/demo/checkout/review", "/demo/complete",
]);
export type FixtureResponse = { status: number; contentType: string; body: Buffer };
export type FixtureSource = (url: URL) => Promise<FixtureResponse>;
export type NetworkSignal = { code: string; url: string };

export function isGatewayControlRequest(url: string, method: string, initiator: string, extensionOrigin?: string): boolean {
  if (!extensionOrigin || !/^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin)) return false;
  return (initiator === `${extensionOrigin}/service-worker.js`
    || initiator === `${extensionOrigin}/offscreen/service-worker-heartbeat.html`)
    && url === "https://api.stagehand.browserbase.com/v1/llm/responses" && method === "POST";
}

export function isFixtureRequest(raw: string, document = false): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.origin !== FIXTURE_ORIGIN || url.username || url.password || url.hash) return false;
  if (fixtureRoutes.has(url.pathname)) return !url.search;
  if (document) return false;
  if (url.pathname === "/demo/cart-summary") {
    return [...url.searchParams.keys()].length === 1
      && ["fixed", "broken"].includes(url.searchParams.get("variant") ?? "");
  }
  return /^\/_next\/static\/[a-zA-Z0-9/_@.-]+\.(?:js|css|woff2?)$/.test(url.pathname)
    && !url.pathname.includes("..") && !url.search;
}

// The browser never connects to this address. Only this trusted, fixed fixture
// transport can reach it, without forwarding browser headers or following redirects.
export function localFixtureSource(port: number): FixtureSource {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid fixture port");
  return async (url) => {
    if (!isFixtureRequest(url.href)) throw new Error("Fixture transport scope violation");
    return new Promise((resolve, reject) => {
      const req = request({
        hostname: "127.0.0.1", port, path: url.pathname + url.search, method: "GET",
        headers: { accept: "*/*", "accept-encoding": "identity" },
      }, (response) => {
        const status = response.statusCode ?? 500;
        if (status >= 300 && status < 400) {
          response.destroy();
          reject(new Error("Fixture redirects are unsupported"));
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) {
            response.destroy(new Error("Fixture response limit"));
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => resolve({
          status, contentType: response.headers["content-type"] ?? "application/octet-stream",
          body: Buffer.concat(chunks),
        }));
      });
      req.setTimeout(5000, () => req.destroy(new Error("Fixture transport timeout")));
      req.on("error", reject);
      req.end();
    });
  };
}

export const FIXTURE_CSP = [
  "default-src 'none'", "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'", "font-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "worker-src 'none'", "frame-src 'none'", "child-src 'none'",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");

/**
 * A replay transport for OUR trusted fixture code, not an arbitrary-site sandbox.
 * No route continues or falls back to the browser network. Unknown content is
 * not accepted; arbitrary-site execution must remain gated at the factory.
 */
export async function installFixtureNetwork(
  context: BrowserContext,
  page: Page,
  source: FixtureSource,
  onSignal: (signal: NetworkSignal) => void,
  extensionOrigin?: string,
): Promise<{ close(): Promise<void>; errors: string[] }> {
  const errors: string[] = [];
  const pending = new Set<Promise<void>>();
  const track = (work: Promise<void>) => {
    pending.add(work);
    void work.catch(() => { errors.push("network_handler_failed"); }).finally(() => pending.delete(work));
  };
  await context.clearPermissions();
  await context.addInitScript(() => {
    const policy = {
      deny() { throw new Error("FLASH_FLOOD_UNSUPPORTED_CHANNEL"); },
      open() { return null; },
    };
    for (const name of ["Worker", "SharedWorker", "WebTransport", "RTCPeerConnection", "webkitRTCPeerConnection"]) {
      Object.defineProperty(globalThis, name, { value: policy.deny, configurable: false, writable: false });
    }
    Object.defineProperty(window, "open", { value: policy.open, configurable: false, writable: false });
    if ("serviceWorker" in navigator) {
      Object.defineProperty(navigator.serviceWorker, "register", { value: policy.deny, configurable: false, writable: false });
    }
  });
  await context.routeWebSocket(/.*/, (socket) => {
    onSignal({ code: "websocket_denied", url: socket.url() });
    socket.close();
  });
  await context.route(/.*/, async (route) => {
    const req = route.request();
    const url = req.url();
    let initiator = req.serviceWorker()?.url() ?? "";
    if (!initiator) {
      try { initiator = req.frame().url(); } catch { /* Requests without an initiator are denied. */ }
    }
    if (isGatewayControlRequest(url, req.method(), initiator, extensionOrigin)) {
      // Stagehand's trusted extension makes Gateway calls inside the browser.
      // A fixture frame cannot use this exception, even at the same URL.
      try {
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30000 });
        if (response.status() >= 300 && response.status() < 400) {
          errors.push("gateway_redirect_denied");
          await route.abort("blockedbyclient");
        } else await route.fulfill({ response });
      } catch (error) {
        errors.push(error instanceof Error && /timed out|Timeout/.test(error.message) ? "gateway_transport_timeout" : "gateway_transport_failed");
        await route.abort("failed");
      }
      return;
    }
    const document = req.isNavigationRequest();
    let allowed = req.method() === "GET" && isFixtureRequest(url, document);
    try {
      allowed &&= req.frame().page() === page;
      if (document) allowed &&= req.frame() === page.mainFrame();
    } catch { allowed = false; }
    if (!allowed) {
      onSignal({ code: "request_denied", url });
      await route.abort("blockedbyclient");
      return;
    }
    try {
      const result = await source(new URL(url));
      if (result.status >= 300 && result.status < 400) throw new Error("Redirect denied");
      await route.fulfill({
        status: result.status, body: result.body,
        headers: {
          "content-type": result.contentType, "content-security-policy": FIXTURE_CSP,
          "cache-control": "no-store", "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer", "permissions-policy": "camera=(), microphone=(), geolocation=()",
        },
      });
    } catch {
      errors.push("fixture_transport_failed");
      onSignal({ code: "fixture_transport_failed", url });
      await route.abort("failed");
    }
  });
  const onPage = (tab: Page) => {
    if (tab !== page) {
      onSignal({ code: "popup_denied", url: tab.url() });
      track(tab.close());
    }
  };
  context.on("page", onPage);
  context.on("serviceworker", () => {
    errors.push("unexpected_service_worker");
    track(page.close());
  });
  page.on("worker", () => {
    errors.push("unexpected_worker");
    track(page.close());
  });
  page.on("download", (download) => track(download.cancel()));
  page.on("dialog", (dialog) => track(dialog.dismiss()));
  return {
    errors,
    async close() {
      context.off("page", onPage);
      await Promise.allSettled([...pending]);
      // Routing must stay installed until the context is closed.
    },
  };
}
