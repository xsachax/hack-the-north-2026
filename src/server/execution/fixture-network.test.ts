import { describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page, Request, Route } from "playwright-core";
import {
  FIXTURE_ORIGIN, installFixtureNetwork, isFixtureRequest,
  isGatewayControlRequest, localFixtureSource,
} from "./fixture-network";

const extension = `chrome-extension://${"a".repeat(32)}`;
const gateway = "https://api.stagehand.browserbase.com/v1/llm/responses";

describe("fixture URL allowlist", () => {
  it.each([
    "/demo", "/demo/category/home", "/demo/category/paper", "/demo/product/mug",
    "/demo/product/candle", "/demo/product/journal", "/demo/cart", "/demo/checkout",
    "/demo/checkout/review", "/demo/complete",
  ])("allows the exact fixture document %s", (path) => {
    expect(isFixtureRequest(`${FIXTURE_ORIGIN}${path}`, true)).toBe(true);
  });

  it.each([
    "/demo/cart-summary?variant=fixed", "/demo/cart-summary?variant=broken",
    "/_next/static/chunks/app.js", "/_next/static/css/app.css",
    "/_next/static/media/font.woff", "/_next/static/media/font.woff2",
  ])("allows a fixture subresource, but not a document: %s", (path) => {
    expect(isFixtureRequest(`${FIXTURE_ORIGIN}${path}`)).toBe(true);
    expect(isFixtureRequest(`${FIXTURE_ORIGIN}${path}`, true)).toBe(false);
  });

  it.each([
    "", "/demo", "not a URL", "https://example.com/demo", "http://127.0.0.1:4317/demo",
    "http://localhost/demo", "http://10.0.0.1/demo", "http://169.254.169.254/demo",
    "http://[::1]/demo", "file:///demo", "data:text/html,hello",
    "http://fixture.flash-flood.invalid/demo", "ws://fixture.flash-flood.invalid/demo",
    "https://fixture.flash-flood.invalid.example.com/demo",
    "https://fixture.flash-flood.invalid@evil.invalid/demo",
    "https://user:password@fixture.flash-flood.invalid/demo",
    "https://fixture.flash-flood.invalid:444/demo",
    `${FIXTURE_ORIGIN}/demo#secret`, `${FIXTURE_ORIGIN}/demo?variant=fixed`,
    `${FIXTURE_ORIGIN}/api/v1/runs`, `${FIXTURE_ORIGIN}/demo-fixtures`,
    `${FIXTURE_ORIGIN}/demo/../api/v1/runs`, `${FIXTURE_ORIGIN}/demo/%2e%2e/demo-fixtures`,
    `${FIXTURE_ORIGIN}/demo/%2f..%2fapi/v1/runs`,
    `${FIXTURE_ORIGIN}/_next/static/../../../api/v1/runs`,
    `${FIXTURE_ORIGIN}/_next/static/%2e%2e/%2e%2e/api.js`,
    `${FIXTURE_ORIGIN}/_next/static/%2f..%2fprivate.js`,
    `${FIXTURE_ORIGIN}/_next/image?url=http://127.0.0.1`,
    `${FIXTURE_ORIGIN}/_next/static/secret.json`,
    `${FIXTURE_ORIGIN}/_next/static/app.js?url=https://example.com`,
    `${FIXTURE_ORIGIN}/demo/cart-summary`, `${FIXTURE_ORIGIN}/demo/cart-summary?variant=unknown`,
    `${FIXTURE_ORIGIN}/demo/cart-summary?variant=fixed&variant=broken`,
    `${FIXTURE_ORIGIN}/demo/cart-summary?variant=fixed&delay=10000`,
    `${FIXTURE_ORIGIN}/demo/cart-summary?variant=fixed&url=http://127.0.0.1`,
  ])("denies non-fixture URL %s", (url) => {
    expect(isFixtureRequest(url)).toBe(false);
    expect(isFixtureRequest(url, true)).toBe(false);
  });

  it.each([0, 80, 1023, 65536, 4317.5, NaN, Infinity])("rejects invalid transport port %s", (port) => {
    expect(() => localFixtureSource(port)).toThrow();
  });

  it("rejects forbidden URLs before opening the local fixture transport", async () => {
    const source = localFixtureSource(4317);
    await expect(source(new URL("http://127.0.0.1:4317/api/v1/runs"))).rejects.toThrow();
  });
});

describe("Gateway browser-derived initiator allowlist", () => {
  it.each(["service-worker.js", "offscreen/service-worker-heartbeat.html"])(
    "allows the launched extension's exact %s document and POST endpoint",
    (path) => expect(isGatewayControlRequest(gateway, "POST", `${extension}/${path}`, extension)).toBe(true),
  );

  it.each([
    "", "about:blank", `${FIXTURE_ORIGIN}/demo`, `${FIXTURE_ORIGIN}/service-worker.js`,
    "https://example.com/service-worker.js", extension, `${extension}/page.html`,
    `${extension}/service-worker.js?trusted=true`, `${extension}/service-worker.js#trusted`,
    `${extension}/offscreen/service-worker-heartbeat.html/other`,
    `chrome-extension://${"b".repeat(32)}/service-worker.js`,
  ])("denies a page, worker, missing, or untrusted initiator %s", (initiator) => {
    expect(isGatewayControlRequest(gateway, "POST", initiator, extension)).toBe(false);
  });

  it.each([
    `${gateway}/`, `${gateway}?redirect=true`, `${gateway}#trusted`,
    "http://api.stagehand.browserbase.com/v1/llm/responses",
    "https://api.stagehand.browserbase.com/v1/llm/responses/../other",
    "https://api.stagehand.browserbase.com.evil.invalid/v1/llm/responses",
    "https://example.com/redirected-response",
  ])("denies mismatched or redirected Gateway endpoint %s", (url) => {
    expect(isGatewayControlRequest(url, "POST", `${extension}/service-worker.js`, extension)).toBe(false);
  });

  it.each(["GET", "PUT", "OPTIONS", "post"])("requires literal POST, not %s", (method) => {
    expect(isGatewayControlRequest(gateway, method, `${extension}/service-worker.js`, extension)).toBe(false);
  });

  it.each([undefined, "", "https://example.com", "chrome-extension://invalid", `chrome-extension://${"z".repeat(32)}`])(
    "requires a trusted launched extension origin: %s", (trusted) => {
      expect(isGatewayControlRequest(gateway, "POST", `${extension}/service-worker.js`, trusted)).toBe(false);
    },
  );

  it.each(["page", "frame", "worker", "missing"] as const)(
    "does not treat a spoofed Referer header as a trusted %s initiator", async (kind) => {
      let handler!: (route: Route) => Promise<void>;
      const page = { on: vi.fn(), mainFrame: vi.fn() } as unknown as Page;
      const context = {
        clearPermissions: vi.fn(), addInitScript: vi.fn(), routeWebSocket: vi.fn(),
        route: vi.fn(async (_pattern: unknown, callback: typeof handler) => { handler = callback; }),
        on: vi.fn(), off: vi.fn(),
      } as unknown as BrowserContext;
      const frame = { url: () => `${FIXTURE_ORIGIN}/demo`, page: () => page };
      const request = {
        url: () => gateway, method: () => "POST", isNavigationRequest: () => false,
        serviceWorker: () => kind === "worker" ? { url: () => `${FIXTURE_ORIGIN}/worker.js` } : null,
        frame: () => { if (kind === "missing" || kind === "worker") throw new Error("No frame"); return frame; },
        headers: () => ({ referer: `${extension}/service-worker.js`, origin: extension }),
      } as unknown as Request;
      const route = { request: () => request, abort: vi.fn(), fetch: vi.fn(), fulfill: vi.fn() };
      const source = vi.fn();
      const signal = vi.fn();
      const network = await installFixtureNetwork(context, page, source, signal, extension);
      await handler(route as unknown as Route);
      expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
      expect(route.fetch).not.toHaveBeenCalled();
      expect(route.fulfill).not.toHaveBeenCalled();
      expect(source).not.toHaveBeenCalled();
      expect(signal).toHaveBeenCalledWith({ code: "request_denied", url: gateway });
      await network.close();
    },
  );
});
