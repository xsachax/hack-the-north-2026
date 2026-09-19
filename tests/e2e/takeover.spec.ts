import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { executePersona } from "../../src/server/execution/loop";
import type { Observation } from "../../src/server/execution/types";
import { WorkerRepository } from "../../src/server/worker/repository";
import { demoCriteria } from "../../src/lib/demo-run";
import { personas } from "../../src/lib/personas";

function fixture() {
  const directory = join(process.cwd(), `.takeover-browser-${randomUUID()}`);
  mkdirSync(directory);
  const repository = new WorkerRepository(directory);
  const owner = repository.createSession().ownerId;
  const run = repository.createDemoRun(owner, randomUUID(), {
    authorizationAcknowledged: true, scenario: "fixed",
    assignments: [{ personaId: personas[0].id, goal: "Read the completed task", criteria: [demoCriteria[0]] }],
  }).run;
  const claim = repository.claim("local-browser-worker")!;
  repository.sessionReference(claim, {
    sessionId: randomUUID(), liveViewUrl: "https://www.browserbase.com/live/local-proof",
    replayUrl: "https://www.browserbase.com/sessions/local-proof", timeoutSeconds: 240,
  });
  return {
    repository, owner, run, claim, service: repository.takeovers,
    close() { repository.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("real local browser: in-flight decision drains, human edits exclusively, agent resumes fresh", async ({ page }) => {
  const f = fixture();
  const controllerId = randomUUID();
  const control = f.service.executionControl(f.claim, (cancelled) => f.repository.assertLease(f.claim, cancelled));
  const calls: string[] = [];
  let finalValue = "";
  let release!: () => void;
  let deciding = false;
  const decision = new Promise<void>((resolve) => { release = resolve; });
  await page.route("http://takeover.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><label>Task<input aria-label="Task" value="Pending"></label><button onclick="document.querySelector(\'input\').value=\'Agent changed\'">Agent action</button>',
  }));
  await page.goto("http://takeover.test/task");
  const abort = new AbortController();
  const running = executePersona({
    persona: personas[0], goal: "Observe completed task",
    criteria: [{ id: "done", kind: "semantic", description: "Task is complete", semantics: "current" }],
    signal: abort.signal, limits: { carefulDelayMs: 0, maxDurationMs: 10_000 },
  }, {
    control,
    driver: {
      observe: async () => {
        control.assertDispatch();
        calls.push("observe");
        const value = await page.getByLabel("Task", { exact: true }).inputValue();
        return {
          id: randomUUID(), url: page.url(), title: "Task", text: value,
          candidates: [{ id: "agent", kind: "button", label: "Agent action" }], checks: [], signals: [],
        } satisfies Observation;
      },
      act: async () => { control.assertDispatch(); calls.push("act"); await page.getByRole("button").click(); },
      close: async () => {
        finalValue = await page.getByLabel("Task", { exact: true }).inputValue();
        await page.close();
        return { status: "closed", errors: [] };
      },
    },
    brain: {
      evaluate: async (input) => {
        control.assertDispatch();
        calls.push("evaluate");
        return [{
          criterion: "done", passed: input.observation.text === "Human complete",
          status: input.observation.text === "Human complete" ? "met" : "not_met", method: "semantic",
          evidence: "", confidence: 1, uncertainty: "",
          citations: [{ observationId: input.observation.id, pageUrl: input.observation.url, step: input.step, excerpt: input.observation.text }],
        }];
      },
      decide: async () => {
        control.assertDispatch();
        calls.push("decide");
        deciding = true;
        await decision;
        return { action: "click", candidateId: "agent", value: null, commentary: "" };
      },
    },
  });
  try {
    await expect.poll(() => deciding).toBe(true);
    f.service.command(f.owner, f.claim.attempt.id, randomUUID(), { action: "request", expectedVersion: 0, controllerId });
    await page.waitForTimeout(100);
    expect(f.service.status(f.owner, f.claim.attempt.id, controllerId).interactiveUrl).toBeNull();
    release();
    await expect.poll(() => control.read().phase).toBe("human");
    const paused = [...calls];
    await page.getByLabel("Task", { exact: true }).fill("Human complete");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(200);
    expect(calls).toEqual(paused);
    const state = f.service.status(f.owner, f.claim.attempt.id, controllerId);
    f.service.command(f.owner, f.claim.attempt.id, randomUUID(), { action: "handback", expectedVersion: state.version, controllerId });
    expect(await running).toMatchObject({ status: "succeeded", modelCalls: 3, steps: 0 });
    expect(calls).toEqual(["observe", "evaluate", "decide", "observe", "evaluate"]);
    expect(finalValue).toBe("Human complete");
    expect(page.isClosed()).toBe(true);
    expect(f.service.intervals(f.owner, f.claim.attempt.id)).toHaveLength(1);
  } finally { release(); abort.abort(); await running; f.close(); }
});

test("managed wall blocks pointer and keyboard until acknowledged, then revokes on handback", async ({ page }, info) => {
  const f = fixture();
  let csrfSeen = false;
  await page.addInitScript(() => {
    class QuietStream extends EventTarget { close() {} }
    Object.assign(window, { EventSource: QuietStream });
  });
  await page.route("https://www.browserbase.com/**", (route) => route.fulfill({
    contentType: "text/html", body: '<!doctype html><input aria-label="Synthetic human input"><button>Fixture action</button>',
  }));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const data = (value: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: value }) });
    if (url.pathname.endsWith("/session")) return data({ ownerId: f.owner, csrfToken: "local-csrf", expiresAt: Date.now() + 60_000 });
    if (url.pathname.endsWith("/takeover")) {
      if (request.method() === "POST") {
        csrfSeen = request.headers()["x-csrf-token"] === "local-csrf";
        return data(f.service.command(f.owner, f.claim.attempt.id, request.headers()["idempotency-key"], request.postDataJSON()));
      }
      return data(f.service.status(f.owner, f.claim.attempt.id, url.searchParams.get("controllerId") ?? undefined));
    }
    if (url.pathname.endsWith(`/runs/${f.run.id}`)) return data(f.repository.getRun(f.owner, f.run.id));
    if (url.pathname.endsWith("/attempts")) return data({ items: f.repository.attempts(f.owner, f.run.id) });
    if (url.pathname.endsWith("/summaries")) return data({ items: f.repository.attemptSummaries(f.owner, f.run.id) });
    if (url.pathname.endsWith("/sessions")) return data({ items: f.repository.sessionViews(f.owner, f.run.id) });
    if (url.pathname.endsWith("/events")) return data(f.repository.events(f.owner, f.run.id, { after: 0, limit: 100 }));
    return route.fulfill({ status: 404 });
  });
  try {
    await page.goto(`/runs/${f.run.id}`);
    await page.getByRole("button", { name: `Show viewer for ${f.claim.attempt.persona.name}`, exact: true }).click();
    const frame = page.locator("iframe");
    await expect(frame).toHaveAttribute("tabindex", "-1");
    await expect(frame).toHaveCSS("pointer-events", "none");
    await expect(page.locator(".wall-viewer-readonly")).toHaveAttribute("inert", "");
    const box = await frame.boundingBox();
    await page.mouse.click(box!.x + 20, box!.y + 20);
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("IFRAME");
    await page.getByRole("button", { name: "Request human control", exact: true }).focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("IFRAME");
    await page.getByRole("button", { name: "Request human control", exact: true }).click();
    expect(csrfSeen).toBe(true);
    await expect(page.getByText("Takeover pending · draining agent work", { exact: true })).toBeVisible();
    await expect(frame).toHaveAttribute("tabindex", "-1");
    const execution = f.service.executionControl(f.claim, (cancelled) => f.repository.assertLease(f.claim, cancelled));
    execution.quiesce();
    execution.acknowledge();
    await expect(page.getByText("Human control acknowledged · agent paused", { exact: true })).toBeVisible();
    await expect(frame).toHaveAttribute("tabindex", "0");
    await page.screenshot({ path: info.outputPath("takeover-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: info.outputPath("takeover-mobile.png"), fullPage: true });
    await page.frameLocator("iframe").getByLabel("Synthetic human input").fill("Synthetic only");
    await page.getByRole("button", { name: "Hand back to agent", exact: true }).click();
    await expect(frame).toHaveAttribute("tabindex", "-1");
    await expect(frame).toHaveCSS("pointer-events", "none");
    expect(f.service.status(f.owner, f.claim.attempt.id).phase).toBe("handback");
    expect(JSON.stringify(f.service.intervals(f.owner, f.claim.attempt.id))).not.toContain("Synthetic only");
  } finally { await page.unrouteAll({ behavior: "wait" }); await page.close(); f.close(); }
});
