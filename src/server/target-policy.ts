import { lookup as nodeLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { targetScopeSchema, type TargetScope } from "../lib/target-scope";

export { targetScopeSchema, type TargetScope } from "../lib/target-scope";

export interface PolicyOptions {
  /** Must return all A/AAAA answers, not just a preferred address. */
  lookup?: (
    hostname: string,
  ) => Promise<readonly { address: string; family: number }[]>;
  /** 1–5000 milliseconds per lookup; defaults to 2000. */
  dnsTimeoutMs?: number;
  /** Defaults to NODE_ENV. Production NODE_ENV cannot be overridden. */
  environment?: string;
  /**
   * Requires environment === "development". One canonical, exact origin,
   * with hostname localhost, 127.0.0.1, or [::1]; custom ports are allowed here.
   * Production NODE_ENV always rejects this. Answers must still be loopback.
   */
  developmentLocalhostOrigin?: string;
}

export class TargetPolicyError extends Error {
  constructor(public readonly code = "target_rejected") {
    super("Target is not permitted by the target policy.");
    this.name = "TargetPolicyError";
  }
}

function reject(code: string): never {
  throw new TargetPolicyError(code);
}

const forbiddenSuffixes = new Set([
  "localhost", "local", "internal", "home", "lan", "corp", "test",
  "invalid", "example", "onion", "arpa",
]);

function isHostname(host: string): boolean {
  const labels = host.split(".");
  return (
    host.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
    ) &&
    /^[a-z][a-z0-9-]*$/i.test(labels.at(-1)!) &&
    !forbiddenSuffixes.has(labels.at(-1)!.toLowerCase())
  );
}

function optionsConfig(options: PolicyOptions) {
  const timeout = options.dnsTimeoutMs ?? 2000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 5000) {
    reject("invalid_configuration");
  }
  const origin = options.developmentLocalhostOrigin;
  if (origin !== undefined) {
    if (
      (options.environment ?? process.env.NODE_ENV) !== "development" ||
      process.env.NODE_ENV === "production"
    ) {
      reject("development_exception_disabled");
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      reject("invalid_configuration");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.origin !== origin ||
      !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    ) {
      reject("invalid_configuration");
    }
  }
  return { timeout, developmentOrigin: origin };
}

function safePath(path: string): string {
  if (
    !path.startsWith("/") ||
    /[\\?#;\u0000-\u0020\u007f]/.test(path) ||
    /%(?:2e|2f|5c|25|3f|23|3b)/i.test(path)
  ) {
    reject("ambiguous_path");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    reject("ambiguous_path");
  }
  if (
    /[\u0000-\u001f\u007f-\u009f\\?#;%]/.test(decoded) ||
    decoded.includes("//") ||
    decoded.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    reject("ambiguous_path");
  }
  return decoded;
}

function parseTargetUrl(raw: string, developmentOrigin?: string): URL {
  if (
    raw.length > 4096 ||
    /[^\u0021-\u007e]/.test(raw) ||
    raw.includes("\\")
  ) {
    reject("invalid_url");
  }
  const match = /^(https?):\/\/([^/?#]+)([^?#]*)(?:\?[^#]*)?(?:#.*)?$/i.exec(raw);
  if (!match) reject("invalid_url");
  const authority = match[2];
  if (/[@%]/.test(authority)) reject("invalid_authority");
  const parts = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/i.exec(authority);
  if (!parts) reject("invalid_authority");
  const rawHost = parts[1].toLowerCase();
  const host = rawHost.startsWith("[") ? rawHost.slice(1, -1) : rawHost;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    reject("invalid_url");
  }
  const development = url.origin === developmentOrigin;
  if (
    url.username ||
    url.password ||
    (url.port !== "" && !development)
  ) {
    reject("invalid_authority");
  }
  if (rawHost.startsWith("[")) {
    if (isIP(host) !== 6 || host.includes(".")) reject("invalid_host");
  } else if (isIP(host) !== 4) {
    if (host !== url.hostname || !(isHostname(host) || (development && host === "localhost"))) {
      reject("invalid_host");
    }
  }
  safePath(match[3] || "/");
  return url;
}

function ipv4Value(address: string): bigint {
  return address.split(".").reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

function ipv6Value(address: string): bigint {
  const [left, right] = address.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const groups = right === undefined
    ? head
    : [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function inRange(value: bigint, base: bigint, prefix: number, bits: number): boolean {
  const shift = BigInt(bits - prefix);
  return value >> shift === base >> shift;
}

const blockedV4: readonly [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  // Azure's platform virtual address is not in a private range.
  ["168.63.129.16", 32],
];

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const value = ipv4Value(address);
    return !blockedV4.some(([base, prefix]) => inRange(value, ipv4Value(base), prefix, 32));
  }
  if (isIP(address) !== 6 || address.includes(".") || address.includes("%")) return false;
  const value = ipv6Value(address);
  // Only global unicast. Exclude protocol assignments, documentation, and 6to4;
  // this also excludes mapped IPv4, NAT64, local, multicast, and reserved space.
  return (
    inRange(value, ipv6Value("2000::"), 3, 128) &&
    !inRange(value, ipv6Value("2001::"), 23, 128) &&
    !inRange(value, ipv6Value("2001:db8::"), 32, 128) &&
    !inRange(value, ipv6Value("2002::"), 16, 128) &&
    !inRange(value, ipv6Value("3ffe::"), 16, 128) &&
    !inRange(value, ipv6Value("3fff::"), 20, 128)
  );
}

function loopbackAddress(address: string): boolean {
  return (
    (isIP(address) === 4 && inRange(ipv4Value(address), ipv4Value("127.0.0.0"), 8, 32)) ||
    (isIP(address) === 6 && !/[.%]/.test(address) && ipv6Value(address) === 1n)
  );
}

async function checkAddress(
  url: URL,
  options: PolicyOptions,
  config: ReturnType<typeof optionsConfig>,
): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const allowedAddress = url.origin === config.developmentOrigin ? loopbackAddress : publicAddress;
  if (isIP(host)) {
    if (!allowedAddress(host)) reject("unsafe_address");
    return;
  }
  const lookup = options.lookup ?? ((hostname: string) => nodeLookup(hostname, { all: true, verbatim: true }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answers = await Promise.race([
      Promise.resolve().then(() => lookup(host)),
      new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new TargetPolicyError("dns_timeout")), config.timeout);
      }),
    ]);
    if (
      !Array.isArray(answers) ||
      answers.length === 0 ||
      answers.length > 32 ||
      answers.some((answer) =>
        !answer ||
        typeof answer.address !== "string" ||
        ![4, 6].includes(answer.family) ||
        isIP(answer.address) !== answer.family ||
        !allowedAddress(answer.address),
      )
    ) {
      reject("unsafe_dns");
    }
  } catch (error) {
    if (error instanceof TargetPolicyError) throw error;
    reject("dns_failure");
  } finally {
    clearTimeout(timer);
  }
}

function policy(scope: TargetScope, options: PolicyOptions) {
  const result = targetScopeSchema.safeParse(scope);
  if (!result.success) reject("invalid_scope");
  const config = optionsConfig(options);
  const target = parseTargetUrl(result.data.targetUrl, config.developmentOrigin);
  const hosts = result.data.allowedSubdomains.map((host) => {
    const normalized = host.toLowerCase();
    if (
      !isHostname(normalized) ||
      isIP(target.hostname.replace(/^\[|\]$/g, "")) ||
      !normalized.endsWith(`.${target.hostname}`) ||
      normalized === target.hostname
    ) {
      reject("invalid_subdomain");
    }
    return normalized;
  });
  const prefixes = result.data.pathPrefixes.map((prefix) => {
    const decoded = safePath(prefix);
    return decoded === "/" ? decoded : decoded.replace(/\/$/, "");
  });
  const origins = new Set([
    target.origin,
    ...hosts.map((host) => `${target.protocol}//${host}${target.port ? `:${target.port}` : ""}`),
  ]);
  return { scope: result.data, config, target, hosts, prefixes, origins };
}

function admit(url: URL, rules: ReturnType<typeof policy>): void {
  if (!rules.origins.has(url.origin)) reject("out_of_scope_origin");
  const path = safePath(url.pathname);
  if (!rules.prefixes.some((prefix) =>
    prefix === "/" || path === prefix || path.startsWith(`${prefix}/`),
  )) {
    reject("out_of_scope_path");
  }
}

/** Validate admission and resolve every allowed host, failing closed on any answer. */
export async function validateTargetScope(
  scope: TargetScope,
  options: PolicyOptions = {},
): Promise<TargetScope> {
  const rules = policy(scope, options);
  admit(rules.target, rules);
  await Promise.all([...rules.origins].map((origin) => checkAddress(new URL(origin), options, rules.config)));
  return {
    ...rules.scope,
    targetUrl: rules.target.href,
    allowedSubdomains: rules.hosts,
  };
}

/**
 * Call for every navigation, redirect hop, and subrequest. Rechecks live DNS,
 * but does not pin the downstream connection; transport must enforce that too.
 * Encoded separators/dots/percent, dot segments, and matrix paths fail closed.
 */
export async function guardTargetUrl(
  url: string,
  scope: TargetScope,
  options: PolicyOptions = {},
): Promise<URL> {
  const rules = policy(scope, options);
  const parsed = parseTargetUrl(url, rules.config.developmentOrigin);
  admit(parsed, rules);
  await checkAddress(parsed, options, rules.config);
  return parsed;
}
