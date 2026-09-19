import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test, expect, type Page, type Route } from "@playwright/test";
import { createApi } from "../../src/server/api";
import { Repository } from "../../src/server/repository";

const accessCode = "offline-only-access-code-not-a-production-secret";
const origin = "http://127.0.0.1:4317";

async function offlineApi(page: Page, directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const repository = new Repository(directory);
  const handle = createApi({
    repository, configuration: { origin, production: false, accessCode, allowDemoRuns: true },
    validateScope: async (scope) => scope,
  });
  let loseReply = false;
  let rejectLaunch = 0;
  let submissions = 0;
  let latestOwner = "";
  const route = async (route: Route) => {
    const input = route.request();
    const url = new URL(input.url());
    if (url.pathname.endsWith("/events/stream")) {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": offline transport reconnect\n\n" });
      return;
    }
    const launch = url.pathname.endsWith("/controlled-runs") && input.method() === "POST";
    if (launch) submissions++;
    if (launch && rejectLaunch) {
      const status = rejectLaunch;
      rejectLaunch = 0;
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code: status === 429 ? "rate_limited" : "invalid_request" } }) });
      return;
    }
    const response = await handle(new Request(input.url(), {
      method: input.method(), headers: await input.allHeaders(),
      ...(input.postData() ? { body: input.postData() } : {}),
    }));
    const body = await response.text();
    if (url.pathname.endsWith("/session") && response.ok) latestOwner = JSON.parse(body).data.ownerId;
    if (launch && loseReply) {
      loseReply = false;
      await route.abort("connectionreset");
    } else await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
  };
  await page.route("**/api/v1/**", route);
  return {
    repository, get owner() { return latestOwner; }, get submissions() { return submissions; },
    loseNextReply() { loseReply = true; }, rejectNextLaunch(status = 400) { rejectLaunch = status; },
    async close() {
      try { if (!page.isClosed()) await page.unroute("**/api/v1/**", route); }
      finally { repository.close(); }
    },
  };
}

async function unlock(page: Page) {
  await page.goto("/");
  await page.getByLabel("Workspace access code").fill(accessCode);
  await page.getByRole("button", { name: "Unlock workspace" }).click();
  await expect(page.getByLabel("Target mode")).toBeVisible();
  await expect(page.getByText("Alex", { exact: true })).toBeVisible();
}
async function configureDemo(page: Page) {
  await page.getByRole("button", { name: "Controlled demo", exact: true }).click();
  await page.getByLabel("I am authorized to test this scope").check();
}

test("bootstrap rejects bad codes and preserves no access code in storage; public mode is explicitly blocked", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"));
  try {
    await page.goto("/");
    await page.getByLabel("Workspace access code").fill("wrong");
    await page.getByRole("button", { name: "Unlock workspace" }).click();
    await expect(page.locator(".error[role=alert]")).toContainText("not accepted");
    await page.getByLabel("Workspace access code").fill(accessCode);
    await page.getByRole("button", { name: "Unlock workspace" }).click();
    await expect(page.getByText("Website execution is not enabled.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save website request (execution blocked)" })).toBeVisible();
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(accessCode);
    const owner = fixture.owner;
    await page.reload();
    await expect(page.getByLabel("Target mode")).toBeVisible();
    expect(fixture.owner).toBe(owner);
  } finally { await fixture.close(); }
});

test("custom persona create, edit, select, scoped launch and delete use real owner API snapshots", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"));
  try {
    await unlock(page);
    await page.getByRole("button", { name: "+ Create persona", exact: true }).click();
    const editor = page.getByRole("region", { name: "Meet someone new" });
    await editor.getByLabel("Name", { exact: true }).fill("Juniper");
    await editor.getByLabel("Character", { exact: true }).fill("An observant community gardener.");
    await editor.getByRole("button", { name: "Save persona" }).click();
    await page.getByText("Juniper: objective, limits & character", { exact: true }).click();
    await page.getByRole("button", { name: "Edit saved persona" }).click();
    await page.getByRole("region", { name: "Edit persona" }).getByRole("textbox", { name: "Character", exact: true }).fill("An observant gardener who verifies saved work.");
    await page.getByRole("button", { name: "Save persona" }).click();
    await expect(page.getByText("An observant gardener who verifies saved work.", { exact: true })).toBeVisible();
    await configureDemo(page);
    await page.getByRole("button", { name: "Launch 2 personas" }).click();
    await expect(page).toHaveURL(/\/runs\/[a-f0-9-]+$/);
    const runId = new URL(page.url()).pathname.split("/").at(-1)!;
    const attempts = fixture.repository.attempts(fixture.owner, runId);
    expect(attempts).toHaveLength(2);
    const custom = attempts.find((attempt) => attempt.persona.name === "Juniper")!;
    expect(custom.persona.character).toContain("verifies saved work");
    expect(custom.criteria).toEqual([expect.objectContaining({ kind: "visible_text", text: "Garden planning" })]);
    expect(custom.limits?.maxSteps).toBeGreaterThan(0);
    await page.goto("/");
    await expect(page.getByText("Juniper", { exact: true })).toBeVisible();
    await page.getByLabel("Juniper", { exact: false }).check();
    await page.getByText("Juniper: objective, limits & character", { exact: true }).click();
    await page.getByRole("button", { name: "Delete Juniper", exact: true }).click();
    await expect(page.getByText("Juniper", { exact: true })).toHaveCount(0);
    expect(fixture.repository.attempts(fixture.owner, runId).find((attempt) => attempt.id === custom.id)?.persona.name).toBe("Juniper");
  } finally { await fixture.close(); }
});

test("custom persona schema errors preserve the editable profile", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"));
  try {
    await unlock(page);
    await page.getByRole("button", { name: "+ Create persona", exact: true }).click();
    const editor = page.getByRole("region", { name: "Meet someone new" });
    await expect(editor.getByRole("textbox", { name: "Name", exact: true })).toBeFocused();
    await editor.getByRole("textbox", { name: "Name", exact: true }).fill("   ");
    await editor.getByRole("textbox", { name: "Character", exact: true }).fill("An observant gardener.");
    await editor.getByRole("button", { name: "Save persona" }).click();
    await expect(editor.getByRole("alert")).toContainText("name");
    await expect(editor.getByRole("textbox", { name: "Character", exact: true })).toHaveValue("An observant gardener.");
    expect(fixture.repository.listPersonas(fixture.owner)).toHaveLength(12);
    await editor.getByRole("textbox", { name: "Name", exact: true }).fill("Juniper");
    await editor.getByRole("button", { name: "Save persona" }).click();
    await expect(page.getByRole("checkbox", { name: /Juniper/ })).toBeChecked();
    expect(fixture.repository.listPersonas(fixture.owner)).toHaveLength(13);
  } finally { await fixture.close(); }
});

test("double click and lost reply across refresh replay one durable launch", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"));
  try {
    await unlock(page);
    await configureDemo(page);
    fixture.loseNextReply();
    await page.getByRole("button", { name: "Launch 1 persona", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(page.getByRole("button", { name: "Reconcile saved launch" })).toBeVisible();
    expect(fixture.submissions).toBe(1);
    expect(fixture.repository.listRuns(fixture.owner, { after: 0, limit: 100 }).items).toHaveLength(1);
    await page.reload();
    await expect(page.getByRole("button", { name: "Reconcile saved launch" })).toBeVisible();
    fixture.rejectNextLaunch(429);
    await page.getByRole("button", { name: "Reconcile saved launch" }).click();
    await expect(page.locator(".error[role=alert]")).toContainText("limit was reached");
    await expect(page.getByRole("button", { name: "Reconcile saved launch" })).toBeVisible();
    await page.getByRole("button", { name: "Reconcile saved launch" }).click();
    await expect(page).toHaveURL(/\/runs\/[a-f0-9-]+$/);
    expect(fixture.submissions).toBe(3);
    expect(fixture.repository.listRuns(fixture.owner, { after: 0, limit: 100 }).items).toHaveLength(1);
    expect(await page.evaluate(() => sessionStorage.getItem("flash-flood.pending-launch.v1"))).toBeNull();
  } finally { await fixture.close(); }
});

test("another owner's run is unavailable through the actual wall API", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"));
  try {
    await unlock(page);
    const other = fixture.repository.createSession();
    const run = fixture.repository.createControlledRun(other.ownerId, randomUUID(), {
      authorizationAcknowledged: true, controlledSiteId: "project-board",
      assignments: [{ personaId: "careful-first-timer", goal: "Find the projects list", criteria: ["The list is visible."] }],
    }).run;
    await page.goto(`/runs/${run.id}`);
    await expect(page.getByRole("alert").filter({ hasText: "This run is unavailable to this owner." })).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
    const results = await page.evaluate(async (id) => {
      const responses = await Promise.all(["sessions", "events", "attempts", "summaries"].map((path) => fetch(`/api/v1/runs/${id}/${path}`)));
      return responses.map((response) => response.status);
    }, run.id);
    expect(results).toEqual([404, 404, 404, 404]);
  } finally { await fixture.close(); }
});

test("lost owner cookie never replays a saved paid request under a new owner", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"));
  try {
    await unlock(page);
    const originalOwner = fixture.owner;
    await configureDemo(page);
    fixture.loseNextReply();
    await page.getByRole("button", { name: "Launch 1 persona", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reconcile saved launch" })).toBeVisible();
    const saved = await page.evaluate(() => sessionStorage.getItem("flash-flood.pending-launch.v1"));
    expect(saved).not.toBeNull();
    await page.context().clearCookies();
    await unlock(page);
    expect(fixture.owner).not.toBe(originalOwner);
    await expect(page.locator(".error[role=alert]")).toContainText("could not be recovered for this owner");
    await expect(page.getByRole("button", { name: "Reconcile saved launch" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save website request (execution blocked)" })).toBeDisabled();
    expect(await page.evaluate(() => sessionStorage.getItem("flash-flood.pending-launch.v1"))).toBe(saved);
    expect(fixture.submissions).toBe(1);
    expect(fixture.repository.listRuns(originalOwner, { after: 0, limit: 100 }).items).toHaveLength(1);
    expect(fixture.repository.listRuns(fixture.owner, { after: 0, limit: 100 }).items).toHaveLength(0);
  } finally { await fixture.close(); }
});

test("scope/criteria validation and server rejection keep all launch input", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"));
  try {
    await unlock(page);
    await configureDemo(page);
    await page.getByText("Configure scope & success criteria", { exact: false }).click();
    await page.getByRole("textbox", { name: "Allowed path prefixes (one per line)", exact: true }).fill("/outside");
    await page.getByRole("button", { name: "Launch 1 persona", exact: true }).click();
    await expect(page.locator(".error[role=alert]")).toContainText("Controlled paths");
    expect(fixture.submissions).toBe(0);
    await page.getByRole("textbox", { name: "Allowed path prefixes (one per line)", exact: true }).fill("/project-board");
    fixture.rejectNextLaunch();
    await page.getByRole("button", { name: "Launch 1 persona", exact: true }).click();
    await expect(page.locator(".error[role=alert]")).toContainText("server rejected");
    await expect(page.getByLabel("What should the crowd try?")).toHaveValue(/Garden planning/);
    await expect(page.getByLabel("Text to observe")).toHaveValue("Garden planning");
    await expect(page.getByRole("button", { name: "Reconcile saved launch" })).toHaveCount(0);
  } finally { await fixture.close(); }
});

test("mobile keyboard launch is usable without horizontal overflow", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"));
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await unlock(page);
    await page.getByRole("button", { name: "Controlled demo", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("combobox", { name: "Controlled site", exact: true })).toBeVisible();
    await page.getByLabel("I am authorized to test this scope").focus();
    await page.keyboard.press("Space");
    await page.getByRole("button", { name: "Launch 1 persona", exact: true }).focus();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/runs\/[a-f0-9-]+$/);
  } finally { await fixture.close(); }
});
