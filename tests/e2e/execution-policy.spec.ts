import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect, type BrowserContext, type Page, type Route } from "@playwright/test";
import {
  FIXTURE_ORIGIN, installFixtureNetwork, localFixtureSource,
  type FixtureSource, type NetworkSignal,
} from "../../src/server/execution/fixture-network";

const gateway = "https://api.stagehand.browserbase.com/v1/llm/responses";
const extension = `chrome-extension://${"a".repeat(32)}`;

async function policy(context: BrowserContext, page: Page, source = localFixtureSource(4317)) {
  const sourceCalls: string[] = [];
  const fulfilled: string[] = [];
  const escapes: string[] = [];
  const signals: NetworkSignal[] = [];
  // Observe route decisions and fail closed even if a regression would contact a provider.
  const guardedContext = new Proxy(context, {
    get(target, name) {
      if (name === "route") {
        return (pattern: string | RegExp, handler: (route: Route) => Promise<void>) =>
          target.route(pattern, (route) => handler(new Proxy(route, {
            get(actual, operation) {
              if (["continue", "fallback", "fetch"].includes(String(operation))) {
                return async () => {
                  escapes.push(`${String(operation)} ${actual.request().url()}`);
                  await actual.abort("blockedbyclient");
                };
              }
              if (operation === "fulfill") {
                return async (options: Parameters<Route["fulfill"]>[0]) => {
                  fulfilled.push(actual.request().url());
                  await actual.fulfill(options);
                };
              }
              const value = Reflect.get(actual, operation);
              return typeof value === "function" ? value.bind(actual) : value;
            },
          })));
      }
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const network = await installFixtureNetwork(guardedContext, page, async (url) => {
    sourceCalls.push(url.href);
    return source(url);
  }, (signal) => signals.push(signal), extension);
  return { ...network, sourceCalls, fulfilled, escapes, signals };
}

async function privateTrap() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" });
    response.end("private listener must not be reached");
  });
  server.on("upgrade", (request, socket) => {
    requests.push(`UPGRADE ${request.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin, requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

test("the real fixture completes checkout through fulfilled virtual-origin responses only", async ({ context, page }) => {
  const network = await policy(context, page);
  const responses: string[] = [];
  page.on("response", (response) => responses.push(response.url()));
  try {
    const response = await page.goto(`${FIXTURE_ORIGIN}/demo/category/home`);
    expect(response?.headers()["content-security-policy"]).toContain("worker-src 'none'");
    await page.getByRole("link", { name: "Maple ceramic mug", exact: true }).click();
    await page.getByRole("button", { name: "Add to cart", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Maple ceramic mug added to cart.");
    await page.getByRole("link", { name: "View cart", exact: true }).click();
    await page.getByRole("button", { name: "Add gift wrap (+CA$3)", exact: true }).click();
    await page.getByRole("button", { name: "Continue to delivery", exact: true }).click();
    await page.getByRole("textbox", { name: "Canadian postal code", exact: true }).fill("N2L 3G1");
    await page.getByRole("button", { name: "Review order", exact: true }).click();
    await page.getByRole("button", { name: "Place demo order", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Thank you! Your demo order is complete.", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Thank you! Your demo order is complete.", exact: true })).toBeVisible();
    expect(network.sourceCalls).toContain(`${FIXTURE_ORIGIN}/demo/cart-summary?variant=fixed`);
    expect(network.sourceCalls.some((url) => url.includes("/_next/static/"))).toBe(true);
    expect(network.sourceCalls.every((url) => new URL(url).origin === FIXTURE_ORIGIN)).toBe(true);
    expect(network.fulfilled.toSorted()).toEqual(network.sourceCalls.toSorted());
    expect(responses.every((url) => network.fulfilled.includes(url))).toBe(true);
    expect(network.escapes).toEqual([]);
    expect(network.errors).toEqual([]);
  } finally {
    await network.close();
  }
});

for (const bypassCSP of [false, true]) {
  test.describe(`unsupported channels with CSP ${bypassCSP ? "bypassed to exercise routing" : "enforced"}`, () => {
    test.use({ bypassCSP });

    test("page channels cannot reach a private listener or enter the trusted source", async ({ context, page }) => {
      const trap = await privateTrap();
      const network = await policy(context, page);
      try {
        const response = await page.goto(`${FIXTURE_ORIGIN}/demo`);
        const csp = response!.headers()["content-security-policy"];
        for (const directive of ["worker-src 'none'", "frame-src 'none'", "form-action 'none'", "connect-src 'self'"]) {
          expect(csp).toContain(directive);
        }
        await expect(page.getByRole("heading", { name: "A little joy, under $50.", exact: true })).toBeVisible();
        const violations: string[] = [];
        await page.exposeFunction("recordViolation", (directive: string) => violations.push(directive));
        const result = await page.evaluate(async (origin) => {
          document.addEventListener("securitypolicyviolation", (event) => {
            void (window as unknown as { recordViolation(value: string): Promise<void> }).recordViolation(event.effectiveDirective);
          });
          const denied: Record<string, string> = {};
          for (const name of ["Worker", "SharedWorker", "RTCPeerConnection", "webkitRTCPeerConnection", "WebTransport"]) {
            try {
              const Constructor = (globalThis as unknown as Record<string, new (url: string) => object>)[name];
              new Constructor(`${origin}/${name}`);
              denied[name] = "unexpectedly allowed";
            } catch (error) { denied[name] = (error as Error).message; }
          }
          try { await navigator.serviceWorker.register(`${origin}/sw.js`); denied.serviceWorker = "unexpectedly allowed"; }
          catch (error) { denied.serviceWorker = (error as Error).message; }
          denied.popup = String(window.open(`${origin}/popup`) === null);
          const image = new Image();
          const imageDone = new Promise<void>((resolve) => { image.onload = image.onerror = () => resolve(); });
          image.src = `${origin}/image`;
          document.body.append(image);
          const frame = document.createElement("iframe");
          frame.src = `${origin}/frame`;
          document.body.append(frame);
          const form = document.createElement("form");
          form.action = `${origin}/form`;
          form.method = "POST";
          form.target = "forbidden-form-target";
          document.body.append(form);
          form.submit();
          const fetchResult = await fetch(`${origin}/fetch`).then(() => "unexpectedly allowed", () => "rejected");
          await imageDone;
          return { denied, fetchResult };
        }, trap.origin);
        for (const name of ["Worker", "SharedWorker", "RTCPeerConnection", "webkitRTCPeerConnection", "WebTransport", "serviceWorker"]) {
          // The denial function can be callable but deliberately non-constructible.
          expect(result.denied[name], name).toMatch(/^(FLASH_FLOOD_UNSUPPORTED_CHANNEL|Constructor is not a constructor)$/);
        }
        expect(result.denied.popup).toBe("true");
        expect(result.fetchResult).toBe("rejected");
        if (!bypassCSP) {
          await expect.poll(() => violations).toEqual(expect.arrayContaining(["connect-src", "img-src", "frame-src", "form-action"]));
        } else {
          for (const path of ["fetch", "image", "frame"]) {
            await expect.poll(() => network.signals).toContainEqual({ code: "request_denied", url: `${trap.origin}/${path}` });
          }
        }
        expect(trap.requests).toEqual([]);
        expect(network.sourceCalls.some((url) => url.startsWith(trap.origin))).toBe(false);
        expect(network.escapes).toEqual([]);
      } finally {
        await context.close();
        await network.close();
        await trap.close();
      }
    });

    test("Gateway page fetches and spoofed extension headers never gain the control-plane exception", async ({ context, page }) => {
      const network = await policy(context, page);
      try {
        await context.setExtraHTTPHeaders({
          referer: `${extension}/service-worker.js`,
          origin: extension,
          "x-extension-origin": extension,
        });
        await page.goto(`${FIXTURE_ORIGIN}/demo`);
        const outcome = await page.evaluate(async (url) => {
          return fetch(url, { method: "POST", body: "{}" }).then(() => "allowed", () => "rejected");
        }, gateway);
        expect(outcome).toBe("rejected");
        expect(network.sourceCalls).not.toContain(gateway);
        expect(network.escapes).toEqual([]);
        if (bypassCSP) {
          expect(network.signals).toContainEqual({ code: "request_denied", url: gateway });
        }
      } finally {
        await network.close();
      }
    });
  });
}

test.describe("routing independent of CSP", () => {
  test.use({ bypassCSP: true });

  test("WebSocket is closed by the context route, never connected to the listener", async ({ context, page }) => {
    const trap = await privateTrap();
    const network = await policy(context, page);
    try {
      await page.goto(`${FIXTURE_ORIGIN}/demo`);
      const url = trap.origin.replace("http:", "ws:") + "/socket";
      const result = await page.evaluate((address) => new Promise<string>((resolve) => {
        const socket = new WebSocket(address);
        socket.onopen = () => resolve("opened");
        socket.onclose = () => resolve("closed");
        socket.onerror = () => resolve("error");
      }), url);
      expect(["closed", "error"]).toContain(result);
      expect(network.signals).toContainEqual({ code: "websocket_denied", url });
      expect(network.sourceCalls).not.toContain(url);
      expect(trap.requests).toEqual([]);
      expect(network.escapes).toEqual([]);
    } finally {
      await context.close();
      await network.close();
      await trap.close();
    }
  });

  test("same-origin operator, API, POST, and child-frame requests are denied before the source", async ({ context, page }) => {
    const network = await policy(context, page);
    try {
      await page.goto(`${FIXTURE_ORIGIN}/demo`);
      const denied = [
        `${FIXTURE_ORIGIN}/api/v1/runs`,
        `${FIXTURE_ORIGIN}/demo-fixtures`,
        `${FIXTURE_ORIGIN}/demo/cart-summary?variant=fixed&delay=10000`,
        `${FIXTURE_ORIGIN}/demo/product/mug`,
      ];
      const outcomes = await page.evaluate(async (urls) => {
        const outcomes = await Promise.all(urls.map((url, index) =>
          fetch(url, { method: index === 3 ? "POST" : "GET" }).then(() => "allowed", () => "rejected")));
        const frame = document.createElement("iframe");
        frame.src = `${location.origin}/demo/product/candle`;
        document.body.append(frame);
        return outcomes;
      }, denied);
      expect(outcomes).toEqual(denied.map(() => "rejected"));
      denied.push(`${FIXTURE_ORIGIN}/demo/product/candle`);
      for (const url of denied) {
        await expect.poll(() => network.signals).toContainEqual({ code: "request_denied", url });
        expect(network.sourceCalls).not.toContain(url);
      }
      expect(network.escapes).toEqual([]);
    } finally {
      await network.close();
    }
  });
});

test("external main-frame navigations abort before transport", async ({ context, page }) => {
  const trap = await privateTrap();
  const network = await policy(context, page);
  try {
    await page.goto(`${FIXTURE_ORIGIN}/demo`);
    await expect(page.goto(`${trap.origin}/navigation`)).rejects.toThrow();
    expect(network.signals).toContainEqual({ code: "request_denied", url: `${trap.origin}/navigation` });
    expect(network.sourceCalls.some((url) => url.startsWith(trap.origin))).toBe(false);
    expect(trap.requests).toEqual([]);
    expect(network.escapes).toEqual([]);
  } finally {
    await context.close();
    await network.close();
    await trap.close();
  }
});

test("new context pages cannot make even an initial allowed fixture request", async ({ context, page }) => {
  const network = await policy(context, page);
  try {
    await page.goto(`${FIXTURE_ORIGIN}/demo`);
    const before = network.sourceCalls.length;
    const other = await context.newPage().catch(() => null);
    if (other) await expect(other.goto(`${FIXTURE_ORIGIN}/demo/product/mug`)).rejects.toThrow();
    await expect.poll(() => network.signals.some((signal) => signal.code === "popup_denied")).toBe(true);
    expect(network.sourceCalls).toHaveLength(before);
    expect(network.sourceCalls).not.toContain(`${FIXTURE_ORIGIN}/demo/product/mug`);
    expect(network.escapes).toEqual([]);
  } finally {
    await network.close();
  }
});

test("a new target's initial navigation is blocked before it can contact a private listener", async ({ context, page }) => {
  const trap = await privateTrap();
  const network = await policy(context, page);
  try {
    await page.goto(`${FIXTURE_ORIGIN}/demo`);
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.send("Target.createTarget", {
      url: `${trap.origin}/initial-navigation`,
      browserContextId: targetInfo.browserContextId,
    });
    await expect.poll(() => network.signals.some((signal) => signal.code === "popup_denied")).toBe(true);
    expect(network.sourceCalls.some((url) => url.startsWith(trap.origin))).toBe(false);
    expect(trap.requests).toEqual([]);
    expect(network.escapes).toEqual([]);
    await session.detach();
  } finally {
    await context.close();
    await network.close();
    await trap.close();
  }
});

test("an injected fixture redirect is aborted rather than fulfilled or followed", async ({ context, page }) => {
  const redirect: FixtureSource = async () => ({
    status: 302, contentType: "text/html", body: Buffer.from("redirect must not be replayed"),
  });
  const network = await policy(context, page, redirect);
  try {
    await expect(page.goto(`${FIXTURE_ORIGIN}/demo`)).rejects.toThrow();
    expect(network.sourceCalls).toEqual([`${FIXTURE_ORIGIN}/demo`]);
    expect(network.fulfilled).toEqual([]);
    expect(network.signals).toContainEqual({ code: "fixture_transport_failed", url: `${FIXTURE_ORIGIN}/demo` });
    expect(network.errors).toContain("fixture_transport_failed");
    expect(network.escapes).toEqual([]);
  } finally {
    await network.close();
  }
});
