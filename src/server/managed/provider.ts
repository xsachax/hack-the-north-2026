import Browserbase from "@browserbasehq/sdk";
import type {
  RunCreateParams, RunListParams, RunRetrieveResponse,
} from "@browserbasehq/sdk/resources/agents/runs";
import type { SessionRetrieveResponse } from "@browserbasehq/sdk/resources/sessions/sessions";

export type ManagedProviderRun = RunRetrieveResponse;
export type ManagedProviderSession = Pick<SessionRetrieveResponse,
  "id" | "projectId" | "status" | "startedAt" | "endedAt">;
export type ManagedProvider = {
  createRun(body: Pick<RunCreateParams, "agentId" | "task" | "resultSchema">): Promise<ManagedProviderRun>;
  retrieveRun(id: string): Promise<ManagedProviderRun>;
  listRuns(query: Required<Pick<RunListParams, "agentId" | "startAt" | "endAt" | "limit">> & {
    cursor?: string;
  }): Promise<{ data: ManagedProviderRun[]; nextCursor: string | null }>;
  listMessages(id: string, query: { limit: number; cursor?: string }): Promise<{
    data: unknown[]; nextCursor: string | null;
  }>;
  stopRun(id: string): Promise<ManagedProviderRun | void>;
  retrieveSession(id: string): Promise<ManagedProviderSession>;
  debugSession(id: string): Promise<{ debuggerFullscreenUrl: string }>;
  releaseSession(id: string, projectId: string): Promise<ManagedProviderSession | void>;
};

export function managedOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function checkedId(id: string): string {
  if (!managedOpaqueId(id)) throw new Error("managed_provider_identity_rejected");
  return id;
}

export function createManagedProvider(apiKey: string): ManagedProvider {
  const bb = new Browserbase({ apiKey, maxRetries: 0, timeout: 10_000 });
  return {
    createRun: (body) => bb.agents.runs.create(body),
    retrieveRun: (id) => bb.agents.runs.retrieve(checkedId(id)),
    listRuns: (query) => bb.agents.runs.list(query),
    listMessages: async (id, { limit, cursor }) => {
      // SDK 2.20.0 and the current public API name the message cursor "since".
      const page = await bb.agents.runs.listMessages(checkedId(id), {
        limit, ...(cursor === undefined ? {} : { since: cursor }),
      });
      return { data: page.data, nextCursor: page.nextSince };
    },
    stopRun: async (id) => {
      // The documented stop endpoint is not yet exposed on SDK 2.20.0's Runs.
      return await bb.post<never, ManagedProviderRun>(`/v1/agents/runs/${checkedId(id)}/stop`);
    },
    retrieveSession: (id) => bb.sessions.retrieve(checkedId(id)),
    debugSession: (id) => bb.sessions.debug(checkedId(id)),
    releaseSession: async (id, projectId) => {
      return await bb.sessions.update(checkedId(id), { projectId, status: "REQUEST_RELEASE" });
    },
  };
}
