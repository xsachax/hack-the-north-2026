import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const ARTIFACT_LIMITS = Object.freeze({
  screenshotBytes: 2 * 1024 * 1024,
  jsonBytes: 128 * 1024,
  attemptBytes: 32 * 1024 * 1024,
  attemptFiles: 128,
});

export type ArtifactReference = {
  key: string;
  kind: "screenshot" | "json";
  bytes: number;
  sha256: string;
};

export type TelemetryKind =
  | "console" | "pageerror" | "requestfailure" | "http_error" | "slow_request" | "policy_block";

export type TelemetryRecord = {
  timestamp: string;
  /** Driver-generated identifiers, never page-provided text or console arguments. */
  pageId: string;
  actionId: string;
  kind: TelemetryKind;
  code: string;
  url?: string;
  status?: number;
  durationMs?: number;
};

export type ArtifactSinks = {
  screenshot: (bytes: Uint8Array) => Promise<ArtifactReference>;
  json: (value: unknown) => Promise<ArtifactReference>;
  telemetry: (record: TelemetryRecord) => Promise<ArtifactReference>;
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[0-9a-f]{64}$/;
const REDACTED = "[REDACTED]";
const sensitiveKey = /(?:auth|credential|password|passwd|secret|token|cookie|headers?|api[-_]?key|stack|console|raw[-_]?body)/i;
const usageCounters = new Set(
  ["total", "act", "extract", "observe", "agent"].flatMap((prefix) =>
    ["PromptTokens", "CompletionTokens", "ReasoningTokens", "CachedInputTokens"].map((suffix) => `${prefix}${suffix}`)),
);
const defaultCodes: Record<TelemetryKind, string> = {
  console: "CONSOLE_EVENT",
  pageerror: "PAGE_ERROR",
  requestfailure: "REQUEST_FAILED",
  http_error: "HTTP_ERROR",
  slow_request: "SLOW_REQUEST",
  policy_block: "POLICY_BLOCK",
};
const diagnosticCodes = new Set([...Object.values(defaultCodes), "FF_DEMO_SECOND_COUPON"]);

function fail(message: string): never {
  throw new Error(message);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function secretVariants(secrets: readonly string[]): string[] {
  return [...new Set(secrets.filter(Boolean).flatMap((secret) => {
    let encoded = secret;
    try { encoded = encodeURIComponent(secret); } catch { /* Malformed Unicode is still redacted literally. */ }
    return [secret, encoded];
  }))].sort((a, b) => b.length - a.length);
}

function redactText(text: string, secrets: readonly string[]): string {
  // Redact before truncating so a secret straddling the bound cannot leak a prefix.
  let result = text;
  for (const secret of secrets) result = result.split(secret).join(REDACTED);
  return result
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/\b(?:bearer|basic)\s+[^\s"',;]+/gi, REDACTED)
    .replace(/\b(?:auth|authorization|authentication|credentials?|password|passwd|secret|token|access[-_]?token|refresh[-_]?token|api[-_]?key)\b(?:\s*[:=]\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, REDACTED)
    .replace(/\bbb_(?:live|test)_[A-Za-z0-9_-]+/g, REDACTED)
    .slice(0, 2048);
}

/**
 * Bounded best-effort redaction for structured evidence, not a general secret detector.
 * Unknown secrets in arbitrary prose (and screenshot pixels) cannot be reliably removed.
 * Never feed browser console text here: use the fixed-code telemetry sink instead.
 */
export function sanitizeEvidence(value: unknown, knownSecrets: readonly string[] = []): Json {
  const secrets = secretVariants(knownSecrets);
  const visited = new WeakSet<object>();
  let nodes = 0;
  const walk = (item: unknown, depth: number): Json => {
    if (++nodes > 1024 || depth > 8) return "[TRUNCATED]";
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") return redactText(item, secrets);
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (typeof item !== "object") return null;
    if (visited.has(item)) return "[CIRCULAR]";
    visited.add(item);
    if (Array.isArray(item)) return item.slice(0, 128).map((entry) => walk(entry, depth + 1));
    const result: { [key: string]: Json } = Object.create(null);
    for (const [key, entry] of Object.entries(item).slice(0, 64)) {
      const safeCounter = usageCounters.has(key) && typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0;
      result[redactText(key, secrets)] = sensitiveKey.test(key) && !safeCounter ? REDACTED : walk(entry, depth + 1);
    }
    return result;
  };
  return walk(value, 0);
}

function safeUrl(value: unknown, secrets: readonly string[]): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
    const clean = `${url.origin}${url.pathname}`;
    const decoded = decodeURIComponent(clean);
    if (secrets.some((secret) => clean.includes(secret) || decoded.includes(secret))) return undefined;
    if (sensitiveKey.test(decoded) || /(?:bearer|basic)[\s/%]/i.test(decoded)) return undefined;
    // Opaque path segments often contain reset tokens, signatures, or user credentials.
    if (url.pathname.split("/").some((part) => part.length > 64 || /[A-Za-z0-9_-]{32,}/.test(part))) return undefined;
    return clean.length <= 2048 ? clean : undefined;
  } catch {
    return undefined;
  }
}

/** Only schema fields and fixed codes survive; no message, stack, body, cookies, or headers. */
export function sanitizeTelemetry(record: TelemetryRecord, knownSecrets: readonly string[] = []): TelemetryRecord {
  if (!Object.hasOwn(defaultCodes, record.kind)) fail("Invalid telemetry kind");
  const secrets = secretVariants(knownSecrets);
  const identifier = (value: string) =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) && !/\s/.test(value) &&
    !secrets.some((secret) => value.includes(secret)) ? value : REDACTED;
  const timestamp = new Date(record.timestamp);
  if (!Number.isFinite(timestamp.getTime())) fail("Invalid telemetry timestamp");
  const result: TelemetryRecord = {
    timestamp: timestamp.toISOString(),
    pageId: identifier(record.pageId),
    actionId: identifier(record.actionId),
    kind: record.kind,
    code: diagnosticCodes.has(record.code) && !secrets.some((secret) => record.code.includes(secret))
      ? record.code : defaultCodes[record.kind],
  };
  const url = safeUrl(record.url, secrets);
  if (url) result.url = url;
  if (Number.isInteger(record.status) && record.status! >= 100 && record.status! <= 599) result.status = record.status;
  if (typeof record.durationMs === "number" && Number.isFinite(record.durationMs) &&
    record.durationMs >= 0 && record.durationMs <= 3_600_000) result.durationMs = record.durationMs;
  return result;
}

function privateDirectory(path: string, recursive = false): void {
  try { mkdirSync(path, { recursive, mode: 0o700 }); }
  catch (error) { if (!hasCode(error, "EEXIST")) fail("Cannot create artifact directory"); }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Unsafe artifact directory");
  if ((stat.mode & 0o777) !== 0o700) fail("Artifact directory must have mode 0700");
}

function privateFile(path: string): number {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("Unsafe artifact file");
  if ((stat.mode & 0o777) !== 0o600) fail("Artifact file must have mode 0600");
  return stat.size;
}

/**
 * Internal-only storage. DATA_DIR is trusted configuration; every child is checked.
 * Existing broad permissions fail closed, rather than silently changing shared data.
 * The containing directories must not be writable by an untrusted same-UID process:
 * Node's path APIs cannot eliminate directory-replacement races by such a process.
 */
export class ArtifactWriter {
  private readonly dataDir: string;
  private readonly knownSecrets: readonly string[];

  constructor(options: { dataDir?: string; knownSecrets?: readonly string[] } = {}) {
    this.dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? "./data");
    this.knownSecrets = [...(options.knownSecrets ?? [])];
  }

  createSinks(runId: string, attemptId: string): ArtifactSinks {
    this.validateIds(runId, attemptId);
    return {
      screenshot: (bytes) => this.writeScreenshot(runId, attemptId, bytes),
      json: (value) => this.writeJson(runId, attemptId, value),
      telemetry: (record) => this.writeTelemetry(runId, attemptId, record),
    };
  }

  async writeScreenshot(runId: string, attemptId: string, bytes: Uint8Array): Promise<ArtifactReference> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > ARTIFACT_LIMITS.screenshotBytes)
      fail("Screenshot exceeds artifact limit or has invalid bytes");
    return this.write(runId, attemptId, "screenshot", Buffer.from(bytes));
  }

  async writeJson(runId: string, attemptId: string, value: unknown): Promise<ArtifactReference> {
    let serialized: string | undefined;
    try { serialized = JSON.stringify(value); } catch { fail("Invalid JSON evidence"); }
    if (serialized === undefined || Buffer.byteLength(serialized) > ARTIFACT_LIMITS.jsonBytes)
      fail("JSON evidence exceeds artifact limit");
    const bytes = Buffer.from(JSON.stringify(sanitizeEvidence(JSON.parse(serialized), this.knownSecrets)));
    if (bytes.byteLength > ARTIFACT_LIMITS.jsonBytes) fail("JSON evidence exceeds artifact limit");
    return this.write(runId, attemptId, "json", bytes);
  }

  async writeTelemetry(runId: string, attemptId: string, record: TelemetryRecord): Promise<ArtifactReference> {
    // Avoid generic evidence redaction here: telemetry URLs have already been constrained.
    const bytes = Buffer.from(JSON.stringify(sanitizeTelemetry(record, this.knownSecrets)));
    return this.write(runId, attemptId, "json", bytes);
  }

  private validateIds(runId: string, attemptId: string): void {
    if (typeof runId !== "string" || typeof attemptId !== "string" ||
      runId.length !== 36 || attemptId.length !== 36 || !UUID.test(runId) || !UUID.test(attemptId))
      fail("Invalid artifact run or attempt ID");
  }

  private attemptDirectory(runId: string, attemptId: string): string {
    privateDirectory(this.dataDir, true);
    let path = this.dataDir;
    for (const segment of ["execution", runId.toLowerCase(), attemptId.toLowerCase()]) {
      path = join(path, segment);
      privateDirectory(path);
    }
    return path;
  }

  private async write(
    runId: string, attemptId: string, kind: ArtifactReference["kind"], bytes: Buffer,
  ): Promise<ArtifactReference> {
    this.validateIds(runId, attemptId);
    let lock: number | undefined;
    let lockPath: string | undefined;
    try {
      const directory = this.attemptDirectory(runId, attemptId);
      lockPath = join(directory, ".write-lock");
      const deadline = Date.now() + 5000;
      while (lock === undefined) {
        // Exclusive lock also serializes independent writers/processes and budget checks.
        this.attemptDirectory(runId, attemptId);
        try { lock = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
        catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
          try { privateFile(lockPath); } catch (checkError) {
            if (hasCode(checkError, "ENOENT")) continue;
            throw checkError;
          }
          if (Date.now() >= deadline) fail("Artifact writer is busy");
          await delay(10);
        }
      }
      let count = 0;
      let total = 0;
      for (const name of readdirSync(directory)) {
        if (name === ".write-lock") continue;
        if (!KEY.test(name)) fail("Unexpected artifact directory entry");
        total += privateFile(join(directory, name));
        count++;
      }
      if (count >= ARTIFACT_LIMITS.attemptFiles || total + bytes.byteLength > ARTIFACT_LIMITS.attemptBytes)
        fail("Attempt artifact budget exceeded");
      const key = randomBytes(32).toString("hex");
      const path = join(directory, key);
      let fd: number | undefined;
      try {
        fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        if ((fstatSync(fd).mode & 0o777) !== 0o600) fail("Artifact file must have mode 0600");
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } catch (error) {
        if (fd !== undefined) unlinkSync(path);
        throw error;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      return { key, kind, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch (error) {
      // Filesystem error messages contain private absolute paths; do not expose them.
      if (error instanceof Error && !("code" in error)) throw error;
      return fail("Artifact storage operation failed");
    } finally {
      if (lock !== undefined) {
        closeSync(lock);
        try { unlinkSync(lockPath!); } catch { /* Fail-closed stale locks block subsequent writes. */ }
      }
    }
  }
}
