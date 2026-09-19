import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../../lib/config";
import { createCloudRecovery, inspectProject } from "./cloud-recovery";

const mocks = vi.hoisted(() => ({
  sdk: vi.fn(),
  sessions: { list: vi.fn(), retrieve: vi.fn(), update: vi.fn() },
  projects: { list: vi.fn(), retrieve: vi.fn(), usage: vi.fn() },
}));
vi.mock("@browserbasehq/sdk", () => ({
  default: class {
    sessions = mocks.sessions;
    projects = mocks.projects;
    constructor(options: unknown) { mocks.sdk(options); }
  },
}));
const projectId = "00000000-0000-4000-8000-000000000001";
const correlationToken = "00000000-0000-4000-8000-000000000002";
const config = configSchema.parse({ BROWSERBASE_API_KEY: "fake-key", BROWSERBASE_PROJECT_ID: projectId });
const session = {
  id: "fake-session", projectId, status: "COMPLETED",
  userMetadata: { correlationToken }, startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:08Z",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  mocks.sessions.list.mockResolvedValue([session]);
  mocks.sessions.retrieve.mockResolvedValue(session);
  mocks.projects.list.mockResolvedValue([{ id: projectId, concurrency: 3 }]);
  mocks.projects.retrieve.mockResolvedValue({ id: projectId, concurrency: 3 });
  mocks.projects.usage.mockResolvedValue({ browserMinutes: 23, proxyBytes: 0 });
});
afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });

describe("bounded correlated cloud recovery", () => {
  it("queries exact metadata across all statuses with retries disabled", async () => {
    expect(await createCloudRecovery(config).recover({ correlationToken })).toEqual({
      confirmed: true, sessions: [{ sessionId: session.id, status: "COMPLETED", actualBrowserSeconds: 8 }],
    });
    expect(mocks.sdk).toHaveBeenCalledWith({ apiKey: "fake-key", maxRetries: 0, timeout: 10000 });
    expect(mocks.sessions.list).toHaveBeenCalledWith({ q: `user_metadata['correlationToken']:'${correlationToken}'` });
    expect(mocks.sessions.update).not.toHaveBeenCalled();
  });

  it.each([[], undefined, null].map((result) => ({ result })))("never treats missing metadata results as proof of no launch: %j", async ({ result }) => {
    mocks.sessions.list.mockResolvedValue(result);
    expect(await createCloudRecovery(config).recover({ correlationToken })).toEqual({ confirmed: false, sessions: [] });
  });

  it("retrieves a known session and still lists correlation matches without double counting", async () => {
    expect((await createCloudRecovery(config).recover({ correlationToken, sessionId: session.id })).confirmed).toBe(true);
    expect(mocks.sessions.retrieve).toHaveBeenCalledWith(session.id);
    expect(mocks.sessions.list).toHaveBeenCalledOnce();
  });

  it("leaves a missing known session unconfirmed", async () => {
    mocks.sessions.retrieve.mockRejectedValue(new Error("not found"));
    mocks.sessions.list.mockResolvedValue([]);
    expect(await createCloudRecovery(config).recover({ correlationToken, sessionId: session.id }))
      .toEqual({ confirmed: false, sessions: [] });
    expect(mocks.sessions.list).toHaveBeenCalledOnce();
    expect(mocks.sessions.update).not.toHaveBeenCalled();
  });

  it.each([
    { userMetadata: undefined },
    { userMetadata: { correlationToken: `${correlationToken}-suffix` } },
    { userMetadata: { correlationToken: 3 } },
    { projectId: "foreign-project" },
  ])("never releases foreign/mismatched sessions from a query or direct lookup: %j", async (override) => {
    const foreign = { ...session, status: "RUNNING", ...override };
    mocks.sessions.list.mockResolvedValue([foreign]);
    mocks.sessions.retrieve.mockResolvedValue(foreign);
    const recovery = createCloudRecovery(config);
    for (const sessionId of [undefined, session.id]) {
      expect(await recovery.recover({ correlationToken, sessionId })).toEqual({ confirmed: false, sessions: [] });
    }
    expect(mocks.sessions.update).not.toHaveBeenCalled();
  });

  it("rejects a mismatched retrieved ID", async () => {
    mocks.sessions.retrieve.mockResolvedValue({ ...session, id: "foreign-session", status: "RUNNING" });
    mocks.sessions.list.mockResolvedValue([]);
    expect(await createCloudRecovery(config).recover({ correlationToken, sessionId: session.id }))
      .toEqual({ confirmed: false, sessions: [] });
    expect(mocks.sessions.update).not.toHaveBeenCalled();
  });

  it("releases and accounts correlated duplicates even when a known ID was supplied", async () => {
    const first = { ...session, status: "RUNNING", endedAt: undefined };
    const second = { ...session, id: "second-session", status: "PENDING", endedAt: undefined };
    mocks.sessions.list.mockResolvedValue([first, second]);
    mocks.sessions.retrieve.mockResolvedValueOnce(first).mockResolvedValueOnce(session)
      .mockResolvedValueOnce({ ...session, id: second.id, endedAt: "2026-01-01T00:00:12Z" });
    expect(await createCloudRecovery(config).recover({ correlationToken, sessionId: session.id })).toEqual({
      confirmed: true, sessions: [
        { sessionId: session.id, status: "COMPLETED", actualBrowserSeconds: 8 },
        { sessionId: second.id, status: "COMPLETED", actualBrowserSeconds: 12 },
      ],
    });
    expect(mocks.sessions.update).toHaveBeenCalledTimes(2);
  });

  it.each(["empty", "failure"])("releases a known session even when the metadata query yields %s", async (mode) => {
    mocks.sessions.retrieve.mockResolvedValueOnce({ ...session, status: "RUNNING" }).mockResolvedValueOnce(session);
    if (mode === "empty") mocks.sessions.list.mockResolvedValue([]);
    else mocks.sessions.list.mockRejectedValue(new Error("lookup unavailable"));
    expect(await createCloudRecovery(config).recover({ correlationToken, sessionId: session.id })).toEqual({
      confirmed: false, sessions: [{ sessionId: session.id, status: "COMPLETED", actualBrowserSeconds: 8 }],
    });
    expect(mocks.sessions.update).toHaveBeenCalledOnce();
  });

  it.each(["RUNNING", "PENDING"])("releases %s and verifies terminal state", async (status) => {
    mocks.sessions.list.mockResolvedValue([{ ...session, status, endedAt: undefined }]);
    expect(await createCloudRecovery(config).recover({ correlationToken })).toEqual({
      confirmed: true, sessions: [{ sessionId: session.id, status: "COMPLETED", actualBrowserSeconds: 8 }],
    });
    expect(mocks.sessions.update).toHaveBeenCalledExactlyOnceWith(session.id, { status: "REQUEST_RELEASE", projectId });
    expect(mocks.sessions.retrieve).toHaveBeenCalledExactlyOnceWith(session.id);
  });

  it.each(["COMPLETED", "ERROR", "TIMED_OUT"])("accepts only terminal %s without needing a duration", async (status) => {
    mocks.sessions.list.mockResolvedValue([{ ...session, status, endedAt: undefined }]);
    expect(await createCloudRecovery(config).recover({ correlationToken })).toEqual({
      confirmed: true, sessions: [{ sessionId: session.id, status }],
    });
    expect(mocks.sessions.update).not.toHaveBeenCalled();
  });

  it.each(["RUNNING", "PENDING", "UNKNOWN"])("does not confirm a nonterminal release response %s", async (status) => {
    mocks.sessions.list.mockResolvedValue([{ ...session, status: "RUNNING" }]);
    mocks.sessions.retrieve.mockResolvedValue({ ...session, status });
    expect(await createCloudRecovery(config).recover({ correlationToken })).toEqual({
      confirmed: false, sessions: [{ sessionId: session.id, status }],
    });
  });

  it("rechecks metadata after release instead of accounting a foreign session", async () => {
    mocks.sessions.list.mockResolvedValue([{ ...session, status: "RUNNING" }]);
    mocks.sessions.retrieve.mockResolvedValue({ ...session, userMetadata: {} });
    expect(await createCloudRecovery(config).recover({ correlationToken })).toEqual({
      confirmed: false, sessions: [{ sessionId: session.id, status: "RUNNING" }],
    });
  });

  it.each(["invalid-date", "2025-12-31T23:59:59Z"])("omits invalid or negative browser duration: %s", async (endedAt) => {
    mocks.sessions.list.mockResolvedValue([{ ...session, endedAt }]);
    expect(await createCloudRecovery(config).recover({ correlationToken })).toEqual({
      confirmed: true, sessions: [{ sessionId: session.id, status: "COMPLETED" }],
    });
  });

  it("returns every correlated session with its own actual usage instead of claiming exactly once", async () => {
    mocks.sessions.list.mockResolvedValue([session, { ...session, id: "second-session", endedAt: "2026-01-01T00:00:20Z" }]);
    expect(await createCloudRecovery(config).recover({ correlationToken })).toEqual({
      confirmed: true, sessions: [
        { sessionId: session.id, status: "COMPLETED", actualBrowserSeconds: 8 },
        { sessionId: "second-session", status: "COMPLETED", actualBrowserSeconds: 20 },
      ],
    });
  });

  it("continues independent releases and retains partial results after one failure", async () => {
    mocks.sessions.list.mockResolvedValue([
      { ...session, status: "RUNNING" }, { ...session, id: "second-session", status: "PENDING" },
    ]);
    mocks.sessions.update.mockRejectedValueOnce(new Error("private failure")).mockResolvedValueOnce({});
    mocks.sessions.retrieve.mockResolvedValue({ ...session, id: "second-session" });
    expect(await createCloudRecovery(config).recover({ correlationToken })).toEqual({
      confirmed: false, sessions: [
        { sessionId: session.id, status: "RUNNING" },
        { sessionId: "second-session", status: "COMPLETED", actualBrowserSeconds: 8 },
      ],
    });
    expect(mocks.sessions.update).toHaveBeenCalledTimes(2);
  });

  it("caps work and returned results and refuses confirmation after overflow", async () => {
    mocks.sessions.list.mockResolvedValue(Array.from({ length: 11 }, (_, i) => ({ ...session, id: `session-${i}` })));
    const result = await createCloudRecovery(config).recover({ correlationToken });
    expect(result.confirmed).toBe(false);
    expect(result.sessions).toHaveLength(10);
  });

  it("does not double count duplicate records of one session", async () => {
    mocks.sessions.list.mockResolvedValue([session, session]);
    const result = await createCloudRecovery(config).recover({ correlationToken });
    expect(result.confirmed).toBe(false);
    expect(result.sessions).toHaveLength(1);
  });

  it.each(["list", "retrieve", "update"] as const)("contains SDK %s errors without exposing provider details or retrying", async (operation) => {
    mocks.sessions.list.mockResolvedValue([{ ...session, status: "RUNNING" }]);
    mocks.sessions[operation].mockRejectedValue(new Error("private URL and secret"));
    const result = await createCloudRecovery(config).recover({ correlationToken });
    expect(result.confirmed).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(mocks.sessions[operation]).toHaveBeenCalledOnce();
  });

  it.each(["list", "retrieve", "update"] as const)("bounds a hung SDK %s request even in a fake client", async (operation) => {
    mocks.sessions.list.mockResolvedValue([{ ...session, status: "RUNNING" }]);
    mocks.sessions[operation].mockImplementation(() => new Promise(() => {}));
    const result = createCloudRecovery(config).recover({ correlationToken });
    await vi.advanceTimersByTimeAsync(10001);
    expect((await result).confirmed).toBe(false);
    expect(mocks.sessions[operation]).toHaveBeenCalledOnce();
  });

  it("validates correlation query input and configured project before remote work", async () => {
    await expect(createCloudRecovery(config).recover({ correlationToken: "' OR true" })).rejects.toThrow("invalid_recovery_reference");
    expect(() => createCloudRecovery({ ...config, BROWSERBASE_PROJECT_ID: "invalid" })).toThrow("invalid_recovery_project");
    expect(mocks.sessions.list).not.toHaveBeenCalled();
  });
});

describe("operator project inspection", () => {
  it("uses an explicit project and reads real concurrency and usage", async () => {
    expect(await inspectProject(config)).toEqual({ projectId, concurrency: 3, browserMinutes: 23 });
    expect(mocks.projects.retrieve).toHaveBeenCalledExactlyOnceWith(projectId);
    expect(mocks.projects.usage).toHaveBeenCalledExactlyOnceWith(projectId);
    expect(mocks.projects.list).not.toHaveBeenCalled();
  });

  it("accepts exactly one available project when none was configured", async () => {
    expect(await inspectProject({ ...config, BROWSERBASE_PROJECT_ID: undefined }))
      .toEqual({ projectId, concurrency: 3, browserMinutes: 23 });
    expect(mocks.projects.retrieve).not.toHaveBeenCalled();
  });

  it.each([[], [{ id: projectId }, { id: correlationToken }]].map((projects) => ({ projects })))("refuses to guess among projects: %j", async ({ projects }) => {
    mocks.projects.list.mockResolvedValue(projects);
    await expect(inspectProject({ ...config, BROWSERBASE_PROJECT_ID: undefined })).rejects.toThrow("cloud_project_inspection_failed");
    expect(mocks.projects.usage).not.toHaveBeenCalled();
  });

  it("contains private SDK failure details", async () => {
    mocks.projects.retrieve.mockRejectedValue(new Error("private-project-secret"));
    await expect(inspectProject(config)).rejects.toThrow(/^cloud_project_inspection_failed$/);
  });

  it.each([
    { id: correlationToken, concurrency: 3 },
    { id: projectId, concurrency: 0 },
    { id: projectId, concurrency: NaN },
  ])("rejects mismatched or malformed project limits: %j", async (project) => {
    mocks.projects.retrieve.mockResolvedValue(project);
    await expect(inspectProject(config)).rejects.toThrow("cloud_project_inspection_failed");
    expect(mocks.projects.usage).not.toHaveBeenCalled();
  });

  it.each([NaN, -1, Infinity])("rejects invalid usage: %s", async (browserMinutes) => {
    mocks.projects.usage.mockResolvedValue({ browserMinutes });
    await expect(inspectProject(config)).rejects.toThrow("cloud_project_inspection_failed");
  });

  it("bounds stalled inspection", async () => {
    mocks.projects.usage.mockImplementation(() => new Promise(() => {}));
    const result = expect(inspectProject(config)).rejects.toThrow("cloud_project_inspection_failed");
    await vi.advanceTimersByTimeAsync(10001);
    await result;
  });
});
