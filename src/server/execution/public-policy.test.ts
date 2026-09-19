import { describe, expect, it } from "vitest";
import { allowsNavigation } from "../../lib/controlled-sites";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../../lib/public-execution";
import { publicExecutionPolicy } from "./public-policy";
import { browserHeaderPermits, capturePublicBrowserHeaders } from "./public-browser-headers";

const input = () => ({
  executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY,
  scope: { targetUrl: "https://example.com/category/item", pathPrefixes: ["/category"], allowedSubdomains: ["shop.example.com"] },
});
describe("separate immutable navigation and public asset policy", () => {
  it("scopes navigation while explicitly allowing resource paths and third-party assets", () => {
    const policy = publicExecutionPolicy(input());
    for (const url of ["https://example.com/category/item?q=1", "https://shop.example.com/category/item"]) {
      expect(policy.authorize({ url, method: "GET", kind: "navigation" })).toBe(true);
      expect(allowsNavigation(policy.navigation, url)).toBe(true);
    }
    for (const url of ["https://example.com/assets/app.js", "https://cdn.example.net/font.woff2"]) {
      expect(policy.authorize({ url, method: "GET", kind: "navigation" })).toBe(false);
      expect(policy.authorize({ url, method: "GET", kind: "asset" })).toBe(true);
      expect(allowsNavigation(policy.navigation, url)).toBe(false);
    }
  });
  it("does not permit boundary/encoded-path tricks or unsupported schemes as navigation", () => {
    const policy = publicExecutionPolicy(input());
    for (const url of [
      "https://example.com/category-other", "https://example.com/category/%2e%2e/admin",
      "https://example.com/category/../admin", "https://example.com/category%2fadmin",
      "https://example.com.attacker.net/category/item", "http://example.com/category/item",
      "javascript:alert(1)", "file:///etc/passwd",
    ]) expect(allowsNavigation(policy.navigation, url), url).toBe(false);
  });
  it("keeps source policy immutable and rejects incomplete or unknown capability versions", () => {
    const submitted = input();
    const policy = publicExecutionPolicy(submitted);
    submitted.scope.pathPrefixes.push("/admin");
    expect(allowsNavigation(policy.navigation, "https://example.com/admin")).toBe(false);
    expect(() => publicExecutionPolicy({ ...input(), assetPolicy: "" })).toThrow("public_policy_unsupported");
    expect(() => publicExecutionPolicy({ ...input(), executionPolicy: "website" })).toThrow("public_policy_unsupported");
  });
  it.each(["api.browserbase.com", "api.stagehand.browserbase.com"])("never treats %s as a public-site asset or target", (host) => {
    const url = `https://${host}/v1/llm/responses`;
    expect(publicExecutionPolicy(input()).authorize({ url, method: "GET", kind: "asset" })).toBe(false);
    expect(() => publicExecutionPolicy({ ...input(), scope: {
      targetUrl: url, pathPrefixes: ["/"], allowedSubdomains: [],
    } })).toThrow("public_control_plane_denied");
  });
});

describe("captured browser header provenance permits", () => {
  it("retains browser negotiation/origin/referrer/cookies and translates only listed browser metadata", () => {
    expect(capturePublicBrowserHeaders("https://example.com/category/item", {
      Accept: "text/html", "Accept-Language": "en-US", Origin: "https://example.com",
      Referer: "https://example.com/category/", Cookie: "anonymous=1",
      Host: "example.com", Connection: "keep-alive", "Accept-Encoding": "gzip, br",
      "User-Agent": "Owned browser", "Sec-Fetch-Mode": "navigate", "Sec-CH-UA": '"Chromium";v="145"',
      "Upgrade-Insecure-Requests": "1",
    })).toEqual([
      ["accept", "text/html"], ["accept-language", "en-US"], ["cookie", "anonymous=1"],
      ["origin", "https://example.com"], ["referer", "https://example.com/category/"],
    ]);
  });
  it.each<Record<string, string>>([
    { Authorization: "Bearer never-forward" }, { "X-CSRF-Token": "owner-token" },
    { "Proxy-Authorization": "secret" }, { "X-Custom": "unsupported" },
    { "Access-Control-Request-Headers": "x-custom" }, { Host: "other.example" },
    { "Content-Length": "1" }, { Connection: "cookie" }, { Cookie: "a=1\r\nb=2" },
    { Accept: "x", accept: "y" },
  ])("rejects unsupported fields rather than silently dropping them: %j", (headers) => {
    expect(() => capturePublicBrowserHeaders("https://example.com/", headers)).toThrow("public_browser_headers_unsupported");
  });
  it("binds sensitive values to exact destination/method/kind for the whole in-flight request, never a redirect", () => {
    const permits = browserHeaderPermits();
    const context = { url: "https://example.com/category/item", method: "GET", kind: "navigation" } as const;
    const headers = capturePublicBrowserHeaders(context.url, { Cookie: "anonymous=1", Accept: "text/html" });
    const cookie = [["cookie", "anonymous=1"]] as const;
    expect(permits.authorize(context, cookie)).toBe(false);
    const revoke = permits.bind(context, headers);
    expect(permits.authorize(context, cookie)).toBe(true);
    expect(permits.authorize(context, cookie)).toBe(true);
    expect(permits.authorize({ ...context, url: "https://example.com/elsewhere" }, cookie)).toBe(false);
    expect(permits.authorize({ ...context, method: "HEAD" }, cookie)).toBe(false);
    expect(permits.authorize({ ...context, kind: "asset" }, cookie)).toBe(false);
    expect(permits.authorize({ ...context, redirectFrom: context.url }, cookie)).toBe(false);
    expect(permits.authorize(context, [["cookie", "owner-secret"]])).toBe(false);
    expect(permits.authorize(context, [["authorization", "Bearer provider"]])).toBe(false);
    revoke();
    expect(permits.authorize(context, cookie)).toBe(false);
  });
});
