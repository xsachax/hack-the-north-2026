import { afterEach, describe, expect, it, vi } from "vitest";
import { executeManagedAgent } from "./runner";
import type { ManagedProvider, ManagedProviderRun, ManagedProviderSession } from "./provider";
import type { ManagedClaim, ManagedJournal } from "./types";

const RUN = "cbe01b11-30e7-4f7f-a024-e22283829435";
const SESSION = "85be1854-9445-4758-9f53-dfca28d167df";
const OTHER_SESSION = "81c762ad-fb87-45f1-a26a-d7115ece3c8c";
const AGENT = "reviewed-agent-fixture";
const PROJECT = "provider-project-fixture";
const SECRET = "bb_test_must_never_appear";
const modelResult = {
  summary: "The model reports a visible pricing link.",
  finalUrl: "https://approved.example/pricing?private=value",
  criteria: [{ criterion: "Find pricing", status: "met" as const, observation: "A pricing link was visible." }],
  limitations: ["This is a model report, not independent verification."],
};

function fixture() {
  const now = Date.now();
  const claim: ManagedClaim = {
    id: "7a3b55ba-78ef-4ac8-9f07-0f99971e0061",
    runId: "45182a76-a97a-415f-a4f6-e2e93fa14f92",
    ownerId: "owner-fixture", workerId: "worker-fixture", generation: 1,
    correlationToken: "unique-correlation-0001",
    persona: {
      id: "careful-reader", name: "Careful reader", character: "Reads unfamiliar sites carefully",
      device: "desktop", techComfort: "low", patienceSteps: 10, readingStyle: "careful",
      quirks: ["Checks navigation"], worries: ["Unexpected charges"],
    },
    goal: "Read the pricing page", criteria: ["Find pricing"],
    scope: { targetUrl: "https://approved.example/", pathPrefixes: ["/"], allowedSubdomains: [] },
    reservedSeconds: 60, startedAt: now, recovery: false, dispatchStarted: false,
  };
  const controller = new AbortController();
  const events: string[] = [];
  let dispatchReference: { agentId: string; task: string } | undefined;
  const journal: ManagedJournal = {
    assertActive: vi.fn(),
    dispatch: vi.fn((reference) => {
      events.push("dispatch");
      dispatchReference = { ...reference };
    }),
    identity: vi.fn((value) => events.push(value.providerSessionId ? "session-identity" : "run-identity")),
    progress: vi.fn(),
    sessionView: vi.fn(),
  };
  let task = "";
  const run = (overrides: Partial<ManagedProviderRun> = {}): ManagedProviderRun => ({
    runId: RUN, agentId: AGENT, task, status: "COMPLETED", sessionId: SESSION,
    result: modelResult, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    ...overrides,
  });
  const session = (overrides: Partial<ManagedProviderSession> = {}): ManagedProviderSession => ({
    id: SESSION, projectId: PROJECT, status: "COMPLETED",
    startedAt: new Date(now).toISOString(), endedAt: new Date(now + 3500).toISOString(),
    ...overrides,
  });
  const provider = {
    createRun: vi.fn<ManagedProvider["createRun"]>(async (input) => {
      events.push("create"); task = input.task;
      return run({ status: "PENDING", sessionId: undefined, result: undefined });
    }),
    retrieveRun: vi.fn<ManagedProvider["retrieveRun"]>(async () => {
      events.push("retrieve-run"); return run();
    }),
    listRuns: vi.fn<ManagedProvider["listRuns"]>(async () => ({ data: [run()], nextCursor: null })),
    listMessages: vi.fn<ManagedProvider["listMessages"]>(async () => ({ data: [], nextCursor: null })),
    stopRun: vi.fn<ManagedProvider["stopRun"]>(async () => { events.push("stop"); }),
    retrieveSession: vi.fn<ManagedProvider["retrieveSession"]>(async () => {
      events.push("retrieve-session"); return session();
    }),
    debugSession: vi.fn<ManagedProvider["debugSession"]>(async () => ({
      debuggerFullscreenUrl: `https://www.browserbase.com/devtools?sessionId=${SESSION}`,
    })),
    releaseSession: vi.fn<ManagedProvider["releaseSession"]>(async () => { events.push("release"); }),
  };
  const options = {
    apiKey: SECRET, projectId: PROJECT, agentId: AGENT, signal: controller.signal,
    allowedOrigins: ["https://approved.example"], provider, pollMs: 0,
  };
  const recoveredClaim = (overrides: Partial<ManagedClaim> = {}): ManagedClaim => ({
    ...claim, recovery: true, dispatchStarted: true,
    providerAgentId: dispatchReference?.agentId, providerTask: dispatchReference?.task,
    ...overrides,
  });
  return { claim, controller, events, journal, provider, options, run, session, recoveredClaim };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("managed Agents runner", () => {
  it("journals exact asynchronous identities and reports model claims separately from lifecycle evidence", async () => {
    const f = fixture();
    f.provider.retrieveRun
      .mockImplementationOnce(async () => f.run({ status: "RUNNING" }))
      .mockImplementationOnce(async () => f.run());
    f.provider.retrieveSession.mockImplementationOnce(async () => f.session({ status: "RUNNING", endedAt: undefined }));
    f.provider.listMessages.mockResolvedValue({
      data: [{
        id: "message-1", role: "assistant", parts: [
          { type: "text", text: "Checking navigation", state: "done" },
          { type: "tool-browser_navigate", state: "output-available", input: { url: "https://secret.invalid/" },
            output: { screenshot: "private screenshot", headers: { authorization: SECRET } } },
          { type: "reasoning", text: "private chain of thought" },
        ],
      }], nextCursor: "message-1",
    });
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({
      status: "completed", cleanup: "closed", error: null, providerStatus: "COMPLETED",
      allocationAttempted: true, actualBrowserSeconds: 3.5,
      result: { ...modelResult, finalUrl: "https://approved.example/pricing" },
    });
    expect(outcome).not.toHaveProperty("modelCalls");
    expect(outcome).not.toHaveProperty("evidence");
    expect(f.events.slice(0, 3)).toEqual(["dispatch", "create", "run-identity"]);
    expect(vi.mocked(f.journal.identity).mock.invocationCallOrder[0])
      .toBeLessThan(f.provider.retrieveRun.mock.invocationCallOrder[0]);
    expect(f.events.indexOf("session-identity")).toBeLessThan(f.events.indexOf("retrieve-session"));
    expect(f.provider.createRun).toHaveBeenCalledOnce();
    expect(f.provider.createRun.mock.calls[0][0]).toMatchObject({
      agentId: AGENT, resultSchema: { type: "object", additionalProperties: false },
    });
    const task = f.provider.createRun.mock.calls[0][0].task;
    expect(f.journal.dispatch).toHaveBeenCalledExactlyOnceWith({ agentId: AGENT, task });
    expect(vi.mocked(f.journal.dispatch).mock.invocationCallOrder[0])
      .toBeLessThan(f.provider.createRun.mock.invocationCallOrder[0]);
    for (const value of [f.claim.correlationToken, f.claim.scope.targetUrl, f.claim.persona.name,
      f.claim.goal, f.claim.criteria[0], "pathPrefixes", "real browser navigation", "Search/Fetch-only",
      "not enforced tool restrictions"]) expect(task).toContain(value);
    expect(task).not.toContain(SECRET);
    expect(task).not.toContain(PROJECT);
    expect(f.provider.debugSession).not.toHaveBeenCalled();
    expect(f.journal.sessionView).toHaveBeenCalledExactlyOnceWith({
      liveViewUrl: "", replayUrl: `https://www.browserbase.com/sessions/${SESSION}`,
    });
    const emitted = vi.mocked(f.journal.progress).mock.calls.map(([entry]) => entry);
    expect(emitted.filter((entry) => entry.kind === "text")).toEqual([
      expect.objectContaining({ text: "Checking navigation" }),
    ]);
    expect(emitted.filter((entry) => entry.kind === "tool")).toEqual([
      expect.objectContaining({ text: "browser_navigate" }),
    ]);
    expect(emitted.map((entry) => entry.text)).toEqual(expect.arrayContaining(["PENDING", "RUNNING", "COMPLETED"]));
    expect(JSON.stringify(emitted)).not.toMatch(/private|secret\.invalid|screenshot|authorization/);
  });

  it("supports SDK message envelopes without exposing tool results or reasoning", async () => {
    const f = fixture();
    f.provider.listMessages.mockResolvedValue({
      data: [{ id: "sdk-message", message: { role: "assistant", content: [
        { type: "text", text: `Reading https://sensitive.invalid/token?value=${SECRET} Authorization: Bearer ${SECRET}` },
        { type: "reasoning", text: SECRET },
        { type: "tool-call", toolName: "browser", input: SECRET },
        { type: "tool-result", toolName: "browser", output: SECRET },
        { type: "file", data: SECRET },
      ] } }, { id: "tool-output", message: { role: "tool", content: SECRET } }],
      nextCursor: null,
    });
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome.status).toBe("completed");
    const output = JSON.stringify({ outcome, progress: vi.mocked(f.journal.progress).mock.calls });
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain("sensitive.invalid");
    expect(output).not.toContain("reasoning");
    expect(vi.mocked(f.journal.progress).mock.calls.filter(([entry]) => entry.kind === "tool")).toHaveLength(2);
  });

  it("requires session COMPLETED readback after run terminal, not a successful release response", async () => {
    const f = fixture();
    f.provider.retrieveSession
      .mockResolvedValueOnce(f.session({ status: "RUNNING", endedAt: undefined }))
      .mockResolvedValueOnce(f.session({ status: "RUNNING", endedAt: undefined }))
      .mockResolvedValueOnce(f.session({ status: "RUNNING", endedAt: undefined }))
      .mockResolvedValueOnce(f.session());
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({ status: "completed", cleanup: "closed", actualBrowserSeconds: 3.5 });
    expect(f.provider.releaseSession).toHaveBeenCalledExactlyOnceWith(SESSION, PROJECT);
    expect(f.provider.retrieveSession).toHaveBeenCalledTimes(4);
    expect(f.provider.retrieveSession.mock.invocationCallOrder.at(-1)!)
      .toBeGreaterThan(f.provider.releaseSession.mock.invocationCallOrder[0]);
    expect(vi.mocked(f.journal.sessionView).mock.invocationCallOrder[0])
      .toBeGreaterThan(f.provider.retrieveSession.mock.invocationCallOrder.at(-1)!);
  });

  it("retains unconfirmed cleanup and unknown metrics when the browser will not close", async () => {
    const f = fixture();
    f.provider.retrieveSession.mockResolvedValue(f.session({ status: "RUNNING", endedAt: undefined }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({
      status: "failed", cleanup: "unconfirmed", error: "managed_cleanup_unconfirmed", actualBrowserSeconds: null,
    });
    expect(f.provider.releaseSession).toHaveBeenCalledOnce();
    expect(f.provider.retrieveSession.mock.calls.length).toBeLessThanOrEqual(11);
    expect(f.journal.sessionView).not.toHaveBeenCalled();
  });

  it.each(["ERROR", "TIMED_OUT"] as const)("does not treat session %s as confirmed COMPLETED", async (status) => {
    const f = fixture();
    f.provider.retrieveSession.mockResolvedValue(f.session({ status }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome.cleanup).toBe("unconfirmed");
    expect(outcome.actualBrowserSeconds).toBeNull();
  });

  it("cancels before dispatch without allocating", async () => {
    const f = fixture();
    f.controller.abort();
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({
      status: "cancelled", cleanup: "closed", allocationAttempted: false, error: "managed_cancelled",
    });
    expect(f.journal.dispatch).not.toHaveBeenCalled();
    expect(f.provider.createRun).not.toHaveBeenCalled();
  });

  it("journals a create response despite concurrent cancellation, then stops and verifies remotely", async () => {
    const f = fixture();
    const originalCreate = f.provider.createRun.getMockImplementation()!;
    f.provider.createRun.mockImplementation(async (input) => {
      const created = await originalCreate(input);
      f.controller.abort();
      return { ...created, sessionId: SESSION };
    });
    f.provider.retrieveRun.mockImplementation(async () => f.run({
      status: f.provider.stopRun.mock.calls.length ? "STOPPED" : "RUNNING",
    }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({
      status: "cancelled", cleanup: "closed", providerStatus: "STOPPED", allocationAttempted: true,
    });
    expect(f.events.indexOf("session-identity")).toBeLessThan(f.events.indexOf("stop"));
    expect(f.provider.stopRun).toHaveBeenCalledExactlyOnceWith(RUN);
    expect(f.provider.debugSession).not.toHaveBeenCalled();
    expect(f.provider.listMessages).not.toHaveBeenCalled();
  });

  it("uses the journal cancellation fence even without an aborted signal", async () => {
    const f = fixture();
    vi.mocked(f.journal.assertActive).mockImplementation((allowCancelled) => {
      if (!allowCancelled) throw new Error(`cancelled ${SECRET}`);
    });
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({ status: "cancelled", cleanup: "closed", allocationAttempted: false });
    expect(f.provider.createRun).not.toHaveBeenCalled();
  });

  it("stops after its reservation deadline without claiming a provider-enforced TTL", async () => {
    const f = fixture();
    const originalCreate = f.provider.createRun.getMockImplementation()!;
    f.provider.createRun.mockImplementation(async (input) => {
      const created = await originalCreate(input);
      vi.spyOn(Date, "now").mockReturnValue(f.claim.startedAt + 60_001);
      return created;
    });
    f.provider.retrieveRun.mockImplementation(async () => f.run({
      status: f.provider.stopRun.mock.calls.length ? "STOPPED" : "RUNNING",
    }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({
      status: "failed", cleanup: "closed", error: "managed_deadline_elapsed", providerStatus: "STOPPED",
    });
    expect(f.provider.stopRun).toHaveBeenCalledOnce();
    expect(Object.keys(f.provider.createRun.mock.calls[0][0]).sort()).toEqual(["agentId", "resultSchema", "task"]);
  });

  it("also stops when the discovered session has exhausted reserved browser seconds", async () => {
    const f = fixture();
    f.provider.retrieveRun.mockImplementation(async () => f.run({
      status: f.provider.stopRun.mock.calls.length ? "STOPPED" : "RUNNING",
    }));
    f.provider.retrieveSession.mockResolvedValue(f.session({
      status: "COMPLETED", startedAt: new Date(f.claim.startedAt - 61_000).toISOString(),
    }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome.error).toBe("managed_deadline_elapsed");
    expect(outcome.cleanup).toBe("closed");
    expect(f.provider.stopRun).toHaveBeenCalledOnce();
  });

  it("does not infer closure from stop 409, and polls until terminal plus session closure", async () => {
    const f = fixture();
    const originalCreate = f.provider.createRun.getMockImplementation()!;
    f.provider.createRun.mockImplementation(async (input) => {
      const created = await originalCreate(input); f.controller.abort(); return created;
    });
    let reads = 0;
    f.provider.retrieveRun.mockImplementation(async () => f.run({ status: ++reads >= 3 ? "STOPPED" : "RUNNING" }));
    f.provider.stopRun.mockRejectedValue(Object.assign(new Error(`409 ${SECRET}`), { status: 409 }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({ status: "cancelled", cleanup: "closed", providerStatus: "STOPPED" });
    expect(f.provider.retrieveRun).toHaveBeenCalledTimes(3);
    expect(f.provider.stopRun).toHaveBeenCalledOnce();
    expect(f.provider.retrieveSession).toHaveBeenCalled();
  });

  it("retains unconfirmed cleanup when stop 409 is never followed by terminal", async () => {
    const f = fixture();
    const originalCreate = f.provider.createRun.getMockImplementation()!;
    f.provider.createRun.mockImplementation(async (input) => {
      const created = await originalCreate(input); f.controller.abort(); return created;
    });
    f.provider.retrieveRun.mockImplementation(async () => f.run({ status: "RUNNING" }));
    f.provider.stopRun.mockRejectedValue(Object.assign(new Error("private"), { status: 409 }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({ status: "cancelled", cleanup: "unconfirmed", actualBrowserSeconds: null });
  });

  it("journals a late session in a stop response before more awaits and independently verifies terminal", async () => {
    const f = fixture();
    const originalCreate = f.provider.createRun.getMockImplementation()!;
    f.provider.createRun.mockImplementation(async (input) => {
      const created = await originalCreate(input); f.controller.abort(); return created;
    });
    f.provider.stopRun.mockImplementation(async () => f.run({ status: "STOPPED" }));
    f.provider.retrieveRun.mockImplementation(async () => f.run({ status: "STOPPED" }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({ status: "cancelled", cleanup: "closed", providerStatus: "STOPPED" });
    const sessionIdentityCall = vi.mocked(f.journal.identity).mock.calls.findIndex(([entry]) => !!entry.providerSessionId);
    expect(vi.mocked(f.journal.identity).mock.invocationCallOrder[sessionIdentityCall])
      .toBeLessThan(f.provider.retrieveRun.mock.invocationCallOrder[0]);
    expect(f.provider.retrieveRun).toHaveBeenCalled();
    expect(f.provider.retrieveSession).toHaveBeenCalled();
  });

  it("still requests stop when the read endpoint fails, without exposing provider errors", async () => {
    const f = fixture();
    f.provider.retrieveRun.mockRejectedValue(new Error(`${SECRET} https://private.invalid Authorization: secret`));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({
      status: "failed", cleanup: "unconfirmed", error: "managed_provider_unavailable",
    });
    expect(f.provider.stopRun).toHaveBeenCalledOnce();
    expect(JSON.stringify(outcome)).not.toMatch(/private\.invalid|Authorization|bb_test/);
  });

  it("does not accept release response COMPLETED as independent closure evidence", async () => {
    const f = fixture();
    f.provider.retrieveSession.mockResolvedValue(f.session({ status: "RUNNING", endedAt: undefined }));
    f.provider.releaseSession.mockResolvedValue(f.session());
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({ cleanup: "unconfirmed", actualBrowserSeconds: null });
    expect(f.provider.releaseSession).toHaveBeenCalledOnce();
  });

  it("rejects a release response that silently substitutes a different session", async () => {
    const f = fixture();
    f.provider.retrieveSession.mockResolvedValue(f.session({ status: "RUNNING", endedAt: undefined }));
    f.provider.releaseSession.mockResolvedValue(f.session({ id: OTHER_SESSION }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({ cleanup: "unconfirmed", error: "managed_session_identity_rejected" });
  });

  it("does not retain prior closure after a contradictory session status read", async () => {
    const f = fixture();
    f.provider.retrieveSession.mockResolvedValueOnce(f.session())
      .mockResolvedValue(f.session({ status: "RUNNING", endedAt: undefined }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({
      status: "failed", cleanup: "unconfirmed", error: "managed_session_identity_rejected", actualBrowserSeconds: null,
    });
  });

  it("never retries an unknown create; a later recovery discovers the exact task and stops it", async () => {
    const f = fixture();
    const originalCreate = f.provider.createRun.getMockImplementation()!;
    f.provider.createRun.mockImplementation(async (input) => {
      await originalCreate(input);
      throw new Error(`network ${SECRET} https://provider.invalid/private`);
    });
    const first = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(first).toMatchObject({
      status: "failed", cleanup: "unconfirmed", allocationAttempted: true, error: "managed_allocation_unknown",
    });
    expect(f.provider.listRuns).not.toHaveBeenCalled();
    f.provider.retrieveRun.mockImplementation(async () => f.run({
      status: f.provider.stopRun.mock.calls.length ? "STOPPED" : "RUNNING",
    }));
    f.provider.listRuns.mockImplementation(async () => ({
      data: [f.run({ status: "RUNNING" }), f.run({ runId: "other-run", task: "wrong task" })], nextCursor: null,
    }));
    const second = await executeManagedAgent(f.recoveredClaim({ generation: 2 }), f.journal, f.options);
    expect(second).toMatchObject({ status: "failed", cleanup: "closed", error: "managed_recovery_stopped" });
    expect(f.provider.createRun).toHaveBeenCalledOnce();
    expect(f.journal.dispatch).toHaveBeenCalledOnce();
    expect(f.provider.stopRun).toHaveBeenCalledOnce();
    expect(f.provider.listRuns.mock.calls[0][0]).toMatchObject({
      agentId: AGENT, startAt: expect.any(String), endAt: expect.any(String), limit: 100,
    });
    expect(JSON.stringify({ first, second })).not.toMatch(/network|provider\.invalid|bb_test/);
  });

  it("uses the journaled agent and task after worker configuration or task construction changes", async () => {
    const f = fixture();
    const originalCreate = f.provider.createRun.getMockImplementation()!;
    f.provider.createRun.mockImplementation(async (input) => { await originalCreate(input); throw new Error("unknown"); });
    await executeManagedAgent(f.claim, f.journal, f.options);
    f.provider.retrieveRun.mockImplementation(async () => f.run({
      status: f.provider.stopRun.mock.calls.length ? "STOPPED" : "RUNNING",
    }));
    const recovered = f.recoveredClaim({ goal: "A changed task builder would no longer reproduce the dispatched bytes" });
    const outcome = await executeManagedAgent(recovered, f.journal, {
      ...f.options, agentId: "new-reviewed-agent", allowedOrigins: [],
    });
    expect(outcome).toMatchObject({
      status: "failed", cleanup: "closed", error: "managed_recovery_stopped", providerStatus: "STOPPED",
    });
    expect(f.provider.listRuns).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT }));
    expect(f.provider.stopRun).toHaveBeenCalledExactlyOnceWith(RUN);
    expect(f.provider.createRun).toHaveBeenCalledOnce();
    expect(f.journal.dispatch).toHaveBeenCalledOnce();
  });

  it.each([true, false])("recovers an old immutable task format, with known run ID = %s", async (knownRun) => {
    const f = fixture();
    const savedTask = `Old deployed instructions; correlation=${f.claim.correlationToken}; retain these exact bytes.`;
    const savedRun = () => f.run({
      task: savedTask, status: f.provider.stopRun.mock.calls.length ? "STOPPED" : "RUNNING",
    });
    f.provider.listRuns.mockImplementation(async () => ({ data: [savedRun()], nextCursor: null }));
    f.provider.retrieveRun.mockImplementation(async () => savedRun());
    const outcome = await executeManagedAgent(f.recoveredClaim({
      providerAgentId: AGENT, providerTask: savedTask, ...(knownRun ? { providerRunId: RUN } : {}),
    }), f.journal, { ...f.options, agentId: "invalid current / agent", allowedOrigins: [] });
    expect(outcome).toMatchObject({ cleanup: "closed", error: "managed_recovery_stopped" });
    expect(f.provider.createRun).not.toHaveBeenCalled();
    expect(f.journal.dispatch).not.toHaveBeenCalled();
    expect(f.provider.stopRun).toHaveBeenCalledExactlyOnceWith(RUN);
    expect(f.provider.listRuns).toHaveBeenCalledTimes(knownRun ? 0 : 1);
  });

  it.each([
    {},
    { providerAgentId: AGENT },
    { providerTask: "missing agent" },
    { providerAgentId: AGENT, providerTask: "" },
    { providerAgentId: AGENT, providerTask: "correlation=another-correlation" },
    { providerAgentId: AGENT, providerTask: "correlation=unique-correlation-0001-other" },
  ])("retains unknown allocation without a complete matching immutable dispatch snapshot", async (snapshot) => {
    const f = fixture();
    const outcome = await executeManagedAgent(f.recoveredClaim({
      providerRunId: RUN, ...snapshot,
    }), f.journal, f.options);
    expect(outcome).toMatchObject({
      status: "failed", cleanup: "unconfirmed", allocationAttempted: true, error: "managed_recovery_unconfirmed",
    });
    expect(f.provider.createRun).not.toHaveBeenCalled();
    expect(f.provider.listRuns).not.toHaveBeenCalled();
    expect(f.provider.retrieveRun).not.toHaveBeenCalled();
    expect(f.provider.stopRun).not.toHaveBeenCalled();
    expect(f.journal.dispatch).not.toHaveBeenCalled();
  });

  it.each(["zero", "multiple", "wrong-token", "unavailable"] as const)(
    "retains unknown allocation on recovery with %s matches rather than launching a replacement", async (mode) => {
      const f = fixture();
      const originalCreate = f.provider.createRun.getMockImplementation()!;
      f.provider.createRun.mockImplementation(async (input) => { await originalCreate(input); throw new Error("unknown"); });
      await executeManagedAgent(f.claim, f.journal, f.options);
      f.provider.listRuns.mockImplementation(async () => {
        if (mode === "unavailable") throw new Error(SECRET);
        return { data: mode === "zero" ? [] : mode === "multiple"
          ? [f.run(), f.run({ runId: "another-run" })]
          : [f.run({ task: f.run().task.replace(f.claim.correlationToken, "other-correlation") })], nextCursor: null };
      });
      const outcome = await executeManagedAgent(f.recoveredClaim(), f.journal, f.options);
      expect(outcome).toMatchObject({ status: "failed", cleanup: "unconfirmed", allocationAttempted: true });
      expect(f.provider.createRun).toHaveBeenCalledOnce();
      expect(f.provider.stopRun).not.toHaveBeenCalled();
    },
  );

  it("recognizes recovery before the dispatch marker as known nonallocation", async () => {
    const f = fixture();
    const outcome = await executeManagedAgent({ ...f.claim, recovery: true }, f.journal, f.options);
    expect(outcome).toMatchObject({
      status: "failed", cleanup: "closed", allocationAttempted: false, error: "managed_recovered_before_dispatch",
    });
    expect(f.provider.createRun).not.toHaveBeenCalled();
    expect(f.provider.listRuns).not.toHaveBeenCalled();
  });

  it("guards recovery cursor loops and scopes every page without replacement allocation", async () => {
    const f = fixture();
    f.provider.listRuns.mockResolvedValue({ data: [], nextCursor: "repeated" });
    const outcome = await executeManagedAgent(f.recoveredClaim({
      providerAgentId: AGENT, providerTask: `Prior instructions\n${JSON.stringify({ correlationToken: f.claim.correlationToken })}`,
    }), f.journal, f.options);
    expect(outcome).toMatchObject({ cleanup: "unconfirmed", error: "managed_recovery_overflow" });
    expect(f.provider.listRuns).toHaveBeenCalledTimes(2);
    expect(f.provider.createRun).not.toHaveBeenCalled();
  });

  it("will not allocate on an expired initial claim or an unapproved origin", async () => {
    const f = fixture();
    const expired = await executeManagedAgent({ ...f.claim, startedAt: f.claim.startedAt - 61_000 }, f.journal, f.options);
    const scope = await executeManagedAgent(f.claim, f.journal, { ...f.options, allowedOrigins: [] });
    expect(expired).toMatchObject({ allocationAttempted: false, cleanup: "closed", error: "managed_deadline_elapsed" });
    expect(scope).toMatchObject({ allocationAttempted: false, cleanup: "closed", error: "managed_scope_rejected" });
    expect(f.provider.createRun).not.toHaveBeenCalled();
  });

  it.each([
    { ...modelResult, criteria: [{ ...modelResult.criteria[0], criterion: "Other criterion" }] },
    { ...modelResult, criteria: [...modelResult.criteria, ...modelResult.criteria] },
    { ...modelResult, criteria: [] },
    { ...modelResult, verified: true },
    { ...modelResult, criteria: [{ ...modelResult.criteria[0], criterion: " Find pricing " }] },
    { output: modelResult },
    { output: modelResult, taskDuration: 1200, summary: "Done", stepsTaken: 3, verified: true },
    { output: { ...modelResult, criteria: [{ ...modelResult.criteria[0], criterion: " Find pricing " }] },
      taskDuration: 1200, summary: "Done", stepsTaken: 3 },
  ])("rejects a nonexact structured result and still verifies cleanup", async (badResult) => {
    const f = fixture();
    f.provider.retrieveRun.mockImplementation(async () => f.run({ result: badResult }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({ status: "failed", cleanup: "closed", result: null, error: "managed_result_rejected" });
    expect(f.provider.retrieveSession).toHaveBeenCalled();
  });

  it("accepts the hosted runner output envelope without treating task metadata as browser or model usage", async () => {
    const f = fixture();
    f.provider.retrieveRun.mockImplementation(async () => f.run({
      result: { output: modelResult, taskDuration: 24261, summary: "Provider summary", stepsTaken: 7 },
    }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({
      status: "completed", cleanup: "closed", actualBrowserSeconds: 3.5, error: null,
      result: { ...modelResult, finalUrl: "https://approved.example/pricing" },
    });
    expect(outcome).not.toHaveProperty("modelCalls");
    expect(outcome).not.toHaveProperty("stepsTaken");
  });

  it("redacts secrets and raw URLs in model prose and limits finalUrl to the approved origin", async () => {
    const f = fixture();
    f.provider.retrieveRun.mockImplementation(async () => f.run({
      result: { ...modelResult, summary: `The value is ${SECRET} ${encodeURIComponent(SECRET)} https://private.invalid/`,
        finalUrl: `https://www.browserbase.com/sessions/${SESSION}`, limitations: [`api_key=${SECRET}`] },
    }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome.status).toBe("completed");
    expect(outcome.result?.finalUrl).toBe("");
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(JSON.stringify(outcome)).not.toContain("private.invalid");
    expect(JSON.stringify(outcome)).not.toContain("browserbase.com");
  });

  it("preserves exact user-authored criterion identities, including approved target URLs", async () => {
    const f = fixture();
    f.claim.criteria = ["Read https://approved.example/pricing"];
    f.provider.retrieveRun.mockImplementation(async () => f.run({
      result: { ...modelResult, criteria: [{ ...modelResult.criteria[0], criterion: f.claim.criteria[0] }] },
    }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome.status).toBe("completed");
    expect(outcome.result?.criteria[0].criterion).toBe(f.claim.criteria[0]);
  });

  it("rejects a task containing configured credentials before dispatch", async () => {
    const f = fixture();
    const outcome = await executeManagedAgent({ ...f.claim, goal: `Print ${SECRET}` }, f.journal, f.options);
    expect(outcome).toMatchObject({ error: "managed_task_rejected", allocationAttempted: false, cleanup: "closed" });
    expect(f.provider.createRun).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it("does not claim real browser work when a completed agent supplied no session", async () => {
    const f = fixture();
    f.provider.retrieveRun.mockImplementation(async () => f.run({ sessionId: undefined }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({
      status: "failed", cleanup: "closed", error: "managed_browser_session_missing", actualBrowserSeconds: null,
    });
  });

  it.each([
    { endedAt: undefined },
    { startedAt: "invalid", endedAt: "invalid" },
    { startedAt: "2026-05-01T00:00:05Z", endedAt: "2026-05-01T00:00:00Z" },
  ])("conserves unknown billing when session timestamps are missing or invalid", async (times) => {
    const f = fixture();
    f.provider.retrieveSession.mockResolvedValue(f.session(times));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome.cleanup).toBe("closed");
    expect(outcome.actualBrowserSeconds).toBeNull();
    expect(outcome).not.toHaveProperty("modelCalls");
  });

  it("rejects wrong-project sessions before live view or release", async () => {
    const f = fixture();
    f.provider.retrieveSession.mockResolvedValue(f.session({ projectId: "wrong-project", status: "RUNNING" }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({ status: "failed", cleanup: "unconfirmed", error: "managed_session_identity_rejected" });
    expect(f.provider.debugSession).not.toHaveBeenCalled();
    expect(f.provider.releaseSession).not.toHaveBeenCalled();
  });

  it("never silently replaces an associated session identity", async () => {
    const f = fixture();
    f.provider.retrieveRun
      .mockImplementationOnce(async () => f.run({ status: "RUNNING" }))
      .mockImplementation(async () => f.run({ sessionId: OTHER_SESSION }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({ status: "failed", cleanup: "unconfirmed", error: "managed_session_identity_rejected" });
    expect(f.provider.stopRun).toHaveBeenCalledOnce();
    expect(f.journal.identity).not.toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: OTHER_SESSION }));
    expect(f.provider.releaseSession).not.toHaveBeenCalled();
  });

  it("never fetches or publishes an interactive debugger URL, even with readOnly=true", async () => {
    const f = fixture();
    f.provider.debugSession.mockResolvedValue({
      debuggerFullscreenUrl: `https://www.browserbase.com/devtools?readOnly=true&key=${SECRET}`,
    });
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({ status: "completed", cleanup: "closed" });
    expect(f.provider.debugSession).not.toHaveBeenCalled();
    expect(f.journal.sessionView).toHaveBeenCalledExactlyOnceWith({
      liveViewUrl: "", replayUrl: `https://www.browserbase.com/sessions/${SESSION}`,
    });
    expect(JSON.stringify(vi.mocked(f.journal.sessionView).mock.calls)).not.toMatch(/devtools|readOnly|key=/);
  });

  it("does not publish even a generated replay URL containing the configured API key", async () => {
    const f = fixture();
    const outcome = await executeManagedAgent(f.claim, f.journal, { ...f.options, apiKey: SESSION });
    expect(outcome).toMatchObject({ status: "completed", cleanup: "closed" });
    expect(f.journal.sessionView).not.toHaveBeenCalled();
    expect(f.journal.progress).toHaveBeenCalledWith(expect.objectContaining({ text: "managed_replay_unavailable" }));
    expect(JSON.stringify({ outcome, progress: vi.mocked(f.journal.progress).mock.calls })).not.toContain(SESSION);
  });

  it.each([0, 1, 2, 10])("rejects key-bearing result URLs and redacts progress after %s levels of encoding", async (depth) => {
    const f = fixture();
    let key = SECRET;
    for (let index = 0; index < depth; index++) {
      key = index === 0
        ? [...key].map((character) => `%${character.charCodeAt(0).toString(16)}`).join("")
        : encodeURIComponent(key);
    }
    const finalUrl = `https://approved.example/pricing?value=${key}`;
    f.provider.retrieveRun.mockImplementation(async () => f.run({
      result: { ...modelResult, finalUrl, summary: `Observed ${key}`, limitations: [] },
    }));
    f.provider.listMessages.mockResolvedValue({
      data: [{ id: "key-message", role: "assistant", parts: [{ type: "text", text: `Reading ${key}` }] }],
      nextCursor: null,
    });
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({ status: "completed", cleanup: "closed", result: { finalUrl: "" } });
    const exposed = JSON.stringify({ outcome, progress: vi.mocked(f.journal.progress).mock.calls,
      views: vi.mocked(f.journal.sessionView).mock.calls });
    expect(exposed).not.toContain(key);
    expect(exposed).not.toContain(SECRET);
    expect(exposed).toContain("[REDACTED]");
  });

  it("does not dispatch a task containing a percent-encoded configured key", async () => {
    const f = fixture();
    const key = [...SECRET].map((character) => `%${character.charCodeAt(0).toString(16)}`).join("");
    const outcome = await executeManagedAgent({ ...f.claim, goal: `Read https://approved.example/?key=${key}` },
      f.journal, f.options);
    expect(outcome).toMatchObject({ allocationAttempted: false, cleanup: "closed", error: "managed_task_rejected" });
    expect(f.provider.createRun).not.toHaveBeenCalled();
  });

  it("stops dispatching when a lease is lost during an awaited create", async () => {
    const f = fixture();
    const originalCreate = f.provider.createRun.getMockImplementation()!;
    f.provider.createRun.mockImplementation(async (input) => {
      const created = await originalCreate(input);
      vi.mocked(f.journal.assertActive).mockImplementation(() => { throw new Error(`lease ${SECRET}`); });
      return created;
    });
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({ status: "failed", cleanup: "unconfirmed", error: "managed_lease_lost" });
    expect(f.journal.identity).not.toHaveBeenCalled();
    expect(f.provider.retrieveRun).not.toHaveBeenCalled();
    expect(f.provider.stopRun).not.toHaveBeenCalled();
  });

  it("stops dispatching on lease loss in cleanup even when cancellation is ignored", async () => {
    const f = fixture();
    const originalCreate = f.provider.createRun.getMockImplementation()!;
    f.provider.createRun.mockImplementation(async (input) => {
      const created = await originalCreate(input); f.controller.abort(); return created;
    });
    f.provider.retrieveRun.mockImplementation(async () => {
      vi.mocked(f.journal.assertActive).mockImplementation(() => { throw new Error("stale"); });
      return f.run({ status: "RUNNING" });
    });
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome.error).toBe("managed_lease_lost");
    expect(f.provider.stopRun).toHaveBeenCalledOnce();
    expect(f.provider.stopRun.mock.invocationCallOrder[0]).toBeLessThan(f.provider.retrieveRun.mock.invocationCallOrder[0]);
    expect(f.provider.retrieveSession).not.toHaveBeenCalled();
  });

  it("guards message cursor loops with a fixed error and still closes the run", async () => {
    const f = fixture();
    f.provider.listMessages.mockResolvedValue({
      data: Array.from({ length: 100 }, (_, index) => ({
        id: `message-${index}`, role: "assistant", parts: [{ type: "text", text: "Reading", state: "done" }],
      })), nextCursor: "repeated",
    });
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({ status: "failed", cleanup: "closed", error: "managed_progress_overflow" });
    expect(f.provider.listMessages).toHaveBeenCalledTimes(2);
  });

  it("bounds progress to 500 events and still stops an active overflowing run", async () => {
    const f = fixture();
    f.provider.retrieveRun.mockImplementation(async () => f.run({
      status: f.provider.stopRun.mock.calls.length ? "STOPPED" : "RUNNING",
    }));
    f.provider.listMessages.mockImplementation(async (_id, query) => ({
      data: Array.from({ length: 100 }, (_, index) => ({
        id: `${query.cursor ?? "first"}-${index}`, role: "assistant",
        parts: [{ type: "text", text: "Reading" }, { type: "tool-browser", state: "output-available" }],
      })), nextCursor: `${query.cursor ?? "first"}-next`,
    }));
    const outcome = await executeManagedAgent(f.claim, f.journal, f.options);
    expect(outcome).toMatchObject({ error: "managed_progress_overflow", cleanup: "closed" });
    expect(f.journal.progress).toHaveBeenCalledTimes(500);
    expect(f.provider.stopRun).toHaveBeenCalledOnce();
  });
});
