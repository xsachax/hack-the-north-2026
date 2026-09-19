import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { RunEvent } from "../src/lib/contracts";
import type { RunReport } from "../src/lib/report-contracts";
import type { CloudRecoveryResult } from "../src/server/worker/cloud-recovery";

export const reportPolicy = {
  globalConcurrency: 2, ownerConcurrency: 2, sessionSeconds: 300,
  maxSteps: 12, maxModelCalls: 24, baselineSeconds: 944,
  developmentBudgetSeconds: 2144, ownerBudgetSeconds: 1200,
  lifetimeReservationLimitSeconds: 1200,
};

export const REPORT_RESUME_TTL_MS = 15 * 60 * 1000;
export const REPORT_RESUME_MAX_BYTES = 8192;
export const reportResumeSchema = z.strictObject({
  version: z.literal(1), invocationId: z.uuid(), mode: z.enum(["paid", "offline-test"]),
  ownerId: z.uuid(), runId: z.uuid(), ownerCookie: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  createdAt: z.int().nonnegative(), expiresAt: z.int().nonnegative(),
  reservedBeforeRun: z.int().min(0).max(900),
}).refine((state) => state.expiresAt > state.createdAt && state.expiresAt - state.createdAt <= REPORT_RESUME_TTL_MS &&
  state.reservedBeforeRun % 300 === 0 && (state.mode !== "offline-test" || state.reservedBeforeRun === 0));
export type ReportResumeState = z.infer<typeof reportResumeSchema>;
export type ReportHarnessMode = "paid" | "resume" | "offline" | "offline-resume";

export function retainReportResumeState(passed: boolean, playbackFinished: boolean, expiresAt: number, now = Date.now()): boolean {
  return now < expiresAt && (!passed || !playbackFinished);
}

export function assertReportOperation(mode: ReportHarnessMode, operation: "worker" | "create-run" | "cancel-run" | "readback") {
  const allowed = operation === "readback" ||
    (operation === "worker" ? mode === "paid" : mode === "paid" || mode === "offline");
  if (!allowed) throw new Error("report_readback_cannot_allocate_or_mutate_run");
}

export function validResumeIdentity(state: ReportResumeState, sessionOwner: string | undefined, run: { id: string; ownerId: string }): boolean {
  return sessionOwner === state.ownerId && run.ownerId === state.ownerId && run.id === state.runId;
}

async function resumeDirectory(root: string, invocationId: string): Promise<string> {
  z.uuid().parse(invocationId);
  const directory = join(resolve(root), invocationId);
  for (const path of [resolve(root), directory]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
      (process.getuid && info.uid !== process.getuid()) || await realpath(path) !== path) {
      throw new Error("report_resume_directory_unsafe");
    }
  }
  return directory;
}

export async function saveReportResumeState(root: string, value: ReportResumeState): Promise<void> {
  const state = reportResumeSchema.parse(value);
  const directory = await resumeDirectory(root, state.invocationId);
  const text = JSON.stringify(state);
  if (Buffer.byteLength(text) > REPORT_RESUME_MAX_BYTES) throw new Error("report_resume_state_too_large");
  const file = await open(join(directory, "owner-resume.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
}

export async function removeReportResumeState(root: string, invocationId: string): Promise<void> {
  const directory = await resumeDirectory(root, invocationId);
  await unlink(join(directory, "owner-resume.json")).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  });
}

/** Only this explicitly named credential file is read/deleted; never follow a directory or file symlink. */
export async function loadReportResumeState(
  root: string, invocationId: string, mode: ReportResumeState["mode"], now = Date.now(),
): Promise<ReportResumeState> {
  let directory: string | undefined;
  try {
    directory = await resumeDirectory(root, invocationId);
    const file = await open(join(directory, "owner-resume.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
        (process.getuid && info.uid !== process.getuid()) || info.size <= 0 || info.size > REPORT_RESUME_MAX_BYTES) {
        throw new Error("report_resume_file_unsafe");
      }
      const bytes = Buffer.alloc(REPORT_RESUME_MAX_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== info.size || (await file.stat()).size !== bytesRead) throw new Error("report_resume_file_changed");
      const state = reportResumeSchema.parse(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
      if (state.invocationId !== invocationId || state.mode !== mode || now < state.createdAt || now >= state.expiresAt) {
        throw new Error("report_resume_state_expired_or_mismatched");
      }
      return state;
    } finally { await file.close(); }
  } catch {
    if (directory) await unlink(join(directory, "owner-resume.json")).catch(() => {});
    throw new Error("report_resume_state_invalid");
  }
}

export function exactResumeLedger(
  before: readonly ExpectedReportLaunch[], after: readonly ExpectedReportLaunch[],
  reservedBefore: number, reservedAfter: number,
): boolean {
  return Number.isInteger(reservedBefore) && reservedBefore >= 0 && reservedBefore <= 1200 &&
    reservedBefore === reservedAfter && before.length === after.length &&
    new Set(before.map((item) => item.correlationToken)).size === before.length &&
    new Set(after.map((item) => item.correlationToken)).size === after.length &&
    before.every((item) => after.some((other) => item.correlationToken === other.correlationToken &&
      item.sessionId === other.sessionId && item.attemptId === other.attemptId && item.runId === other.runId));
}

export function canReserveReportRun(reservedSeconds: number): boolean {
  return Number.isInteger(reservedSeconds) && reservedSeconds >= 0 &&
    reservedSeconds + reportPolicy.sessionSeconds <= reportPolicy.lifetimeReservationLimitSeconds;
}

export function privateDownloadHeaders(headers: Record<string, string>, mime: string): boolean {
  const cache = headers["cache-control"]?.split(",").map((part) => part.trim().toLowerCase()) ?? [];
  return cache.includes("no-store") && !cache.includes("public") &&
    headers["content-type"]?.split(";")[0].trim().toLowerCase() === mime &&
    headers["content-disposition"]?.startsWith("attachment;") === true &&
    headers["x-content-type-options"] === "nosniff";
}

export type ExpectedReportLaunch = {
  correlationToken: string; sessionId?: string; attemptId: string; runId: string;
};
export type ReportRemoteProof = { correlationToken: string; result: CloudRecoveryResult };

/** The durable allocation ledger, not a provider response, defines the expected set. */
export function exactReportClosure(expected: readonly ExpectedReportLaunch[], proof: readonly ReportRemoteProof[]): boolean {
  if (!expected.length || expected.length !== proof.length ||
    new Set(expected.map((item) => item.correlationToken)).size !== expected.length ||
    new Set(expected.map((item) => item.sessionId)).size !== expected.length ||
    new Set(proof.map((item) => item.correlationToken)).size !== proof.length) return false;
  return expected.every((launch) => {
    const result = proof.find((item) => item.correlationToken === launch.correlationToken)?.result;
    if (!launch.sessionId || !result?.confirmed || result.sessions.length !== 1) return false;
    const session = result.sessions[0];
    return session.sessionId === launch.sessionId && session.status === "COMPLETED" &&
      Number.isFinite(session.actualBrowserSeconds) && session.actualBrowserSeconds! >= 0 &&
      session.actualBrowserSeconds! <= reportPolicy.sessionSeconds;
  });
}

export type ReportLinkSource = {
  runId: string;
  attemptId: string;
  events: RunEvent[];
  steps: { ordinal: number; kind: string; evidenceId: string; attemptId: string }[];
  evidence: { id: string; runId: string; attemptId: string; kind: string; storageKey: string }[];
  observations: {
    evidenceId: string; observationId: string; screenshotKey?: string;
    checks: { criterion: string; passed: boolean }[];
  }[];
};

export type ProjectJourneyEntry =
  | { kind: "observation"; textBlocks: readonly string[]; candidates: readonly { id: string; kind: string; label: string }[] }
  | { kind: "action"; action: string; candidateId: string | null };

export function readOnlyProjectJourney(entries: readonly ProjectJourneyEntry[]): boolean {
  let observed: Extract<ProjectJourneyEntry, { kind: "observation" }> | undefined;
  let navigated = false;
  let observedAfterNavigation = false;
  for (const entry of entries) {
    if (entry.kind === "observation") { observed = entry; observedAfterNavigation ||= navigated; continue; }
    if (entry.action === "click") {
      const candidate = observed?.candidates.find((item) => item.id === entry.candidateId);
      if (candidate?.kind !== "link" || candidate.label !== "All projects") return false;
      navigated = true;
    } else if (entry.action === "navigate") navigated = true;
    else if (!["scroll", "wait", "back"].includes(entry.action)) return false;
  }
  return navigated && observedAfterNavigation && entries.at(-1)?.kind === "observation" && !!observed &&
    observed.textBlocks.includes("No projects yet. Start with New project.") &&
    observed.textBlocks.includes("0 of 12 synthetic projects in this tab.");
}

/** Check both directions so extra, duplicated or cross-attempt references cannot pass. */
export function exactReportLinks(report: RunReport, source: ReportLinkSource): boolean {
  const agent = report.agents[0];
  if (report.runId !== source.runId || report.status !== "succeeded" || report.finality !== "final" ||
    report.agents.length !== 1 || !agent || agent.attemptId !== source.attemptId ||
    agent.status !== "succeeded" || agent.finality !== "final" || agent.launchState !== "settled" ||
    agent.cleanup !== "closed" || agent.steps < 1 || agent.steps > reportPolicy.maxSteps ||
    agent.modelCalls < 1 || agent.modelCalls > reportPolicy.maxModelCalls) return false;
  if (source.evidence.some((item) => item.runId !== source.runId || item.attemptId !== source.attemptId) ||
    new Set(source.evidence.map((item) => item.id)).size !== source.evidence.length ||
    new Set(source.evidence.map((item) => item.storageKey)).size !== source.evidence.length ||
    agent.evidence.length !== source.evidence.length ||
    new Set(agent.evidence.map((item) => item.id)).size !== agent.evidence.length ||
    !agent.evidence.every((item) => source.evidence.some((entry) =>
      entry.id === item.id && entry.attemptId === item.attemptId && entry.kind === item.kind))) return false;
  const events = source.events.filter((item) => item.attemptId === source.attemptId);
  if (agent.timeline.length !== events.length || !agent.timeline.every((item, index) => {
    const event = events[index];
    return item.sequence === event.sequence && item.timestamp === event.timestamp && item.kind === event.kind &&
      item.actor === (event.data.actor ?? null) && item.step === (event.data.step ?? null) &&
      item.action === (event.data.action ?? null) && item.evidenceId === (event.data.evidenceId ?? null) &&
      item.page === (event.data.pageUrl ?? null);
  })) return false;
  const stepEvents = events.filter((event) => ["attempt.observation", "attempt.decision", "attempt.action"].includes(event.kind));
  if (source.steps.length !== stepEvents.length || !source.steps.every((step, index) =>
    step.attemptId === source.attemptId && step.ordinal === index + 1 &&
    stepEvents[index].kind === `attempt.${step.kind}` && stepEvents[index].data.evidenceId === step.evidenceId &&
    agent.evidence.some((item) => item.id === step.evidenceId && item.state === "available"))) return false;
  if (source.observations.length !== source.steps.filter((step) => step.kind === "observation").length ||
    new Set(source.observations.map((item) => item.evidenceId)).size !== source.observations.length ||
    !source.observations.every((item) => source.steps.some((step) =>
      step.kind === "observation" && step.evidenceId === item.evidenceId))) return false;
  if (!report.groups.every((group) => agent.groupSignatures.includes(group.signature) &&
    group.occurrences.every((item) => item.attemptId === source.attemptId && item.personaId === agent.persona.id &&
      item.evidenceIds.every((id) => source.evidence.some((entry) => entry.id === id)))) ||
    !agent.groupSignatures.every((signature) => report.groups.some((group) => group.signature === signature))) return false;
  const actions = events.filter((event) => event.kind === "attempt.action");
  if (actions.length !== agent.steps || !actions.every((event, index) =>
    event.data.actor === "agent" && event.data.step === index + 1 &&
    ["click", "navigate", "back", "scroll", "wait"].includes(event.data.action ?? ""))) return false;
  const criterion = agent.criteria[0];
  if (agent.criteria.length !== 1 || criterion?.key !== "projects-open" ||
    criterion.status !== "met" || criterion.method !== "structural" || !criterion.citations.length) return false;
  return criterion.citations.every((citation) => {
    const observation = source.observations.find((item) => item.observationId === citation.observationId);
    const screenshot = source.evidence.find((item) => item.storageKey === observation?.screenshotKey && item.kind === "screenshot");
    const observationEvent = events.find((item) => item.kind === "attempt.observation" &&
      item.data.evidenceId === observation?.evidenceId);
    let path: string | undefined;
    try { path = new URL(citation.page ?? "").pathname; } catch { return false; }
    if (!observation || !screenshot || !observationEvent || path !== "/project-board/projects" ||
      citation.page !== observationEvent.data.pageUrl || citation.state !== "available" ||
      !observation.checks.some((check) => check.criterion === criterion.key && check.passed)) return false;
    const priorAction = actions.filter((event) => event.sequence < observationEvent.sequence).at(-1);
    const ids = [observation.evidenceId, screenshot.id];
    return citation.step === (priorAction?.data.step ?? 0) && citation.evidenceIds.length === ids.length &&
      new Set(citation.evidenceIds).size === ids.length && ids.every((id) =>
        citation.evidenceIds.includes(id) && agent.evidence.some((item) => item.id === id && item.state === "available"));
  });
}

export function safeReportExport(text: string, privateValues: readonly string[]): boolean {
  return !privateValues.some((value) => value.length > 0 && text.includes(value)) &&
    !/(?:https?|wss?):\/\/[^\s"'<>]*(?:browserbase\.com|stagehand\.com)|data:image|<script|!\[[^\]]*\]\(/i.test(text);
}

export type RecordingPlaybackProof = {
  initialTime: number; currentTime: number; decodedFrames: number; readyState: number;
  width: number; height: number; pixelSamples: number; opaqueSamples: number; distinctColors: number;
  screenshotBytes: number; protectedPlaylistRead: boolean; protectedMediaReads: number; onlySameOriginMedia: boolean;
};

/** Rendering proof, in addition to the server's authorized session/media association. */
export function decodedReportRecording(proof: RecordingPlaybackProof): boolean {
  return proof.protectedPlaylistRead && proof.protectedMediaReads > 0 && proof.onlySameOriginMedia &&
    proof.readyState >= 2 && proof.currentTime > proof.initialTime && proof.decodedFrames > 0 &&
    proof.width >= 200 && proof.height >= 120 && proof.pixelSamples >= 256 &&
    proof.opaqueSamples >= proof.pixelSamples * 0.9 && proof.distinctColors >= 8 && proof.screenshotBytes >= 1024;
}
