import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { personaProfileSchema, personaSchema, type Persona } from "../../src/lib/contracts";
import {
  MANAGED_EXECUTION_POLICY, MANAGED_POLICY_NOTICE, managedCreateSchema,
  type ManagedCapabilities, type ManagedCreate, type ManagedRun,
} from "../../src/lib/managed-contracts";
import { personas, personaTemplates } from "../../src/lib/personas";
import { surferColors } from "../../src/lib/persona-sprites";

const owner = "11111111-1111-4111-8111-111111111111";
const nextOwner = "22222222-2222-4222-8222-222222222222";
const pendingKey = (id = owner) => `flash-flood:managed-pending:${id}`;
const profiles = personas.map((persona) => personaSchema.parse(persona));
const defaultBody: ManagedCreate = {
  executionPolicy: MANAGED_EXECUTION_POLICY, authorizationAcknowledged: true, managedPolicyAcknowledged: true,
  scope: { targetUrl: "https://example.com/help", pathPrefixes: ["/"], allowedSubdomains: [] },
  assignments: [{ personaId: profiles[0].id, goal: "Read delivery information.", criteria: ["Delivery costs are clear."] }],
};

function makeRun(body = defaultBody, people = profiles): ManagedRun {
  return {
    id: randomUUID(), executionPolicy: MANAGED_EXECUTION_POLICY, scope: body.scope,
    createdAt: "2026-09-20T01:00:00.000Z", updatedAt: "2026-09-20T01:00:00.000Z", status: "queued",
    attempts: body.assignments.map((assignment) => ({
      id: randomUUID(), persona: structuredClone(people.find((persona) => persona.id === assignment.personaId)!),
      goal: assignment.goal, criteria: assignment.criteria, status: "queued",
      providerStatus: null, cleanup: "not_started", cancelRequested: false, progress: [], result: null,
      error: null, reservedSeconds: 300, actualBrowserSeconds: null, modelCalls: null,
    })),
  };
}

async function mockManaged(page: Page, options: { enabled?: boolean; run?: ManagedRun; lostReply?: boolean; malformedReply?: boolean; delayPoll?: number } = {}) {
  let currentOwner = owner;
  let run = options.run ?? null;
  let runOwner = owner;
  let loseNextReply = options.lostReply ?? false;
  let malformedReply = options.malformedReply ?? false;
  let report: ManagedRun | null = null;
  let viewer: unknown = {
    liveViewUrl: "",
    replayUrl: "https://www.browserbase.com/sessions/private",
  };
  let viewRequests = 0;
  let reports = 0;
  let polls = 0;
  let activePolls = 0;
  let maximumActivePolls = 0;
  const unexpected: string[] = [];
  const customProfiles = new Map<string, Persona[]>();
  const ownerProfiles = () => [...profiles, ...(customProfiles.get(currentOwner) ?? [])];
  const personaMutations: { method: string; persona: Persona }[] = [];
  const submissions: { body: ManagedCreate; key: string | undefined; stored: string | null; csrf: string | undefined }[] = [];
  const capabilities: ManagedCapabilities = {
    enabled: options.enabled ?? true, allowedOrigins: ["https://example.com"], maxAgents: 8,
    policy: MANAGED_EXECUTION_POLICY, notice: MANAGED_POLICY_NOTICE,
  };
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      unexpected.push(request.url());
      await route.abort();
      return;
    }
    if (!url.pathname.startsWith("/api/v1/")) { await route.continue(); return; }
    const path = url.pathname.slice("/api/v1".length);
    const send = async (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
    if (path === "/session") {
      await send({ ownerId: currentOwner, csrfToken: `csrf-${currentOwner}`, expiresAt: Date.now() + 60_000 });
    } else if (path === "/managed-capabilities") await send(capabilities);
    else if (path === "/personas" && request.method() === "GET") await send({ items: ownerProfiles() });
    else if (path === "/personas" && request.method() === "POST") {
      expect(request.headers()["x-csrf-token"]).toBe(`csrf-${currentOwner}`);
      const persona = { ...personaProfileSchema.parse(request.postDataJSON()), id: randomUUID() };
      customProfiles.set(currentOwner, [...(customProfiles.get(currentOwner) ?? []), persona]);
      personaMutations.push({ method: "POST", persona });
      await send(persona);
    } else if (path.startsWith("/personas/") && request.method() === "PUT") {
      expect(request.headers()["x-csrf-token"]).toBe(`csrf-${currentOwner}`);
      const id = path.slice("/personas/".length);
      const persona = { ...personaProfileSchema.parse(request.postDataJSON()), id };
      expect((customProfiles.get(currentOwner) ?? []).some((value) => value.id === id)).toBe(true);
      customProfiles.set(currentOwner, (customProfiles.get(currentOwner) ?? []).map((value) => value.id === id ? persona : value));
      personaMutations.push({ method: "PUT", persona });
      await send(persona);
    } else if (path.startsWith("/personas/") && request.method() === "DELETE") {
      expect(request.headers()["x-csrf-token"]).toBe(`csrf-${currentOwner}`);
      const id = path.slice("/personas/".length);
      const persona = ownerProfiles().find((value) => value.id === id)!;
      customProfiles.set(currentOwner, (customProfiles.get(currentOwner) ?? []).filter((value) => value.id !== id));
      personaMutations.push({ method: "DELETE", persona });
      await send({ deleted: true });
    }
    else if (path === "/managed-runs" && request.method() === "GET") await send({ items: run && runOwner === currentOwner ? [run] : [] });
    else if (path === "/managed-runs" && request.method() === "POST") {
      const body = managedCreateSchema.parse(request.postDataJSON());
      submissions.push({
        body, key: request.headers()["idempotency-key"], csrf: request.headers()["x-csrf-token"],
        stored: await page.evaluate((key) => sessionStorage.getItem(key), pendingKey(currentOwner)),
      });
      if (!run || runOwner !== currentOwner) { run = makeRun(body, ownerProfiles()); runOwner = currentOwner; }
      if (loseNextReply) { loseNextReply = false; await route.abort("connectionreset"); }
      else if (malformedReply) { malformedReply = false; await send({ id: run.id, status: "completed" }); }
      else await send(run);
    } else if (run && path === `/managed-runs/${run.id}` && currentOwner === runOwner) {
      polls++;
      activePolls++;
      maximumActivePolls = Math.max(maximumActivePolls, activePolls);
      try {
        if (options.delayPoll) await new Promise((resolve) => setTimeout(resolve, options.delayPoll));
        await send(run);
      } finally { activePolls--; }
    } else if (run && path === `/managed-runs/${run.id}/cancel`) {
      expect(request.method()).toBe("POST");
      expect(request.postDataJSON()).toEqual({});
      expect(request.headers()["x-csrf-token"]).toBe(`csrf-${currentOwner}`);
      run = { ...run, updatedAt: "2026-09-20T01:02:00.000Z", attempts: run.attempts.map((attempt) => ({ ...attempt, cancelRequested: true })) };
      await send(run);
    } else if (run && path === `/managed-runs/${run.id}/report`) {
      reports++;
      await send(report ?? run);
    } else if (run && path.match(new RegExp(`^/managed-runs/${run.id}/attempts/[^/]+/view$`))) {
      viewRequests++;
      await send(viewer);
    } else {
      unexpected.push(`${request.method()} ${path}`);
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found" } }) });
    }
  });
  return {
    submissions, unexpected, capabilities, personaMutations,
    get run() { return run!; },
    get viewRequests() { return viewRequests; },
    get reports() { return reports; },
    get polls() { return polls; },
    get maximumActivePolls() { return maximumActivePolls; },
    setOwner(value: string) { currentOwner = value; },
    setRun(value: ManagedRun) { run = value; },
    setReport(value: ManagedRun) { report = value; },
    setViewer(value: unknown) { viewer = value; },
  };
}

async function configure(page: Page) {
  await page.goto("/managed");
  await expect(page.getByLabel("Initial target URL")).toBeEnabled();
  await page.getByLabel("Initial target URL").fill("https://example.com/help");
  await page.getByLabel("What should the agents try?").fill("  Read delivery information.  ");
  await page.getByLabel("Success criteria (one per line, up to 6)").fill("  Delivery costs are clear. \n\n");
  await page.getByLabel("Select Dana", { exact: true }).check();
}

async function acknowledge(page: Page) {
  await page.getByLabel("I acknowledge the managed policy:").check();
  await page.getByLabel("I am authorized to test this initial target").check();
}

async function createFromTemplate(page: Page, templateId: string, name: string) {
  await page.getByRole("button", { name: "+ Create persona", exact: true }).click();
  await page.getByLabel("Start from a template (replaces the fields below)").selectOption(templateId);
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save persona", exact: true }).click();
  await expect(page.getByLabel(`Select ${name}`, { exact: true })).toBeChecked();
}

test("disabled managed execution still allows preparing goals and personas without starting anything", async ({ page }) => {
  const fixture = await mockManaged(page, { enabled: false });
  await page.goto("/managed");
  await expect(page.getByRole("status")).toContainText("Managed launch is disabled by the operator");
  await page.getByLabel("Initial target URL").fill("https://example.com/help");
  await page.getByLabel("What should the agents try?").fill("Review the help page.");
  await page.getByLabel("Success criteria (one per line, up to 6)").fill("The help page is clear.");
  await expect(page.getByRole("button", { name: "Launch managed agents" })).toBeDisabled();
  await expect(page.getByText("Browserbase tools cannot be disabled.", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("It is not arbitrary safe browsing.", { exact: false })).toBeVisible();
  await createFromTemplate(page, "ux-review", "Offline UX reviewer");
  await acknowledge(page);
  await expect(page.getByRole("button", { name: "Launch 1 managed agent", exact: true })).toBeDisabled();
  await page.getByLabel("Initial target URL").press("Enter");
  expect(fixture.personaMutations).toHaveLength(1);
  expect(fixture.submissions).toHaveLength(0);
  expect(fixture.unexpected).toEqual([]);
});

test("launch requires separate acknowledgements, an approved target, and at most eight personas", async ({ page }) => {
  const fixture = await mockManaged(page);
  await configure(page);
  const launch = page.getByRole("button", { name: /^Launch .*managed agent/ });
  await expect(launch).toBeDisabled();
  await page.getByLabel("I acknowledge the managed policy:").check();
  await expect(launch).toBeDisabled();
  await page.getByLabel("I am authorized to test this initial target").check();
  await expect(launch).toBeEnabled();
  await page.getByLabel("Initial target URL").fill("https://example.com.attacker.invalid/help");
  await expect(launch).toBeDisabled();
  await expect(page.getByText("This initial target is not an exact approved HTTP(S) origin.")).toBeVisible();
  await page.getByLabel("Initial target URL").fill("https://example.com/help");
  await page.getByLabel("Requested path prefixes (one per line)").fill("/help\n/delivery");
  for (const persona of profiles.slice(1, 8)) await page.getByLabel(`Select ${persona.name}`, { exact: true }).check();
  await expect(page.getByText("8 / 8 selected")).toBeVisible();
  await expect(page.getByLabel("Select Robin", { exact: true })).toBeDisabled();
  await launch.click();
  await expect(page).toHaveURL(/\/managed\/[a-f0-9-]+$/);
  expect(fixture.submissions).toHaveLength(1);
  const saved = fixture.submissions[0];
  expect(saved.body).toMatchObject({
    authorizationAcknowledged: true, managedPolicyAcknowledged: true,
    executionPolicy: MANAGED_EXECUTION_POLICY,
    scope: { allowedSubdomains: [], pathPrefixes: ["/help", "/delivery"] },
  });
  expect(saved.body.assignments).toHaveLength(8);
  expect(saved.body.assignments[0]).toMatchObject({ goal: "Read delivery information.", criteria: ["Delivery costs are clear."] });
  expect(saved.csrf).toBe(`csrf-${owner}`);
  expect(JSON.parse(saved.stored!)).toEqual({ ownerId: owner, key: saved.key, body: saved.body });
  expect(await page.evaluate((key) => sessionStorage.getItem(key), pendingKey())).toBeNull();
  expect(fixture.unexpected).toEqual([]);
});

test("a lost launch reply survives refresh and only explicitly reconciles the same body and key", async ({ page }) => {
  const fixture = await mockManaged(page, { lostReply: true });
  await configure(page);
  await acknowledge(page);
  await page.getByRole("button", { name: "Launch 1 managed agent", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reconcile saved launch", exact: true })).toBeEnabled();
  await expect(page.getByLabel("What should the agents try?")).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("button", { name: "Reconcile saved launch", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Unresolved managed launch")).toContainText("Read delivery information.");
  await expect(page.getByRole("heading", { name: "Your saved managed runs" })).toBeVisible();
  expect(fixture.submissions).toHaveLength(1);
  await page.getByRole("button", { name: "Reconcile saved launch", exact: true }).click();
  await expect(page).toHaveURL(`/managed/${fixture.run.id}`);
  expect(fixture.submissions).toHaveLength(2);
  expect(fixture.submissions[1]).toEqual(fixture.submissions[0]);
  expect(fixture.unexpected).toEqual([]);
});

test("malformed success responses keep the request locked until deliberate discard", async ({ page }) => {
  const fixture = await mockManaged(page, { malformedReply: true });
  await configure(page);
  await acknowledge(page);
  await page.getByRole("button", { name: "Launch 1 managed agent", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reconcile saved launch", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Initial target URL")).toBeDisabled();
  await page.getByText("Deliberately discard the saved request", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Discard saved request", exact: true })).toBeDisabled();
  await page.getByLabel("I understand discarding does not cancel a run").check();
  await page.getByRole("button", { name: "Discard saved request", exact: true }).click();
  await expect(page.getByLabel("Initial target URL")).toBeEnabled();
  expect(fixture.submissions).toHaveLength(1);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), pendingKey())).toBeNull();
});

test("a different owner never reuses a pending launch or sees the previous owner's saved runs", async ({ page }) => {
  const fixture = await mockManaged(page, { lostReply: true });
  await configure(page);
  await acknowledge(page);
  await page.getByRole("button", { name: "Launch 1 managed agent", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reconcile saved launch", exact: true })).toBeEnabled();
  fixture.setOwner(nextOwner);
  await page.reload();
  await expect(page.getByLabel("Initial target URL")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Reconcile saved launch", exact: true })).toHaveCount(0);
  await expect(page.getByText("No managed runs saved yet.", { exact: true })).toBeVisible();
  expect(fixture.submissions).toHaveLength(1);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), pendingKey())).not.toBeNull();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), pendingKey(nextOwner))).toBeNull();
});

test("unavailable tab storage prevents submission before any paid request", async ({ page }) => {
  const fixture = await mockManaged(page);
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("flash-flood:managed-pending:")) throw new Error("storage unavailable");
      return original.call(this, key, value);
    };
  });
  await configure(page);
  await acknowledge(page);
  await page.getByRole("button", { name: "Launch 1 managed agent", exact: true }).click();
  await expect(page.locator(".error[role=alert]")).toContainText("Nothing was submitted");
  await expect(page.getByLabel("Initial target URL")).toBeDisabled();
  expect(fixture.submissions).toHaveLength(0);
  expect(fixture.unexpected).toEqual([]);
});

for (const template of personaTemplates) {
  test(`managed persona editor saves the ${template.id} template as a custom profile`, async ({ page }) => {
    const fixture = await mockManaged(page);
    await configure(page);
    await createFromTemplate(page, template.id, `My ${template.profile.name}`);
    expect(fixture.personaMutations).toHaveLength(1);
    expect(fixture.personaMutations[0]).toMatchObject({
      method: "POST", persona: { ...template.profile, name: `My ${template.profile.name}` },
    });
    expect(fixture.personaMutations[0].persona.id).toMatch(/^[a-f0-9-]{36}$/);
    await expect(page.getByText("Analysis focus does not grant tools or permissions.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Launch 2 managed agents", exact: true })).toBeDisabled();
    expect(fixture.submissions).toHaveLength(0);
    expect(fixture.unexpected).toEqual([]);
  });
}

test("different per-persona assignments survive a lost reply with the same canonical idempotency request", async ({ page }) => {
  const fixture = await mockManaged(page, { lostReply: true });
  await configure(page);
  await createFromTemplate(page, "security-review", "Trust reviewer");
  await page.getByText("Dana: goal, criteria & character", { exact: true }).click();
  await page.getByRole("textbox", { name: "Goal for Dana", exact: true }).fill("Observe visible loading and recovery feedback.");
  await page.getByLabel("Criteria for Dana (one per line, up to 6)").fill("No indefinite loading indicator remains.");
  await page.getByText("Trust reviewer: goal, criteria & character", { exact: true }).click();
  await page.getByRole("textbox", { name: "Goal for Trust reviewer", exact: true }).fill("Review visible privacy and permission disclosures without interaction.");
  await page.getByLabel("Criteria for Trust reviewer (one per line, up to 6)").fill("The purpose of requested permissions is visible.\nThe privacy policy is clearly labelled.");
  await page.getByLabel("What should the agents try?").fill("");
  await page.getByRole("textbox", { name: "Success criteria (one per line, up to 6)", exact: true }).fill("");
  await acknowledge(page);
  await page.getByRole("button", { name: "Launch 2 managed agents", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reconcile saved launch", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "+ Create persona", exact: true })).toBeDisabled();
  const request = fixture.submissions[0];
  expect(request.body.assignments.map((assignment) => assignment.goal)).toEqual([
    "Observe visible loading and recovery feedback.",
    "Review visible privacy and permission disclosures without interaction.",
  ]);
  expect(request.body.assignments[1].criteria).toEqual([
    "The purpose of requested permissions is visible.", "The privacy policy is clearly labelled.",
  ]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Reconcile saved launch", exact: true })).toBeEnabled();
  await page.getByText("Trust reviewer: goal, criteria & character", { exact: true }).click();
  await page.getByText("Dana: goal, criteria & character", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Goal for Trust reviewer", exact: true })).toHaveValue(request.body.assignments[1].goal);
  await expect(page.getByLabel("Criteria for Trust reviewer (one per line, up to 6)")).toHaveValue(request.body.assignments[1].criteria.join("\n"));
  await expect(page.getByRole("textbox", { name: "Goal for Dana", exact: true })).toHaveValue(request.body.assignments[0].goal);
  await expect(page.getByRole("textbox", { name: "Goal for Trust reviewer", exact: true })).toBeDisabled();
  expect(fixture.submissions).toHaveLength(1);
  await page.getByRole("button", { name: "Reconcile saved launch", exact: true }).click();
  await expect(page).toHaveURL(`/managed/${fixture.run.id}`);
  expect(fixture.submissions).toHaveLength(2);
  expect(fixture.submissions[1]).toEqual(request);
  const specialist = page.getByRole("article", { name: "Trust reviewer's managed attempt" });
  await expect(specialist).toContainText(request.body.assignments[1].goal);
  await expect(specialist.locator(".persona-avatar")).toHaveAttribute("data-sprite-color", surferColors[1]);
  await expect(specialist.locator(".persona-avatar")).toHaveAttribute("data-sprite-state", "idle");
  expect(fixture.unexpected).toEqual([]);
});

test("preset customization creates a copy, while later edits and deletion leave run snapshots unchanged", async ({ page }) => {
  const fixture = await mockManaged(page);
  await configure(page);
  await page.getByText("Dana: goal, criteria & character", { exact: true }).click();
  await page.getByRole("button", { name: "Customize a copy", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("My Dana");
  await page.getByRole("button", { name: "Save persona", exact: true }).click();
  await expect(page.getByLabel("Select My Dana", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Select Dana", { exact: true })).toBeChecked();
  const copy = fixture.personaMutations[0].persona;
  expect(copy.id).not.toBe(profiles[0].id);
  await page.getByText("My Dana: goal, criteria & character", { exact: true }).click();
  await page.getByRole("button", { name: "Edit saved persona", exact: true }).click();
  await page.getByRole("textbox", { name: "Character", exact: true }).fill("Checks visible loading feedback without repeated requests.");
  await page.getByRole("button", { name: "Save persona", exact: true }).click();
  await expect(page.getByRole("button", { name: "+ Create persona", exact: true })).toBeEnabled();
  expect(fixture.personaMutations[1]).toMatchObject({ method: "PUT", persona: { id: copy.id } });
  await acknowledge(page);
  await page.getByRole("button", { name: "Launch 2 managed agents", exact: true }).click();
  await expect(page).toHaveURL(/\/managed\/[a-f0-9-]+$/);
  const snapshot = structuredClone(fixture.run.attempts.find((attempt) => attempt.persona.id === copy.id)!.persona);
  await page.getByRole("link", { name: "Managed workspace", exact: true }).click();
  await page.getByLabel("Select My Dana", { exact: true }).check();
  await page.getByText("My Dana: goal, criteria & character", { exact: true }).click();
  await page.getByRole("button", { name: "Edit saved persona", exact: true }).click();
  await page.getByRole("textbox", { name: "Character", exact: true }).fill("A changed profile for future runs only.");
  await page.getByRole("button", { name: "Save persona", exact: true }).click();
  await page.getByRole("button", { name: "Delete My Dana", exact: true }).click();
  await expect(page.getByLabel("Select My Dana", { exact: true })).toHaveCount(0);
  expect(fixture.personaMutations.map((mutation) => mutation.method)).toEqual(["POST", "PUT", "PUT", "DELETE"]);
  expect(fixture.run.attempts.find((attempt) => attempt.persona.id === copy.id)!.persona).toEqual(snapshot);
  await page.goto(`/managed/${fixture.run.id}`);
  await expect(page.getByRole("article", { name: "My Dana's managed attempt" })).toContainText(snapshot.character);
  expect(fixture.unexpected).toEqual([]);
});

test("surfer slots stay distinct and only running non-cancelled attempts use the working sprite", async ({ page }) => {
  const run = makeRun({
    ...defaultBody,
    assignments: profiles.slice(0, 8).map((persona) => ({ ...defaultBody.assignments[0], personaId: persona.id })),
  });
  run.status = "running";
  run.attempts[1] = { ...run.attempts[1], status: "running", cleanup: "unconfirmed" };
  run.attempts[2] = { ...run.attempts[2], status: "running", cleanup: "unconfirmed", cancelRequested: true };
  run.attempts[3] = { ...run.attempts[3], status: "completed", cleanup: "closed" };
  run.attempts[4] = { ...run.attempts[4], status: "failed", cleanup: "closed" };
  run.attempts[5] = { ...run.attempts[5], status: "cancelled", cleanup: "closed" };
  run.attempts[6] = { ...run.attempts[6], status: "cleanup_required", cleanup: "unconfirmed" };
  const fixture = await mockManaged(page, { run });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/managed/${run.id}`);
  for (const [slot, attempt] of run.attempts.entries()) {
    const avatar = page.locator(`[data-managed-attempt-id="${attempt.id}"] .persona-avatar`);
    await expect(avatar).toHaveAttribute("data-sprite-color", surferColors[slot]);
    await expect(avatar).toHaveAttribute("data-sprite-state", slot === 1 ? "working" : "idle");
    await expect.poll(() => avatar.locator("img").evaluate((image: HTMLImageElement) => image.currentSrc)).toContain("/surfers/static/");
  }
  expect(fixture.unexpected).toEqual([]);
});

test("wall shows actual progress, failure and cleanup independently, and never treats completion as success", async ({ page }) => {
  const run = makeRun({
    ...defaultBody, assignments: [
      defaultBody.assignments[0],
      { ...defaultBody.assignments[0], personaId: profiles[1].id },
    ],
  });
  run.status = "running";
  run.attempts[0] = { ...run.attempts[0], status: "completed", providerStatus: "completed", cleanup: "unconfirmed", actualBrowserSeconds: 12.25,
    progress: [{ sequence: 1, timestamp: run.createdAt, kind: "tool", text: "Provider tool: navigate to the approved help page." }],
    result: {
      summary: "The delivery page was reached, but no price was stated.", finalUrl: "https://untrusted.invalid/agent-output",
      criteria: [{ criterion: "Delivery costs are clear.", status: "not_met", observation: "The page says costs are calculated later." }],
      limitations: ["No independent verification was performed."],
    },
  };
  run.attempts[1] = { ...run.attempts[1], status: "failed", providerStatus: "error", cleanup: "closed", error: "provider_execution_failed" };
  const fixture = await mockManaged(page, { run });
  await page.goto(`/managed/${run.id}`);
  const dana = page.getByRole("article", { name: "Dana's managed attempt" });
  const alex = page.getByRole("article", { name: "Alex's managed attempt" });
  await expect(page.getByTestId("managed-run-wall")).toHaveAttribute("data-run-id", run.id);
  await expect(page.getByTestId("managed-run-wall")).toHaveAttribute("data-run-loaded", "true");
  await expect(dana).toHaveAttribute("data-attempt-id", run.attempts[0].id);
  await expect(dana).toHaveAttribute("data-managed-attempt-id", run.attempts[0].id);
  await expect(dana.getByTestId("managed-progress-event")).toHaveCount(run.attempts[0].progress.length);
  await expect(dana.getByTestId("managed-progress-event")).toHaveAttribute("data-event-sequence", "1");
  await expect(dana.getByTestId("managed-progress-event")).toHaveAttribute("data-managed-progress-sequence", "1");
  await expect(dana.getByTestId("managed-progress-text")).toHaveText(run.attempts[0].progress[0].text);
  await expect(dana.getByTestId("managed-result")).toHaveAttribute("data-has-result", "true");
  await expect(dana.getByTestId("managed-result-summary")).toHaveText(run.attempts[0].result!.summary);
  await expect(dana.getByTestId("managed-result-criterion")).toHaveAttribute("data-criterion-status", "not_met");
  await expect(dana.getByText("Provider tool: navigate to the approved help page.")).toBeVisible();
  await expect(dana.getByText("12.25 seconds", { exact: true })).toBeVisible();
  await expect(dana.getByText("Unknown — not reported", { exact: true })).toBeVisible();
  await expect(dana.getByText("Unconfirmed — browser closure has not been confirmed.", { exact: true })).toBeVisible();
  await expect(dana.getByText("Reported not met", { exact: true })).toBeVisible();
  await expect(dana.getByRole("heading", { name: "Agent-reported, not independently verified" })).toBeVisible();
  await expect(alex.getByText("provider_execution_failed", { exact: true })).toBeVisible();
  await expect(alex.getByText("Closed — browser cleanup confirmed.", { exact: true })).toBeVisible();
  await expect(alex.getByText("Unavailable", { exact: true })).toBeVisible();
  await expect(page.locator("a[href*='untrusted.invalid']")).toHaveCount(0);
  await expect(page.locator(".managed-attempt-body").locator("iframe, img, video, audio")).toHaveCount(0);
  expect(fixture.viewRequests).toBe(0);
  await expect(dana.getByRole("button", { name: "Reveal owner-only replay", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Request cancellation", exact: true }).click();
  await expect(dana.getByText("Cancellation requested.", { exact: false })).toBeVisible();
  await expect(dana.getByText("Unconfirmed — browser closure has not been confirmed.", { exact: true })).toBeVisible();
  const report = structuredClone(fixture.run);
  report.updatedAt = "2026-09-20T01:03:00.000Z";
  report.status = "cancelled";
  report.attempts[0].status = "cancelled";
  report.attempts[0].cleanup = "closed";
  report.attempts[0].result!.summary = "A later provider report still does not verify success.";
  fixture.setReport(report);
  await page.getByRole("button", { name: "Refresh provider-reported report", exact: true }).click();
  await expect(dana.getByText("A later provider report still does not verify success.")).toBeVisible();
  expect(fixture.reports).toBe(1);
  await dana.getByRole("button", { name: "Reveal owner-only replay", exact: true }).click();
  await expect(dana.getByRole("link", { name: "Open read-only live view" })).toHaveCount(0);
  await expect(dana.getByRole("link", { name: "Open Browserbase replay" })).toBeVisible();
  expect(fixture.viewRequests).toBe(1);
  expect(fixture.unexpected).toEqual([]);
});

test("replay rejects lookalike hosts and live control capabilities", async ({ page }) => {
  const run = makeRun();
  run.attempts[0].cleanup = "closed";
  const fixture = await mockManaged(page, { run });
  await page.goto(`/managed/${run.id}`);
  for (const value of [
    { liveViewUrl: "", replayUrl: "https://browserbase.com.attacker.invalid/replay" },
    { liveViewUrl: "https://www.browserbase.com/live/private", replayUrl: "https://www.browserbase.com/sessions/private" },
  ]) {
    fixture.setViewer(value);
    await page.getByRole("button", { name: "Reveal owner-only replay", exact: true }).click();
    await expect(page.locator(".error[role=alert]")).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "Open read-only live view" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open Browserbase replay" })).toHaveCount(0);
  expect(fixture.viewRequests).toBe(2);
  expect(fixture.unexpected).toEqual([]);
});

test("managed-runs route alias renders the same owner wall and proof selectors", async ({ page }) => {
  const run = makeRun();
  run.attempts[0].progress = [{
    sequence: 1, timestamp: run.createdAt, kind: "text", text: "Offline fixture progress for route-alias verification.",
  }];
  const fixture = await mockManaged(page, { run });
  await page.goto(`/managed-runs/${run.id}`);
  await expect(page).toHaveURL(`/managed-runs/${run.id}`);
  await expect(page.getByTestId("managed-run-wall")).toHaveAttribute("data-run-loaded", "true");
  await expect(page.getByTestId("managed-run-wall")).toHaveAttribute("data-run-id", run.id);
  const card = page.locator(`[data-managed-attempt-id="${run.attempts[0].id}"]`);
  await expect(card.locator('[data-managed-progress-sequence="1"]')).toContainText(run.attempts[0].progress[0].text);
  expect(fixture.unexpected).toEqual([]);
});

test("wall polling does not overlap slow requests and stops after navigation", async ({ page }) => {
  const run = makeRun();
  const fixture = await mockManaged(page, { run, delayPoll: 1700 });
  await page.goto(`/managed/${run.id}`);
  await expect(page.getByRole("article", { name: "Dana's managed attempt" })).toBeVisible();
  await expect.poll(() => fixture.polls, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
  expect(fixture.maximumActivePolls).toBe(1);
  await page.getByRole("link", { name: "Managed workspace", exact: true }).click();
  await expect(page.getByLabel("Initial target URL")).toBeEnabled();
  const stoppedAt = fixture.polls;
  await page.waitForTimeout(3300);
  expect(fixture.polls).toBe(stoppedAt);
  expect(fixture.unexpected).toEqual([]);
});
