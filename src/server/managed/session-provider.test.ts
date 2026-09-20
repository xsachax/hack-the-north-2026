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

type Step = { observation: string; done: boolean; nextAction: { kind: "click" | "scroll" | "tab" | "none"; target: string } };
type Report = { summary: string; criteria: { status: string; observation: string }[]; limitations: string[] };
const goodReport: Report = {
  summary: "Pricing was easy to find.",
  criteria: [{ status: "met", observation: "A pricing page opened." }, { status: "not_met", observation: "No contact link seen." }],
  limitations: ["Only two pages were read."],
};

function harness(setup: {
  steps?: (Step | Error | Promise<Step> | (() => Step))[]; report?: Report | Error; afterAct?: string[];
  maxSteps?: number; start?: number; newTab?: string; keys?: boolean; evaluate?: (expression: string) => unknown;
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
  const keyPress = vi.fn(async (key: string) => { void key; });
  const evaluate = vi.fn(async (expression: string) => setup.evaluate?.(expression));
  const page = {
    pageId: "page-1",
    goto: vi.fn(async (url: string) => { current = url; }),
    url: vi.fn(async () => current),
    scroll: vi.fn(async () => {}),
    // Optional engine members are only present when a test asks for them.
    ...(setup.keys ? { keyPress } : {}),
    ...(setup.evaluate ? { evaluate } : {}),
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
    launch: vi.fn<SessionEngineDeps["launch"]>(async () => browser as unknown as SessionEngineBrowser),
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
  return {
    provider, deps, browser, page, opened, stagehand, extract, instructions, keyPress, evaluate, settle, parts,
    advance: (ms: number) => { clock += ms; },
    reportInstruction: () => instructions.find((entry) => entry.startsWith("Write the final evaluation report")) ?? "",
  };
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
    // An early "done" is only honoured after three actions; until then each one becomes a harmless scroll.
    expect(messages.tools).toEqual(["session-started", "goto:home", "click:pricing", "scroll-down", "scroll-down", "report"]);
    for (const name of messages.tools) expect(name).toMatch(TOOL);
    // "Nothing new." was observed twice in a row and is shown once.
    expect(messages.texts).toEqual(["I see a pricing link in the header.", "The pricing table is clear.", "Nothing new."]);
    expect(h.page.scroll).toHaveBeenCalledTimes(2);
    expect(h.page.scroll).toHaveBeenLastCalledWith(640, 450, 0, 600);
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

  it("returns to the last in-scope page and reports the off-site link by hostname, never clicking it twice", async () => {
    const click = (observation: string): Step => ({ observation, done: false, nextAction: { kind: "click", target: "Privacy Policy" } });
    const h = harness({
      afterAct: ["https://policies.elsewhere.example/privacy?session=private-query"],
      steps: [click("There is a privacy link in the footer."), click("Trying the privacy link again."),
        { observation: "Still the home page.", done: false, nextAction: { kind: "click", target: "  privacy   POLICY " } }],
    });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const done = await h.settle(runId);
    const finding = "The \"Privacy Policy\" link leads to policies.elsewhere.example, outside the approved site, so it was not explored.";
    expect(h.page.goto).toHaveBeenLastCalledWith("https://approved.example/", expect.anything());
    expect(h.stagehand.act).toHaveBeenCalledOnce();
    const messages = await h.parts(runId);
    expect(messages.texts).toContain(finding);
    expect(messages.texts).not.toContain("Left the declared scope; returning.");
    expect(messages.tools.filter((name) => name.startsWith("click:"))).toEqual(["click:privacy-policy"]);
    const result = managedResultSchema.parse(done.result);
    expect(result.finalUrl).toBe("https://approved.example/");
    expect(result.limitations).toContain(finding);
    // The next step is told not to choose the label again, and the report sees the finding as an engine fact.
    expect(h.instructions[1]).toContain("\"doNotClick\":[\"privacy policy\"]");
    expect(h.reportInstruction()).toContain("outside the approved site");
    expect(JSON.stringify([messages.data, done.result, h.instructions])).not.toMatch(/private-query|\/privacy\?/);
  });

  it.each([
    ["a browser error page", { afterAct: ["chrome-error://chromewebdata/"] },
      "The \"Pricing\" link showed a blank or browser error page, so it was not explored and where it leads is unknown."],
    ["a new tab that is still blank", { newTab: "about:blank" },
      "The \"Pricing\" link opened a new tab showing a blank or browser error page, so it was not explored and where it leads is unknown."],
  ])("never turns %s into a claim about where the link leads", async (_label, setup, finding) => {
    const h = harness(setup);
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const done = await h.settle(runId);
    expect(done.status).toBe("COMPLETED");
    const messages = await h.parts(runId);
    expect(messages.texts).toContain(finding);
    expect(managedResultSchema.parse(done.result).limitations).toContain(finding);
    expect(JSON.stringify([messages.data, done.result, h.instructions])).not.toMatch(/chromewebdata|outside the approved|leads to/);
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
    // The proposal is never acted on: it becomes a scroll and the label joins the avoid list.
    expect((await h.parts(runId)).tools.some((name) => name.startsWith("click:"))).toBe(false);
    expect(h.instructions[1]).toContain(`"doNotClick":[${JSON.stringify(target.toLowerCase())}]`);
    expect((await h.parts(runId)).texts).toContain("Skipped an action that is not read-only.");
  });

  it("never acts on a numeric or id-like click target and produces no tool message for it", async () => {
    const h = harness({ steps: [
      { observation: "A footer link.", done: false, nextAction: { kind: "click", target: "260" } },
      { observation: "A pricing link.", done: false, nextAction: { kind: "click", target: "Pricing" } },
      { observation: "A long target.", done: false, nextAction: { kind: "click", target: "x".repeat(121) } },
      { observation: "A URL target.", done: false, nextAction: { kind: "click", target: "https://approved.example/docs" } },
    ] });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const done = await h.settle(runId);
    expect(done.status).toBe("COMPLETED");
    expect(h.stagehand.act).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("\"Pricing\""), expect.anything());
    const messages = await h.parts(runId);
    // One unusable proposal becomes a scroll; a usable one in between resets the count; two in a row end browsing.
    expect(messages.tools).toEqual(["session-started", "goto:home", "scroll-down", "click:pricing", "scroll-down", "report"]);
    for (const name of messages.tools) expect(name).toMatch(TOOL);
    expect(managedResultSchema.parse(done.result).limitations).toEqual(expect.arrayContaining([
      "A proposed click target was not the visible text of a link, so it was not used.",
      "Browsing ended early after two unusable click proposals in a row.",
    ]));
    expect(h.instructions[0]).toContain("never an element id, index, URL or number");
    // The model is told why its click did not happen.
    expect(h.instructions[1]).toContain("The proposed click \\\"260\\\" was not used because it was not the visible text of a link");
  });

  it("ends exploration after two wasted proposals in a row and still completes with a report", async () => {
    const h = harness({ steps: [
      { observation: "First.", done: false, nextAction: { kind: "click", target: "260" } },
      { observation: "Second.", done: false, nextAction: { kind: "click", target: "267" } },
      { observation: "Never read.", done: false, nextAction: { kind: "click", target: "Pricing" } },
    ] });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const done = await h.settle(runId);
    expect(done.status).toBe("COMPLETED");
    expect(managedResultSchema.parse(done.result).summary).toBe("Pricing was easy to find.");
    expect(h.stagehand.act).not.toHaveBeenCalled();
    expect(h.extract).toHaveBeenCalledTimes(3);
    const messages = await h.parts(runId);
    expect(messages.tools).toEqual(["session-started", "goto:home", "scroll-down", "report"]);
    expect(messages.texts).not.toContain("Never read.");
  });

  it("presses Tab exactly three times, records where focus landed and never acts or presses another key", async () => {
    const h = harness({
      keys: true,
      evaluate: (expression) => expression.includes("activeElement")
        ? { tag: "a", role: "", text: "Domain Names", outlineStyle: "solid", outlineWidth: "2px", boxShadowSet: false } : null,
      steps: [{ observation: "Checking keyboard focus.", done: false, nextAction: { kind: "tab", target: "" } }],
    });
    const task = taskText({ criteria: ["Keyboard focus is visible", "Find a contact route"] });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task, resultSchema: {} });
    expect((await h.settle(runId)).status).toBe("COMPLETED");
    expect(h.keyPress.mock.calls).toEqual([["Tab"], ["Tab"], ["Tab"]]);
    expect(h.stagehand.act).not.toHaveBeenCalled();
    const fact = "After 3 Tab presses on / since it opened or was last clicked, focus is on <a> \"Domain Names\"; focus indicator: outline 2px solid.";
    const messages = await h.parts(runId);
    expect(messages.tools.slice(0, 3)).toEqual(["session-started", "goto:home", "tab-x3"]);
    for (const name of messages.tools) expect(name).toMatch(TOOL);
    expect(messages.texts).toContain(fact);
    expect(h.instructions[0]).toContain("can only be judged from the tab action");
    expect(h.instructions[0]).not.toContain("rarely useful");
    expect(h.instructions[1]).toContain(JSON.stringify(fact).slice(1, -1));
    expect(h.reportInstruction()).toContain(JSON.stringify(fact).slice(1, -1));
  });

  it("reports a missing focus indicator only as not detected, and an unreadable focus as unread", async () => {
    const bare = harness({
      keys: true,
      evaluate: () => ({ tag: "button", role: "", text: "", outlineStyle: "none", outlineWidth: "0px", boxShadowSet: false }),
      steps: [{ observation: "Checking focus.", done: false, nextAction: { kind: "tab", target: "" } }],
    });
    const first = await bare.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    await bare.settle(first.runId);
    expect((await bare.parts(first.runId)).texts).toContain(
      "After 3 Tab presses on / since it opened or was last clicked, focus is on <button> with no text or label read by the harness; "
      + "focus indicator: no outline or box-shadow detected (other styles not checked, so an indicator may still exist).");
    // Criteria that do not mention keyboard or focus are told Tab is rarely useful.
    expect(bare.instructions[0]).toContain("rarely useful");

    const blind = harness({ keys: true, steps: [{ observation: "Checking focus.", done: false, nextAction: { kind: "tab", target: "" } }] });
    const second = await blind.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    await blind.settle(second.runId);
    const texts = (await blind.parts(second.runId)).texts;
    expect(texts).toContain("Made 3 Tab presses on / since it opened or was last clicked; the focused element could not be read.");
    expect(texts.join(" ")).not.toMatch(/focus is on|focus indicator/);
  });

  it("counts Tab presses per page: a second tab step adds up, and a click to a new page starts the count again", async () => {
    const tab: Step = { observation: "Checking focus.", done: false, nextAction: { kind: "tab", target: "" } };
    const h = harness({
      keys: true,
      evaluate: (expression) => expression.includes("activeElement")
        ? { tag: "a", role: "", text: "Domains", outlineStyle: "solid", outlineWidth: "2px", boxShadowSet: false } : null,
      steps: [tab, { ...tab, observation: "Tabbing further." },
        { observation: "A pricing link.", done: false, nextAction: { kind: "click", target: "Pricing" } },
        { ...tab, observation: "Checking focus on pricing." }],
    });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    expect((await h.settle(runId)).status).toBe("COMPLETED");
    expect(h.keyPress).toHaveBeenCalledTimes(9);
    const texts = (await h.parts(runId)).texts.filter((text) => text?.includes("Tab presses"));
    expect(texts.map((text) => text?.slice(0, text.indexOf(" since")))).toEqual([
      "After 3 Tab presses on /", "After 6 Tab presses on /", "After 3 Tab presses on /pricing",
    ]);
    // The run-wide total is never presented as a count for a page.
    expect(h.reportInstruction()).not.toMatch(/9 Tab presses/);
  });

  it("degrades a tab action to a scroll when the page cannot press keys", async () => {
    const h = harness({ steps: [{ observation: "Checking focus.", done: false, nextAction: { kind: "tab", target: "" } }] });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    expect((await h.settle(runId)).status).toBe("COMPLETED");
    const messages = await h.parts(runId);
    expect(messages.tools).not.toContain("tab-x3");
    expect(messages.tools.slice(0, 3)).toEqual(["session-started", "goto:home", "scroll-down"]);
    expect(h.keyPress).not.toHaveBeenCalled();
    expect(h.stagehand.act).not.toHaveBeenCalled();
    expect(JSON.stringify([messages.data, h.instructions])).not.toMatch(/Tab presses|Pressed Tab/);
  });

  it("passes measured navigation timings to the report as engine facts without showing them on the wall", async () => {
    const h = harness({ evaluate: (expression) => expression.includes("getEntriesByType") ? { dcl: 412, load: 0 } : null });
    h.page.goto.mockImplementationOnce(async () => { h.advance(1_240); });
    h.page.url.mockResolvedValueOnce("https://approved.example/");
    h.stagehand.act.mockImplementationOnce(async () => {
      h.advance(6_200);
      h.page.url.mockResolvedValue("https://approved.example/pricing?plan=1");
      return { data: { success: true } };
    });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    expect((await h.settle(runId)).status).toBe("COMPLETED");
    const report = h.reportInstruction();
    expect(report).toContain("Measured: / opened in 1.2 s wall-clock (harness navigation until the DOM was ready; page timing: DOMContentLoaded 412 ms).");
    // A click's duration is mostly the harness's own model call, so only the page's own timing is reported for it.
    expect(report).toContain("Measured: /pricing loaded after a click; page timing: DOMContentLoaded 412 ms (browser Navigation Timing).");
    expect(report).not.toMatch(/6\.2 s|the click to|locating the link/);
    // A load event that had not fired yet is left out rather than reported as 0 ms.
    expect(report).not.toMatch(/load \d/);
    expect(report).toContain("the only numbers you may cite");
    expect(h.instructions[0]).toContain("the only numbers you may cite");
    expect(report).toContain("\"visited\":[\"/\",\"/pricing\"]");
    expect((await h.parts(runId)).texts.join(" ")).not.toContain("Measured");
  });

  it("invents no page timing when the page cannot be evaluated or did not navigate", async () => {
    const h = harness({ afterAct: ["https://approved.example/#pricing"] });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    expect((await h.settle(runId)).status).toBe("COMPLETED");
    const report = h.reportInstruction();
    expect(report).toContain("Measured: / opened in 0.0 s wall-clock (harness navigation until the DOM was ready).");
    expect(report).not.toMatch(/DOMContentLoaded|page timing|the click to/);
    expect(h.evaluate).not.toHaveBeenCalled();
  });

  it("reports a clicked page without a readable page timing as unmeasured, never with the click's duration", async () => {
    const h = harness();
    h.stagehand.act.mockImplementationOnce(async () => {
      h.advance(6_200);
      h.page.url.mockResolvedValue("https://approved.example/pricing?plan=1");
      return { data: { success: true } };
    });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    expect((await h.settle(runId)).status).toBe("COMPLETED");
    const report = h.reportInstruction();
    expect(report).toContain("Load time for /pricing after a click is unmeasured: the harness could not read a page timing for it.");
    expect(report).not.toMatch(/6\.2 s|Measured: \/pricing/);
  });

  it("adds the timing limitation only when the report cites a duration", async () => {
    const h = harness({ report: { ...goodReport, summary: "The pricing page opened in 1.2 s." } });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    expect(managedResultSchema.parse((await h.settle(runId)).result).limitations).toEqual([
      "Timings were measured by the harness from an unthrottled cloud browser, not a real user's device or network.",
      "Only two pages were read.", SCOPE_NOTE, REPORT_NOTE,
    ]);
  });

  it("shows identical consecutive observations once and honours an early done only after three actions", async () => {
    const same = (observation: string): Step => ({ observation, done: true, nextAction: { kind: "none", target: "" } });
    const h = harness({ steps: [same("The home page is plain."), same("the  HOME page is plain."), same("The home page is plain."),
      same("Nothing else to see.")] });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    expect((await h.settle(runId)).status).toBe("COMPLETED");
    const messages = await h.parts(runId);
    expect(messages.texts).toEqual(["The home page is plain.", "Nothing else to see."]);
    // done was true from the first step, yet three scrolls happened before it was honoured on the fourth.
    expect(messages.tools).toEqual(["session-started", "goto:home", "scroll-down", "scroll-down", "scroll-down", "report"]);
    expect(h.extract).toHaveBeenCalledTimes(5);
    expect(h.instructions[2]).toContain("Repeated the previous observation.");
    expect(messages.data.length).toBeLessThanOrEqual(60);
  });

  it("takes six steps by default", async () => {
    const h = harness({ steps: Array.from({ length: 9 }, (_, index) => ({
      observation: `View ${index}`, done: false, nextAction: { kind: "scroll" as const, target: "" },
    })) });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    await h.settle(runId);
    expect((await h.parts(runId)).tools.filter((name) => name === "scroll-down")).toHaveLength(6);
    expect(h.extract).toHaveBeenCalledTimes(7);
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
    expect(messages.tools).toEqual(["session-started", "goto:home", "scroll-down", "scroll-down", "scroll-down", "report"]);
    // A first failure is not ruled out, but the model is told about it.
    expect(h.instructions[1]).toContain("\"doNotClick\":[]");
    expect(h.instructions[1]).toContain("Then the click on \\\"Pricing\\\" did not complete.");
    expect(h.deps.log).toHaveBeenCalledExactlyOnceWith("managed_session_engine_error:explore:Error:0");
    expect(JSON.stringify([messages.data, done, h.deps.log.mock.calls])).not.toContain(SECRET);
  });

  it("rules a label out only after its click failed twice, so one transient failure can be retried", async () => {
    const click: Step = { observation: "I want pricing.", done: false, nextAction: { kind: "click", target: "Pricing" } };
    const scroll: Step = { observation: "Looking further down.", done: false, nextAction: { kind: "scroll", target: "" } };
    const h = harness({ steps: [click, { ...click, observation: "Trying pricing again." }] });
    h.stagehand.act.mockRejectedValueOnce(new Error("transient"));
    const first = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    await h.settle(first.runId);
    expect(h.stagehand.act).toHaveBeenCalledTimes(2);
    expect((await h.parts(first.runId)).tools).toContain("click:pricing");

    const twice = harness({ steps: [click, scroll, { ...click, observation: "Trying pricing again." }, scroll] });
    twice.stagehand.act.mockRejectedValue(new Error("act failed"));
    const second = await twice.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    expect((await twice.settle(second.runId)).status).toBe("COMPLETED");
    expect(twice.instructions[2]).toContain("\"doNotClick\":[]");
    expect(twice.instructions[3]).toContain("\"doNotClick\":[\"pricing\"]");
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
    const finding = "The \"Pricing\" link opens a new tab on elsewhere.example, outside the approved site, so it was not explored.";
    expect((await h.parts(runId)).texts).toContain(finding);
    const result = managedResultSchema.parse(done.result);
    expect(result.finalUrl).toBe("https://approved.example/");
    expect(result.summary).toBe("Pricing was easy to find.");
    expect(result.limitations).toEqual(expect.arrayContaining([
      "A link opened a new tab; it was closed and browsing continued in the original tab.", finding,
    ]));
  });

  it("follows an in-scope new tab in the original tab", async () => {
    const h = harness({ newTab: "https://approved.example/docs" });
    const { runId } = await h.provider.createRun({ agentId: AGENT, task: taskText(), resultSchema: {} });
    const result = managedResultSchema.parse((await h.settle(runId)).result);
    expect(h.opened.close).toHaveBeenCalledOnce();
    expect(h.page.goto).toHaveBeenLastCalledWith("https://approved.example/docs", expect.anything());
    expect(result.finalUrl).toBe("https://approved.example/docs");
    expect((await h.parts(runId)).texts.join(" ")).not.toContain("outside the approved");
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
      .toEqual(["session-started", "goto:home", "click:pricing", "scroll-down", "scroll-down", "report"]);
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
