import { expect, test, type Page } from "@playwright/test";
import type { Attempt, Run, RunEvent } from "../../src/lib/contracts";
import type { AttemptSummary } from "../../src/lib/ui-contracts";

// These HTTP/stream adapters exist only in Playwright. Production always uses owner APIs and EventSource.
const runId = "11111111-1111-4111-8111-111111111111";
const timestamp = "2026-09-19T09:00:00.000Z";
const csrfToken = "test-only-csrf";
const run: Run = {
  id: runId, cursor: 1, status: "running", authorizationAcknowledged: true, executionMode: "controlled-fixture",
  scope: { targetUrl: "https://project-board.demo.flash-flood.test/project-board", allowedSubdomains: [], pathPrefixes: ["/project-board"] },
  createdAt: timestamp, updatedAt: timestamp, cancelRequestedAt: null,
};
const attempt = (index: number): Attempt => ({
  id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`, runId, status: "running",
  createdAt: timestamp, updatedAt: timestamp, goal: `Read project ${index + 1}`,
  persona: { id: `reader-${index + 1}`, name: `Reader ${index + 1}`, character: "A careful reader", device: index % 2 ? "phone" : "desktop",
    techComfort: "low", patienceSteps: 8, readingStyle: "careful", quirks: ["Reads"], worries: ["Losing work"] },
  criteria: ["The project is listed"], limits: { maxSteps: 9, maxModelCalls: 12, maxDurationMs: 60_000 },
});
const event = (sequence: number, kind: RunEvent["kind"], data: RunEvent["data"] = {}): RunEvent => ({
  runId, sequence, kind, data, timestamp, attemptId: kind.startsWith("run.") ? null : attempt(0).id,
});
const summary = (item: Attempt, launchState: AttemptSummary["launchState"] = "active"): AttemptSummary => ({
  attemptId: item.id, status: item.status, launchState, summary: null, usage: null,
  reservedSeconds: 60, consumedSeconds: 0, releasedSeconds: 0,
});

async function manualStream(page: Page) {
  await page.addInitScript(() => {
    class TestEventSource extends EventTarget {
      static instances: TestEventSource[] = [];
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      constructor(public url: string) {
        super();
        TestEventSource.instances.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }
      close() { this.closed = true; }
    }
    Object.assign(window, { EventSource: TestEventSource, __wallStreams: TestEventSource.instances });
  });
}
async function emit(page: Page, value: RunEvent) {
  await page.evaluate((entry) => {
    const streams = (window as unknown as { __wallStreams: EventTarget[] }).__wallStreams;
    streams.at(-1)!.dispatchEvent(new MessageEvent(entry.kind, { data: JSON.stringify(entry), lastEventId: String(entry.sequence) }));
  }, value);
}
async function fixture(page: Page, { count = 1, available = true, locked = false, native = false } = {}) {
  if (!native) await manualStream(page);
  const state = {
    run: { ...run }, attempts: Array.from({ length: count }, (_, index) => attempt(index)),
    history: [event(1, "run.created")], summaries: [] as AttemptSummary[],
    locked, expired: false, cancelled: false, streams: [] as string[],
    streamBody: "", summaryReads: 0, cancelBody: "", cancelCsrf: "",
  };
  state.summaries = state.attempts.map((item) => summary(item));
  await page.route("https://www.browserbase.com/**", (route) => route.fulfill({
    contentType: "text/html", body: "<!doctype html><html><body>Test-only private browser frame</body></html>",
  }));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const suffix = url.pathname.replace("/api/v1", "");
    const data = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: body }) });
    const error = (status: number) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code: "unauthorized", message: "Unauthorized" } }) });
    if (suffix === "/session") {
      const body = request.postDataJSON();
      if (state.expired || (state.locked && body.accessCode !== "test-access")) return error(401);
      state.locked = false;
      return data({ ownerId: "test-owner", csrfToken, expiresAt: Date.now() + 60_000 });
    }
    if (state.locked || state.expired) return error(401);
    if (suffix === `/runs/${runId}`) return data(state.run);
    if (suffix.endsWith("/attempts")) return data({ items: state.attempts });
    if (suffix.endsWith("/summaries")) { state.summaryReads++; return data({ items: state.summaries }); }
    if (suffix.endsWith("/sessions")) return data({ items: state.attempts.map((item) => ({
      attemptId: item.id, available: available && !state.cancelled,
      liveViewUrl: available && !state.cancelled ? `https://www.browserbase.com/live/test-${item.id}` : null,
    })) });
    if (suffix.endsWith("/events")) return data({
      items: state.history.filter((entry) => entry.sequence > Number(url.searchParams.get("after"))), nextCursor: null,
    });
    if (suffix.endsWith("/events/stream")) {
      state.streams.push(url.search);
      return route.fulfill({ contentType: "text/event-stream", body: state.streamBody });
    }
    if (suffix.endsWith("/cancel")) {
      state.cancelled = true;
      state.cancelBody = request.postData() ?? "";
      state.cancelCsrf = request.headers()["x-csrf-token"];
      state.run.cancelRequestedAt = timestamp;
      return data(state.run);
    }
    if (suffix.startsWith("/evidence/")) return data({
      id: suffix.split("/").at(-1), runId, attemptId: attempt(0).id, kind: "observation", createdAt: timestamp,
      summary: "Page: /project-board/projects. <script>never execute this</script>",
    });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found" } }) });
  });
  return state;
}

test("owner gate precedes private reads; viewers are explicit, real and capped at three", async ({ page }) => {
  const state = await fixture(page, { count: 4, locked: true });
  await page.goto(`/runs/${runId}`);
  await expect(page.getByLabel("Workspace access code")).toBeVisible();
  expect(state.summaryReads).toBe(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.getByLabel("Workspace access code").fill("test-access");
  await page.getByRole("button", { name: "Unlock workspace" }).click();
  await expect(page.getByRole("heading", { name: "Reader 1", exact: true })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  for (const index of [1, 2, 3]) await page.getByRole("button", { name: `Show viewer for Reader ${index}`, exact: true }).click();
  await expect(page.locator("iframe")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Show viewer for Reader 4", exact: true })).toBeDisabled();
  await expect(page.frameLocator('iframe[title="Live browser for Reader 1"]').getByText("Test-only private browser frame")).toBeVisible();
  await page.getByRole("button", { name: "Hide viewer", exact: true }).first().click();
  await page.getByRole("button", { name: "Show viewer for Reader 4", exact: true }).click();
  await expect(page.locator("iframe")).toHaveCount(3);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("browserbase");
});

test("no-session placeholder is honest and the wall fits a phone without motion", async ({ page }) => {
  await fixture(page, { available: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/runs/${runId}`);
  await expect(page.getByText("No live browser available yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show viewer for Reader 1" })).toBeDisabled();
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Refresh persisted data" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Steps recorded")).toBeVisible();
});

test("cancel hides frames immediately but does not claim remote closure", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/runs/${runId}`);
  await page.getByRole("button", { name: "Show viewer for Reader 1" }).click();
  await expect(page.locator("iframe")).toHaveCount(1);
  await page.getByRole("button", { name: "Cancel run", exact: true }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByText(/This is intent to stop, not confirmation/)).toBeVisible();
  await expect.poll(() => state.cancelBody).toBe("{}");
  expect(state.cancelCsrf).toBe(csrfToken);
  await expect(page.getByRole("button", { name: "Cancel run", exact: true })).toBeDisabled();
  expect(state.run.status).toBe("running");
});

test("stream duplicates and gaps reconcile persisted history; recovery hides its viewer", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/runs/${runId}`);
  await page.getByRole("button", { name: "Show viewer for Reader 1" }).click();
  const observation = event(2, "attempt.observation", { step: 1, pageUrl: "https://example.com/projects", commentary: "<img src=x onerror=alert(1)>", evidenceId: "33333333-3333-4333-8333-333333333333" });
  const recovering = event(3, "attempt.recovering", { reason: "worker_recovery" });
  state.history.push(observation, recovering);
  await emit(page, recovering);
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.locator('[data-event-sequence="2"]')).toHaveCount(1);
  await emit(page, observation);
  await expect(page.locator('[data-event-sequence="2"]')).toHaveCount(1);
  await expect(page.locator('[data-event-sequence="2"]')).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator('[data-event-sequence="2"] img')).toHaveCount(0);
  await page.getByRole("button", { name: "Evidence 33333333" }).click();
  await expect(page.getByRole("region", { name: "Private evidence metadata" })).toContainText("<script>never execute this</script>");
});

test("native SSE reconnect uses the retained cursor and closes on terminal", async ({ page }) => {
  const state = await fixture(page, { native: true, available: false });
  const action = event(2, "attempt.action", { step: 1, action: "click" });
  state.streamBody = `id: 2\nevent: attempt.action\ndata: ${JSON.stringify(action)}\n\n`;
  await page.goto(`/runs/${runId}`);
  await expect(page.locator('[data-event-sequence="2"]')).toHaveCount(1);
  await expect.poll(() => state.streams.length).toBeGreaterThanOrEqual(2);
  expect(state.streams[1]).toBe("?after=2");
  const finish = event(3, "run.finished", { status: "succeeded" });
  state.history.push(action, finish);
  state.run.status = "succeeded";
  state.summaries = [summary({ ...attempt(0), status: "succeeded" }, "settled")];
  state.streamBody = `id: 3\nevent: run.finished\ndata: ${JSON.stringify(finish)}\n\n`;
  await expect(page.getByText("Run finished · live stream closed")).toBeVisible();
  expect(state.streams[0]).toBe("?after=1");
  await expect(page.locator('[data-event-sequence="2"]')).toHaveCount(1);
  const connections = state.streams.length;
  await page.waitForTimeout(1200);
  expect(state.streams).toHaveLength(connections);
});

test("terminal during initial history stays terminal and quarantine keeps refreshing until settled", async ({ page }) => {
  const state = await fixture(page);
  state.history.push(event(2, "run.finished", { status: "infrastructure_failed" }));
  state.summaries = [summary(attempt(0), "quarantined")];
  await page.goto(`/runs/${runId}`);
  await expect(page.getByText("Run finished · live stream closed")).toBeVisible();
  await expect(page.getByText(/recovery \/ remote cleanup is unresolved/)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __wallStreams: unknown[] }).__wallStreams.length)).toBe(0);
  const readsBeforeSettlement = state.summaryReads;
  state.summaries = [summary(attempt(0), "settled")];
  await expect.poll(() => state.summaryReads, { timeout: 7000 }).toBeGreaterThan(readsBeforeSettlement);
  await expect(page.getByText(/recovery \/ remote cleanup is unresolved/)).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("all five criterion states and semantic heuristic labels are shown without fake downloads", async ({ page }) => {
  const state = await fixture(page, { available: false });
  const states = ["met", "not_met", "not_observed", "inconclusive", "unsupported"] as const;
  state.attempts[0].criteria = states.map((status) => `Criterion ${status}`);
  state.attempts[0].status = "target_failed";
  state.run.status = "target_failed";
  state.summaries = [{
    ...summary(state.attempts[0], "settled"),
    summary: { steps: 3, modelCalls: 4, durationMs: 10_000, cleanup: { status: "closed" },
      checks: states.map((status) => ({
        criterion: `Criterion ${status}`, status, passed: status === "met", evidence: "Observed safely",
        method: "semantic", confidence: 0.8, confidenceMeaning: "heuristic",
      })) },
  }];
  await page.goto(`/runs/${runId}`);
  for (const status of states) await expect(page.locator(`.wall-check-${status}`)).toHaveText(status.replaceAll("_", " "));
  await expect(page.getByText(/Heuristic confidence 80%/)).toHaveCount(5);
  await expect(page.locator("a[download], a[href*='/reports/']")).toHaveCount(0);
});

test("owner expiry removes all private frames and offers bootstrap recovery", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/runs/${runId}`);
  await page.getByRole("button", { name: "Show viewer for Reader 1" }).click();
  state.expired = true;
  await page.getByRole("button", { name: "Refresh persisted data" }).click();
  await expect(page.getByLabel("Workspace access code")).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("same-owner retry resumes the wall controller after an authorization failure", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/runs/${runId}`);
  await page.getByRole("button", { name: "Show viewer for Reader 1" }).click();
  state.expired = true;
  await page.getByRole("button", { name: "Refresh persisted data" }).click();
  await expect(page.getByRole("button", { name: "Retry existing session" })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __wallStreams: { closed: boolean }[] }).__wallStreams[0].closed)).toBe(true);

  const reads = state.summaryReads;
  state.expired = false;
  state.history.push(event(2, "attempt.action", { action: "scroll", step: 1 }));
  await page.getByRole("button", { name: "Retry existing session" }).click();
  await expect(page.getByRole("heading", { name: "Reader 1", exact: true })).toBeVisible();
  await expect(page.locator('[data-event-sequence="2"]')).toContainText("scroll");
  await expect.poll(() => state.summaryReads).toBeGreaterThan(reads);
  expect(await page.evaluate(() => (window as unknown as { __wallStreams: { url: string }[] }).__wallStreams.at(-1)?.url)).toContain("after=2");
  await emit(page, event(3, "attempt.action", { action: "click", step: 2 }));
  await expect(page.locator('[data-event-sequence="3"]')).toContainText("click");
  await expect(page.getByText("Live event connection")).toBeVisible();
});
