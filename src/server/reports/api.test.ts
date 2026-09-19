import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Evidence, Run } from "../../lib/contracts";
import type { RunReport } from "../../lib/report-contracts";
import { createApi } from "../api";
import { Repository, type StoredEvidence } from "../repository";
import { WorkerRepository } from "../worker/repository";
import { ReportService } from "./service";
import type { LoadedEvidence } from "./aggregate";
import { ArtifactWriter } from "../execution/artifacts";

const origin = "http://127.0.0.1:3000";
let directory: string;
let repository: WorkerRepository;
let owner: ReturnType<Repository["createSession"]>;
let foreign: ReturnType<Repository["createSession"]>;
let run: Run;
let attemptId: string;
let evidence: Evidence;
let loaded: Map<string, LoadedEvidence>;
const load = (item: StoredEvidence): LoadedEvidence => loaded.get(item.metadata.id) ?? { ...item, state: "missing" };
const handler = () => createApi({ repository, configuration: { origin, production: false }, evidenceLoader: load });
const request = (path: string, token = owner.token, headers: Record<string, string> = {}) =>
  new Request(`${origin}/api/v1/${path}`, { headers: { cookie: `ff_owner=${token}`, ...headers } });
async function data<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  return (await response.json()).data as T;
}
function sql(work: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(join(directory, "flash-flood.sqlite"));
  try { work(db); } finally { db.close(); }
}

beforeEach(() => {
  directory = join(process.cwd(), `.report-api-test-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  repository = new WorkerRepository(directory);
  owner = repository.createSession();
  foreign = repository.createSession();
  loaded = new Map();
  run = repository.createControlledRun(owner.ownerId, randomUUID(), {
    authorizationAcknowledged: true, controlledSiteId: "project-board",
    assignments: [{ personaId: "careful-first-timer", goal: "Visit the board",
      criteria: [{ id: "board", kind: "url", description: "Board is visible", semantics: "current", path: "/project-board" }] }],
  }).run;
  const claim = repository.claim("test-worker")!;
  attemptId = claim.attempt.id;
  const screenshotKey = "a".repeat(64);
  const shotId = repository.recordArtifact(claim, { key: screenshotKey, kind: "screenshot", bytes: 8, sha256: "b".repeat(64) }, "screenshot");
  const check = { criterion: "board", passed: true, status: "met" as const, method: "deterministic" as const,
    evidence: "https://board.flash-flood.invalid/project-board" };
  const key = "c".repeat(64);
  const id = repository.recordArtifact(claim, { key, kind: "json", bytes: 32, sha256: "d".repeat(64) }, "observation");
  evidence = repository.getEvidence(owner.ownerId, id);
  loaded.set(id, { metadata: evidence, storageKey: key, state: "available", data: {
    kind: "observation", actor: "agent",
    observation: { id: "observation-1", screenshotKey, signals: [], checks: [{ ...check, evidence: "[REDACTED_URL]" }], text: "sensitive visible page" },
  } });
  loaded.set(shotId, { metadata: repository.getEvidence(owner.ownerId, shotId), storageKey: screenshotKey, state: "available" });
  repository.recordStep(claim, "observation", id, { pageUrl: check.evidence });
  repository.finish(claim, {
    status: "succeeded", reason: "Verified", originalTerminal: { status: "succeeded", reason: "Verified" },
    checks: [check], steps: 0, modelCalls: 0, durationMs: 1, cleanup: { status: "closed", errors: [] }, errors: [],
  }, { allocationAttempted: false, reservedSeconds: 240, elapsedSeconds: 0 });
});
afterEach(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });

describe("protected durable reports API", () => {
  it("projects the authoritative persisted result and survives a repository/server restart exactly", async () => {
    const report = await data<RunReport>(await handler()(request(`runs/${run.id}/reports`)));
    expect(report.agents[0].criteria[0]).toMatchObject({ status: "met", method: "structural", citations: [{ state: "available" }] });
    expect(report.agents[0].timeline.some((event) => event.evidenceId === evidence.id)).toBe(true);
    sql((db) => expect(JSON.parse(String(db.prepare("SELECT report FROM report_snapshots WHERE run_id=?").get(run.id)?.report))).toEqual(report));
    const reopened = new Repository(directory);
    try {
      const second = createApi({ repository: reopened, configuration: { origin, production: false }, evidenceLoader: load });
      expect(await data(await second(request(`runs/${run.id}/reports`)))).toEqual(report);
    } finally { reopened.close(); }
  });

  it("invalidates finding-v1 cached projections on upgrade and rebuilds finding-v2 from unchanged sources", async () => {
    const first = await data<RunReport>(await handler()(request(`runs/${run.id}/reports`)));
    sql((db) => {
      db.prepare("UPDATE report_snapshots SET revision='obsolete',report=json_set(report,'$.signatureVersion','finding-v1')").run();
      // Reproduce the actual v5 schema, not new tables with an artificially old version.
      db.exec("DROP TRIGGER runs_execution_policy_immutable");
      db.exec("ALTER TABLE runs DROP COLUMN public_asset_policy");
      db.exec("ALTER TABLE runs DROP COLUMN public_execution_policy");
      for (const table of [
        "native_resource_events", "native_resources",
        "reproduction_worker_jobs", "reproduction_candidates", "reproductions", "rerun_attempts", "rerun_runs",
        "takeover_commands", "takeover_intervals", "takeover_controls",
        "context_operations", "context_selections", "browser_contexts",
      ]) db.exec(`DROP TABLE ${table}`);
      expect(db.prepare("PRAGMA table_info(runs)").all().map((column) => column.name))
        .not.toContain("public_execution_policy");
      expect(db.prepare("PRAGMA table_info(runs)").all().map((column) => column.name))
        .not.toContain("public_asset_policy");
      db.exec("PRAGMA user_version=5");
    });
    repository.close();
    repository = new WorkerRepository(directory);
    sql((db) => expect(db.prepare("SELECT count(*) AS n FROM report_snapshots").get()?.n).toBe(0));
    const rebuilt = await data<RunReport>(await handler()(request(`runs/${run.id}/reports`)));
    expect(rebuilt).toEqual(first);
    expect(rebuilt.signatureVersion).toBe("finding-v2");
    sql((db) => expect(JSON.parse(String(db.prepare("SELECT report FROM report_snapshots WHERE run_id=?").get(run.id)?.report))).toEqual(rebuilt));
  });

  it("exposes per-agent and safe export endpoints with no private keys or active Markdown injection", async () => {
    const api = handler();
    const agent = await data<{ attemptId: string }>(await api(request(`runs/${run.id}/attempts/${attemptId}/report`)));
    expect(agent.attemptId).toBe(attemptId);
    for (const format of ["json", "markdown"]) {
      const response = await api(request(`runs/${run.id}/exports/${format}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toContain("attachment;");
      const text = await response.text();
      expect(text).toContain(evidence.id);
      expect(text).not.toContain("a".repeat(64));
      expect(text).not.toContain("sensitive visible page");
    }
  });

  it("redacts typed/page data and resolves nested refs only within the actual attempt", async () => {
    const detail = await data<{ text: string; references: { evidenceId: string | null; state: string }[] }>(
      await handler()(request(`evidence/${evidence.id}/detail`)));
    expect(detail.text).not.toContain("sensitive visible page");
    expect(detail.text).not.toContain("a".repeat(64));
    expect(detail.references).toHaveLength(1);
    expect(detail.references[0].state).toBe("available");
    loaded.get(evidence.id)!.data = { screenshotKey: "e".repeat(64), action: { action: "type", value: "private-value" } };
    const missing = await data<{ text: string; references: unknown[] }>(await handler()(request(`evidence/${evidence.id}/detail`)));
    expect(missing.references).toEqual([{ evidenceId: null, state: "missing" }]);
    expect(missing.text).not.toContain("private-value");
  });

  it.each([
    (run: Run) => `runs/${run.id}/reports`,
    (run: Run, attempt: string) => `runs/${run.id}/attempts/${attempt}/report`,
    (run: Run) => `runs/${run.id}/groups/${"a".repeat(64)}`,
    (run: Run) => `runs/${run.id}/exports/json`,
    (run: Run) => `runs/${run.id}/exports/markdown`,
    (run: Run, attempt: string, evidence: Evidence) => `evidence/${evidence.id}`,
    (run: Run, attempt: string, evidence: Evidence) => `evidence/${evidence.id}/detail`,
    (run: Run, attempt: string, evidence: Evidence) => `evidence/${evidence.id}/content`,
  ])("denies anonymous and foreign-owner reads before loading artifacts", async (path) => {
    const api = handler();
    const uri = path(run, attemptId, evidence);
    expect((await api(request(uri, "invalid"))).status).toBe(401);
    expect((await api(request(uri, foreign.token))).status).toBe(404);
    expect((await api(request(uri, owner.token, { origin: "https://foreign.example" }))).status).toBe(403);
  });

  it("denies same-owner cross-run attempt routes and malformed/query/range requests", async () => {
    const api = handler();
    expect((await api(request(`runs/${run.id}/attempts/${randomUUID()}/report`))).status).toBe(404);
    expect((await api(request(`runs/${run.id}/reports?format=html`))).status).toBe(400);
    expect((await api(request(`runs/${run.id}/reports`, owner.token, { Range: "bytes=0-10" }))).status).toBe(400);
    expect((await api(request(`runs/${run.id}/groups/../../../`))).status).toBe(404);
  });

  it("marks late missing artifacts on a new revision instead of trusting the saved report snapshot", async () => {
    const service = new ReportService(repository, load);
    const first = service.report(owner.ownerId, run.id);
    loaded.get(evidence.id)!.state = "missing";
    const second = service.report(owner.ownerId, run.id);
    expect(second.revision).not.toBe(first.revision);
    expect(second.agents[0].evidence.find(({ id }) => id === evidence.id)?.state).toBe("missing");
    expect(second.agents[0].criteria[0].citations).toEqual([]);
  });

  it("rejects evidence metadata impersonating another actual attempt or owner", async () => {
    sql((db) => db.prepare("UPDATE evidence SET metadata=json_set(metadata,'$.attemptId',?) WHERE id=?").run(randomUUID(), evidence.id));
    const api = handler();
    expect((await api(request(`evidence/${evidence.id}`))).status).toBe(404);
    expect((await api(request(`evidence/${evidence.id}/detail`))).status).toBe(404);
    expect((await api(request(`runs/${run.id}/reports`))).status).toBe(404);
  });

  it("does not expose a foreign evidence ID smuggled into an owned event", async () => {
    const foreignId = randomUUID();
    sql((db) => db.prepare(`UPDATE events SET event=json_set(event,'$.data.evidenceId',?)
      WHERE run_id=? AND json_extract(event,'$.kind')='attempt.observation'`).run(foreignId, run.id));
    const report = await data<RunReport>(await handler()(request(`runs/${run.id}/reports`)));
    expect(JSON.stringify(report)).not.toContain(foreignId);
    expect(report.agents[0].timeline.find(({ kind }) => kind === "attempt.observation")).toMatchObject({ evidenceId: null, evidenceState: "missing" });
  });

  it("rejects an orphaned actual evidence relation even when the metadata claims the right owner", async () => {
    const foreignRun = repository.createControlledRun(foreign.ownerId, randomUUID(), {
      authorizationAcknowledged: true, controlledSiteId: "project-board",
      assignments: [{ personaId: "careful-first-timer", goal: "Other", criteria: ["Other"] }],
    }).run;
    const foreignAttempt = repository.attempts(foreign.ownerId, foreignRun.id)[0];
    sql((db) => db.prepare("UPDATE evidence SET attempt_id=? WHERE id=?").run(foreignAttempt.id, evidence.id));
    expect((await handler()(request(`evidence/${evidence.id}/detail`))).status).toBe(404);
  });

  it("checks session bindings rather than trusting a launch's JSON provider ID", () => {
    const other = repository.createControlledRun(foreign.ownerId, randomUUID(), {
      authorizationAcknowledged: true, controlledSiteId: "project-board",
      assignments: [{ personaId: "careful-first-timer", goal: "Other", criteria: ["Other"] }],
    }).run;
    const claim = repository.claim("other-worker")!;
    const sessionId = randomUUID();
    const reference = { sessionId, timeoutSeconds: 240,
      liveViewUrl: "", replayUrl: `https://www.browserbase.com/sessions/${sessionId}` };
    repository.sessionReference(claim, reference);
    expect(repository.recordingSession(foreign.ownerId, other.id, claim.attempt.id)).toEqual({ sessionId, active: true });
    expect(() => repository.recordingSession(owner.ownerId, other.id, claim.attempt.id)).toThrow("not_found");
    expect(() => repository.recordingSession(owner.ownerId, run.id, claim.attempt.id)).toThrow("not_found");
    sql((db) => db.prepare(`UPDATE launches SET session_reference=?
      WHERE job_id=(SELECT id FROM jobs WHERE run_id=?)`).run(JSON.stringify(reference), run.id));
    expect(() => repository.recordingSession(owner.ownerId, run.id, attemptId)).toThrow("not_found");
    expect(() => new ReportService(repository, load).report(owner.ownerId, run.id)).toThrow("not_found");
  });

  it("revalidates stored finding evidence on read, including same-owner cross-run references", () => {
    const finding = repository.recordFinding(owner.ownerId, {
      runId: run.id, attemptId, title: "Recorded observation", description: "Not a classification",
      evidenceIds: [evidence.id],
    });
    expect(repository.getFinding(owner.ownerId, finding.id)).toEqual(finding);
    const other = repository.createControlledRun(owner.ownerId, randomUUID(), {
      authorizationAcknowledged: true, controlledSiteId: "project-board",
      assignments: [{ personaId: "careful-first-timer", goal: "Other", criteria: ["Other"] }],
    }).run;
    const otherEvidence = repository.recordEvidence(owner.ownerId, {
      runId: other.id, attemptId: repository.attempts(owner.ownerId, other.id)[0].id, kind: "observation", summary: "Other evidence",
    }, "f".repeat(64));
    sql((db) => db.prepare("UPDATE findings SET finding=json_set(finding,'$.evidenceIds',json(?)) WHERE id=?")
      .run(JSON.stringify([otherEvidence.id]), finding.id));
    expect(() => repository.getFinding(owner.ownerId, finding.id)).toThrow("not_found");
  });

  it("uses the real private writer/reader in the default API and never downloads raw typed values", async () => {
    const writer = new ArtifactWriter({ dataDir: directory });
    const artifact = await writer.writeJson(run.id, attemptId, {
      kind: "action", actor: "agent", action: { action: "type", value: "private-typed-content", commentary: "Entered private-typed-content" },
      html: "<script>alert(1)</script>", url: "https://provider.invalid/live?token=private",
    });
    const actual = repository.recordEvidence(owner.ownerId, {
      runId: run.id, attemptId, kind: "observation", summary: "Action evidence",
    }, artifact.key);
    const api = createApi({ repository, configuration: { origin, production: false } });
    const content = await api(request(`evidence/${actual.id}/content`));
    expect(content.status).toBe(200);
    expect(content.headers.get("content-disposition")).toContain("attachment;");
    expect(content.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(content.headers.get("content-security-policy")).toContain("default-src 'none'");
    const result = await content.text();
    expect(result).not.toContain("private-typed-content");
    expect(result).not.toContain("provider.invalid");
    expect(result).not.toContain(artifact.key);
    expect((await api(request(`evidence/${actual.id}/content`, owner.token, { range: "bytes=0-10" }))).status).toBe(416);
    expect((await api(request(`evidence/${actual.id}/content`, foreign.token))).status).toBe(404);
    const report = await data<RunReport>(await api(request(`runs/${run.id}/reports`)));
    expect(report.agents[0].evidence.find(({ id }) => id === actual.id)?.state).toBe("available");
    rmSync(join(directory, "execution", run.id, attemptId, artifact.key));
    expect((await api(request(`evidence/${actual.id}/content`))).status).toBe(404);
    const changed = await data<RunReport>(await api(request(`runs/${run.id}/reports`)));
    expect(changed.agents[0].evidence.find(({ id }) => id === actual.id)?.state).toBe("missing");
  });
});
