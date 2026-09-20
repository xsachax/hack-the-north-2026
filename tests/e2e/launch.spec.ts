import { mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test, expect, type Page, type Route } from "@playwright/test";
import { createApi, type ApiConfiguration } from "../../src/server/api";
import { Repository } from "../../src/server/repository";
import { WorkerRepository } from "../../src/server/worker/repository";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../../src/lib/public-execution";
import { createRunSchema } from "../../src/lib/contracts";
import { controlledRunSchema, resolveControlledScope } from "../../src/lib/controlled-run";
import { personas } from "../../src/lib/personas";

const accessCode = "offline-only-access-code-not-a-production-secret";
const origin = "http://127.0.0.1:4317";

async function offlineApi(page: Page, directory: string, configuration: Partial<ApiConfiguration> = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const repository = new Repository(directory);
  const handle = createApi({
    repository, configuration: { origin, production: false, accessCode, allowDemoRuns: true, ...configuration },
    validateScope: async (scope) => scope,
  });
  let loseReply = false;
  let rejectLaunch = 0;
  let submissions = 0;
  let latestOwner = "";
  const requests: { body: unknown; key: string | undefined }[] = [];
  const route = async (route: Route) => {
    const input = route.request();
    const url = new URL(input.url());
    if (url.pathname.endsWith("/events/stream")) {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": offline transport reconnect\n\n" });
      return;
    }
    const launch = ["/api/v1/controlled-runs", "/api/v1/runs"].includes(url.pathname) && input.method() === "POST";
    if (launch) {
      submissions++;
      requests.push({ body: input.postDataJSON(), key: (await input.allHeaders())["idempotency-key"] });
    }
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
    repository, requests, get owner() { return latestOwner; }, get submissions() { return submissions; },
    loseNextReply() { loseReply = true; }, rejectNextLaunch(status = 400) { rejectLaunch = status; },
    async close() {
      try { if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" }); }
      finally { repository.close(); }
    },
  };
}

async function unlock(page: Page) {
  await page.goto("/");
  await page.getByLabel("Workspace access code").fill(accessCode);
  await page.getByRole("button", { name: "Unlock workspace" }).click();
  await expect(page.getByLabel("Target mode")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose your target", exact: true })).toBeVisible();
}
async function continueSetup(page: Page, count = 1) {
  for (let index = 0; index < count; index++) {
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("region", { name: /^(Target|Mission|Criteria|Personas|Review) setup$/ })).toHaveCount(1);
    await expect(page.getByRole("checkbox", { name: /I am authorized|acknowledge|accept.*terms/i })).toHaveCount(0);
  }
}
async function configureDemo(page: Page, destination: "Target" | "Personas" | "Review" = "Review") {
  await page.getByRole("button", { name: "Controlled demo", exact: true }).click();
  await continueSetup(page, destination === "Target" ? 0 : destination === "Personas" ? 3 : 4);
}
async function websiteReview(page: Page, goal = "Read the example domain heading without following links.") {
  await page.getByLabel("Website URL", { exact: true }).fill("https://example.com/");
  await continueSetup(page);
  await page.getByLabel("What should the crowd try?").fill(goal);
  await continueSetup(page, 3);
}

test("surfer badges respect reduced motion and specialty templates save editable owner profiles", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"));
  try {
    await unlock(page);
    await configureDemo(page, "Personas");
    const sprite = page.locator(".person-chip .persona-avatar img").first();
    await expect(sprite).toHaveAttribute("src", /\/surfers\/animated\/avatar-\w+-idle\.svg/);
    await expect.poll(() => sprite.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1024);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => sprite.evaluate((image: HTMLImageElement) => image.currentSrc)).toContain("/surfers/static/");
    for (const [template, name] of [["security-review", "Security reviewer"], ["ux-review", "UX reviewer"], ["network-review", "Loading reviewer"]]) {
      await page.getByRole("button", { name: "+ Create persona", exact: true }).click();
      const editor = page.getByRole("region", { name: "Meet someone new" });
      await editor.getByLabel("Start from a template", { exact: false }).selectOption(template);
      await expect(editor.getByLabel("Name", { exact: true })).toHaveValue(name);
      await editor.getByRole("button", { name: "Save persona" }).click();
      await expect(page.getByRole("checkbox", { name: new RegExp(name) })).toBeChecked();
    }
    const saved = fixture.repository.listPersonas(fixture.owner);
    expect(saved.find((persona) => persona.name === "Security reviewer")?.character).toContain("Never probes exploits");
    expect(saved.find((persona) => persona.name === "Loading reviewer")?.character).toContain("only when the tools supply actual measurements");
    expect(fixture.submissions).toBe(0);
  } finally { await fixture.close(); }
});

test("bootstrap rejects bad codes and preserves no access code in storage; public mode is explicitly blocked", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"));
  try {
    await page.goto("/");
    await page.getByLabel("Workspace access code").fill("wrong");
    await page.getByRole("button", { name: "Unlock workspace" }).click();
    await expect(page.locator(".error[role=alert]")).toContainText("not accepted");
    await page.getByLabel("Workspace access code").fill(accessCode);
    await page.getByRole("button", { name: "Unlock workspace" }).click();
    await expect(page.getByLabel("Target mode")).toBeVisible();
    await expect(page.getByText("Website execution is not enabled.", { exact: false })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Website execution", exact: true })).toHaveValue("save");
    await expect(page.getByRole("button", { name: "Save website request (execution blocked)" })).toHaveCount(0);
    await page.getByLabel("Website URL", { exact: true }).fill("https://example.com/");
    await continueSetup(page);
    await page.getByLabel("What should the crowd try?").fill("Read the heading.");
    await continueSetup(page, 2);
    await expect(page.getByText("Alex", { exact: true })).toBeVisible();
    await page.getByText("Supported testing and known limits", { exact: true }).click();
    await expect(page.getByText("Agents use DOM plus viewport screenshots", { exact: false })).toBeVisible();
    await expect(page.getByText("Keyboard actions are supported, but there is no general accessibility or WCAG scanner.", { exact: false })).toBeVisible();
    await expect(page.getByText("Comparisons need matching criteria and confirming tested coverage", { exact: false })).toBeVisible();
    await continueSetup(page);
    await expect(page.getByRole("button", { name: "Save website request (execution blocked)" })).toBeVisible();
    expect(fixture.submissions).toBe(0);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(accessCode);
    const owner = fixture.owner;
    await page.reload();
    await expect(page.getByLabel("Target mode")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Choose your target", exact: true })).toBeVisible();
    expect(fixture.owner).toBe(owner);
  } finally { await fixture.close(); }
});

test("public opt-in stays unavailable without implementation readiness and explains separate policy limits", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"), { allowPublicRuns: true });
  try {
    await unlock(page);
    await page.getByRole("combobox", { name: "Website execution", exact: true }).selectOption("public");
    await expect(page.getByRole("button", { name: "Launch public read-only run" })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "native browser and broker integration is not ready" })).toBeVisible();
    await expect(page.getByText("Assets never create an exception", { exact: false })).toBeVisible();
    await expect(page.getByText("Fresh profiles only; no typing, forms, saved state or human takeover.", { exact: false })).toBeVisible();
    await expect(page.getByText("not transparent browser-request replay", { exact: false })).not.toBeVisible();
    await page.getByText("Public policy and unsupported features", { exact: true }).click();
    await expect(page.getByText("not transparent browser-request replay", { exact: false })).toBeVisible();
    await expect(page.getByText("Returning profiles and saving browser state are unsupported", { exact: false })).toBeVisible();
    await expect(page.getByLabel("Allowed path prefixes (one per line)")).toBeVisible();
    await websiteReview(page);
    await expect(page.getByRole("button", { name: "Launch public read-only run" })).toBeDisabled();
    expect(fixture.repository.listRuns(fixture.owner, { after: 0, limit: 100 }).items).toEqual([]);
  } finally { await fixture.close(); }
});

test("public opt-in rejects a TTL without native shutdown reserve even when enabled", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"), {
    allowPublicRuns: true, publicExecutionReady: true, publicSessionTimeoutSeconds: 80,
  });
  try {
    await unlock(page);
    await page.getByRole("combobox", { name: "Website execution", exact: true }).selectOption("public");
    await expect(page.getByRole("status").filter({ hasText: "session timeout above 80 seconds" })).toBeVisible();
    await websiteReview(page);
    await expect(page.getByRole("button", { name: "Launch public read-only run" })).toBeDisabled();
    expect(fixture.repository.listRuns(fixture.owner, { after: 0, limit: 100 }).items).toEqual([]);
  } finally { await fixture.close(); }
});

test("enabled public launch preserves explicit policies through the owner API without allocating in the UI", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"), {
    allowPublicRuns: true, publicExecutionReady: true, publicSessionTimeoutSeconds: 300,
  });
  try {
    await unlock(page);
    await page.getByRole("combobox", { name: "Website execution", exact: true }).selectOption("public");
    await websiteReview(page);
    expect(fixture.submissions).toBe(0);
    await page.getByRole("button", { name: "Launch public read-only run" }).click();
    await expect(page).toHaveURL(/\/runs\/[a-f0-9-]+$/);
    const runs = fixture.repository.listRuns(fixture.owner, { after: 0, limit: 100 }).items;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ executionMode: "public-readonly", status: "queued",
      authorizationAcknowledged: true, executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY });
    expect(fixture.requests[0].body).toMatchObject({ authorizationAcknowledged: true,
      executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY });
    expect(fixture.repository.attemptSummaries(fixture.owner, runs[0].id)[0]).toMatchObject({
      launchState: "not_launched", reservedSeconds: 0,
    });
  } finally { await fixture.close(); }
});

test("website execution defaults to save-only even when public execution is ready", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"), {
    allowPublicRuns: true, publicExecutionReady: true, publicSessionTimeoutSeconds: 300,
  });
  try {
    await unlock(page);
    await expect(page.getByRole("combobox", { name: "Website execution", exact: true })).toHaveValue("save");
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await websiteReview(page);
    expect(fixture.submissions).toBe(0);
    await expect(page.getByRole("button", { name: "Launch public read-only run" })).toHaveCount(0);
    await page.getByRole("button", { name: "Save website request (execution blocked)" }).click();
    await expect(page).toHaveURL(/\/runs\/[a-f0-9-]+$/);
    const runs = fixture.repository.listRuns(fixture.owner, { after: 0, limit: 100 }).items;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ executionMode: "website", status: "queued", authorizationAcknowledged: true });
    const worker = new WorkerRepository(info.outputPath("api"));
    try { expect(worker.claim("offline-save-only-check")).toBeNull(); } finally { worker.close(); }
    expect(fixture.repository.getRun(fixture.owner, runs[0].id)).toMatchObject({ executionMode: "website", status: "blocked" });
    expect(fixture.requests[0].body).toMatchObject({ authorizationAcknowledged: true });
    expect(fixture.requests[0].body).not.toHaveProperty("executionPolicy");
    expect(fixture.requests[0].body).not.toHaveProperty("assetPolicy");
    expect(fixture.repository.attemptSummaries(fixture.owner, runs[0].id)[0]).toMatchObject({
      launchState: "not_launched", reservedSeconds: 0,
    });
  } finally { await fixture.close(); }
});

test("stored public snapshots retain wall/report surfaces without enabling unsupported workflows", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"), { allowPublicRuns: true, publicExecutionReady: true });
  try {
    await unlock(page);
    const run = fixture.repository.createRun(fixture.owner, randomUUID(), {
      authorizationAcknowledged: true, executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY,
      scope: { targetUrl: "https://example.com/help", allowedSubdomains: [], pathPrefixes: ["/help"] },
      assignments: [{ personaId: "careful-first-timer", goal: "Read the public help page", criteria: ["The help page explains delivery costs"] }],
    }).run;
    await page.goto(`/runs/${run.id}`);
    await expect(page).toHaveURL(/\/runs\/[a-f0-9-]+$/);
    expect(run).toMatchObject({ executionMode: "public-readonly", status: "queued", executionPolicy: PUBLIC_EXECUTION_POLICY, assetPolicy: PUBLIC_ASSET_POLICY });
    expect(fixture.repository.attemptSummaries(fixture.owner, run.id)[0]).toMatchObject({ launchState: "not_launched", reservedSeconds: 0 });
    await expect(page.getByText("Public read-only run ·", { exact: false })).toBeVisible();
    await expect(page.getByText("Human takeover is unsupported", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Request human control" })).toHaveCount(0);
    await page.getByRole("link", { name: "Reports", exact: true }).click();
    await expect(page.getByLabel("Rerun unsupported")).toContainText("Public reruns are unsupported");
    await expect(page.getByLabel("Rerun unsupported")).toContainText("Public run comparisons are unsupported");
    await expect(page.getByLabel("Reproduction unsupported")).toContainText("Public reduction and reproduction are unsupported");
    await expect(page.getByRole("button", { name: "Rerun selected attempts", exact: true })).toHaveCount(0);
  } finally { await fixture.close(); }
});

test("custom persona create, edit, select, scoped launch and delete use real owner API snapshots", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"));
  try {
    await unlock(page);
    await configureDemo(page, "Personas");
    await page.getByRole("button", { name: "+ Create persona", exact: true }).click();
    const editor = page.getByRole("region", { name: "Meet someone new" });
    await expect(page.locator("form")).toHaveCount(1);
    await expect(page.locator("form form")).toHaveCount(0);
    await editor.getByLabel("Name", { exact: true }).fill("Juniper");
    await editor.getByLabel("Character", { exact: true }).fill("An observant community gardener.");
    await editor.getByRole("button", { name: "Save persona" }).click();
    await page.getByText("Juniper: objective, limits & character", { exact: true }).click();
    await page.getByRole("button", { name: "Edit saved persona" }).click();
    await page.getByRole("region", { name: "Edit persona" }).getByRole("textbox", { name: "Character", exact: true }).fill("An observant gardener who verifies saved work.");
    await page.getByRole("button", { name: "Save persona" }).click();
    await page.getByText("Juniper: objective, limits & character", { exact: true }).click();
    await expect(page.getByText("An observant gardener who verifies saved work.", { exact: true })).toBeVisible();
    await continueSetup(page);
    await page.getByRole("button", { name: "Launch 2 personas" }).click();
    await expect(page).toHaveURL(/\/runs\/[a-f0-9-]+$/);
    const runId = new URL(page.url()).pathname.split("/").at(-1)!;
    const attempts = fixture.repository.attempts(fixture.owner, runId);
    expect(attempts).toHaveLength(2);
    const custom = attempts.find((attempt) => attempt.persona.name === "Juniper")!;
    expect(custom.persona.character).toContain("verifies saved work");
    expect(custom.criteria).toEqual([expect.objectContaining({ kind: "visible_text", text: "Garden planning" })]);
    expect(custom.limits?.maxSteps).toBeGreaterThan(0);
    expect(fixture.requests[0].body).toMatchObject({ authorizationAcknowledged: true });
    await page.goto("/");
    await configureDemo(page, "Personas");
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
    await configureDemo(page, "Personas");
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

test("selection and saved custom personas cannot exceed eight assignments", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"));
  try {
    await unlock(page);
    await configureDemo(page, "Personas");
    const choices = page.locator(".people-picker").getByRole("checkbox");
    for (let index = 0; index < 8; index++) await choices.nth(index).check();
    await expect(page.getByText("Select up to 8 personas per run.", { exact: false })).toBeVisible();
    await expect(page.locator(".people-picker input:checked")).toHaveCount(8);
    await continueSetup(page);
    await expect(page.getByRole("button", { name: "Launch 8 personas", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Back to Personas", exact: true }).click();
    for (let index = 8; index < 12; index++) await expect(choices.nth(index)).toBeDisabled();
    for (let index = 0; index < 8; index++) await expect(choices.nth(index)).toBeEnabled();
    expect(fixture.submissions).toBe(0);
    await page.getByRole("button", { name: "+ Create persona", exact: true }).click();
    const editor = page.getByRole("region", { name: "Meet someone new" });
    await editor.getByLabel("Name", { exact: true }).fill("Ninth saved profile");
    await editor.getByLabel("Character", { exact: true }).fill("A careful reader.");
    await editor.getByRole("button", { name: "Save persona" }).click();
    const saved = page.getByRole("checkbox", { name: /Ninth saved profile/ });
    await expect(saved).not.toBeChecked();
    await expect(saved).toBeDisabled();
    await expect(page.locator(".people-picker input:checked")).toHaveCount(8);
    await choices.nth(0).uncheck();
    await expect(saved).toBeEnabled();
    await saved.check();
    await continueSetup(page);
    await expect(page.getByRole("button", { name: "Launch 8 personas", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Launch 8 personas", exact: true }).click();
    await expect(page).toHaveURL(/\/runs\/[a-f0-9-]+$/);
    const runId = new URL(page.url()).pathname.split("/").at(-1)!;
    const attempts = fixture.repository.attempts(fixture.owner, runId);
    expect(attempts).toHaveLength(8);
    expect(attempts.some(({ persona }) => persona.name === "Ninth saved profile")).toBe(true);
    expect(fixture.submissions).toBe(1);
  } finally { await fixture.close(); }
});

test("a saved historical twelve-persona launch reconciles its exact key and body", async ({ page }, info) => {
  const directory = info.outputPath("api");
  const fixture = await offlineApi(page, directory);
  try {
    await unlock(page);
    const body = controlledRunSchema.parse({
      authorizationAcknowledged: true, controlledSiteId: "store",
      assignments: personas.map(({ id }) => ({ personaId: id, goal: "Read the cart", criteria: ["The cart is visible"] })),
    });
    const key = randomUUID();
    const run = fixture.repository.createControlledRun(fixture.owner, key, {
      ...body, assignments: body.assignments.slice(0, 8),
    }).run;
    const canonical = createRunSchema.parse({
      authorizationAcknowledged: true, scope: resolveControlledScope("store"), assignments: body.assignments,
    });
    const db = new DatabaseSync(`${directory}/flash-flood.sqlite`);
    try {
      db.prepare("UPDATE runs SET request_hash=? WHERE id=?").run(
        createHash("sha256").update(JSON.stringify({ request: canonical, controlledSiteId: "store", mode: "controlled-fixture" })).digest("hex"), run.id,
      );
      const source = fixture.repository.attempts(fixture.owner, run.id)[0];
      for (const persona of personas.slice(8)) {
        const id = randomUUID(), jobId = randomUUID();
        db.prepare("INSERT INTO attempts VALUES(?,?,?,?)").run(id, run.id, "queued", JSON.stringify({ ...source, id, persona }));
        db.prepare("INSERT INTO jobs(id,run_id,attempt_id,status) VALUES(?,?,?,'queued')").run(jobId, run.id, id);
        db.prepare("INSERT INTO usage_reservations(job_id) VALUES(?)").run(jobId);
      }
    } finally { db.close(); }
    await page.evaluate((saved) => sessionStorage.setItem("flash-flood.pending-launch.v1", JSON.stringify(saved)),
      { ownerId: fixture.owner, key, path: "/controlled-runs", body });
    await page.reload();
    await expect(page.getByRole("button", { name: "Reconcile saved launch" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Reconcile saved launch" }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${run.id}$`));
    expect(fixture.repository.attempts(fixture.owner, run.id)).toHaveLength(12);
    expect(fixture.repository.listRuns(fixture.owner, { after: 0, limit: 100 }).items).toHaveLength(1);
    expect(fixture.submissions).toBe(1);
    expect(fixture.requests[0]).toEqual({ key, body });
    expect(await page.evaluate(() => sessionStorage.getItem("flash-flood.pending-launch.v1"))).toBeNull();
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
    const originalRequest = fixture.requests[0];
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
    expect(fixture.requests).toEqual([originalRequest, originalRequest, originalRequest]);
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
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
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
    await configureDemo(page, "Target");
    await page.getByRole("textbox", { name: "Allowed path prefixes (one per line)", exact: true }).fill("/outside");
    await continueSetup(page);
    await expect(page.locator(".error[role=alert]")).toContainText("Controlled paths");
    await expect(page.getByRole("region", { name: "Target setup", exact: true })).toBeVisible();
    await expect(page.getByLabel("What should the crowd try?")).toHaveCount(0);
    expect(fixture.submissions).toBe(0);
    await page.getByRole("textbox", { name: "Allowed path prefixes (one per line)", exact: true }).fill("/project-board");
    await continueSetup(page);
    await page.getByLabel("What should the crowd try?").fill(" ");
    await continueSetup(page);
    await expect(page.getByRole("region", { name: "Mission setup", exact: true })).toBeVisible();
    await expect(page.locator(".error[role=alert]")).toBeVisible();
    const mission = "Create a synthetic Garden planning project and check the saved result.";
    await page.getByLabel("What should the crowd try?").fill(mission);
    await continueSetup(page);
    await page.getByLabel("Text to observe").fill("");
    await continueSetup(page);
    await expect(page.getByRole("region", { name: "Criteria setup", exact: true })).toBeVisible();
    await expect(page.locator(".error[role=alert]")).toBeVisible();
    await page.getByLabel("Text to observe").fill("Garden planning");
    await continueSetup(page);
    await page.getByText("Alex: objective, limits & character", { exact: true }).click();
    await page.getByRole("textbox", { name: "Objective for Alex", exact: true }).fill("Verify the Garden planning project.");
    await page.getByLabel("Maximum steps", { exact: true }).fill("4");
    await page.getByLabel("Maximum model calls", { exact: true }).fill("6");
    await page.getByLabel("Maximum duration (seconds)", { exact: true }).fill("20");
    await page.getByText("Override canonical criteria JSON", { exact: true }).click();
    await page.getByRole("textbox", { name: "Criteria for Alex", exact: true }).fill("{");
    await continueSetup(page);
    await expect(page.getByRole("region", { name: "Personas setup", exact: true })).toBeVisible();
    await expect(page.locator(".error[role=alert]")).toContainText("criteria JSON");
    const override = JSON.stringify([{ id: "personal-visible", kind: "visible_text", semantics: "current",
      description: "The saved project appears.", text: "Garden planning", match: "contains" }]);
    await page.getByRole("textbox", { name: "Criteria for Alex", exact: true }).fill(override);
    await page.getByRole("button", { name: "Back to Mission", exact: true }).click();
    await expect(page.getByLabel("What should the crowd try?")).toHaveValue(mission);
    await continueSetup(page);
    await expect(page.getByLabel("Text to observe")).toHaveValue("Garden planning");
    await continueSetup(page);
    await page.getByText("Alex: objective, limits & character", { exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Objective for Alex", exact: true })).toHaveValue("Verify the Garden planning project.");
    await expect(page.getByLabel("Maximum steps", { exact: true })).toHaveValue("4");
    await expect(page.getByLabel("Maximum model calls", { exact: true })).toHaveValue("6");
    await expect(page.getByLabel("Maximum duration (seconds)", { exact: true })).toHaveValue("20");
    await page.getByText("Override canonical criteria JSON", { exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Criteria for Alex", exact: true })).toHaveValue(override);
    await continueSetup(page);
    expect(fixture.submissions).toBe(0);
    fixture.rejectNextLaunch();
    await page.getByRole("button", { name: "Launch 1 persona", exact: true }).click();
    await expect(page.locator(".error[role=alert]")).toContainText("server rejected");
    await expect(page.getByRole("button", { name: "Reconcile saved launch" })).toHaveCount(0);
    expect(fixture.requests[0].body).toMatchObject({
      authorizationAcknowledged: true, scope: { targetPath: "/project-board", pathPrefixes: ["/project-board"] },
      assignments: [{ personaId: "careful-first-timer", goal: "Verify the Garden planning project.",
        criteria: JSON.parse(override), limits: { maxSteps: 4, maxModelCalls: 6, maxDurationMs: 20000 } }],
    });
    await page.getByRole("button", { name: "Back to Mission", exact: true }).click();
    await expect(page.getByLabel("What should the crowd try?")).toHaveValue(mission);
    await continueSetup(page);
    await expect(page.getByLabel("Text to observe")).toHaveValue("Garden planning");
  } finally { await fixture.close(); }
});

test("mobile keyboard advances one centered panel without page overflow or early launch", async ({ page }, info) => {
  const fixture = await offlineApi(page, info.outputPath("api"));
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await unlock(page);
    await page.getByRole("button", { name: "Controlled demo", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("combobox", { name: "Controlled site", exact: true })).toBeVisible();
    for (const title of ["Set the mission", "Define success", "Pick your people", "Review your run"]) {
      await page.getByRole("button", { name: "Continue", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeFocused();
      await expect(page.getByRole("region", { name: /^(Target|Mission|Criteria|Personas|Review) setup$/ })).toHaveCount(1);
      await expect(page.getByRole("checkbox", { name: /I am authorized|acknowledge|accept.*terms/i })).toHaveCount(0);
      expect(fixture.submissions).toBe(0);
      expect(await page.evaluate(() => ({
        horizontal: document.documentElement.scrollWidth <= window.innerWidth,
        vertical: document.documentElement.scrollHeight <= window.innerHeight,
      }))).toEqual({ horizontal: true, vertical: true });
    }
    await page.getByRole("button", { name: "Launch 1 persona", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/runs\/[a-f0-9-]+$/);
  } finally { await fixture.close(); }
});
