import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createApi } from "../../src/server/api";
import { Repository } from "../../src/server/repository";
import { FixtureDriver } from "../../src/server/execution/driver";
import { FIXTURE_ORIGIN, installFixtureNetwork, localFixtureSource } from "../../src/server/execution/fixture-network";

test("the actual grounded driver opens and reads the synthetic preference through UI actions", async ({ page }) => {
  const network = await installFixtureNetwork(page.context(), page, localFixtureSource(4317), () => {});
  const artifact = (kind: "json" | "screenshot") => ({ key: "a".repeat(64), sha256: "b".repeat(64), bytes: 1, kind });
  const driver = new FixtureDriver({
    page,
    artifacts: {
      json: async () => artifact("json"), telemetry: async () => artifact("json"),
      screenshot: async () => artifact("screenshot"),
    },
    networkErrors: network.errors,
    close: async () => { await network.close(); return { status: "closed", errors: [] }; },
  });
  const signal = new AbortController().signal;
  try {
    await page.goto(`${FIXTURE_ORIGIN}/demo/category/home`);
    await page.getByRole("button", { name: "Returning-user demo preference" }).waitFor();
    await page.getByRole("button", { name: "Returning-user demo preference" }).scrollIntoViewIfNeeded();
    const before = await driver.observe(signal);
    const disclosure = before.candidates.find((candidate) => candidate.label === "Returning-user demo preference");
    expect(disclosure).toBeDefined();
    expect(before.text).not.toContain("Synthetic preference:");
    expect(before.textBlocks?.join(" ")).not.toContain("Synthetic preference:");
    expect(before.candidates.some((candidate) => candidate.label === "Remember this demo visit")).toBe(false);
    await driver.act({ action: "click", candidateId: disclosure!.id, value: null, commentary: "", actor: "agent" }, signal);
    await driver.act({ action: "scroll", candidateId: null, value: "down", commentary: "", actor: "agent" }, signal);
    const opened = await driver.observe(signal);
    expect(opened.text).toContain("Synthetic preference: fresh.");
    const remember = opened.candidates.find((candidate) => candidate.label === "Remember this demo visit");
    expect(remember).toBeDefined();
    await driver.act({ action: "click", candidateId: remember!.id, value: null, commentary: "", actor: "agent" }, signal);
    expect((await driver.observe(signal)).text).toContain("Synthetic preference: remembered.");
  } finally { await driver.close(); }
});

test("controlled synthetic marker distinguishes fresh and restored localStorage without restoring task state", async ({ browser }) => {
  const first = await browser.newContext();
  let returning: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  const fresh = await browser.newContext();
  try {
    const page = await first.newPage();
    await page.goto("http://127.0.0.1:4317/project-board");
    await page.getByText("Returning-user demo preference", { exact: true }).click();
    await expect(page.getByText("Synthetic preference: fresh.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Remember this demo visit" }).click();
    await expect(page.getByText("Synthetic preference: remembered.", { exact: true })).toBeVisible();
    returning = await browser.newContext({ storageState: await first.storageState() });
    const returned = await returning.newPage();
    await returned.goto("http://127.0.0.1:4317/project-board");
    await returned.getByText("Returning-user demo preference", { exact: true }).click();
    await expect(returned.getByText("Synthetic preference: remembered.", { exact: true })).toBeVisible();
    const empty = await fresh.newPage();
    await empty.goto("http://127.0.0.1:4317/project-board");
    await empty.getByText("Returning-user demo preference", { exact: true }).click();
    await expect(empty.getByText("Synthetic preference: fresh.", { exact: true })).toBeVisible();
  } finally { await first.close(); await returning?.close(); await fresh.close(); }
});

test("launch saves private context only after explicit selection and keeps opaque provider state out of UI", async ({ page }, info) => {
  const directory = info.outputPath("api");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const repository = new Repository(directory);
  const origin = "http://127.0.0.1:4317";
  const accessCode = "offline-context-fixture-not-a-production-secret";
  const handle = createApi({ repository, configuration: { origin, production: false, accessCode, allowDemoRuns: true } });
  let owner = "";
  await page.route("**/api/v1/**", async (route) => {
    const input = route.request();
    if (input.url().includes("/events/stream")) {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": offline\n\n" });
      return;
    }
    const response = await handle(new Request(input.url(), {
      method: input.method(), headers: await input.allHeaders(),
      ...(input.postData() ? { body: input.postData() } : {}),
    }));
    const body = await response.text();
    if (input.url().endsWith("/session") && response.ok) owner = JSON.parse(body).data.ownerId;
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
  });
  try {
    await page.goto("/");
    await page.getByLabel("Workspace access code").fill(accessCode);
    await page.getByRole("button", { name: "Unlock workspace" }).click();
    await page.getByRole("button", { name: "Controlled demo", exact: true }).click();
    await page.getByText("Alex: objective, limits & character", { exact: true }).click();
    await page.getByText("Browser state: fresh", { exact: true }).click();
    await expect(page.getByLabel("State for this assignment")).toHaveValue("fresh");
    expect(repository.contexts.list(owner)).toEqual([]);
    await page.getByLabel("State for this assignment").selectOption("save");
    await page.screenshot({ path: info.outputPath("contexts-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: info.outputPath("contexts-mobile.png"), fullPage: true });
    await page.getByLabel("I am authorized to test this scope").check();
    await page.getByRole("button", { name: "Launch 1 persona", exact: true }).click();
    await expect(page).toHaveURL(/\/runs\/[a-f0-9-]+$/);
    expect(repository.contexts.list(owner)).toEqual([expect.objectContaining({ status: "pending", persistence: "never_saved" })]);
    const attempt = repository.attempts(owner, page.url().split("/").at(-1)!)[0];
    expect(attempt.browserState).toEqual({ mode: "save", acknowledgeSensitiveStorage: true });
    expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }))).not.toContain(accessCode);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    repository.close();
  }
});
