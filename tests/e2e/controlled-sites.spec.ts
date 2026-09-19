import { createHash } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { controlledNavigationScope, controlledSite, type ControlledSiteId } from "../../src/lib/controlled-sites";
import { BOARD_STORAGE_KEY } from "../../src/lib/project-board";
import { personas } from "../../src/lib/personas";
import type { Criterion } from "../../src/lib/criteria";
import { ScopedBrowserDriver } from "../../src/server/execution/driver";
import { controlledRequestPolicy, installControlledNetwork, localControlledSource } from "../../src/server/execution/fixture-network";
import { executePersona } from "../../src/server/execution/loop";
import { boundedObservation, deterministicCheck } from "../../src/server/execution/evaluator";
import type { ArtifactSinks } from "../../src/server/execution/artifacts";
import type { BrowserAction, Decision, Observation } from "../../src/server/execution/types";

const signal = () => new AbortController().signal;
const artifact = (bytes: Uint8Array, kind: "screenshot" | "json") => {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { key: sha256, sha256, bytes: bytes.length, kind };
};
const artifacts: ArtifactSinks = {
  screenshot: async (bytes) => artifact(bytes, "screenshot"),
  json: async (value) => artifact(Buffer.from(JSON.stringify(value)), "json"),
  telemetry: async (value) => artifact(Buffer.from(JSON.stringify(value)), "json"),
};

async function setup(page: Page, id: ControlledSiteId, path?: string, paths?: string[]) {
  const site = controlledSite(id);
  const targetUrl = site.origin + (path ?? site.entryPath);
  const scope = controlledNavigationScope(site, targetUrl, paths
    ? { targetUrl, allowedSubdomains: [], pathPrefixes: paths } : undefined);
  const policy = controlledRequestPolicy(site, scope);
  const calls: string[] = [];
  const source = localControlledSource(4317, policy);
  const holder: { driver?: ScopedBrowserDriver } = {};
  const network = await installControlledNetwork(page.context(), page, async (url) => {
    calls.push(url.href);
    return source(url);
  }, (event) => holder.driver?.policySignal(event.url, event.code), policy);
  await page.goto(targetUrl);
  await page.getByRole("heading", { level: 1 }).waitFor();
  const driver = new ScopedBrowserDriver({
    page, scope, artifacts, networkErrors: network.errors,
    close: async () => { await page.close(); await network.close(); return { status: "closed", errors: [] }; },
  });
  holder.driver = driver;
  return { driver, calls, network };
}

type PlannedAction = [BrowserAction["action"], string | null, string | null];
async function journey(page: Page, site: ControlledSiteId, goal: string, criteria: Criterion[], actions: PlannedAction[]) {
  const { driver, calls } = await setup(page, site);
  const observations: Observation[] = [];
  expect((await driver.observe(signal())).checks).toEqual([]);
  const result = await executePersona({
    persona: personas[0], goal, criteria,
    limits: { maxSteps: 20, maxModelCalls: 20, maxDurationMs: 20000, carefulDelayMs: 0, rushDelayMs: 0 },
  }, {
    driver,
    brain: {
      decide: async ({ observation }): Promise<Decision> => {
        if (/Opening the (?:store|project board)/.test(observation.text)) {
          return { action: "wait", candidateId: null, value: "250", commentary: "Waiting for the page." };
        }
        const next = actions[0];
        if (!next) return { action: "done", candidateId: null, value: null, commentary: "" };
        const [action, label, value] = next;
        const candidate = observation.candidates.find((candidate) => candidate.label === label);
        if (label) expect(candidate, label).toBeDefined();
        actions.shift();
        return { action, candidateId: candidate?.id ?? null, value, commentary: "" };
      },
    },
    onEvent: async (event) => { if (event.kind === "observation") observations.push(event.observation); },
  });
  expect(result.status, JSON.stringify({ result, text: observations.at(-1)?.text })).toBe("succeeded");
  expect(result.cleanup.status).toBe("closed");
  expect(actions).toHaveLength(0);
  expect(result.checks.every((check) => check.passed && check.method === "deterministic")).toBe(true);
  expect(observations.every((observation) => observation.checks.length === criteria.length
    && observation.checks.every((check) => check.method === "deterministic"))).toBe(true);
  expect(calls.every((url) => new URL(url).origin === controlledSite(site).origin)).toBe(true);
  return observations;
}

test("generic driver and actual loop fulfill a novel store goal without the coupon oracle", async ({ page }) => {
  const observations = await journey(page, "store", "Put a pocket journal in the cart, without checking out.", [
    { id: "cart", kind: "url", description: "Viewing the cart", semantics: "current", path: "/demo/cart" },
    { id: "journal", kind: "visible_text", description: "Journal in cart", semantics: "current",
      paths: ["/demo/cart"], text: "Pocket trail journal - CA$12.00", match: "contains" },
  ], [
    ["click", "Paper goods", null], ["click", "Pocket trail journal", null],
    ["click", "Add to cart", null], ["click", "View cart", null],
  ]);
  expect(observations.some((observation) => observation.candidates.some((candidate) =>
    candidate.label === "Added to cart" && candidate.disabled))).toBe(true);
});

test("generic driver and actual loop create a project without any store seed or selectors", async ({ page }) => {
  const observations = await journey(page, "project-board", "Create Aurora as an Engineering project and find it in the list.", [
    { id: "list", kind: "url", description: "Viewing all projects", semantics: "current", path: "/project-board/projects" },
    { id: "named", kind: "visible_text", description: "Created project is visible", semantics: "current",
      paths: ["/project-board/projects"], text: "Aurora", match: "contains" },
    { id: "category", kind: "visible_text", description: "Engineering category is visible", semantics: "current",
      paths: ["/project-board/projects"], text: "Category: Engineering", match: "contains" },
  ], [
    ["click", "New project", null], ["type", "Project name", "Aurora"],
    ["select", "Category", "Engineering"], ["click", "Create project", null],
  ]);
  expect(observations.some((observation) => observation.candidates.some((candidate) =>
    candidate.label === "Project name" && candidate.value === "Aurora"))).toBe(true);
  expect(observations.some((observation) => observation.candidates.some((candidate) =>
    candidate.label === "Category" && candidate.selected?.includes("Engineering")))).toBe(true);
});

test("board state survives reload in one tab, detects invalid storage and can reset", async ({ page, browser }) => {
  const { driver } = await setup(page, "project-board", "/project-board/new");
  await page.getByLabel("Project name", { exact: true }).fill("Telescope");
  await page.getByLabel("Category", { exact: true }).selectOption("Design");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Telescope", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Telescope", exact: true })).toBeVisible();
  const otherContext = await browser.newContext();
  try {
    const other = await setup(await otherContext.newPage(), "project-board", "/project-board/projects");
    expect((await other.driver.observe(signal())).text).toContain("No projects yet.");
    await other.driver.close();
  } finally { await otherContext.close(); }
  await page.evaluate((key) => sessionStorage.setItem(key, '{"version":1,"projects":"invalid"}'), BOARD_STORAGE_KEY);
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "could not be read" })).toBeVisible();
  await page.getByRole("button", { name: "Reset this tab", exact: true }).click();
  await expect(page.getByText("No projects yet.", { exact: false })).toBeVisible();
  await driver.close();
});

test("board duplicate and storage-write failures remain explicit, without a fake success", async ({ page }) => {
  const { driver } = await setup(page, "project-board", "/project-board/new");
  await page.getByLabel("Project name", { exact: true }).fill("Aurora");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill("aurora");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already exists" })).toBeVisible();
  await page.getByLabel("Project name", { exact: true }).fill("New idea");
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("storage unavailable"); }; });
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "could not be saved" })).toBeVisible();
  expect(page.url()).toBe(controlledSite("project-board").origin + "/project-board/new");
  await driver.close();
});

test("both navigation and transport enforce narrowed board scope and deny cross-site pages", async ({ page }) => {
  const { driver, calls } = await setup(page, "project-board", "/project-board/new", ["/project-board/new"]);
  const observed = await driver.observe(signal());
  const link = observed.candidates.find((candidate) => candidate.label === "All projects")!;
  await expect(driver.act({ actor: "agent", action: "click", candidateId: link.id, value: null, commentary: "" }, signal())).rejects.toThrow("link_out_of_scope");
  await expect(driver.act({
    actor: "agent", action: "navigate", candidateId: null, value: controlledSite("store").origin + "/demo", commentary: "",
  }, signal())).rejects.toThrow("navigation_out_of_scope");
  const denied = await page.evaluate(async () => fetch("/project-board/projects").then(() => false, () => true));
  expect(denied).toBe(true);
  expect(calls.some((url) => url.endsWith("/project-board/projects"))).toBe(false);
  await driver.close();
});

test("subframes and new-tab actions report unsupported rather than silently succeeding", async ({ page }) => {
  const { driver } = await setup(page, "project-board");
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.textContent = "Open another tab";
    button.onclick = () => { window.open("/project-board/projects"); };
    document.querySelector("main")!.append(button);
  });
  const observed = await driver.observe(signal());
  const button = observed.candidates.find((candidate) => candidate.label === "Open another tab")!;
  await expect(driver.act({ actor: "agent", action: "click", candidateId: button.id, value: null, commentary: "" }, signal())).rejects.toMatchObject({ code: "unsupported" });
  await driver.close();
});

test("a child frame is explicitly unsupported even when it cannot load", async ({ page }) => {
  const { driver } = await setup(page, "project-board");
  await page.evaluate(() => document.body.append(document.createElement("iframe")));
  await expect(driver.observe(signal())).rejects.toThrow("subframes_unsupported");
  await driver.close();
});

test("exact text criteria use viewport rendered blocks, including inline heading text, not hidden claims", async ({ page }) => {
  const site = controlledSite("project-board");
  const targetUrl = site.origin + site.entryPath;
  const scope = controlledNavigationScope(site, targetUrl);
  const policy = controlledRequestPolicy(site, scope);
  const html = `<!doctype html><title>Exact visible text</title>
    <style>body{margin:24px;font:16px sans-serif}.offscreen{position:absolute;left:-10000px}
    .clipped{height:0;overflow:hidden}.transparent{opacity:0}</style>
    <h1>Your <span>projects</span></h1><p>Visible <strong>project</strong> summary.</p>
    <h2>Payment<br>failed</h2>
    <h2 style="width:80px"><span>Wrapped</span><wbr><span>heading</span></h2>
    <h2>Still<br style="display:none">together</h2>
    <button>New project</button><input aria-label="Project name" value="Synthetic input evidence">
    <h2 hidden>Hidden success</h2><div class="transparent"><h2>Transparent success</h2><button>Transparent action</button>
    <input aria-label="Transparent input" value="Transparent input secret"></div>
    <div class="clipped"><h2>Clipped success</h2><button>Clipped action</button></div>
    <h2 class="offscreen">Offscreen success</h2><button class="offscreen">Offscreen action</button>
    <div style="height:4px;overflow:hidden"><h2 style="margin:0">Partial glyph success</h2></div>
    <div style="height:10px;overflow:hidden"><button style="height:30px">Partially visible action</button></div>
    <details><summary>Visible disclosure</summary>Direct disclosure success<p>Disclosed success</p>
      <button>Disclosed action</button><input aria-label="Disclosed input" value="Disclosed input secret">
      <details open><summary>Nested summary</summary><p>Nested hidden success</p></details>
    </details>
    <div style="content-visibility:hidden">Direct skipped success<p>Skipped rendering success</p><button>Skipped rendering action</button></div>
    <script type="application/json">{"textBlocks":["Script success"],"checks":[{"passed":true}]}</script>
    <div style="height:2000px"></div><h2>Below fold success</h2>`;
  const network = await installControlledNetwork(page.context(), page, async () => ({
    status: 200, contentType: "text/html", body: Buffer.from(html),
  }), () => {}, policy);
  await page.goto(targetUrl);
  const driver = new ScopedBrowserDriver({
    page, scope, artifacts, networkErrors: network.errors,
    close: async () => { await page.close(); await network.close(); return { status: "closed", errors: [] }; },
  });
  const observation = await driver.observe(signal());
  const exact = (text: string): Criterion => ({
    id: "exact", kind: "visible_text", description: "Exact rendered text", semantics: "current", text, match: "exact",
  });
  const invisible = ["Hidden success", "Transparent success", "Clipped success", "Offscreen success",
    "Below fold success", "Script success", "Partial glyph success", "Transparent input secret",
    "Disclosed success", "Direct disclosure success", "Disclosed input secret", "Nested hidden success",
    "Skipped rendering success", "Direct skipped success"];
  for (const text of invisible) {
    expect(observation.text, text).not.toContain(text);
    expect(boundedObservation(observation).textBlocks?.join(" "), text).not.toContain(text);
    expect(deterministicCheck(exact(text), observation), text).toMatchObject({ passed: false, status: "not_met" });
    expect(deterministicCheck({
      id: "contains", kind: "visible_text", description: "Rendered text only", semantics: "current", text, match: "contains",
    }, observation), text).toMatchObject({ passed: false, status: "not_met" });
  }
  for (const label of ["Transparent action", "Transparent input", "Clipped action", "Offscreen action",
    "Disclosed action", "Disclosed input", "Nested summary", "Skipped rendering action"]) {
    expect(observation.candidates.some((candidate) => candidate.label === label), label).toBe(false);
  }
  expect(observation.candidates.some((candidate) => candidate.label === "Partially visible action")).toBe(true);
  expect(observation.text).toContain("Focused control:");
  expect(observation.textBlocks).toEqual(expect.arrayContaining([
    "Your projects", "Visible project summary.", "Payment failed", "Wrapped heading", "Stilltogether",
  ]));
  expect(boundedObservation(observation).textBlocks).toEqual(observation.textBlocks);
  const disclosure = observation.candidates.find((candidate) => candidate.label === "Visible disclosure");
  expect(disclosure).toBeDefined();
  await driver.act({ action: "click", candidateId: disclosure!.id, value: null, commentary: "", actor: "agent" }, signal());
  await page.getByText("Disclosed success", { exact: true }).scrollIntoViewIfNeeded();
  const opened = await driver.observe(signal());
  expect(deterministicCheck(exact("Disclosed success"), opened)).toMatchObject({ passed: true, status: "met" });
  expect(deterministicCheck(exact("Direct disclosure success"), opened)).toMatchObject({ passed: true, status: "met" });
  expect(opened.candidates.some((candidate) => candidate.label === "Disclosed action")).toBe(true);
  await page.getByText("Visible disclosure", { exact: true }).click();
  const closedAgain = await driver.observe(signal());
  expect(deterministicCheck(exact("Disclosed success"), closedAgain)).toMatchObject({ passed: false, status: "not_met" });
  expect(closedAgain.text).not.toContain("Direct disclosure success");
  expect(closedAgain.textBlocks?.join(" ")).not.toContain("Direct disclosure success");
  expect(boundedObservation(closedAgain).textBlocks?.join(" ")).not.toContain("Direct disclosure success");
  expect(deterministicCheck(exact("Direct disclosure success"), closedAgain)).toMatchObject({ passed: false, status: "not_met" });
  expect(closedAgain.candidates.some((candidate) => candidate.label === "Disclosed action")).toBe(false);
  for (const text of ["Your projects", "Visible project summary.", "Payment failed", "Wrapped heading", "Stilltogether"]) {
    expect(deterministicCheck(exact(text), observation)).toMatchObject({ passed: true, status: "met" });
  }
  for (const text of ["projects", "Paymentfailed", "Wrappedheading", "Still together", "Hidden success", "Transparent success", "Clipped success",
    "Offscreen success", "Below fold success", "Script success", "Focused control: none", "Synthetic input evidence"]) {
    expect(deterministicCheck(exact(text), observation), text).toMatchObject({ passed: false, status: "not_met" });
  }
  const result = await executePersona({
    persona: personas[0], goal: "Find the project heading.", criteria: [exact("Your projects")],
  }, {
    driver,
    brain: { decide: async () => { throw new Error("Exact observed heading should need no model decision"); } },
  });
  expect(result.status).toBe("succeeded");
  expect(result.modelCalls).toBe(0);
});
