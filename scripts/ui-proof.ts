import type { RunEvent } from "../src/lib/contracts";
import type { AttemptSummary } from "../src/lib/ui-contracts";
import type { CloudRecoveryResult } from "../src/server/worker/cloud-recovery";

export const uiPolicy = {
  globalConcurrency: 3, ownerConcurrency: 3, sessionSeconds: 300,
  maxSteps: 12, maxModelCalls: 24, baselineSeconds: 852,
  developmentBudgetSeconds: 2652, ownerBudgetSeconds: 1800,
  lifetimeReservationLimitSeconds: 1800,
};

export function canReserveUiRun(reservedSeconds: number): boolean {
  return Number.isInteger(reservedSeconds) && reservedSeconds >= 0 &&
    reservedSeconds + 2 * uiPolicy.sessionSeconds <= uiPolicy.lifetimeReservationLimitSeconds;
}

export type ExpectedLaunch = {
  correlationToken: string; sessionId?: string; attemptId: string; runId: string;
};
export type RemoteProof = { correlationToken: string; result: CloudRecoveryResult };

/** Expected identities come from SQLite, never from the provider's answer. */
export function exactCompletedClosure(expected: readonly ExpectedLaunch[], proof: readonly RemoteProof[]): boolean {
  if (!expected.length || expected.length !== proof.length ||
    new Set(expected.map((item) => item.correlationToken)).size !== expected.length ||
    new Set(expected.map((item) => item.sessionId)).size !== expected.length ||
    new Set(proof.map((item) => item.correlationToken)).size !== proof.length) return false;
  return expected.every((launch) => {
    const found = proof.find((item) => item.correlationToken === launch.correlationToken)?.result;
    if (!launch.sessionId || !found?.confirmed || found.sessions.length !== 1) return false;
    const session = found.sessions[0];
    return session.sessionId === launch.sessionId && session.status === "COMPLETED" &&
      Number.isFinite(session.actualBrowserSeconds) && session.actualBrowserSeconds! >= 0 &&
      session.actualBrowserSeconds! <= uiPolicy.sessionSeconds;
  });
}

export type VisualSample = {
  kind: "canvas" | "video"; width: number; height: number; visible: boolean;
  pixelSamples: number; opaqueSamples: number; distinctColors: number;
  readyState?: number; currentTime?: number; decodedFrames?: number;
};
export type ViewerProof = {
  attemptId: string; authenticatedUrl: string; iframeUrl: string;
  documentReady: boolean; screenshotBytes: number; samples: VisualSample[];
};

/** A loaded iframe (or video shell) is not proof that browser pixels arrived. */
export function renderedViewer(proof: ViewerProof): boolean {
  if (!proof.authenticatedUrl || proof.iframeUrl !== proof.authenticatedUrl ||
    !proof.documentReady || proof.screenshotBytes < 1024) return false;
  return proof.samples.some((sample) => sample.visible && sample.width >= 200 && sample.height >= 120 &&
    sample.pixelSamples >= 256 && sample.opaqueSamples >= sample.pixelSamples * 0.9 && sample.distinctColors >= 8 &&
    (sample.kind === "canvas" || (sample.readyState! >= 2 &&
      (sample.currentTime! > 0 || sample.decodedFrames! > 0))));
}

export type PersistedStep = { attemptId: string; ordinal: number; kind: string; evidenceId: string };
export type WallEvent = { sequence: number; text: string; timestamp: string | null };

export function exactWallProof(
  summaries: readonly AttemptSummary[], events: readonly RunEvent[],
  steps: readonly PersistedStep[], wall: readonly WallEvent[],
): boolean {
  const expectedWall = events.slice(-200);
  if (summaries.length !== 2 || wall.length !== expectedWall.length ||
    new Set(summaries.map((item) => item.attemptId)).size !== 2 ||
    new Set(wall.map((item) => item.sequence)).size !== wall.length) return false;
  if (!expectedWall.every((event, index) => {
    const row = wall[index];
    return row.sequence === event.sequence && row.timestamp === event.timestamp &&
      row.text.includes(event.kind.replaceAll("_", " ").replaceAll(".", " · ")) &&
      (!event.data.action || row.text.includes(event.data.action)) &&
      (!event.data.commentary || row.text.includes(event.data.commentary)) &&
      (!event.data.pageUrl || row.text.includes(event.data.pageUrl));
  })) return false;
  const stepEvents = events.filter((event) => ["attempt.observation", "attempt.decision", "attempt.action"].includes(event.kind));
  if (stepEvents.length !== steps.length || steps.some((step) =>
    !summaries.some((summary) => summary.attemptId === step.attemptId))) return false;
  return summaries.every((item) => {
    const summary = item.summary;
    const actions = events.filter((event) => event.attemptId === item.attemptId && event.kind === "attempt.action");
    const ownSteps = steps.filter((step) => step.attemptId === item.attemptId);
    const ownEvents = stepEvents.filter((event) => event.attemptId === item.attemptId);
    const operations = summary?.modelOperations;
    return item.status === "succeeded" && item.launchState === "settled" &&
      item.reservedSeconds === 300 && item.usage?.remoteStatus === "COMPLETED" &&
      summary?.cleanup.status === "closed" && actions.length > 0 && actions.length === summary.steps &&
      summary.steps <= 12 && summary.modelCalls > 0 && summary.modelCalls <= 24 &&
      !!operations && operations.decision > 0 && summary.modelCalls === operations.total &&
      operations.total === operations.decision + operations.evaluation + operations.retry &&
      !!item.usage?.modelMetrics && Object.values(item.usage.modelMetrics).some((value) => value !== undefined && value > 0) &&
      summary.checks.length > 0 && summary.checks.every((check) => check.passed) &&
      actions.every((event, index) => event.data.actor === "agent" && event.data.step === index + 1) &&
      ownSteps.length === ownEvents.length && ownSteps.every((step, index) =>
        step.ordinal === index + 1 && ownEvents[index]?.kind === `attempt.${step.kind}` &&
        ownEvents[index]?.data.evidenceId === step.evidenceId);
  });
}

export function boardJourneyProof(observations: readonly { textBlocks: string[] }[]): boolean {
  const empty = observations.findIndex((item) =>
    item.textBlocks.includes("No projects yet. Start with New project.") &&
    item.textBlocks.includes("0 of 12 synthetic projects in this tab."));
  const final = observations.at(-1);
  return empty >= 0 && empty < observations.length - 1 && !!final &&
    final.textBlocks.includes("Garden planning") && final.textBlocks.includes("Category: Design") &&
    final.textBlocks.includes("1 of 12 synthetic projects in this tab.");
}
