import Browserbase from "@browserbasehq/sdk";
import type { Session } from "@browserbasehq/sdk/resources/sessions/sessions";
import { z } from "zod";
import type { AppConfig } from "../../lib/config";

export type CloudRecoveryRequest = { correlationToken: string; sessionId?: string };
export type RecoveredSession = { sessionId: string; status: string; actualBrowserSeconds?: number };
export type CloudRecoveryResult = { confirmed: boolean; sessions: RecoveredSession[] };
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
  return {
    async recover({ correlationToken, sessionId }) {
      if (!z.uuid().safeParse(correlationToken).success
        || (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId.length || sessionId.length > 200))) {
        throw new Error("invalid_recovery_reference");
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
      if (!listed.length && !known) return { confirmed: false, sessions: [] };
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
        try {
          if (session.status === "RUNNING" || session.status === "PENDING") {
            await bounded(() => bb.sessions.update(initial.id, { status: "REQUEST_RELEASE", projectId: initial.projectId }));
            const released = await bounded(() => bb.sessions.retrieve(initial.id));
            if (!matches(released) || released.id !== initial.id || released.projectId !== initial.projectId) {
              confirmed = false;
              return summary(initial);
            }
            session = released;
          }
          if (!terminal.has(session.status)) confirmed = false;
        } catch { confirmed = false; }
        return summary(session);
      }));
      const verified = sessions.filter((session): session is RecoveredSession => session !== undefined);
      return { confirmed: confirmed && verified.length > 0, sessions: verified };
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
