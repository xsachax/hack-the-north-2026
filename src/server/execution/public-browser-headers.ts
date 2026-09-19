import type { PublicRequestContext } from "./public-transport";

const forwarded = new Set([
  "accept", "accept-language", "cache-control", "if-none-match", "if-modified-since",
  "origin", "referer", "cookie",
]);
const sensitive = new Set(["origin", "referer", "cookie"]);
export const omittedBrowserMetadata = Object.freeze([
  "user-agent", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user",
  "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-ch-ua-arch",
  "sec-ch-ua-bitness", "sec-ch-ua-full-version", "sec-ch-ua-full-version-list",
  "sec-ch-ua-model", "sec-ch-ua-platform-version", "sec-ch-ua-wow64", "sec-ch-ua-form-factors",
  "upgrade-insecure-requests", "priority",
]);
const omitted = new Set(omittedBrowserMetadata);
type Headers = readonly (readonly [string, string])[];

/** Call only on an actual paused browser request, never on app/owner/provider headers. */
export function capturePublicBrowserHeaders(url: string, input: Readonly<Record<string, string>>): Headers {
  const destination = new URL(url);
  const entries = Object.entries(input);
  if (entries.length > 64) throw new Error("public_browser_headers_unsupported");
  let bytes = 0;
  const seen = new Set<string>();
  const result: (readonly [string, string])[] = [];
  for (const [name, value] of entries) {
    const key = name.toLowerCase();
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (seen.has(key) || bytes > 16384 || !/^[a-z0-9-]{1,64}$/.test(key) || /[^\x20-\x7e]/.test(value)) {
      throw new Error("public_browser_headers_unsupported");
    }
    seen.add(key);
    if (forwarded.has(key)) result.push(Object.freeze([key, value] as const));
    else if (omitted.has(key) || key === "accept-encoding") continue;
    else if (key === "host" && value === destination.host) continue;
    else if (key === "connection" && /^(?:keep-alive|close)$/i.test(value)) continue;
    else if (key === "content-length" && value === "0") continue;
    else throw new Error("public_browser_headers_unsupported");
  }
  return Object.freeze(result.sort(([a], [b]) => a.localeCompare(b)));
}

/** Each permit is scoped to one in-flight, proven CDP request and revoked after settlement. */
export function browserHeaderPermits() {
  const permits = new Set<Readonly<{ url: string; method: string; kind: string; headers: string }>>();
  return {
    bind(context: PublicRequestContext, headers: Headers) {
      if (permits.size >= 8) throw new Error("public_browser_header_permit_limit");
      const permit = Object.freeze({
        url: context.url, method: context.method, kind: context.kind,
        headers: JSON.stringify(headers.filter(([name]) => sensitive.has(name))),
      });
      permits.add(permit);
      return () => { permits.delete(permit); };
    },
    authorize(context: PublicRequestContext, headers: Headers) {
      if (context.redirectFrom !== undefined || headers.some(([name]) => !sensitive.has(name))) return false;
      const encoded = JSON.stringify(headers);
      return [...permits].some((permit) => permit.url === context.url && permit.method === context.method
        && permit.kind === context.kind && permit.headers === encoded);
    },
    clear() { permits.clear(); },
  };
}
