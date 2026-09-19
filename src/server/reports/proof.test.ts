import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertReportOperation, canReserveReportRun, decodedReportRecording, exactReportClosure, exactReportLinks, exactResumeLedger,
  loadReportResumeState, removeReportResumeState, REPORT_RESUME_MAX_BYTES, REPORT_RESUME_TTL_MS,
  reportResumeSchema, retainReportResumeState, saveReportResumeState, validResumeIdentity,
  privateDownloadHeaders, readOnlyProjectJourney, reportPolicy, safeReportExport,
  type ExpectedReportLaunch, type RecordingPlaybackProof, type ReportHarnessMode, type ReportLinkSource, type ReportRemoteProof,
  type ReportResumeState,
} from "../../../scripts/report-proof";
import { runReportSchema } from "../../lib/report-contracts";
import { artifactDownloadResponse } from "./artifacts";
import { WorkerRepository } from "../worker/repository";
import { createApi } from "../api";

describe("private short-lived genuine-owner resume credentials", () => {
  let root: string;
  let directory: string;
  let state: ReportResumeState;
  const now = 1_800_000_000_000;
  beforeEach(async () => {
    root = resolve("data", `report-resume-test-${randomUUID()}`);
    const invocationId = randomUUID();
    directory = join(root, invocationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    state = {
      version: 1, invocationId, mode: "paid", ownerId: randomUUID(), runId: randomUUID(),
      ownerCookie: "a".repeat(43), createdAt: now, expiresAt: now + REPORT_RESUME_TTL_MS, reservedBeforeRun: 300,
    };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const file = () => join(directory, "owner-resume.json");
  it("retains genuine state for processing or unavailable recording without another allocation", () => {
    expect(retainReportResumeState(true, false, state.expiresAt, now)).toBe(true);
    expect(retainReportResumeState(false, true, state.expiresAt, now)).toBe(true);
    expect(retainReportResumeState(false, false, state.expiresAt, now)).toBe(true);
  });
  it("removes completed or expired state without extending its original deadline", () => {
    expect(retainReportResumeState(true, true, state.expiresAt, now)).toBe(false);
    expect(retainReportResumeState(true, false, state.expiresAt, state.expiresAt)).toBe(false);
    expect(retainReportResumeState(false, false, state.expiresAt, state.expiresAt + 1)).toBe(false);
  });
  it("round-trips only minimal credentials in mode600 and deletes on completion", async () => {
    await saveReportResumeState(root, state);
    expect((await lstat(file())).mode & 0o777).toBe(0o600);
    expect(await loadReportResumeState(root, state.invocationId, "paid", now + 1)).toEqual(state);
    expect(Object.keys(JSON.parse(await readFile(file(), "utf8")))).not.toContain("storageState");
    await removeReportResumeState(root, state.invocationId);
    await expect(lstat(file())).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([
    { version: 2 }, { ownerCookie: "fabricated-short-token" }, { ownerId: "not-an-owner" },
    { runId: "not-a-run" }, { invocationId: "../outside" }, { mode: "resume" },
    { expiresAt: now + REPORT_RESUME_TTL_MS + 1 }, { expiresAt: now },
    { reservedBeforeRun: 301 }, { providerKey: "never-store-this" },
  ])("rejects malformed or excessive credential state %j", (changes) => {
    expect(reportResumeSchema.safeParse({ ...state, ...changes }).success).toBe(false);
  });
  it.each(["expired", "future", "wrong-mode", "wrong-invocation", "unsafe-file", "oversized", "malformed"] as const)(
    "removes only the explicit local credential file on %s", async (condition) => {
      await saveReportResumeState(root, state);
      if (condition === "unsafe-file") await chmod(file(), 0o644);
      if (condition === "oversized") await writeFile(file(), "x".repeat(REPORT_RESUME_MAX_BYTES + 1));
      if (condition === "malformed") await writeFile(file(), "{");
      if (condition === "wrong-invocation") await writeFile(file(), JSON.stringify({ ...state, invocationId: randomUUID() }));
      await expect(loadReportResumeState(root, state.invocationId, condition === "wrong-mode" ? "offline-test" : "paid",
        condition === "expired" ? state.expiresAt : condition === "future" ? now - 1 : now + 1))
        .rejects.toThrow("report_resume_state_invalid");
      await expect(lstat(file())).rejects.toMatchObject({ code: "ENOENT" });
    });
  it("unlinks a credential-file symlink without reading or deleting its target", async () => {
    const target = join(root, "do-not-touch.json");
    await writeFile(target, JSON.stringify(state), { mode: 0o600 });
    await symlink(target, file());
    await expect(loadReportResumeState(root, state.invocationId, "paid", now + 1)).rejects.toThrow("report_resume_state_invalid");
    expect(await readFile(target, "utf8")).toBe(JSON.stringify(state));
    await expect(lstat(file())).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("never follows a directory symlink or deletes credentials through it", async () => {
    const target = join(root, "do-not-touch");
    await mkdir(target, { mode: 0o700 });
    await writeFile(join(target, "owner-resume.json"), JSON.stringify(state), { mode: 0o600 });
    await rm(directory, { recursive: true });
    await symlink(target, directory);
    await expect(loadReportResumeState(root, state.invocationId, "paid", now + 1)).rejects.toThrow("report_resume_state_invalid");
    expect(await readFile(join(target, "owner-resume.json"), "utf8")).toBe(JSON.stringify(state));
  });
  it("rejects unsafe directory permissions without following or deleting through them", async () => {
    await saveReportResumeState(root, state);
    await chmod(directory, 0o755);
    await expect(loadReportResumeState(root, state.invocationId, "paid", now + 1)).rejects.toThrow("report_resume_state_invalid");
    expect((await lstat(file())).isFile()).toBe(true);
  });
  it("rejects fake credentials and owner/run mismatches independently of schema validity", () => {
    const run = { id: state.runId, ownerId: state.ownerId };
    expect(validResumeIdentity(state, state.ownerId, run)).toBe(true);
    expect(validResumeIdentity(state, undefined, run)).toBe(false);
    expect(validResumeIdentity(state, randomUUID(), run)).toBe(false);
    expect(validResumeIdentity(state, state.ownerId, { ...run, ownerId: randomUUID() })).toBe(false);
    expect(validResumeIdentity(state, state.ownerId, { ...run, id: randomUUID() })).toBe(false);
  });
  it("requires explicit isolated offline mode and zero paid reservations", async () => {
    const offline = { ...state, mode: "offline-test" as const, reservedBeforeRun: 0 };
    await saveReportResumeState(root, offline);
    expect(await loadReportResumeState(root, state.invocationId, "offline-test", now + 1)).toEqual(offline);
    expect(reportResumeSchema.safeParse({ ...offline, reservedBeforeRun: 300 }).success).toBe(false);
  });
  it("verifies a genuine opaque cookie through empty bootstrap and never mints a replacement for a fake", async () => {
    const repository = new WorkerRepository(root);
    try {
      const owner = repository.createSession();
      const origin = "https://127.0.0.1:4326";
      const api = createApi({ repository, configuration: {
        origin, production: true, accessCode: "test-access-gate-not-written-to-state".repeat(2),
      } });
      const bootstrap = (token: string) => api(new Request(`${origin}/api/v1/session`, {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: `__Host-ff_owner=${token}` },
        body: "{}",
      }));
      const genuine = await bootstrap(owner.token);
      expect(genuine.status).toBe(200);
      expect((await genuine.json()).data.ownerId).toBe(owner.ownerId);
      expect(genuine.headers.has("set-cookie")).toBe(false);
      const fake = await bootstrap("b".repeat(43));
      expect(fake.status).toBe(401);
      expect(fake.headers.has("set-cookie")).toBe(false);
      expect(repository.session("b".repeat(43))).toBeNull();
      expect(repository.accounting().reservedSeconds).toBe(0);
      expect(repository.claim("offline-readback-must-not-have-jobs")).toBeNull();
    } finally { repository.close(); }
  });
});

describe("readback-only admission fence", () => {
  it.each(["resume", "offline-resume"] as ReportHarnessMode[])("never allocates, starts workers or mutates runs in %s", (mode) => {
    for (const operation of ["worker", "create-run", "cancel-run"] as const) {
      expect(() => assertReportOperation(mode, operation)).toThrow("report_readback_cannot_allocate_or_mutate_run");
    }
    expect(() => assertReportOperation(mode, "readback")).not.toThrow();
  });
  it("allows only paid workers; offline setup can create and cancel but cannot allocate", () => {
    expect(() => assertReportOperation("paid", "worker")).not.toThrow();
    expect(() => assertReportOperation("offline", "worker")).toThrow();
    expect(() => assertReportOperation("offline", "create-run")).not.toThrow();
    expect(() => assertReportOperation("offline", "cancel-run")).not.toThrow();
  });
  it("requires the complete original ledger and unchanged non-refundable reservations", () => {
    const before = [{ correlationToken: "a", sessionId: "s", attemptId: "attempt", runId: "run" }];
    expect(exactResumeLedger(before, [...before], 300, 300)).toBe(true);
    expect(exactResumeLedger(before, [...before], 300, 0)).toBe(false);
    expect(exactResumeLedger(before, [...before], 300, 600)).toBe(false);
    expect(exactResumeLedger(before, [], 300, 300)).toBe(false);
    expect(exactResumeLedger(before, [{ ...before[0], sessionId: "foreign" }], 300, 300)).toBe(false);
    expect(exactResumeLedger(before, [before[0], { ...before[0], correlationToken: "b" }], 300, 600)).toBe(false);
    expect(exactResumeLedger([], [], 0, 0)).toBe(true);
  });
});

describe("actual private download response policy", () => {
  const response = () => artifactDownloadResponse({
    status: "available", kind: "screenshot", evidenceId: "screenshot",
    mime: "image/png", bytes: Buffer.from("private pixels"), redaction: "not-redacted",
  });
  it("accepts the real artifact reader's compound private no-store policy", () => {
    const actual = response();
    expect(actual.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(privateDownloadHeaders(Object.fromEntries(actual.headers), "image/png")).toBe(true);
  });
  it.each(["content-type", "content-disposition", "cache-control", "x-content-type-options"])(
    "requires %s rather than weakening the private download check", (header) => {
      const actual = response();
      actual.headers.delete(header);
      expect(privateDownloadHeaders(Object.fromEntries(actual.headers), "image/png")).toBe(false);
    },
  );
  it.each(["private, max-age=0", "public, no-store", "no-store-ish"])("rejects unsafe %s", (value) => {
    const actual = response();
    actual.headers.set("cache-control", value);
    expect(privateDownloadHeaders(Object.fromEntries(actual.headers), "image/png")).toBe(false);
  });
});

function fixture() {
  const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
  const runId = id(1);
  const attemptId = id(2);
  const timestamp = "2026-09-19T10:00:00.000Z";
  const page = "https://board.flash-flood.invalid/project-board/projects";
  const source: ReportLinkSource = {
    runId, attemptId,
    events: [
      { runId, attemptId, sequence: 1, timestamp, kind: "attempt.action",
        data: { actor: "agent", step: 1, action: "click", evidenceId: id(3) } },
      { runId, attemptId, sequence: 2, timestamp, kind: "attempt.observation",
        data: { actor: "agent", pageUrl: page, evidenceId: id(4) } },
    ],
    steps: [
      { attemptId, ordinal: 1, kind: "action", evidenceId: id(3) },
      { attemptId, ordinal: 2, kind: "observation", evidenceId: id(4) },
    ],
    evidence: [
      { id: id(3), runId, attemptId, kind: "observation", storageKey: "a".repeat(64) },
      { id: id(4), runId, attemptId, kind: "observation", storageKey: "b".repeat(64) },
      { id: id(5), runId, attemptId, kind: "screenshot", storageKey: "c".repeat(64) },
    ],
    observations: [{ evidenceId: id(4), observationId: "observation-1", screenshotKey: "c".repeat(64),
      checks: [{ criterion: "projects-open", passed: true }] }],
  };
  const report = runReportSchema.parse({
    version: "report-v1", signatureVersion: "finding-v2", runId, revision: "revision",
    status: "succeeded", finality: "final", target: page, createdAt: timestamp, updatedAt: timestamp, groups: [], notices: [],
    agents: [{
      attemptId, persona: { id: "careful-first-timer", name: "Careful", device: "desktop" },
      goal: "Open projects without editing", status: "succeeded", finality: "final",
      launchState: "settled", cleanup: "closed", steps: 1, modelCalls: 1, groupSignatures: [],
      criteria: [{
        key: "projects-open", definitionSignature: "definition", description: "Projects is open",
        semantics: "current", status: "met", method: "structural", confidence: null,
        confidenceMeaning: "heuristic", explanation: "URL matches", uncertainty: null,
        citations: [{ step: 1, observationId: "observation-1", page, excerpt: "URL matches",
          evidenceIds: [id(4), id(5)], state: "available" }],
      }],
      timeline: source.events.map((event) => ({
        sequence: event.sequence, timestamp, kind: event.kind, actor: event.data.actor,
        step: event.data.step ?? null, action: event.data.action ?? null, commentary: null,
        page: event.data.pageUrl ?? null, evidenceId: event.data.evidenceId, evidenceState: "available",
      })),
      evidence: source.evidence.map((entry) => ({
        id: entry.id, attemptId, kind: entry.kind, createdAt: timestamp, state: "available",
        sensitivity: entry.kind === "screenshot" ? "private_pixels" : "redacted_text",
      })),
    }],
  });
  return { source, report };
}

describe("report rehearsal non-refundable lifetime policy", () => {
  it("reserves one 300-second session, never credits completed or failed sessions", () => {
    expect(reportPolicy).toMatchObject({ sessionSeconds: 300, globalConcurrency: 2, baselineSeconds: 944,
      lifetimeReservationLimitSeconds: 1200, developmentBudgetSeconds: 2144 });
    for (const total of [0, 300, 600, 900]) expect(canReserveReportRun(total)).toBe(true);
    for (const total of [-1, 900.5, 901, 1200, NaN, Infinity]) expect(canReserveReportRun(total)).toBe(false);
  });
});

describe("exact report-to-durable-source proof", () => {
  it("requires the actual observation, PNG reference, action and timeline associations", () => {
    const { source, report } = fixture();
    expect(exactReportLinks(report, source)).toBe(true);
  });

  it.each(["foreign-attempt", "foreign-run", "wrong-screenshot", "missing-screenshot", "duplicate-citation",
    "wrong-observation", "wrong-page", "wrong-step", "extra-timeline", "wrong-action-reference",
    "reordered-steps", "failed-observation", "edit-action", "missing-timeline", "duplicate-evidence"] as const)(
    "rejects %s rather than accepting a successful-looking report", (change) => {
      const { source, report } = fixture();
      const agent = report.agents[0];
      const citation = agent.criteria[0].citations[0];
      switch (change) {
        case "foreign-attempt": source.evidence[2].attemptId = "foreign"; break;
        case "foreign-run": source.evidence[2].runId = "foreign"; break;
        case "wrong-screenshot": source.observations[0].screenshotKey = "wrong"; break;
        case "missing-screenshot": agent.evidence[2].state = "missing"; break;
        case "duplicate-citation": citation.evidenceIds[1] = citation.evidenceIds[0]; break;
        case "wrong-observation": citation.observationId = "not-persisted"; break;
        case "wrong-page": citation.page = "https://board.flash-flood.invalid/project-board"; break;
        case "wrong-step": citation.step = 2; break;
        case "extra-timeline": agent.timeline.push(agent.timeline[0]); break;
        case "wrong-action-reference": agent.timeline[0].evidenceId = agent.evidence[1].id; break;
        case "reordered-steps": source.steps.reverse(); break;
        case "failed-observation": source.observations[0].checks[0].passed = false; break;
        case "edit-action": source.events[0].data.action = agent.timeline[0].action = "type"; break;
        case "missing-timeline": agent.timeline.pop(); break;
        case "duplicate-evidence": agent.evidence[1] = agent.evidence[0]; break;
      }
      expect(exactReportLinks(report, source)).toBe(false);
    });
});

describe("exact remotely reread closure", () => {
  const launch: ExpectedReportLaunch = { correlationToken: "correlation", sessionId: "session", runId: "run", attemptId: "attempt" };
  const proof = (): ReportRemoteProof[] => [{ correlationToken: "correlation",
    result: { confirmed: true, sessions: [{ sessionId: "session", status: "COMPLETED", actualBrowserSeconds: 42 }] } }];
  it("accepts only the exact independently persisted session set", () => {
    expect(exactReportClosure([launch], proof())).toBe(true);
    expect(exactReportClosure([], [])).toBe(false);
    expect(exactReportClosure([launch, launch], [...proof(), ...proof()])).toBe(false);
    expect(exactReportClosure([{ ...launch, sessionId: undefined }], proof())).toBe(false);
  });
  it.each(["wrong-id", "wrong-correlation", "unconfirmed", "extra-session", "running", "timed-out", "missing-duration", "over-ttl"] as const)(
    "rejects %s", (change) => {
      const remote = proof();
      const result = remote[0].result;
      switch (change) {
        case "wrong-id": result.sessions[0].sessionId = "different"; break;
        case "wrong-correlation": remote[0].correlationToken = "different"; break;
        case "unconfirmed": result.confirmed = false; break;
        case "extra-session": result.sessions.push({ ...result.sessions[0], sessionId: "different" }); break;
        case "running": result.sessions[0].status = "RUNNING"; break;
        case "timed-out": result.sessions[0].status = "TIMED_OUT"; break;
        case "missing-duration": delete result.sessions[0].actualBrowserSeconds; break;
        case "over-ttl": result.sessions[0].actualBrowserSeconds = 301; break;
      }
      expect(exactReportClosure([launch], remote)).toBe(false);
    });
});

describe("safe export checks", () => {
  it("rejects credentials, exact provider references, embedded images and active markup", () => {
    expect(safeReportExport("safe stable evidence ID", ["credential"])).toBe(true);
    for (const text of ["credential", "https://www.browserbase.com/sessions/secret",
      "<script>alert(1)</script>", "data:image/png;base64,abc", "![private](https://example.test/image)"]) {
      expect(safeReportExport(text, ["credential"])).toBe(false);
    }
  });

  describe("read-only projects journey", () => {
    const observation = {
      kind: "observation" as const, textBlocks: ["No projects yet. Start with New project.", "0 of 12 synthetic projects in this tab."],
      candidates: [{ id: "projects", kind: "link", label: "All projects" }, { id: "reset", kind: "button", label: "Reset this tab" }],
    };
    it("grounds navigation in the actual candidate and unchanged empty list", () => {
      expect(readOnlyProjectJourney([observation, { kind: "action", action: "click", candidateId: "projects" }, observation])).toBe(true);
      expect(readOnlyProjectJourney([observation])).toBe(false);
    });

    describe("decoded recording playback proof", () => {
      const proof = (): RecordingPlaybackProof => ({
        initialTime: 0, currentTime: 1.2, decodedFrames: 12, readyState: 4, width: 1280, height: 900,
        pixelSamples: 4096, opaqueSamples: 4096, distinctColors: 32, screenshotBytes: 12000,
        protectedPlaylistRead: true, protectedMediaReads: 2, onlySameOriginMedia: true,
      });

      it("accepts advancing, decoded nonblank private video using protected routes", () => {
        expect(decodedReportRecording(proof())).toBe(true);
      });
      it.each([
        { currentTime: 0 }, { decodedFrames: 0 }, { readyState: 1 }, { distinctColors: 1 },
        { opaqueSamples: 0 }, { screenshotBytes: 0 }, { protectedPlaylistRead: false },
        { protectedMediaReads: 0 }, { onlySameOriginMedia: false }, { width: 0 },
      ])("rejects metadata-only, blank, stalled or unprotected media %j", (change) => {
        expect(decodedReportRecording({ ...proof(), ...change })).toBe(false);
      });
    });
    it("rejects reset, typing and a nonempty final list", () => {
      expect(readOnlyProjectJourney([observation, { kind: "action", action: "click", candidateId: "reset" }, observation])).toBe(false);
      expect(readOnlyProjectJourney([observation, { kind: "action", action: "type", candidateId: null }, observation])).toBe(false);
      expect(readOnlyProjectJourney([observation, { kind: "action", action: "click", candidateId: "projects" },
        { ...observation, textBlocks: ["1 of 12 synthetic projects in this tab."] }])).toBe(false);
    });
  });
});
