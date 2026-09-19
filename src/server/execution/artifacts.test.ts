import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARTIFACT_LIMITS, ArtifactWriter, sanitizeEvidence, sanitizeTelemetry, type TelemetryRecord } from "./artifacts";

describe("private immutable execution artifacts", () => {
  let dir: string;
  let runId: string;
  let attemptId: string;
  let writer: ArtifactWriter;
  const attemptPath = () => join(dir, "execution", runId, attemptId);
  const telemetry = (overrides: Partial<TelemetryRecord> = {}): TelemetryRecord => ({
    timestamp: "2026-09-19T06:00:00.000Z", pageId: "page-1", actionId: "action-1",
    kind: "console", code: "FF_DEMO_SECOND_COUPON", ...overrides,
  });

  beforeEach(() => {
    dir = join(process.cwd(), `.artifacts-test-${randomUUID()}`);
    mkdirSync(dir, { mode: 0o700 });
    runId = randomUUID();
    attemptId = randomUUID();
    writer = new ArtifactWriter({ dataDir: dir, knownSecrets: ["known-secret", "private key"] });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes opaque, immutable, private files and accurate metadata", async () => {
    const bytes = Buffer.from("screenshot");
    const first = await writer.writeScreenshot(runId, attemptId, bytes);
    const second = await writer.writeScreenshot(runId, attemptId, bytes);
    expect(first.key).toMatch(/^[a-f0-9]{64}$/);
    expect(second.key).not.toBe(first.key);
    expect(first).toEqual({
      key: first.key, kind: "screenshot", bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(readFileSync(join(attemptPath(), first.key))).toEqual(bytes);
    for (const path of [dir, join(dir, "execution"), join(dir, "execution", runId), attemptPath()])
      expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(statSync(join(attemptPath(), first.key)).mode & 0o777).toBe(0o600);
    expect(readdirSync(attemptPath()).sort()).toEqual([first.key, second.key].sort());
  });

  it("bounds concurrent files across separate writer instances", async () => {
    const writers = [writer, new ArtifactWriter({ dataDir: dir })];
    const results = await Promise.allSettled(Array.from({ length: 136 }, (_, i) =>
      writers[i % 2].writeJson(runId, attemptId, { index: i })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(128);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(8);
    expect(readdirSync(attemptPath())).toHaveLength(128);
    expect(new Set(readdirSync(attemptPath())).size).toBe(128);
  });

  it("bounds concurrent aggregate bytes, while isolating attempts", async () => {
    const bytes = Buffer.alloc(ARTIFACT_LIMITS.screenshotBytes, 7);
    const results = await Promise.allSettled(Array.from({ length: 18 }, () =>
      writer.writeScreenshot(runId, attemptId, bytes)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(16);
    expect(readdirSync(attemptPath()).reduce((sum, key) => sum + statSync(join(attemptPath(), key)).size, 0))
      .toBe(ARTIFACT_LIMITS.attemptBytes);
    await expect(writer.writeScreenshot(runId, randomUUID(), bytes)).resolves.toHaveProperty("kind", "screenshot");
  });

  it("uses on-disk budgets after a writer restart", async () => {
    await writer.writeJson(runId, attemptId, {});
    for (let i = 1; i < ARTIFACT_LIMITS.attemptFiles; i++)
      writeFileSync(join(attemptPath(), i.toString(16).padStart(64, "0")), "{}", { mode: 0o600 });
    await expect(new ArtifactWriter({ dataDir: dir }).writeJson(runId, attemptId, {})).rejects.toThrow("budget");
  });

  it("rejects oversized raw and encoded data without leaving artifacts", async () => {
    await expect(writer.writeScreenshot(runId, attemptId, Buffer.alloc(ARTIFACT_LIMITS.screenshotBytes + 1)))
      .rejects.toThrow("limit");
    await expect(writer.writeJson(runId, attemptId, { data: "x".repeat(ARTIFACT_LIMITS.jsonBytes) }))
      .rejects.toThrow("limit");
    await expect(writer.writeJson(runId, attemptId, { data: "💧".repeat(40_000) }))
      .rejects.toThrow("limit");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("rejects invalid identifiers rather than accepting paths", async () => {
    for (const invalid of ["../escape", "/absolute", "", `${runId}/child`, `${runId}\0`, `${runId}\n`, "not-a-uuid"]) {
      await expect(writer.writeJson(invalid, attemptId, {})).rejects.toThrow("ID");
      await expect(writer.writeJson(runId, invalid, {})).rejects.toThrow("ID");
      expect(() => writer.createSinks(runId, invalid)).toThrow("ID");
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each(["execution", "run", "attempt"])("rejects symlink %s directories", async (level) => {
    const target = join(dir, "target");
    mkdirSync(target, { mode: 0o700 });
    let link = join(dir, "execution");
    if (level !== "execution") {
      mkdirSync(link, { mode: 0o700 });
      link = join(link, runId);
    }
    if (level === "attempt") {
      mkdirSync(link, { mode: 0o700 });
      link = join(link, attemptId);
    }
    symlinkSync(target, link);
    await expect(writer.writeJson(runId, attemptId, {})).rejects.toThrow("Unsafe");
    expect(readdirSync(target)).toEqual([]);
  });

  it("rejects symlink artifacts and symlink lock files without following them", async () => {
    await writer.writeJson(runId, attemptId, {});
    const target = join(dir, "sentinel");
    writeFileSync(target, "untouched", { mode: 0o600 });
    const link = join(attemptPath(), "a".repeat(64));
    symlinkSync(target, link);
    await expect(writer.writeJson(runId, attemptId, {})).rejects.toThrow("Unsafe");
    rmSync(link);
    symlinkSync(target, join(attemptPath(), ".write-lock"));
    await expect(writer.writeJson(runId, attemptId, {})).rejects.toThrow("Unsafe");
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  it("rejects a configured symlink root and conceals filesystem error paths", async () => {
    const target = join(dir, "target");
    const root = join(dir, "root");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, root);
    await expect(new ArtifactWriter({ dataDir: root }).writeJson(runId, attemptId, {})).rejects.toThrow("Unsafe");
    writeFileSync(join(dir, "not-directory"), "sentinel", { mode: 0o600 });
    await expect(new ArtifactWriter({ dataDir: join(dir, "not-directory", "child") })
      .writeJson(runId, attemptId, {})).rejects.toThrow(/^Cannot create artifact directory$/);
  });

  it("fails closed on broad existing directory or file permissions", async () => {
    chmodSync(dir, 0o755);
    await expect(writer.writeJson(runId, attemptId, {})).rejects.toThrow("0700");
    chmodSync(dir, 0o700);
    const artifact = await writer.writeJson(runId, attemptId, {});
    chmodSync(join(attemptPath(), artifact.key), 0o644);
    await expect(writer.writeJson(runId, attemptId, {})).rejects.toThrow("0600");
    chmodSync(join(attemptPath(), artifact.key), 0o600);
    chmodSync(attemptPath(), 0o750);
    await expect(writer.writeJson(runId, attemptId, {})).rejects.toThrow("0700");
  });

  it("sanitizes known secrets, URL queries, bearer tokens and sensitive fields in evidence", async () => {
    const artifact = await writer.writeJson(runId, attemptId, {
      text: "known-secret https://example.com/p?token=hidden#fragment Bearer abc-def password=hunter2 private%20key auth=sesame token othertoken",
      nested: { authorization: "Basic abc", apiKey: "hidden", cookie: "sid=unknown" },
    });
    const saved = readFileSync(join(attemptPath(), artifact.key), "utf8");
    for (const value of ["known-secret", "https://", "hidden", "fragment", "abc-def", "hunter2", "private%20key", "sid=unknown", "sesame", "othertoken"])
      expect(saved).not.toContain(value);
    expect(saved).toContain("[REDACTED]");
    expect(artifact.bytes).toBe(Buffer.byteLength(saved));
  });

  it("bounds evidence depth and text without leaking secret prefixes at truncation", () => {
    const secret = "long-sensitive-secret";
    const value = sanitizeEvidence({ text: `${"x".repeat(2040)}${secret}` }, [secret]);
    expect(JSON.stringify(value)).not.toContain("long-sen");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(sanitizeEvidence(circular)).toEqual({ self: "[CIRCULAR]" });
    expect((sanitizeEvidence(Array.from({ length: 1000 }, () => "x")) as unknown[])).toHaveLength(128);
  });

  it("preserves only explicitly allowlisted nonnegative numeric Stagehand usage counters", async () => {
    const counters = Object.fromEntries(
      ["total", "act", "extract", "observe", "agent"].flatMap((prefix) =>
        ["PromptTokens", "CompletionTokens", "ReasoningTokens", "CachedInputTokens"]
          .map((suffix, index) => [`${prefix}${suffix}`, index])),
    );
    const artifact = await writer.writeJson(runId, attemptId, { metrics: counters });
    expect(JSON.parse(readFileSync(join(attemptPath(), artifact.key), "utf8"))).toEqual({ metrics: counters });
    expect(sanitizeEvidence({
      accessToken: "credential", refreshToken: "credential", totalPromptTokens: "credential",
      extractPromptTokens: -1, actCompletionTokens: Infinity, observeReasoningTokens: 1.5,
      agentCachedInputTokens: Number.MAX_SAFE_INTEGER + 1, arbitraryPromptTokens: 123,
      accessTokenPromptTokens: 123,
    })).toEqual({
      accessToken: "[REDACTED]", refreshToken: "[REDACTED]", totalPromptTokens: "[REDACTED]",
      extractPromptTokens: "[REDACTED]", actCompletionTokens: "[REDACTED]", observeReasoningTokens: "[REDACTED]",
      agentCachedInputTokens: "[REDACTED]", arbitraryPromptTokens: "[REDACTED]",
      accessTokenPromptTokens: "[REDACTED]",
    });
  });

  it("keeps only fixed telemetry codes and safe URL origin/path, never raw diagnostics", async () => {
    const record = {
      ...telemetry({ url: "https://example.com/checkout?token=known-secret#fragment", status: 503, durationMs: 125 }),
      message: "Bearer unknown-secret", headers: { authorization: "secret" },
      body: "private", stack: "trace", cookies: "sid=secret",
    };
    const artifact = await writer.createSinks(runId, attemptId).telemetry(record);
    expect(JSON.parse(readFileSync(join(attemptPath(), artifact.key), "utf8"))).toEqual({
      ...telemetry(), url: "https://example.com/checkout", status: 503, durationMs: 125,
    });
    expect(sanitizeTelemetry(telemetry({ code: "arbitrary console secret" })).code).toBe("CONSOLE_EVENT");
    expect(sanitizeTelemetry(telemetry({ kind: "pageerror", code: "Error: password=secret" })).code).toBe("PAGE_ERROR");
  });

  it.each([
    "https://user:password@example.com/path", "file:///private/config", "not a URL",
    "https://example.com/known-secret", "https://example.com/private%20key",
    "https://example.com/authentication/callback", `https://example.com/${"a".repeat(64)}`,
    "https://example.com/%FF",
  ])("omits unsafe telemetry URL %s", (url) => {
    expect(sanitizeTelemetry(telemetry({ url }), ["known-secret", "private key"])).not.toHaveProperty("url");
  });

  it("rejects invalid telemetry and strips invalid optional values", () => {
    expect(() => sanitizeTelemetry(telemetry({ timestamp: "not a date" }))).toThrow("timestamp");
    expect(() => sanitizeTelemetry(telemetry({ kind: "unknown" as "console" }))).toThrow("kind");
    const safe = sanitizeTelemetry(telemetry({
      pageId: "known-secret", actionId: "Bearer unknown", durationMs: Infinity, status: 900,
    }), ["known-secret"]);
    expect(safe.pageId).toBe("[REDACTED]");
    expect(safe.actionId).toBe("[REDACTED]");
    expect(safe).not.toHaveProperty("durationMs");
    expect(safe).not.toHaveProperty("status");
  });

  it("copies screenshot buffers before asynchronous work", async () => {
    const bytes = Buffer.from("original");
    const pending = writer.writeScreenshot(runId, attemptId, bytes);
    bytes.fill(0);
    const artifact = await pending;
    expect(readFileSync(join(attemptPath(), artifact.key), "utf8")).toBe("original");
  });

  it("waits for a competing lock and snapshots caller bytes before waiting", async () => {
    await writer.writeJson(runId, attemptId, {});
    const lock = join(attemptPath(), ".write-lock");
    writeFileSync(lock, "", { mode: 0o600, flag: "wx" });
    const bytes = Buffer.from("original");
    const pending = writer.writeScreenshot(runId, attemptId, bytes);
    bytes.fill(0);
    rmSync(lock);
    const artifact = await pending;
    expect(readFileSync(join(attemptPath(), artifact.key), "utf8")).toBe("original");
    expect(readdirSync(attemptPath())).not.toContain(".write-lock");
  });
});
