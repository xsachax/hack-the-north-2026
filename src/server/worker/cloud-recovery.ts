import Browserbase from "@browserbasehq/sdk";
import type { Session } from "@browserbasehq/sdk/resources/sessions/sessions";
import { z } from "zod";
import type { AppConfig } from "../../lib/config";
import { isNativeSessionRetired, type NativeResource, type NativeSessionClosure } from "../execution/native-resources";
import { PUBLIC_EXECUTION_IMPLEMENTATION_READY } from "../public-execution-readiness";

export type CloudRecoveryRequest = {
  correlationToken: string; sessionId?: string;
  native?: {
    resource?: NativeResource;
    predispatchProven?: boolean;
    assertActive: () => void;
    onResource: (resource: Readonly<NativeResource>) => undefined;
  };
};
export type RecoveredSession = {
  sessionId: string; status: string; actualBrowserSeconds?: number;
  nativeClosure?: NativeSessionClosure;
};
export function isRecoveredNativeSessionRetired(session: RecoveredSession): boolean {
  if (session.status === "COMPLETED") return isNativeSessionRetired(session);
  const closure = session.nativeClosure;
  if (!closure || closure.sessionId !== session.sessionId || closure.status !== session.status ||
    !isNativeSessionRetired(closure)) return false;
  return session.actualBrowserSeconds === undefined || session.actualBrowserSeconds ===
    (Date.parse(closure.endedAt!) - Date.parse(closure.startedAt!)) / 1000;
}
export type CloudRecoveryResult = {
  confirmed: boolean; sessions: RecoveredSession[];
  nativeResourceConfirmed?: boolean; allocationAttempted?: false;
};
export interface CloudRecovery {
  recover(request: CloudRecoveryRequest): Promise<CloudRecoveryResult>;
}
export type ProjectInspection = { projectId: string; concurrency: number; browserMinutes: number };

const MAX_SESSIONS = 10;
const TIMEOUT_MS = 10000;
const terminal = new Set(["COMPLETED", "ERROR", "TIMED_OUT"]);

function client(config: AppConfig): Browserbase {
  if (config.BROWSERBASE_PROJECT_ID !== undefined && !z.uuid().safeParse(config.BROWSERBASE_PROJECT_ID).success) {
    throw new Error("invalid_recovery_project");
  }
  return new Browserbase({ apiKey: config.BROWSERBASE_API_KEY, maxRetries: 0, timeout: TIMEOUT_MS });
}

async function bounded<T>(operation: () => PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("cloud_recovery_timeout")), TIMEOUT_MS); }),
    ]);
  } finally { clearTimeout(timer); }
}

function summary(session: Session): RecoveredSession {
  const seconds = session.endedAt ? (Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 1000 : NaN;
  return {
    sessionId: session.id, status: session.status,
    ...(terminal.has(session.status) && Number.isFinite(seconds) && seconds >= 0 ? { actualBrowserSeconds: seconds } : {}),
  };
}

export function createCloudRecovery(config: AppConfig): CloudRecovery {
  const bb = client(config);
  const reconcileNative = async (request: CloudRecoveryRequest, outcome: CloudRecoveryResult): Promise<CloudRecoveryResult> => {
    if (!request.native) return outcome;
    const { assertActive, onResource } = request.native;
    let resource = request.native.resource;
    if (!resource) return { ...outcome, nativeResourceConfirmed: false };
    if (!resource.sessionId && resource.sessionAllocationAttempted && outcome.confirmed && outcome.sessions.length === 1) {
      resource = { ...resource, sessionId: outcome.sessions[0].sessionId };
      assertActive();
      onResource(resource);
    }
    const predispatch = !request.sessionId && !resource.sessionAllocationAttempted && !resource.sessionId &&
      (["uploaded", "not_dispatched", "delete_intent", "delete_unconfirmed", "deleted"].includes(resource.state) ||
        resource.state === "quarantined" && request.native.predispatchProven === true);
    if (resource.state === "not_dispatched" && predispatch) return {
      confirmed: true, sessions: [], nativeResourceConfirmed: true, allocationAttempted: false,
    };
    const matchedRetired = outcome.confirmed && !!resource.sessionId &&
      outcome.sessions.some((session) => session.sessionId === resource.sessionId && isRecoveredNativeSessionRetired(session)) &&
      outcome.sessions.every(isRecoveredNativeSessionRetired);
    if (!resource.extensionId || (!predispatch && !matchedRetired)) {
      assertActive();
      onResource({ ...resource, state: "quarantined" });
      return { ...outcome, nativeResourceConfirmed: false };
    }
    const extensionId = resource.extensionId;
    try {
      assertActive();
      if (resource.state !== "deleted") {
        onResource({ ...resource, state: "delete_intent" });
        assertActive();
        try { await bounded(() => bb.extensions.delete(extensionId, { headers: { "Content-Type": null } })); }
        catch (error) {
          if (!(error instanceof Browserbase.APIError && error.status === 404)) throw error;
        }
      }
      assertActive();
      try {
        await bounded(() => bb.extensions.retrieve(extensionId));
        throw new Error("native_extension_delete_unconfirmed");
      } catch (error) {
        if (!(error instanceof Browserbase.APIError && error.status === 404)) throw error;
      }
      assertActive();
      onResource({ ...resource, state: "deleted" });
      return {
        ...outcome, confirmed: predispatch || outcome.confirmed, nativeResourceConfirmed: true,
        ...(predispatch ? { allocationAttempted: false as const } : {}),
      };
    } catch {
      assertActive();
      if (resource.state !== "deleted") onResource({ ...resource, state: "delete_unconfirmed" });
      return { ...outcome, nativeResourceConfirmed: false };
    }
  };
  return {
    async recover(request) {
      if (request.native && !PUBLIC_EXECUTION_IMPLEMENTATION_READY) {
        throw new Error("public_recovery_checkpoint_disabled");
      }
      const { correlationToken } = request;
      const sessionId = request.sessionId ?? request.native?.resource?.sessionId;
      if (!z.uuid().safeParse(correlationToken).success
        || (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId.length || sessionId.length > 200))) {
        throw new Error("invalid_recovery_reference");
      }
      const resource = request.native?.resource;
      if (resource?.sessionId && request.sessionId && resource.sessionId !== request.sessionId) {
        throw new Error("native_recovery_session_mismatch");
      }
      if (resource && !request.sessionId && !resource.sessionAllocationAttempted && !resource.sessionId &&
        (["uploaded", "not_dispatched", "delete_intent", "delete_unconfirmed", "deleted"].includes(resource.state) ||
          resource.state === "quarantined" && request.native?.predispatchProven === true)) {
        return reconcileNative(request, { confirmed: false, sessions: [] });
      }
      const matches = (session: Session): boolean => Boolean(
        session && typeof session.id === "string" && session.id.length
        && typeof session.status === "string" && typeof session.projectId === "string" && session.projectId.length
        && session.userMetadata?.correlationToken === correlationToken
        && (!config.BROWSERBASE_PROJECT_ID || session.projectId === config.BROWSERBASE_PROJECT_ID),
      );
      let confirmed = true;
      let known: Session | undefined;
      if (sessionId) {
        try {
          const retrieved = await bounded(() => bb.sessions.retrieve(sessionId));
          if (matches(retrieved) && retrieved.id === sessionId) known = retrieved;
          else confirmed = false;
        } catch { confirmed = false; }
      }
      let listed: Session[] = [];
      try {
        listed = await bounded(() => bb.sessions.list({ q: `user_metadata['correlationToken']:'${correlationToken}'` }));
        if (!Array.isArray(listed)) { listed = []; confirmed = false; }
      } catch { confirmed = false; }
      // An empty metadata query can be propagation lag, never proof of no launch.
      if (!listed.length) confirmed = false;
      if (!listed.length && !known) return reconcileNative(request, { confirmed: false, sessions: [] });
      if (listed.length > MAX_SESSIONS) confirmed = false;
      const found = known ? [known, ...listed.slice(0, MAX_SESSIONS).filter((session) => {
        if (session?.id !== known.id) return true;
        if (!matches(session)) confirmed = false;
        return false;
      })] : listed;
      if (found.length > MAX_SESSIONS) confirmed = false;
      const seen = new Set<string>();
      const sessions = await Promise.all(found.slice(0, MAX_SESSIONS).map(async (initial): Promise<RecoveredSession | undefined> => {
        if (!matches(initial) || seen.has(initial.id)) { confirmed = false; return; }
        seen.add(initial.id);
        let session = initial;
        let nativeClosure: NativeSessionClosure | undefined;
        try {
          if (session.status === "RUNNING" || session.status === "PENDING") {
            request.native?.assertActive();
            await bounded(() => bb.sessions.update(initial.id, { status: "REQUEST_RELEASE", projectId: initial.projectId }));
            const released = await bounded(() => bb.sessions.retrieve(initial.id));
            if (!matches(released) || released.id !== initial.id || released.projectId !== initial.projectId) {
              confirmed = false;
              return summary(initial);
            }
            session = released;
          }
          if (request.native && ["ERROR", "TIMED_OUT"].includes(session.status)) {
            request.native.assertActive();
            const first = await bounded(() => bb.sessions.retrieve(initial.id));
            request.native.assertActive();
            const second = await bounded(() => bb.sessions.retrieve(initial.id));
            if (!matches(first) || !matches(second) || first.id !== initial.id || second.id !== initial.id ||
              first.projectId !== initial.projectId || second.projectId !== initial.projectId ||
              first.status !== session.status) {
              confirmed = false;
              return summary(session);
            }
            const closure: NativeSessionClosure = {
              sessionId: first.id, status: first.status, startedAt: first.startedAt, endedAt: first.endedAt ?? undefined,
              independent: { sessionId: second.id, status: second.status,
                startedAt: second.startedAt, endedAt: second.endedAt ?? undefined },
            };
            if (isNativeSessionRetired(closure)) nativeClosure = closure;
            else confirmed = false;
            session = first;
          }
          if (!terminal.has(session.status)) confirmed = false;
        } catch { confirmed = false; }
        return { ...summary(session), ...(nativeClosure ? { nativeClosure } : {}) };
      }));
      const verified = sessions.filter((session): session is RecoveredSession => session !== undefined).map((session) =>
        request.native && ["ERROR", "TIMED_OUT"].includes(session.status) && !isRecoveredNativeSessionRetired(session)
          ? { sessionId: session.sessionId, status: session.status } : session);
      return reconcileNative(request, { confirmed: confirmed && verified.length > 0, sessions: verified });
    },
  };
}

export async function inspectProject(config: AppConfig): Promise<ProjectInspection> {
  const bb = client(config);
  try {
    const projects = config.BROWSERBASE_PROJECT_ID
      ? [await bounded(() => bb.projects.retrieve(config.BROWSERBASE_PROJECT_ID!))]
      : await bounded(() => bb.projects.list());
    if (!Array.isArray(projects) || projects.length !== 1) throw new Error("ambiguous_project");
    const project = projects[0];
    if (!z.uuid().safeParse(project.id).success
      || (config.BROWSERBASE_PROJECT_ID && project.id !== config.BROWSERBASE_PROJECT_ID)
      || !Number.isInteger(project.concurrency) || project.concurrency < 1) throw new Error("invalid_project");
    const usage = await bounded(() => bb.projects.usage(project.id));
    if (!Number.isFinite(usage.browserMinutes) || usage.browserMinutes < 0) throw new Error("invalid_usage");
    return { projectId: project.id, concurrency: project.concurrency, browserMinutes: usage.browserMinutes };
  } catch { throw new Error("cloud_project_inspection_failed"); }
}
