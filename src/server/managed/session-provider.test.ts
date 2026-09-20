import { describe, expect, it, vi } from "vitest";
import { managedResultSchema } from "../../lib/managed-contracts";
import { executeManagedAgent } from "./runner";
import {
  createSessionManagedProvider, type SessionEngineBrowser, type SessionEngineDeps, type SessionEngineStagehand,
} from "./session-provider";
import type { ManagedProviderRun, ManagedProviderSession } from "./provider";
import type { ManagedClaim, ManagedJournal } from "./types";

const SESSION = "85be1854-9445-4758-9f53-dfca28d167df";
const AGENT = "reviewed-agent-fixture";
const PROJECT = "provider-project-fixture";
const SECRET = "bb_test_must_never_appear";
const LIVE = `https://www.browserbase.com/devtools?sessionId=${SESSION}`;
const SCOPE_NOTE = "Scope and read-only behaviour were instructions to a model-driven browser loop, not enforced restrictions.";
const REPORT_NOTE = "Model-authored report, not independently verified.";
const TOOL = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;
const persona = {
  id: "careful-reader", name: "Careful reader", character: "Reads unfamiliar sites carefully",
  device: "desktop" as const, techComfort: "low" as const, patienceSteps: 10, readingStyle: "careful" as const,
  quirks: ["Checks navigation"], worries: ["Unexpected charges"],
};
const criteria = ["Find pricing", "Find a contact route"];
function taskText(change: Record<string, unknown> = {}): string {
  return ["Instructions.", "More instructions.", JSON.stringify({
    correlationToken: "unique-correlation-0001", targetUrl: "https://approved.example/",
    declaredScope: { origin: "https://approved.example", allowedSubdomains: [], pathPrefixes: ["/"] },
    persona, goal: "Read the pricing page", criteria, ...change,
  })].join("\n");
}

type Step = { observation: string; done: boolean; nextAction: { kind: "click" | "scroll" | "none"; target: string } };
type Report = { summary: string; criteria: { status: string; observation: string }[]; limitations: string[] };
const goodReport: Report = {
  summary: "Pricing was easy to find.",
  criteria: [{ status: "met", observation: "A pricing page opened." }, { status: "not_met", observation: "No contact link seen." }],
  limitations: ["Only two pages were read."],
};

function harness(setup: {
  steps?: (Step | Error | Promise<Step> | (() => Step))[]; report?: Report | Error; afterAct?: string[];
  maxSteps?: number; start?: number; newTab?: string;
} = {}) {
  const steps = [...(setup.steps ?? [
    { observation: "I see a pricing link in the header.", done: false, nextAction: { kind: "click" as const, target: "Pricing" } },
    { observation: "The pricing table is clear.", done: true, nextAction: { kind: "none" as const, target: "" } },
  ])];
  const afterAct = [...(setup.afterAct ?? ["https://approved.example/pricing?plan=1"])];
  let current = "about:blank";
  let closed = false;
  let clock = setup.start ?? Date.parse("2026-09-20T12:00:00.000Z");
  let counter = 0;
  const page = {
    pageId: "page-1",
    goto: vi.fn(async (url: string) => { current = url; }),
    url: vi.fn(async () => current),
    scroll: vi.fn(async () => {}),
  };
  const opened = {
    pageId: "page-2",
    goto: vi.fn(async () => {}),
    url: vi.fn(async () => setup.newTab ?? "about:blank"),
    close: vi.fn(async () => { activeTab = page; }),
  };
  let activeTab: typeof page | typeof opened = page;
  const browser = {
    sessionId: SESSION as string | undefined,
    context: {
      activePage: vi.fn(async () => activeTab),
      setActivePage: vi.fn(async () => { activeTab = page; }),
    },
    close: vi.fn(async () => { closed = true; }),
  };
  const instructions: string[] = [];
  const extract = vi.fn(async (instruction: string) => {
    instructions.push(instruction);
    if (instruction.startsWith("Write the final evaluation report")) {
      const report = setup.report ?? goodReport;
      if (report instanceof Error) throw report;
      return { data: report };
    }
    const step = steps.shift() ?? { observation: "Nothing new.", done: true, nextAction: { kind: "none", target: "" } };
    if (step instanceof Error) throw step;
    return { data: typeof step === "function" ? step() : await step };
  });
  const stagehand = {
    extract: extract as unknown as SessionEngineStagehand["extract"],
    act: vi.fn<SessionEngineStagehand["act"]>(async () => {
      if (setup.newTab) activeTab = opened;
      else current = afterAct.shift() ?? current;
      return { data: { success: true } };
    }),
    close: vi.fn(async () => {}),
  };
  const session = (): ManagedProviderSession => closed
    ? { id: SESSION, projectId: PROJECT, status: "COMPLETED", startedAt: new Date(clock).toISOString(),
      endedAt: new Date(clock + 4000).toISOString() }
    : { id: SESSION, projectId: PROJECT, status: "RUNNING", startedAt: new Date(clock).toISOString() };
  const deps = {
    launch: vi.fn<SessionEngineDeps["launch"]>(async () => browser as SessionEngineBrowser),
    createStagehand: vi.fn<SessionEngineDeps["createStagehand"]>(async () => stagehand),
    base: {
      retrieveSession: vi.fn(async () => session()),
      debugSession: vi.fn(async () => ({ debuggerFullscreenUrl: LIVE })),
      releaseSession: vi.fn(async () => {}),
    },
    now: () => clock,
    id: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    log: vi.fn<SessionEngineDeps["log"]>(),
  };
  const provider = createSessionManagedProvider({
    apiKey: SECRET, projectId: PROJECT, modelName: "google/gemini-2.5-flash", runSeconds: 60,
    ...(setup.maxSteps ? { maxSteps: setup.maxSteps } : {}),
  }, deps);
  async function settle(runId: string): Promise<ManagedProviderRun> {
    for (let index = 0; index < 500; index++) {
      const run = await provider.retrieveRun(runId);
      if (!["PENDING", "RUNNING"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("run did not settle");
  }
  async function parts(runId: string) {
    const { data, nextCursor } = await provider.listMessages(runId, { limit: 100 });
    const flat = (data as { id: string; role: string; parts: { type: string; text?: string }[] }[])
      .flatMap((entry) => entry.parts);
    return {
      data, nextCursor,
      tools: flat.filter((part) => part.type.startsWith("tool-")).map((part) => part.type.slice(5)),
      texts: flat.filter((part) => part.type === "text").map((part) => part.text),
    };
  }
  return { provider, deps, browser, page, opened, stagehand, extract, instructions, settle, parts, advance: (ms: number) => { clock += ms; } };
}

describe("session-backed managed provider", () => {
  it("drives PENDING to COMPLETED with a normalised result and valid tool names", async () => {
    const h = harness();
    const task = taskText();
    const created = await h.provider.createRun({ agentId: AGENT, task, resultSchema: {} });
    expect(created).toMatchObject({ agentId: AGENT, task, status: "PENDING" });
    expect(created).not.toHaveProperty("sessionId");
    expect(created).not.toHaveProperty("result");
    const done = await h.settle(created.runId);
    expect(done).toMatchObject({ runId: created.runId, agentId: AGENT, task, status: "COMPLETED", sessionId: SESSION });
    expect(Date.parse(done.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
    expect(done.createdAt).toBe(created.createdAt);
    const result = managedResultSchema.parse(done.result);
    expect(result).toEqual({
      summary: "Pricing was easy to find.", finalUrl: "https://approved.example/pricing?plan=1",
      criteria: [
        { criterion: criteria[0], status: "met", observation: "A pricing page opened." },
        { criterion: criteria[1], status: "not_met", observation: "No contact link seen." },
      ],
      limitations: ["Only two pages were read.", SCOPE_NOTE, REPORT_NOTE],
    });
    const messages = await h.parts(created.runId);
    // An early "done" still gets one harmless scroll, without a model call, before the report.
    expect(messages.tools).toEqual(["session-started", "goto:home", "click:pricing", "scroll-down", "report"]);
    for (const name of messages.tools) expect(name).toMatch(TOOL);
    expect(messages.texts).toEqual(["I see a pricing link in the header.", "The pricing table is clear.", "Nothing new."]);
    expect(h.page.scroll).toHaveBeenCalledExactlyOnceWith(640, 450, 0, 600);
    expect(h.deps.log).not.toHaveBeenCalled();
    expect(new Set((messages.data as { id: string }[]).map((entry) => entry.id)).size).toBe(messages.data.length);
    expect(h.deps.launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      apiKey: SECRET, projectId: PROJECT, api_timeout: 60, keepAlive: false, proxies: false,
    }));
    expect(h.page.goto).toHaveBeenCalledWith("https://approved.example/", expect.anything());
    expect(h.stagehand.act).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("\"Pricing\""), expect.anything());
    expect(h.instructions[0]).toContain("Careful reader");
    expect(h.instructions[0]).toContain("untrusted evidence");
    expect(h.stagehand.close).toHaveBeenCalledOnce();
    expect(h.browser.close).toHaveBeenCalledOnce();
    expect(JSON.stringify([messages.data, done.result])).not.toMatch(new RegExp(`${SECRET}|devtools`));
  });

  it.each([
    ["no JSON line", "Just instructions."],
    ["extra keys", taskText({ extra: true })],
    ["a target outside its declared scope", taskText({ targetUrl: "https://other.example/" })],
    ["no criteria", taskText({ criteria: [] })],
  ])("rejects a task with %s before launching", async (_label, task) => {
    const h = harness();
    await expect(h.provider.createRun({ agentId: AGENT, task, resultSchema: {} })).rejects.toThrow("session_task_rejected");
    expect(h.deps.launch).not.toHaveBeenCalled();
    expect((await h.provider.listRuns({ agentId: AGENT, startAt: "2000-01-01T00:00:00.000Z",
      endAt: "2100-01-01T00:00:00.000Z", limit: 100 })).data).toEqual([]);
  });

  it("returns to the last in-scope page and records a limitation after leaving scope", async () => {
    const h = harness({ afterAct: ["https://elsewhere.example/pricing"] });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const done = await h.settle(runId);
    expect(h.page.goto).toHaveBeenLastCalledWith("https://approved.example/", expect.anything());
    expect((await h.parts(runId)).texts).toContain("Left the declared scope; returning.");
    const result = managedResultSchema.parse(done.result);
    expect(result.finalUrl).toBe("https://approved.example/");
    expect(result.limitations.join(" ")).toContain("left the declared scope");
  });

  it.each(["Sign up now", "Create account", "Book a demo", "Add to cart", "Log out"])(
    "skips the forbidden click target %s without acting", async (target) => {
    const h = harness({ steps: [
      { observation: "There is a sign-up form.", done: false, nextAction: { kind: "click", target } },
    ] });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const done = await h.settle(runId);
    expect(h.stagehand.act).not.toHaveBeenCalled();
    expect(done.status).toBe("COMPLETED");
    expect(h.page.scroll).not.toHaveBeenCalled();
    expect((await h.parts(runId)).texts).toContain("Skipped an action that is not read-only.");
  });

  it("still completes with a report when an action rejects", async () => {
    const h = harness();
    h.stagehand.act.mockRejectedValueOnce(new Error(`gateway failure ${SECRET}`));
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const done = await h.settle(runId);
    expect(done.status).toBe("COMPLETED");
    expect(managedResultSchema.parse(done.result).summary).toBe("Pricing was easy to find.");
    const messages = await h.parts(runId);
    expect(messages.texts).toContain("That action did not complete.");
    // One failed action does not end browsing; the loop carries on with scrolls.
    expect(messages.tools).toEqual(["session-started", "goto:home", "scroll-down", "scroll-down", "report"]);
    expect(h.deps.log).toHaveBeenCalledExactlyOnceWith("managed_session_engine_error:explore:Error:0");
    expect(JSON.stringify([messages.data, done, h.deps.log.mock.calls])).not.toContain(SECRET);
  });

  it("stops browsing after two failed actions in a row and still reports", async () => {
    const click = (target: string): Step => ({ observation: `I want ${target}.`, done: false, nextAction: { kind: "click", target } });
    const h = harness({ steps: [click("Pricing"), click("Docs"), click("Contact")] });
    h.stagehand.act.mockRejectedValue(new Error("act failed"));
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const done = await h.settle(runId);
    expect(done.status).toBe("COMPLETED");
    expect(h.stagehand.act).toHaveBeenCalledTimes(2);
    const result = managedResultSchema.parse(done.result);
    expect(result.limitations.filter((entry) => entry === "A browser action did not complete.")).toHaveLength(1);
  });

  it("closes an out-of-scope new tab, returns to the original tab and records limitations", async () => {
    const h = harness({ newTab: "https://elsewhere.example/docs" });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const done = await h.settle(runId);
    expect(h.opened.close).toHaveBeenCalledOnce();
    expect(h.browser.context.setActivePage).toHaveBeenCalledExactlyOnceWith(h.page);
    expect(h.page.goto).toHaveBeenCalledOnce();
    expect((await h.parts(runId)).texts).toContain("Left the declared scope; returning.");
    const result = managedResultSchema.parse(done.result);
    expect(result.finalUrl).toBe("https://approved.example/");
    expect(result.summary).toBe("Pricing was easy to find.");
    expect(result.limitations.join(" ")).toMatch(/opened a new tab.*left the declared scope/);
  });

  it("follows an in-scope new tab in the original tab", async () => {
    const h = harness({ newTab: "https://approved.example/docs" });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const result = managedResultSchema.parse((await h.settle(runId)).result);
    expect(h.opened.close).toHaveBeenCalledOnce();
    expect(h.page.goto).toHaveBeenLastCalledWith("https://approved.example/docs", expect.anything());
    expect(result.finalUrl).toBe("https://approved.example/docs");
    expect((await h.parts(runId)).texts).not.toContain("Left the declared scope; returning.");
  });

  it("writes no model report when the new tab cannot be closed", async () => {
    const h = harness({ newTab: "https://elsewhere.example/docs" });
    h.opened.close.mockRejectedValue(new Error("close failed"));
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const done = await h.settle(runId);
    expect(done.status).toBe("COMPLETED");
    const result = managedResultSchema.parse(done.result);
    expect(result.finalUrl).toBe("");
    expect(result.criteria.every((entry) => entry.status === "inconclusive")).toBe(true);
    expect(h.instructions.some((entry) => entry.startsWith("Write the final evaluation report"))).toBe(false);
  });

  it("completes without a model report when returning to scope fails", async () => {
    const h = harness();
    let here = "about:blank";
    h.page.goto.mockImplementation(async (url: string) => {
      if (h.page.goto.mock.calls.length > 1) throw new Error("navigation failed");
      here = url;
    });
    h.page.url.mockImplementation(async () => here);
    h.stagehand.act.mockImplementationOnce(async () => {
      here = "https://elsewhere.example/pricing";
      return { data: { success: true } };
    });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const done = await h.settle(runId);
    expect(done.status).toBe("COMPLETED");
    const result = managedResultSchema.parse(done.result);
    expect(result.finalUrl).toBe("");
    expect(result.criteria.every((entry) => entry.status === "inconclusive")).toBe(true);
    expect(result.limitations).toEqual(expect.arrayContaining([
      "A tab or scope check did not complete, so browsing stopped early.", "The final report could not be generated.",
    ]));
    expect(h.instructions.some((entry) => entry.startsWith("Write the final evaluation report"))).toBe(false);
  });

  it("does not explore or write a model report when the target lands outside the declared scope", async () => {
    const h = harness();
    h.page.url.mockResolvedValue("https://www.approved.example/");
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const done = await h.settle(runId);
    expect(done.status).toBe("COMPLETED");
    expect(h.extract).not.toHaveBeenCalled();
    const result = managedResultSchema.parse(done.result);
    expect(result.finalUrl).toBe("");
    expect(result.criteria.every((entry) => entry.status === "inconclusive")).toBe(true);
    expect(result.limitations.join(" ")).toContain("redirected outside the declared scope");
  });

  it("does not start a step that cannot finish before the loop cutoff", async () => {
    const h = harness({ maxSteps: 12, steps: [() => {
      h.advance(25_000);
      return { observation: "Reading slowly.", done: false, nextAction: { kind: "scroll", target: "" } };
    }] });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    expect((await h.settle(runId)).status).toBe("COMPLETED");
    // 33 s loop window at runSeconds 60: after 25 s fewer than 12 s remain, so only the report follows.
    expect(h.extract).toHaveBeenCalledTimes(2);
    expect((await h.parts(runId)).texts).not.toContain("Could not read the page this time.");
  });

  it("falls back to an all-inconclusive result when the report fails", async () => {
    const h = harness({ report: new Error("report failed") });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const result = managedResultSchema.parse((await h.settle(runId)).result);
    expect(result.criteria).toEqual(criteria.map((criterion) => ({
      criterion, status: "inconclusive", observation: "Not observed.",
    })));
    expect(result.limitations).toEqual(expect.arrayContaining([
      "The final report could not be generated.", SCOPE_NOTE, REPORT_NOTE,
    ]));
  });

  it("rebuilds criteria by index and clamps an oversized or mismatched report", async () => {
    const h = harness({ report: {
      summary: "s".repeat(5000),
      criteria: [{ status: "met", observation: "o".repeat(2000) }, { status: "met", observation: " " },
        { status: "met", observation: "extra" }],
      limitations: Array.from({ length: 30 }, (_, index) => `${index} ${"l".repeat(600)}`),
    } });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const result = managedResultSchema.parse((await h.settle(runId)).result);
    expect(result.summary).toHaveLength(4000);
    expect(result.criteria.map((entry) => entry.criterion)).toEqual(criteria);
    expect(result.criteria[0].observation).toHaveLength(1500);
    expect(result.criteria[1].observation).toBe("Not observed.");
    expect(result.limitations).toHaveLength(12);
    expect(result.limitations.slice(-2)).toEqual([SCOPE_NOTE, REPORT_NOTE]);
  });

  it("fails without a session when launch rejects, and closes after a Stagehand startup failure", async () => {
    const h = harness();
    h.deps.launch.mockRejectedValueOnce(Object.assign(new Error(`quota ${SECRET} wss://connect.example`), { status: 402 }));
    const first = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const failed = await h.settle(first.runId);
    expect(failed.status).toBe("FAILED");
    expect(failed).not.toHaveProperty("sessionId");
    expect(failed).not.toHaveProperty("result");
    expect(h.deps.createStagehand).not.toHaveBeenCalled();
    // The stage and HTTP status are diagnosable; the error message never is.
    expect(h.deps.log).toHaveBeenCalledExactlyOnceWith("managed_session_engine_error:launch:Error:402");
    expect((await h.parts(first.runId)).texts).toEqual(["The browser session failed during launch."]);

    h.deps.createStagehand.mockRejectedValueOnce(new Error("startup failed"));
    const second = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    expect(await h.settle(second.runId)).toMatchObject({ status: "FAILED", sessionId: SESSION });
    expect(h.browser.close).toHaveBeenCalledOnce();
    expect(h.deps.log).toHaveBeenLastCalledWith("managed_session_engine_error:stagehand:Error:0");
    expect(JSON.stringify([h.deps.log.mock.calls, await h.parts(second.runId)])).not.toMatch(/bb_test|connect\.example/);
  });

  it("fails when the launched session identity is not a UUID", async () => {
    const h = harness();
    h.browser.sessionId = "not-a-uuid";
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const failed = await h.settle(runId);
    expect(failed.status).toBe("FAILED");
    expect(failed).not.toHaveProperty("sessionId");
    expect(h.browser.close).toHaveBeenCalledOnce();
  });

  it("stops mid-run although the in-flight call never settles, and never exposes a result", async () => {
    // Stagehand does not reject in-flight calls when the browser closes, so neither does this fake.
    const h = harness({ steps: [new Promise<Step>(() => {})] });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    for (let index = 0; index < 100 && !h.extract.mock.calls.length; index++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect((await h.provider.retrieveRun(runId)).status).toBe("RUNNING");
    await h.provider.stopRun(runId);
    expect(h.browser.close).toHaveBeenCalled();
    const stopped = await h.settle(runId);
    expect(stopped).toMatchObject({ status: "STOPPED", sessionId: SESSION });
    expect(h.stagehand.close).toHaveBeenCalledOnce();
    expect(h.deps.log).not.toHaveBeenCalled();
    expect(stopped).not.toHaveProperty("result");
    expect((await h.parts(runId)).tools).not.toContain("report");
    expect(await h.provider.stopRun(runId)).toMatchObject({ status: "STOPPED" });
  });

  it("bounds messages to sixty with a null cursor", async () => {
    const h = harness({
      maxSteps: 12,
      steps: Array.from({ length: 12 }, (_, index) => ({
        observation: `Observation ${index}`, done: false, nextAction: { kind: "scroll" as const, target: "" },
      })),
    });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    await h.settle(runId);
    const all = await h.parts(runId);
    expect(all.nextCursor).toBeNull();
    expect(all.data.length).toBeLessThanOrEqual(60);
    expect(all.tools.filter((name) => name === "scroll-down")).toHaveLength(12);
    expect((await h.provider.listMessages(runId, { limit: 3 })).data).toHaveLength(3);
  });

  it("lists runs from memory by agent and creation time", async () => {
    const h = harness();
    const first = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    h.advance(120_000);
    const second = await h.provider.createRun({ agentId: "other-agent", task: taskText(), resultSchema: {} });
    await h.settle(first.runId); await h.settle(second.runId);
    const query = { startAt: "2026-09-20T11:59:00.000Z", endAt: "2026-09-20T12:01:00.000Z", limit: 100 };
    expect(await h.provider.listRuns({ agentId: AGENT, ...query })).toMatchObject({
      data: [{ runId: first.runId }], nextCursor: null,
    });
    expect((await h.provider.listRuns({ agentId: "other-agent", ...query })).data).toEqual([]);
    expect((await h.provider.listRuns({ agentId: "other-agent", ...query, endAt: "2026-09-20T12:03:00.000Z" })).data)
      .toMatchObject([{ runId: second.runId }]);
  });

  it("reports an unknown run as not found", async () => {
    const h = harness();
    await expect(h.provider.retrieveRun("missing")).rejects.toMatchObject({ message: "not_found", status: 404 });
    await expect(h.provider.listMessages("missing", { limit: 10 })).rejects.toMatchObject({ status: 404 });
    await expect(h.provider.stopRun("missing")).rejects.toMatchObject({ status: 404 });
  });

  it("delegates session operations to the real-session base", async () => {
    const h = harness();
    await h.provider.retrieveSession(SESSION);
    await h.provider.debugSession(SESSION);
    await h.provider.releaseSession(SESSION, PROJECT);
    expect(h.deps.base.retrieveSession).toHaveBeenCalledExactlyOnceWith(SESSION);
    expect(h.deps.base.debugSession).toHaveBeenCalledExactlyOnceWith(SESSION);
    expect(h.deps.base.releaseSession).toHaveBeenCalledExactlyOnceWith(SESSION, PROJECT);
  });
});

describe("managed runner over the session-backed provider", () => {
  it("completes, publishes one live view and confirms closure through the session API", async () => {
    const slow = new Promise<Step>((resolve) => setTimeout(() => resolve({
      observation: "I see a pricing link in the header.", done: false, nextAction: { kind: "click", target: "Pricing" },
    }), 25));
    // The runner compares the session start with the real clock.
    const h = harness({ steps: [slow], start: Date.now() });
    const claim: ManagedClaim = {
      id: "7a3b55ba-78ef-4ac8-9f07-0f99971e0061", runId: "45182a76-a97a-415f-a4f6-e2e93fa14f92",
      ownerId: "owner-fixture", workerId: "worker-fixture", generation: 1,
      correlationToken: "unique-correlation-0001", persona, goal: "Read the pricing page", criteria,
      scope: { targetUrl: "https://approved.example/", pathPrefixes: ["/"], allowedSubdomains: [] },
      reservedSeconds: 60, startedAt: Date.now(), recovery: false, dispatchStarted: false,
    };
    const journal: ManagedJournal = {
      assertActive: vi.fn(), dispatch: vi.fn(), identity: vi.fn(), progress: vi.fn(),
      sessionView: vi.fn(), liveView: vi.fn(),
    };
    const outcome = await executeManagedAgent(claim, journal, {
      apiKey: SECRET, projectId: PROJECT, agentId: AGENT, signal: new AbortController().signal,
      allowedOrigins: ["https://approved.example"], provider: h.provider, pollMs: 0,
    });
    expect(outcome).toMatchObject({
      status: "completed", cleanup: "closed", error: null, providerStatus: "COMPLETED", actualBrowserSeconds: 4,
      result: {
        summary: "Pricing was easy to find.", finalUrl: "https://approved.example/pricing",
        criteria: [
          { criterion: criteria[0], status: "met", observation: "A pricing page opened." },
          { criterion: criteria[1], status: "not_met", observation: "No contact link seen." },
        ],
        limitations: ["Only two pages were read.", SCOPE_NOTE, REPORT_NOTE],
      },
    });
    expect(journal.liveView).toHaveBeenCalledOnce();
    expect(h.deps.base.debugSession).toHaveBeenCalledOnce();
    expect(h.deps.launch).toHaveBeenCalledOnce();
    expect(h.deps.base.releaseSession).not.toHaveBeenCalled();
    expect(journal.identity).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: SESSION }));
    expect(journal.sessionView).toHaveBeenCalledExactlyOnceWith({
      liveViewUrl: "", replayUrl: `https://www.browserbase.com/sessions/${SESSION}`,
    });
    const emitted = vi.mocked(journal.progress).mock.calls.map(([entry]) => entry);
    expect(emitted.filter((entry) => entry.kind === "tool").map((entry) => entry.text))
      .toEqual(["session-started", "goto:home", "click:pricing", "scroll-down", "report"]);
    expect(emitted.filter((entry) => entry.kind === "text").map((entry) => entry.text))
      .toContain("I see a pricing link in the header.");
    expect(emitted.map((entry) => entry.text)).toEqual(expect.arrayContaining(["PENDING", "RUNNING", "COMPLETED"]));
    expect(JSON.stringify([outcome, emitted])).not.toMatch(new RegExp(`${SECRET}|devtools`));
  });

  it("confirms closure when cancelled while a Stagehand call never settles", async () => {
    const h = harness({ steps: [new Promise<Step>(() => {})], start: Date.now() });
    const controller = new AbortController();
    const claim: ManagedClaim = {
      id: "7a3b55ba-78ef-4ac8-9f07-0f99971e0061", runId: "45182a76-a97a-415f-a4f6-e2e93fa14f92",
      ownerId: "owner-fixture", workerId: "worker-fixture", generation: 1,
      correlationToken: "unique-correlation-0001", persona, goal: "Read the pricing page", criteria,
      scope: { targetUrl: "https://approved.example/", pathPrefixes: ["/"], allowedSubdomains: [] },
      reservedSeconds: 60, startedAt: Date.now(), recovery: false, dispatchStarted: false,
    };
    const journal: ManagedJournal = {
      assertActive: vi.fn(), dispatch: vi.fn(), identity: vi.fn(), progress: vi.fn(),
      sessionView: vi.fn(), liveView: vi.fn(),
    };
    const pending = executeManagedAgent(claim, journal, {
      apiKey: SECRET, projectId: PROJECT, agentId: AGENT, signal: controller.signal,
      allowedOrigins: ["https://approved.example"], provider: h.provider, pollMs: 0,
    });
    for (let index = 0; index < 200 && !h.extract.mock.calls.length; index++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(h.extract).toHaveBeenCalledOnce();
    controller.abort();
    const began = Date.now();
    const outcome = await pending;
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(outcome).toMatchObject({
      status: "cancelled", error: "managed_cancelled", providerStatus: "STOPPED", cleanup: "closed", result: null,
    });
    expect(h.browser.close).toHaveBeenCalled();
    expect(h.deps.launch).toHaveBeenCalledOnce();
  });
});
