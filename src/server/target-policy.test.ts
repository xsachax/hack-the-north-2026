import { afterEach, describe, expect, it, vi } from "vitest";
import { targetScopeSchema, type TargetScope } from "../lib/target-scope";
import {
  guardTargetUrl,
  TargetPolicyError,
  validateTargetScope,
  type PolicyOptions,
} from "./target-policy";

const publicV4 = { address: "93.184.216.34", family: 4 };
const publicV6 = { address: "2606:4700:4700::1111", family: 6 };
const options: PolicyOptions = { lookup: async () => [publicV4, publicV6] };
const scope: TargetScope = {
  targetUrl: "https://example.com/docs",
  allowedSubdomains: ["api.example.com"],
  pathPrefixes: ["/docs"],
};
const rootScope = (url: string): TargetScope => ({
  targetUrl: url,
  allowedSubdomains: [],
  pathPrefixes: ["/"],
});

describe("target scope schema", () => {
  it("is strict, requires a bounded nonempty path list, and defaults subdomains", () => {
    expect(targetScopeSchema.parse({ targetUrl: scope.targetUrl, pathPrefixes: ["/"] }))
      .toEqual({ targetUrl: scope.targetUrl, allowedSubdomains: [], pathPrefixes: ["/"] });
    for (const invalid of [
      { ...scope, extra: true },
      { ...scope, pathPrefixes: [] },
      { ...scope, pathPrefixes: Array(17).fill("/") },
      { ...scope, allowedSubdomains: Array(17).fill("api.example.com") },
      { ...scope, targetUrl: "" },
      { ...scope, pathPrefixes: [1] },
    ]) {
      expect(targetScopeSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("checks the schema at runtime without exposing validation input", async () => {
    await expect(validateTargetScope({ ...scope, extra: true } as TargetScope, options))
      .rejects.toMatchObject({ name: "TargetPolicyError", code: "invalid_scope" });
  });
});

describe("URL and host admission", () => {
  it.each([
    "https://example.com", "http://example.com:80/", "https://example.com:443/",
    "HTTPS://EXAMPLE.COM/", "https://8.8.8.8/", "https://1.1.1.1/",
    "https://[2606:4700:4700::1111]/",
    "https://[2606:4700:4700:0000:0000:0000:0000:1111]/",
    "https://xn--bcher-kva.de/",
  ])("allows an unambiguous public target: %s", async (url) => {
    await expect(validateTargetScope(rootScope(url), options)).resolves.toHaveProperty("targetUrl");
  });

  it.each([
    "file:///etc/passwd", "ftp://example.com", "data:text/plain,hello",
    "javascript:alert(1)", "//example.com", "https:example.com",
    "https:///example.com", "https://user:password@example.com",
    "https://@example.com", "https://example.com:80", "http://example.com:443",
    "https://example.com:8443", "https://example.com:", "https://example.com:0443",
    "https://example.com:0", "https://example.com:65536",
    "https://example.com.", "https://example..com", "https://example.com./",
    "https://localhost", "https://service", "https://service.local",
    "https://service.localhost", "https://service.internal", "https://service.home",
    "https://service.lan", "https://service.corp", "https://service.test",
    "https://service.invalid", "https://service.example", "https://service.onion",
    "https://service.arpa", "https://-example.com", "https://example-.com",
    "https://exam_ple.com", "https://bücher.de", "https://example.123",
    "https://2130706433", "https://0x7f000001", "https://017700000001",
    "https://127.1", "https://127.0.1", "https://0177.0.0.1",
    "https://0x7f.0.0.1", "https://127.000.000.001", "https://1.2.3.999",
    "https://%65xample.com", "https://example%2ecom", "https://example.com\\@evil.com/",
    "https://example.com\\docs", " https://example.com", "https://example.com ",
    "https://exam\tple.com", "https://example.com/\nsecret", "https://[fe80::1%25eth0]/",
  ])("rejects invalid or ambiguous authority: %s", async (url) => {
    const lookup = vi.fn(options.lookup!);
    await expect(validateTargetScope(rootScope(url), { lookup })).rejects.toBeInstanceOf(TargetPolicyError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "100.64.0.1", "100.100.100.200",
    "100.127.255.255", "127.0.0.1", "127.255.255.255", "169.254.169.254",
    "169.254.170.2", "172.16.0.1", "172.31.255.255", "192.0.0.9", "192.0.2.1",
    "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.255",
    "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255",
    "240.0.0.1", "255.255.255.255", "168.63.129.16",
  ])("rejects special IPv4 both directly and via DNS: %s", async (address) => {
    await expect(validateTargetScope(rootScope(`https://${address}/`), options))
      .rejects.toBeInstanceOf(TargetPolicyError);
    await expect(validateTargetScope(scope, { lookup: async () => [{ address, family: 4 }] }))
      .rejects.toBeInstanceOf(TargetPolicyError);
  });

  it.each([
    "::", "::1", "::2", "::ffff:127.0.0.1", "::ffff:8.8.8.8",
    "::ffff:7f00:1", "::ffff:808:808", "::127.0.0.1", "fc00::1", "fd12::1",
    "fd00:ec2::254", "fe80::1", "febf::1", "fec0::1", "ff02::1",
    "64:ff9b::808:808", "64:ff9b:1::1", "100::1", "2001::1", "2001:2::1",
    "2001:10::1", "2001:20::1", "2001:db8::1", "2002:0808:0808::1",
    "3ffe::1", "3fff::1", "4000::1", "5f00::1",
  ])("rejects special IPv6 both directly and via DNS: %s", async (address) => {
    await expect(validateTargetScope(rootScope(`https://[${address}]/`), options))
      .rejects.toBeInstanceOf(TargetPolicyError);
    await expect(validateTargetScope(scope, { lookup: async () => [{ address, family: 6 }] }))
      .rejects.toBeInstanceOf(TargetPolicyError);
  });

  it.each(["9.255.255.255", "11.0.0.1", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "198.17.255.255", "198.20.0.1"])(
    "does not overblock adjacent public IPv4 ranges: %s",
    async (address) => {
      await expect(validateTargetScope(rootScope(`https://${address}`), options)).resolves.toBeDefined();
    },
  );
});

describe("exact origins and path scopes", () => {
  it("resolves every explicit host and normalizes host case", async () => {
    const lookup = vi.fn(options.lookup!);
    const validated = await validateTargetScope(
      { ...scope, allowedSubdomains: ["API.EXAMPLE.COM", "nested.api.example.com"] },
      { lookup },
    );
    expect(validated.allowedSubdomains).toEqual(["api.example.com", "nested.api.example.com"]);
    expect(lookup.mock.calls.map(([host]) => host).sort())
      .toEqual(["api.example.com", "example.com", "nested.api.example.com"]);
  });

  it.each([
    "*.example.com", "example.com", "otherexample.com", "example.com.evil.com",
    "https://api.example.com", "api.example.com:443", "api.example.com.",
    "api.example.com/path", "api%2eexample.com", "api..example.com",
  ])("rejects non-exact/non-subdomain grants: %s", async (host) => {
    await expect(validateTargetScope({ ...scope, allowedSubdomains: [host] }, options))
      .rejects.toBeInstanceOf(TargetPolicyError);
  });

  it("does not allow subdomains of IP literals", async () => {
    await expect(validateTargetScope({
      ...rootScope("https://8.8.8.8"), allowedSubdomains: ["x.8.8.8.8"],
    }, options)).rejects.toBeInstanceOf(TargetPolicyError);
  });

  it.each([
    "https://example.com/docs", "https://example.com/docs/",
    "https://example.com/docs/page?next=%2fadmin#section",
    "https://api.example.com/docs/file", "https://api.example.com:443/docs",
    "https://example.com/docs/a%20b", "https://example.com/docs/caf%C3%A9",
  ])("allows exact origin and segment boundary: %s", async (url) => {
    await expect(guardTargetUrl(url, scope, options)).resolves.toBeInstanceOf(URL);
  });

  it.each([
    "http://example.com/docs", "https://example.com:8443/docs",
    "https://other.example.com/docs", "https://nested.api.example.com/docs",
    "https://api.example.com.evil.com/docs", "https://example.com.evil.com/docs",
    "https://93.184.216.34/docs", "https://example.com/docsevil",
    "https://example.com/doc", "https://example.com/admin",
    "https://example.com/Docs", "https://example.com/",
  ])("rejects outside exact scope before resolving: %s", async (url) => {
    const lookup = vi.fn(options.lookup!);
    await expect(guardTargetUrl(url, scope, { lookup })).rejects.toBeInstanceOf(TargetPolicyError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    "/docs/../admin", "/docs/./page", "/docs/%2e%2e/admin",
    "/docs/.%2E/admin", "/docs/%2e./admin", "/docs/%252e%252e/admin",
    "/docs/%25252e%25252e/admin", "/docs%2f../admin", "/docs/%2Fadmin",
    "/docs/%5cadmin", "/docs/%255cadmin", "/docs\\admin",
    "//docs/page", "/docs//page", "/docs/..;ignored/admin", "/docs/;%2fadmin",
    "/docs/%00", "/docs/%0a", "/docs/%7f", "/docs/%C2%85",
    "/docs/%C0%AF", "/docs/%E0%80%AE", "/docs/%FF", "/docs/%",
    "/docs/%2", "/docs/%GG", "/docs/%3fadmin", "/docs/%23admin",
  ])("rejects normalization/encoding ambiguity before URL normalization: %s", async (path) => {
    await expect(guardTargetUrl(`https://example.com${path}`, scope, options))
      .rejects.toBeInstanceOf(TargetPolicyError);
  });

  it.each(["docs", "//docs", "/docs/..", "/docs/%2e", "/docs/%252e", "/docs?x", "/docs#x", "/docs;param", "/docs\\page"])(
    "rejects ambiguous path prefixes: %s",
    async (prefix) => {
      await expect(validateTargetScope({ ...scope, pathPrefixes: [prefix] }, options))
        .rejects.toBeInstanceOf(TargetPolicyError);
    },
  );

  it("treats a trailing prefix slash as a segment boundary and admits multiple prefixes", async () => {
    const paths = { ...scope, pathPrefixes: ["/docs/", "/assets"] };
    await expect(guardTargetUrl("https://example.com/docs", paths, options)).resolves.toBeDefined();
    await expect(guardTargetUrl("https://example.com/assets/app.js", paths, options)).resolves.toBeDefined();
    await expect(guardTargetUrl("https://example.com/assets-evil", paths, options)).rejects.toBeInstanceOf(TargetPolicyError);
  });

  it("requires the initial target to be in the path scope", async () => {
    await expect(validateTargetScope({ ...scope, targetUrl: "https://example.com/admin" }, options))
      .rejects.toMatchObject({ code: "out_of_scope_path" });
  });
});

describe("live DNS fail-closed checks", () => {
  it.each([
    [], [publicV4, { address: "10.0.0.1", family: 4 }],
    [publicV4, { address: "::1", family: 6 }],
    [{ address: "not-an-ip", family: 4 }], [{ address: "8.8.8.8", family: 6 }],
    [{ address: "::ffff:8.8.8.8", family: 6 }],
    [{ address: "fe80::1%eth0", family: 6 }],
    [{ address: "8.8.8.8", family: 0 }], Array(33).fill(publicV4),
  ])("rejects empty, mixed, malformed, or excessive answers: %j", async (answers) => {
    await expect(validateTargetScope(scope, { lookup: async () => answers }))
      .rejects.toBeInstanceOf(TargetPolicyError);
  });

  it("rejects an unsafe extra host even when the target itself is safe", async () => {
    await expect(validateTargetScope(scope, {
      lookup: async (host) => host === "example.com" ? [publicV4] : [{ address: "127.0.0.1", family: 4 }],
    })).rejects.toMatchObject({ code: "unsafe_dns" });
  });

  it("sanitizes DNS failures and synchronous throws", async () => {
    for (const lookup of [
      async () => { throw new Error("secret resolver configuration"); },
      () => { throw new Error("secret synchronous error"); },
    ]) {
      await expect(validateTargetScope(scope, { lookup })).rejects.toMatchObject({
        code: "dns_failure", message: "Target is not permitted by the target policy.",
      });
    }
  });

  it("times out unresolved DNS and enforces timeout bounds", async () => {
    await expect(validateTargetScope(scope, {
      lookup: () => new Promise(() => {}), dnsTimeoutMs: 5,
    })).rejects.toMatchObject({ code: "dns_timeout" });
    for (const dnsTimeoutMs of [0, -1, 5001, NaN, Infinity, 1.1]) {
      await expect(validateTargetScope(scope, { ...options, dnsTimeoutMs }))
        .rejects.toMatchObject({ code: "invalid_configuration" });
    }
  });

  it("resolves again for each request and rejects changed/rebound answers", async () => {
    const lookup = vi.fn()
      .mockResolvedValueOnce([publicV4])
      .mockResolvedValueOnce([publicV6])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const target = rootScope("https://example.com");
    await validateTargetScope(target, { lookup });
    await guardTargetUrl("https://example.com/page", target, { lookup });
    await expect(guardTargetUrl("https://example.com/redirect", target, { lookup }))
      .rejects.toMatchObject({ code: "unsafe_dns" });
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("guards each redirect hop without fetching anything", async () => {
    await guardTargetUrl("https://example.com/docs", scope, options);
    await guardTargetUrl("https://api.example.com/docs/next", scope, options);
    await expect(guardTargetUrl("https://127.0.0.1/docs", scope, options))
      .rejects.toBeInstanceOf(TargetPolicyError);
  });

  it("does not resolve public IP literals", async () => {
    const lookup = vi.fn(options.lookup!);
    await validateTargetScope(rootScope("https://8.8.8.8"), { lookup });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("explicit development-only exception", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["production", "test", "", undefined])(
    "rejects an exception when default NODE_ENV is %s",
    async (environment) => {
      vi.stubEnv("NODE_ENV", environment);
      const origin = "http://localhost:3000";
      const devOptions: PolicyOptions = {
        developmentLocalhostOrigin: origin,
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      };
      await expect(validateTargetScope(rootScope(origin), devOptions))
        .rejects.toMatchObject({ code: "development_exception_disabled" });
      await expect(guardTargetUrl(`${origin}/page`, rootScope(origin), devOptions))
        .rejects.toMatchObject({ code: "development_exception_disabled" });
    },
  );

  it("defaults to NODE_ENV development when no environment option is supplied", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const origin = "http://127.0.0.1:3000";
    const devOptions: PolicyOptions = { developmentLocalhostOrigin: origin };
    await expect(validateTargetScope(rootScope(origin), devOptions)).resolves.toBeDefined();
    await expect(guardTargetUrl(`${origin}/page`, rootScope(origin), devOptions)).resolves.toBeDefined();
  });

  it("does not allow an explicit development option to override production NODE_ENV", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const origin = "http://127.0.0.1:3000";
    const devOptions: PolicyOptions = {
      developmentLocalhostOrigin: origin,
      environment: "development",
    };
    await expect(validateTargetScope(rootScope(origin), devOptions))
      .rejects.toMatchObject({ code: "development_exception_disabled" });
    await expect(guardTargetUrl(`${origin}/page`, rootScope(origin), devOptions))
      .rejects.toMatchObject({ code: "development_exception_disabled" });
  });

  it.each(["production", "test", ""])("rejects explicit non-development environment %s", async (environment) => {
    vi.stubEnv("NODE_ENV", "development");
    const origin = "http://127.0.0.1:3000";
    await expect(validateTargetScope(rootScope(origin), {
      developmentLocalhostOrigin: origin,
      environment,
    })).rejects.toMatchObject({ code: "development_exception_disabled" });
  });

  it("does not alter strict public-target admission in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(validateTargetScope(scope, options)).resolves.toBeDefined();
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "https://[::1]:4443"])(
    "allows only one explicitly configured loopback origin: %s",
    async (origin) => {
      const target = rootScope(origin);
      const devOptions: PolicyOptions = {
        developmentLocalhostOrigin: origin,
        environment: "development",
        lookup: async () => [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }],
      };
      await expect(validateTargetScope(target, devOptions)).resolves.toBeDefined();
      await expect(guardTargetUrl(`${origin}/page`, target, devOptions)).resolves.toBeDefined();
      await expect(validateTargetScope(target, options)).rejects.toBeInstanceOf(TargetPolicyError);
      await expect(guardTargetUrl(`${origin}/page`, target, options)).rejects.toBeInstanceOf(TargetPolicyError);
    },
  );

  it.each([
    "http://10.0.0.1:3000", "http://example.com", "http://127.0.0.2:3000",
    "http://localhost:3000/", "http://user@localhost:3000",
    "http://localhost:3000/path", "http://localhost:3000?x", "ftp://localhost",
  ])("rejects an invalid exception configuration: %s", async (developmentLocalhostOrigin) => {
    await expect(validateTargetScope(scope, { ...options, developmentLocalhostOrigin, environment: "development" }))
      .rejects.toMatchObject({ code: "invalid_configuration" });
  });

  it("does not grant another port, protocol, host, or non-loopback DNS answer", async () => {
    const target = rootScope("http://localhost:3000");
    const devOptions: PolicyOptions = {
      developmentLocalhostOrigin: "http://localhost:3000",
      environment: "development",
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    };
    for (const url of ["http://localhost:3001", "https://localhost:3000", "http://127.0.0.1:3000"]) {
      await expect(guardTargetUrl(url, target, devOptions)).rejects.toBeInstanceOf(TargetPolicyError);
    }
    for (const answers of [[publicV4], [{ address: "10.0.0.1", family: 4 }]]) {
      await expect(validateTargetScope(target, { ...devOptions, lookup: async () => answers }))
        .rejects.toBeInstanceOf(TargetPolicyError);
    }
  });
});
