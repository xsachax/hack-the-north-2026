import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Evidence } from "../../lib/contracts";
import { ARTIFACT_LIMITS } from "../execution/artifacts";

export type ArtifactJson = null | boolean | number | string | ArtifactJson[] | { [key: string]: ArtifactJson };
export type ArtifactReadInput = {
  /** Already authorized and registered by the repository, never supplied by the HTTP caller. */
  evidence: Evidence;
  storageKey: string;
  runId: string;
  attemptId: string;
  /** Trusted repository lookup, constrained to this run AND attempt; results are checked again. */
  resolveArtifact?: (storageKey: string) => Evidence | undefined;
};
export type ArtifactReadResult =
  | { status: "available"; kind: "screenshot"; evidenceId: string; mime: "image/png"; bytes: Buffer; redaction: "not-redacted" }
  | { status: "available"; kind: "json"; evidenceId: string; mime: "application/json"; data: ArtifactJson; redaction: "best-effort" }
  | { status: "missing"; reason: "not-found" }
  | { status: "unavailable"; reason: "invalid-reference" | "unsafe-storage" | "too-large" | "invalid-content" | "unsupported-kind" }
  | { status: "redacted"; reason: "redacted-content" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[0-9a-f]{64}$/;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const REDACTED = "[REDACTED]";
const PRIVATE = "[PRIVATE_ARTIFACT]";
const rawJson = new WeakMap<ArtifactReadResult, ArtifactJson>();
const sensitiveKey = /(?:auth|credential|password|passwd|secret|token|cookie|headers?|api[-_]?key|stack|console|raw[-_]?body)/i;
const usageCounter = /^(?:total|act|extract|observe|agent)(?:Prompt|Completion|Reasoning|CachedInput)Tokens$/;

/** Internal aggregation only. Never serialize this value into an API response or report. */
export function getRawArtifactJson(result: ArtifactReadResult): ArtifactJson | undefined {
  return rawJson.get(result);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && UUID.test(value);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isPrivate(stat: Stats, directory: boolean): boolean {
  return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) &&
    (stat.mode & 0o7777) === (directory ? 0o700 : 0o600) &&
    (typeof process.getuid !== "function" || stat.uid === process.getuid());
}

class ReadFailure extends Error {
  constructor(readonly reason: "unsafe-storage" | "too-large" | "invalid-content") { super(reason); }
}

function sanitize(
  value: ArtifactJson, input: ArtifactReadInput, knownSecrets: readonly string[],
): ArtifactJson {
  const secrets = [...new Set(knownSecrets.filter(Boolean).flatMap((secret) => {
    try { return [secret, encodeURIComponent(secret)]; } catch { return [secret]; }
  }))].sort((a, b) => b.length - a.length);
  const text = (value: string): string => {
    let safe = value;
    for (const secret of secrets) safe = safe.split(secret).join(REDACTED);
    safe = safe.replace(/\b(?:bearer|basic)\s+[^\s"',;]+/gi, REDACTED)
      .replace(/\b(?:password|passwd|secret|token|api[-_]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, REDACTED)
      .replace(/\bbb_(?:live|test)_[A-Za-z0-9_-]+/g, REDACTED);
    // URLs retain useful origin/path information, but not credentials, query secrets, or fragments.
    safe = safe.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, (match) => {
      try {
        const url = new URL(match);
        return `${url.origin}${url.pathname}`;
      } catch { return "[REDACTED_URL]"; }
    });
    return safe.replace(/[a-f0-9]{64}/gi, (key) => {
      try {
        const evidence = input.resolveArtifact?.(key.toLowerCase());
        if (evidence && validId(evidence.id) && evidence.runId === input.runId &&
          evidence.attemptId === input.attemptId) return evidence.id;
      } catch { /* A missing or failed lookup is never permission to expose a private key. */ }
      return PRIVATE;
    });
  };
  let nodes = 0;
  const walk = (item: ArtifactJson, depth: number): ArtifactJson => {
    if (++nodes > 8192 || depth > 32) return "[TRUNCATED]";
    if (typeof item === "string") return text(item);
    if (item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map((entry) => walk(entry, depth + 1));
    const result: { [key: string]: ArtifactJson } = Object.create(null);
    const typedInput = ["type", "fill", "select"].includes(String(item.action)) ||
      ["input", "select"].includes(String(item.kind)) || typeof item.inputType === "string";
    for (const [key, entry] of Object.entries(item)) {
      const counter = usageCounter.test(key) && typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0;
      const sensitive = (sensitiveKey.test(key) && !counter) ||
        (typedInput && /^(?:value|text|selected)$/i.test(key));
      // The source field is deliberately retained, but its value is a public evidence UUID, not a storage key.
      result[text(key)] = sensitive ? REDACTED : walk(entry, depth + 1);
    }
    return result;
  };
  return walk(value, 0);
}

/**
 * Reads only repository-registered execution artifacts after the caller verifies ownership.
 * dataDir is trusted configuration, never a request parameter. All directories must be private.
 * Like the writer, Node path APIs cannot defeat directory replacement by a hostile same-UID process.
 * The raw parsed JSON is held separately for trusted aggregation; only `data` is safe to serialize.
 * Redaction is best-effort for JSON. Screenshot pixels are explicitly NOT redacted.
 */
export class ArtifactReader {
  private readonly dataDir: string;
  private readonly knownSecrets: readonly string[];

  constructor(options: { dataDir?: string; knownSecrets?: readonly string[] } = {}) {
    this.dataDir = resolve(/* turbopackIgnore: true */ options.dataDir ?? process.env.DATA_DIR ?? "./data");
    this.knownSecrets = [...(options.knownSecrets ?? [])];
  }

  read(input: ArtifactReadInput): ArtifactReadResult {
    const { evidence, runId, attemptId, storageKey } = input;
    if (!evidence || !validId(evidence.id) || !validId(runId) || !validId(attemptId) ||
      evidence.runId !== runId || evidence.attemptId !== attemptId ||
      typeof storageKey !== "string" || storageKey.length !== 64 || !KEY.test(storageKey))
      return { status: "unavailable", reason: "invalid-reference" };
    if (!["screenshot", "console", "network", "observation"].includes(evidence.kind))
      return { status: "unavailable", reason: "unsupported-kind" };
    const screenshot = evidence.kind === "screenshot";
    try {
      const bytes = this.readBytes(runId, attemptId, storageKey,
        screenshot ? ARTIFACT_LIMITS.screenshotBytes : ARTIFACT_LIMITS.jsonBytes);
      if (screenshot) {
        // Playwright page.screenshot() defaults to PNG; the driver does not request JPEG.
        if (bytes.length < PNG.length || !bytes.subarray(0, PNG.length).equals(PNG))
          return { status: "unavailable", reason: "invalid-content" };
        return { status: "available", kind: "screenshot", evidenceId: evidence.id,
          mime: "image/png", bytes, redaction: "not-redacted" };
      }
      let parsed: ArtifactJson;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as ArtifactJson;
      } catch { return { status: "unavailable", reason: "invalid-content" }; }
      const data = sanitize(parsed, input, this.knownSecrets);
      if (data === REDACTED || data === PRIVATE) return { status: "redacted", reason: "redacted-content" };
      const result: ArtifactReadResult = { status: "available", kind: "json", evidenceId: evidence.id,
        mime: "application/json", data, redaction: "best-effort" };
      rawJson.set(result, parsed);
      return result;
    } catch (error) {
      if (error instanceof ReadFailure) return { status: "unavailable", reason: error.reason };
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { status: "missing", reason: "not-found" };
      return { status: "unavailable", reason: "unsafe-storage" };
    }
  }

  private readBytes(runId: string, attemptId: string, key: string, limit: number): Buffer {
    const opened: { path: string; fd: number; stat: Stats; directory: boolean }[] = [];
    const check = (path: string, directory: boolean) => {
      const stat = lstatSync(path);
      if (!isPrivate(stat, directory)) throw new ReadFailure("unsafe-storage");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK |
        (directory ? constants.O_DIRECTORY : 0));
      opened.push({ path, fd, stat, directory });
      const actual = fstatSync(fd);
      if (!isPrivate(actual, directory) || !sameFile(stat, actual)) throw new ReadFailure("unsafe-storage");
      return { fd, stat: actual };
    };
    try {
      if (realpathSync(this.dataDir) !== this.dataDir) throw new ReadFailure("unsafe-storage");
      let path = this.dataDir;
      check(path, true);
      for (const segment of ["execution", runId.toLowerCase(), attemptId.toLowerCase()]) {
        path = join(/* turbopackIgnore: true */ path, segment);
        check(path, true);
      }
      const file = check(join(path, key), false);
      if (file.stat.size > limit) throw new ReadFailure("too-large");
      const bytes = Buffer.alloc(file.stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(file.fd, bytes, length, bytes.length - length, length);
        if (!count) break;
        length += count;
      }
      if (length !== file.stat.size) throw new ReadFailure("unsafe-storage");
      for (const entry of opened) {
        const current = lstatSync(entry.path);
        const actual = fstatSync(entry.fd);
        if (!isPrivate(current, entry.directory) || !isPrivate(actual, entry.directory) ||
          !sameFile(entry.stat, current) || !sameFile(entry.stat, actual) ||
          (!entry.directory && (actual.size !== entry.stat.size || actual.mtimeMs !== entry.stat.mtimeMs ||
            actual.ctimeMs !== entry.stat.ctimeMs))) throw new ReadFailure("unsafe-storage");
      }
      return bytes.subarray(0, length);
    } finally {
      for (const entry of opened.reverse()) closeSync(entry.fd);
    }
  }
}

/** Downloads use attachment-only safe MIME types; partial/range responses are deliberately unsupported. */
export function artifactDownloadResponse(
  result: ArtifactReadResult, options: { range?: string | null } = {},
): Response {
  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
    "Accept-Ranges": "none",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  if (options.range !== undefined && options.range !== null)
    return new Response(null, { status: 416, headers });
  if (result.status !== "available") {
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(result), { status: result.status === "missing" ? 404 : 422, headers });
  }
  const png = result.kind === "screenshot";
  headers.set("Content-Type", png ? "image/png" : "application/json; charset=utf-8");
  headers.set("Content-Disposition", `attachment; filename="evidence.${png ? "png" : "json"}"`);
  const body = png ? new Uint8Array(result.bytes) : JSON.stringify(result.data);
  headers.set("Content-Length", String(typeof body === "string" ? Buffer.byteLength(body) : body.byteLength));
  return new Response(body, { status: 200, headers });
}
