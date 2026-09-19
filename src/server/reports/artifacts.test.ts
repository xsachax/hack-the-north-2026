import { randomUUID } from "node:crypto";
import {
  chmodSync, linkSync, mkdirSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Evidence } from "../../lib/contracts";
import { ARTIFACT_LIMITS, ArtifactWriter } from "../execution/artifacts";
import {
  ArtifactReader, artifactDownloadResponse, getRawArtifactJson, type ArtifactReadInput,
} from "./artifacts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
  "base64",
);

describe("authorized private artifact reader", () => {
  let workspace: string;
  let dataDir: string;
  let runId: string;
  let attemptId: string;
  let reader: ArtifactReader;
  let writer: ArtifactWriter;
  const directory = () => join(dataDir, "execution", runId, attemptId);
  const metadata = (kind: Evidence["kind"] = "observation"): Evidence => ({
    id: randomUUID(), runId, attemptId, kind, createdAt: "2026-09-19T06:00:00.000Z", summary: `Agent ${kind}`,
  });
  const json = async (value: unknown = { checks: [{ criterion: "checkout", passed: true }], steps: 3 }): Promise<ArtifactReadInput> => ({
    evidence: metadata(), runId, attemptId, storageKey: (await writer.writeJson(runId, attemptId, value)).key,
  });
  const screenshot = async (bytes: Uint8Array = PNG): Promise<ArtifactReadInput> => ({
    evidence: metadata("screenshot"), runId, attemptId,
    storageKey: (await writer.writeScreenshot(runId, attemptId, bytes)).key,
  });
  const replace = (input: ArtifactReadInput, bytes: string | Buffer) =>
    writeFileSync(join(directory(), input.storageKey), bytes);

  beforeEach(() => {
    workspace = join(process.cwd(), `.report-artifacts-test-${randomUUID()}`);
    dataDir = join(workspace, "private");
    mkdirSync(workspace, { mode: 0o700 });
    runId = randomUUID();
    attemptId = randomUUID();
    writer = new ArtifactWriter({ dataDir });
    reader = new ArtifactReader({ dataDir, knownSecrets: ["private credential"] });
  });

  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("reads real writer JSON and preserves exact raw shape only through the internal accessor", async () => {
    const input = await json();
    const result = reader.read(input);
    expect(result).toMatchObject({
      status: "available", kind: "json", evidenceId: input.evidence.id, mime: "application/json",
      data: { checks: [{ criterion: "checkout", passed: true }], steps: 3 }, redaction: "best-effort",
    });
    expect(getRawArtifactJson(result)).toEqual({ checks: [{ criterion: "checkout", passed: true }], steps: 3 });
    expect(JSON.stringify(result)).not.toContain(input.storageKey);
    expect(JSON.stringify(result)).not.toContain(dataDir);
  });

  it("reads PNG screenshots without claiming pixel redaction", async () => {
    const result = reader.read(await screenshot());
    expect(result).toMatchObject({ status: "available", kind: "screenshot", mime: "image/png", redaction: "not-redacted" });
    if (result.status !== "available" || result.kind !== "screenshot") throw new Error("Expected screenshot");
    expect(result.bytes).toEqual(PNG);
    expect(getRawArtifactJson(result)).toBeUndefined();
  });

  it("preserves writer telemetry codes, safe URLs, and model token counters", async () => {
    const ref = await writer.writeTelemetry(runId, attemptId, {
      timestamp: "2026-09-19T06:00:00.000Z", pageId: "page-1", actionId: "action-1",
      kind: "http_error", code: "HTTP_ERROR", status: 500, url: "https://example.com/checkout",
    });
    const result = reader.read({ evidence: metadata("console"), runId, attemptId, storageKey: ref.key });
    expect(result).toMatchObject({ data: { kind: "http_error", status: 500, url: "https://example.com/checkout" } });
    expect(reader.read(await json({ totalPromptTokens: 20, actCompletionTokens: 2 })))
      .toMatchObject({ data: { totalPromptTokens: 20, actCompletionTokens: 2 } });
  });

  it("redacts typed fields and known secrets, retaining useful structured evidence", async () => {
    const input = await json();
    const value = {
      action: { action: "type", candidateId: "email", value: "someone@example.test", commentary: "Filling email" },
      observation: { candidates: [{ id: "name", kind: "input", label: "Name", value: "Jane" }] },
      headers: { authorization: "Bearer credential" },
      note: "private credential private%20credential Bearer unknown-secret",
      url: "https://user:pass@example.com/checkout?token=secret#fragment",
      checks: [{ criterion: "checkout", passed: true }],
    };
    replace(input, JSON.stringify(value));
    const result = reader.read(input);
    expect(result).toMatchObject({ data: {
      action: { action: "type", candidateId: "email", value: "[REDACTED]", commentary: "Filling email" },
      observation: { candidates: [{ id: "name", label: "Name", value: "[REDACTED]" }] },
      headers: "[REDACTED]", note: "[REDACTED] [REDACTED] [REDACTED]",
      url: "https://example.com/checkout", checks: [{ criterion: "checkout", passed: true }],
    } });
    const response = await artifactDownloadResponse(result).text();
    for (const secret of ["someone@example", "Jane", "private credential", "unknown-secret", "?token", "user:pass"])
      expect(response).not.toContain(secret);
    expect(getRawArtifactJson(result)).toEqual(value);
  });

  it("maps only registered same-attempt references, including nested references and property names", async () => {
    const shot = await screenshot();
    const unknown = "a".repeat(64);
    const input = await json({
      observation: { screenshotKey: shot.storageKey },
      evidence: `Screenshot:${shot.storageKey}`,
      nested: [{ [unknown]: unknown }],
    });
    input.resolveArtifact = (key) => key === shot.storageKey ? shot.evidence : undefined;
    const result = reader.read(input);
    expect(result).toMatchObject({ data: {
      observation: { screenshotKey: shot.evidence.id }, evidence: `Screenshot:${shot.evidence.id}`,
      nested: [{ "[PRIVATE_ARTIFACT]": "[PRIVATE_ARTIFACT]" }],
    } });
    expect(getRawArtifactJson(result)).toMatchObject({ observation: { screenshotKey: shot.storageKey } });
    expect(JSON.stringify(result)).not.toMatch(/[a-f0-9]{64}/);
    expect(await artifactDownloadResponse(result).text()).not.toMatch(/[a-f0-9]{64}/);
  });

  it.each(["foreign-run", "foreign-attempt", "invalid-id", "failure"])("masks %s callback results", async (variant) => {
    const key = "b".repeat(64);
    const input = await json({ screenshotKey: key });
    input.resolveArtifact = () => {
      if (variant === "failure") throw new Error(`private lookup failed ${dataDir}`);
      return { ...metadata("screenshot"),
        ...(variant === "foreign-run" ? { runId: randomUUID() } : {}),
        ...(variant === "foreign-attempt" ? { attemptId: randomUUID() } : {}),
        ...(variant === "invalid-id" ? { id: "../escape" } : {}),
      };
    };
    expect(reader.read(input)).toMatchObject({ data: { screenshotKey: "[PRIVATE_ARTIFACT]" } });
  });

  it.each(["../escape", "/absolute", "", "a".repeat(63), "A".repeat(64), `${"a".repeat(64)}\n`,
    `${"a".repeat(64)}\0`, `../${"a".repeat(64)}`, `${"a".repeat(64)}/file`])("rejects invalid key %j", async (key) => {
    const input = await json();
    expect(reader.read({ ...input, storageKey: key })).toEqual({ status: "unavailable", reason: "invalid-reference" });
  });

  it.each(["../escape", "", "/absolute", "not-uuid", `${randomUUID()}\n`, `${randomUUID()}\0`])
    ("rejects malformed expected IDs %j", async (id) => {
      const input = await json();
      expect(reader.read({ ...input, runId: id, evidence: { ...input.evidence, runId: id } }))
        .toMatchObject({ status: "unavailable", reason: "invalid-reference" });
      expect(reader.read({ ...input, attemptId: id, evidence: { ...input.evidence, attemptId: id } }))
        .toMatchObject({ status: "unavailable", reason: "invalid-reference" });
    });

  it("rejects registered metadata from a different run/attempt and invalid evidence IDs", async () => {
    const input = await json();
    for (const evidence of [
      { ...input.evidence, runId: randomUUID() }, { ...input.evidence, attemptId: randomUUID() },
      { ...input.evidence, id: "../unsafe\r\nheader" },
    ]) expect(reader.read({ ...input, evidence })).toMatchObject({ status: "unavailable", reason: "invalid-reference" });
  });

  it("explicitly handles missing root, attempt directory, and artifact", async () => {
    const input: ArtifactReadInput = { evidence: metadata(), runId, attemptId, storageKey: "a".repeat(64) };
    expect(reader.read(input)).toEqual({ status: "missing", reason: "not-found" });
    const created = await json();
    unlinkSync(join(directory(), created.storageKey));
    expect(reader.read(created)).toEqual({ status: "missing", reason: "not-found" });
    rmSync(directory(), { recursive: true });
    expect(reader.read(created)).toEqual({ status: "missing", reason: "not-found" });
  });

  it.each(["root", "execution", "run", "attempt", "file"])("rejects symlink at %s", async (level) => {
    const input = await json();
    const path = {
      root: dataDir, execution: join(dataDir, "execution"), run: join(dataDir, "execution", runId),
      attempt: directory(), file: join(directory(), input.storageKey),
    }[level]!;
    const target = join(workspace, "moved");
    renameSync(path, target);
    symlinkSync(target, path);
    expect(reader.read(input)).toEqual({ status: "unavailable", reason: "unsafe-storage" });
  });

  it("rejects symlink ancestors of the configured root", async () => {
    const input = await json();
    const alias = join(workspace, "alias");
    symlinkSync(workspace, alias);
    const aliasedReader = new ArtifactReader({ dataDir: join(alias, "private") });
    expect(aliasedReader.read(input)).toEqual({ status: "unavailable", reason: "unsafe-storage" });
  });

  it.each(["root", "execution", "run", "attempt", "file"])("rejects broad permissions at %s", async (level) => {
    const input = await json();
    const path = {
      root: dataDir, execution: join(dataDir, "execution"), run: join(dataDir, "execution", runId),
      attempt: directory(), file: join(directory(), input.storageKey),
    }[level]!;
    chmodSync(path, level === "file" ? 0o644 : 0o755);
    expect(reader.read(input)).toEqual({ status: "unavailable", reason: "unsafe-storage" });
  });

  it("rejects hard-linked artifacts and directories in place of files", async () => {
    const input = await json();
    const path = join(directory(), input.storageKey);
    linkSync(path, join(workspace, "copy"));
    expect(reader.read(input)).toEqual({ status: "unavailable", reason: "unsafe-storage" });
    unlinkSync(path);
    mkdirSync(path, { mode: 0o700 });
    expect(reader.read(input)).toEqual({ status: "unavailable", reason: "unsafe-storage" });
  });

  it.each(["screenshot", "json"])("rejects oversize %s before reading", async (kind) => {
    const input = kind === "screenshot" ? await screenshot() : await json();
    const limit = kind === "screenshot" ? ARTIFACT_LIMITS.screenshotBytes : ARTIFACT_LIMITS.jsonBytes;
    truncateSync(join(directory(), input.storageKey), limit + 1);
    expect(reader.read(input)).toEqual({ status: "unavailable", reason: "too-large" });
  });

  it("accepts bounded JSON and screenshot files at their exact limits", async () => {
    const input = await json();
    replace(input, JSON.stringify("x".repeat(ARTIFACT_LIMITS.jsonBytes - 2)));
    expect(reader.read(input)).toMatchObject({ status: "available", kind: "json" });
    const bytes = Buffer.alloc(ARTIFACT_LIMITS.screenshotBytes);
    PNG.copy(bytes);
    expect(reader.read(await screenshot(bytes))).toMatchObject({ status: "available", kind: "screenshot" });
  });

  it.each(["<html>active</html>", "<svg onload='alert(1)'/>", "{\"valid\":\"json\"}", "\xff\xd8jpeg", ""])
    ("rejects non-PNG screenshot content %j", async (content) => {
      expect(reader.read(await screenshot(Buffer.from(content))))
        .toEqual({ status: "unavailable", reason: "invalid-content" });
    });

  it.each(["<html>active</html>", "<svg/>", "{broken", "", "undefined"])
    ("rejects non-JSON evidence %j", async (content) => {
      const input = await json();
      replace(input, content);
      expect(reader.read(input)).toEqual({ status: "unavailable", reason: "invalid-content" });
    });

  it("rejects invalid UTF-8 instead of silently replacing bytes", async () => {
    const input = await json();
    replace(input, Buffer.from([0x22, 0xff, 0x22]));
    expect(reader.read(input)).toEqual({ status: "unavailable", reason: "invalid-content" });
  });

  it("bounds recursive sanitization and treats prototype-looking keys as ordinary data", async () => {
    const input = await json();
    replace(input, `{"__proto__":{"polluted":true},"constructor":"safe","deep":${"[".repeat(100)}1${"]".repeat(100)}}`);
    const result = reader.read(input);
    expect(result).toMatchObject({ status: "available", data: { "__proto__": { polluted: true }, constructor: "safe" } });
    expect(JSON.stringify(result)).toContain("[TRUNCATED]");
    expect(Object.hasOwn({}, "polluted")).toBe(false);
  });

  it("returns explicit redacted and unsupported states", async () => {
    expect(reader.read(await json("[REDACTED]"))).toEqual({ status: "redacted", reason: "redacted-content" });
    const input = await json();
    expect(reader.read({ ...input, evidence: { ...input.evidence, kind: "recording" } }))
      .toEqual({ status: "unavailable", reason: "unsupported-kind" });
  });

  it("returns attachment-only safe JSON MIME for HTML-looking strings", async () => {
    const result = reader.read(await json({ html: "<script>alert(1)</script>", title: "Useful evidence" }));
    const response = artifactDownloadResponse(result);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="evidence.json"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const body = await response.text();
    expect(body).toContain("Useful evidence");
    expect(Number(response.headers.get("content-length"))).toBe(Buffer.byteLength(body));
  });

  it("serves PNG bytes with fixed non-injectable filename", async () => {
    const input = await screenshot();
    input.evidence.summary = 'unsafe\r\nContent-Type: text/html "filename.svg"';
    const response = artifactDownloadResponse(reader.read(input));
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="evidence.png"');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
  });

  it.each(["bytes=0-1", "bytes=0-", "bytes=-10", "bytes=0-1,3-4", "bytes=999999999999-", "invalid", ""])
    ("rejects range %j without returning any artifact bytes", async (range) => {
      const response = artifactDownloadResponse(reader.read(await screenshot()), { range });
      expect(response.status).toBe(416);
      expect(response.headers.get("accept-ranges")).toBe("none");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.text()).toBe("");
    });

  it("returns generic private-safe missing/unavailable responses", async () => {
    const missing = artifactDownloadResponse({ status: "missing", reason: "not-found" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ status: "missing", reason: "not-found" });
    const unavailable = artifactDownloadResponse({ status: "unavailable", reason: "unsafe-storage" });
    expect(unavailable.status).toBe(422);
    expect(await unavailable.text()).not.toContain(dataDir);
  });
});
