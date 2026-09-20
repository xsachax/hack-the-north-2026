import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { personaProfileSchema, personaSchema, type Persona } from "../../src/lib/contracts";
import {
  MANAGED_EXECUTION_POLICY, MANAGED_POLICY_NOTICE, managedCreateSchema,
  type ManagedCapabilities, type ManagedCreate, type ManagedRun,
} from "../../src/lib/managed-contracts";
import { personas, personaTemplates } from "../../src/lib/personas";
import { surferColors } from "../../src/lib/persona-sprites";
import { managedIanaDemoAssignments, managedIanaDemoScope, managedSpecialists } from "../../src/lib/managed-specialists";

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

async function mockManaged(page: Page, options: {
  enabled?: boolean; allowedOrigins?: string[]; run?: ManagedRun; lostReply?: boolean; malformedReply?: boolean; delayPoll?: number;
} = {}) {
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
    enabled: options.enabled ?? true, allowedOrigins: options.allowedOrigins ?? ["https://example.com", "https://www.iana.org"], maxAgents: 8,
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

async function advanced(page: Page) {
  if (await page.locator(".managed-advanced").getAttribute("open") === null) {
    await page.getByText("Advanced: missions & personas", { exact: true }).click();
  }
}

async function configure(page: Page) {
  await page.goto("/managed");
  await expect(page.getByLabel("Initial target URL")).toBeEnabled();
  await page.getByLabel("Initial target URL").fill("https://example.com/help");
  await advanced(page);
  await page.getByLabel("Shared goal for additional personas").fill("  Read delivery information.  ");
  await page.getByLabel("Shared criteria for additional personas (one per line, up to 6)").fill("  Delivery costs are clear. \n\n");
  await page.getByLabel("Select Dana", { exact: true }).check();
}

async function review(page: Page) {
  const details = page.locator(".managed-mission-review");
  if (await details.getAttribute("open") === null) await details.locator(":scope > summary").click();
  await expect(details.locator(".onboarding-review")).toBeVisible();
}

async function createFromTemplate(page: Page, templateId: string, name: string) {
  await advanced(page);
  await page.getByRole("button", { name: "+ Create persona", exact: true }).click();
  await page.getByLabel("Start from a template (replaces the fields below)").selectOption(templateId);
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save persona", exact: true }).click();
  await expect(page.getByLabel(`Select ${name}`, { exact: true })).toBeChecked();
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`single-panel onboarding launches concrete assignments by keyboard at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const fixture = await mockManaged(page, {
      allowedOrigins: ["https://example.com", "https://www.iana.org", "https://www.browserbase.com", "https://browserbase.com"],
    });
    await page.goto("/managed");
    const target = page.getByLabel("Initial target URL");
    const approved = page.getByRole("combobox", { name: "Approved website", exact: true });
    await expect(target).toBeEnabled();
    await expect(target).toHaveValue("https://www.browserbase.com/");
    await expect(approved).toHaveValue("https://www.browserbase.com");
    await expect(page.locator("form.managed-composer")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^(Continue|Back(?: to .*)?)$/ })).toHaveCount(0);
    await expect(page.locator(".onboarding-progress, [aria-current=step], [role=progressbar]")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Make waves. Find friction.");
    await expect(page.getByRole("heading", { name: "Choose your crew", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Launch agents", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Launch agents", exact: true })).toBeDisabled();
    await target.fill("https://example.com/help");
    await target.press("Enter");
    await expect(target).toBeFocused();
    await expect(target).toBeVisible();
    await expect(page.getByLabel("Shared goal for additional personas")).toBeHidden();
    await expect(page.getByLabel("Requested path prefixes (one per line)")).toBeHidden();
    await expect(page.getByRole("button", { name: "+ Create persona", exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "Prepare five-agent IANA demo", exact: true })).toBeHidden();
    await expect(page.locator(".onboarding-review")).toBeHidden();
    const cards = page.locator(".managed-specialist");
    await expect(cards).toHaveCount(5);
    await expect(page.getByText("0 / 8 selected", { exact: true })).toBeVisible();
    for (const specialist of managedSpecialists) {
      await expect(page.getByLabel(`Select ${specialist.label}`, { exact: true })).not.toBeChecked();
    }
    const grid = await page.locator(".managed-specialist-grid").boundingBox();
    expect(grid).not.toBeNull();
    const boxes = await cards.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    }));
    for (const box of boxes) {
      expect(box.width).toBeGreaterThan(120);
      expect(box.height).toBeGreaterThan(65);
      expect(box.x).toBeGreaterThanOrEqual(grid!.x);
      expect(box.right).toBeLessThanOrEqual(grid!.x + grid!.width + 1);
      expect(box.y).toBeGreaterThanOrEqual(grid!.y);
      expect(box.bottom).toBeLessThanOrEqual(grid!.y + grid!.height + 1);
    }
    expect(boxes[0].right).toBeLessThanOrEqual(boxes[1].x);
    if (viewport.width > 800) {
      for (const [index, box] of boxes.entries()) {
        expect(box.y).toBeCloseTo(boxes[0].y, 0);
        expect(box.width).toBeCloseTo(boxes[0].width, 0);
        if (index) expect(boxes[index - 1].right).toBeLessThanOrEqual(box.x);
      }
    } else {
      expect(boxes[0].y).toBeCloseTo(boxes[1].y, 0);
      expect(boxes[2].y).toBeCloseTo(boxes[3].y, 0);
      expect(boxes[0].bottom).toBeLessThanOrEqual(boxes[2].y);
      expect(boxes[2].right).toBeLessThanOrEqual(boxes[3].x);
      expect(boxes[2].bottom).toBeLessThanOrEqual(boxes[4].y);
      expect(boxes[4].x).toBeCloseTo(grid!.x, 0);
      expect(boxes[4].width).toBeCloseTo(grid!.width, 0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("specialists.png"), fullPage: true, animations: "disabled" });
    await page.keyboard.press("Tab");
    await expect(approved).toBeFocused();
    for (const [index, specialist] of managedSpecialists.entries()) {
      const checkbox = page.getByLabel(`Select ${specialist.label}`, { exact: true });
      await page.keyboard.press("Tab");
      await expect(checkbox).toBeFocused();
      await expect(checkbox).toHaveAccessibleDescription(specialist.purpose);
      await page.keyboard.press("Space");
      await expect(checkbox).toBeChecked();
      await expect(page.getByText(`${index + 1} / 8 selected`, { exact: true })).toBeVisible();
      await expect(cards.nth(index).getByText(specialist.purpose, { exact: true })).toBeVisible();
      await expect(cards.nth(index).locator(".managed-specialist-checks")).toHaveAttribute("data-customized", "false");
      await expect(cards.nth(index).locator(".managed-specialist-checks")).toBeHidden();
      for (const check of specialist.checks) {
        const chip = cards.nth(index).getByText(check, { exact: true });
        await expect(chip).toBeHidden();
      }
      await expect(cards.nth(index).locator(".persona-avatar")).toHaveAttribute("data-sprite-state", "idle");
      await expect.poll(() => cards.nth(index).locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    }
    await page.keyboard.press("Tab");
    await expect(page.getByText("Advanced: missions & personas", { exact: true })).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.getByLabel("Shared goal for additional personas")).toBeVisible();
    await page.keyboard.press("Space");
    await expect(page.getByLabel("Shared goal for additional personas")).toBeHidden();
    await page.keyboard.press("Tab");
    await expect(page.getByText("Review selected missions (5)", { exact: true })).toBeFocused();
    await expect(page.locator(".onboarding-review")).toBeHidden();
    expect(fixture.submissions).toHaveLength(0);
    const launch = page.getByRole("button", { name: "Launch 5 agents", exact: true });
    await page.keyboard.press("Tab");
    await expect(launch).toBeFocused();
    await expect(launch).toBeEnabled();
    await expect(target).toBeVisible();
    await expect(page.getByRole("checkbox")).toHaveCount(5);
    for (const specialist of managedSpecialists) await expect(page.getByLabel(`Select ${specialist.label}`, { exact: true })).toBeChecked();
    if (viewport.width < 520) {
      expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("onboarding.png"), fullPage: true, animations: "disabled" });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/managed\/[a-f0-9-]+$/);
    expect(new URL(page.url()).pathname).toBe(`/managed/${fixture.run.id}`);
    expect(fixture.submissions).toHaveLength(1);
    expect(fixture.submissions[0].body.assignments).toEqual(managedSpecialists.map(({ personaId, goal, criteria }) => ({ personaId, goal, criteria })));
    for (const specialist of managedSpecialists) await expect(page.getByRole("heading", { name: specialist.label, exact: true })).toBeVisible();
    expect(fixture.personaMutations).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const enabled of [true, false]) {
  test(`Approved website is the actual allowlist when managed execution is ${enabled ? "enabled" : "disabled"}`, async ({ page }) => {
    const allowedOrigins = ["https://example.com", "https://www.iana.org", "https://www.browserbase.com", "https://browserbase.com"];
    const fixture = await mockManaged(page, { enabled, allowedOrigins });
    await page.goto("/managed");
    const target = page.getByLabel("Initial target URL");
    const approved = page.getByRole("combobox", { name: "Approved website", exact: true });
    await expect(target).toBeEnabled();
    await expect(target).toHaveValue("https://www.browserbase.com/");
    await expect(approved).toBeEnabled();
    expect(await approved.evaluate((select: HTMLSelectElement) => select.tagName)).toBe("SELECT");
    const options = approved.locator("option:not([value=''])");
    await expect(options).toHaveText(allowedOrigins.map((origin) => new URL(origin).host));
    expect(await options.evaluateAll((elements) => elements.map((option) => (option as HTMLOptionElement).value))).toEqual(allowedOrigins);
    await page.getByLabel("Select UI/UX", { exact: true }).check();
    for (const origin of allowedOrigins) {
      await approved.selectOption(origin);
      await expect(target).toHaveValue(`${origin}/`);
      await expect(target).toHaveAttribute("aria-invalid", "false");
      if (enabled) await expect(page.getByRole("button", { name: "Launch 1 agent", exact: true })).toBeEnabled();
      else await expect(page.getByRole("button", { name: "Launch 1 agent", exact: true })).toBeDisabled();
    }
    await advanced(page);
    await expect(page.getByRole("button", { name: "Prepare five-agent IANA demo", exact: true })).toBeEnabled();
    expect(fixture.submissions).toHaveLength(0);
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const approvedBrowserbase of [null, "https://browserbase.com"]) {
  test(`Browserbase is ${approvedBrowserbase ? "prefilled only at its approved non-www origin" : "not implicitly approved or prefilled"}`, async ({ page }) => {
    const allowedOrigins = ["https://example.com", "https://www.iana.org", ...(approvedBrowserbase ? [approvedBrowserbase] : [])];
    const fixture = await mockManaged(page, { allowedOrigins });
    await page.goto("/managed");
    const target = page.getByLabel("Initial target URL");
    const approved = page.getByRole("combobox", { name: "Approved website", exact: true });
    await expect(target).toBeEnabled();
    await expect(target).toHaveValue(approvedBrowserbase ? `${approvedBrowserbase}/` : "");
    await expect(approved).toHaveValue(approvedBrowserbase ?? "");
    await expect(approved.locator("option[value='https://www.browserbase.com']")).toHaveCount(0);
    await page.getByLabel("Select UI/UX", { exact: true }).check();
    await target.fill("https://www.browserbase.com/");
    await expect(target).toHaveAttribute("aria-invalid", "true");
    await expect(approved).toHaveValue("");
    await expect(page.getByRole("button", { name: "Launch 1 agent", exact: true })).toBeDisabled();
    if (!approvedBrowserbase) {
      await expect(approved.locator("option[value='https://browserbase.com']")).toHaveCount(0);
      await target.fill("browserbase.com");
      await expect(target).toHaveAttribute("aria-invalid", "true");
      await expect(page.getByRole("button", { name: "Launch 1 agent", exact: true })).toBeDisabled();
    }
    expect(fixture.submissions).toHaveLength(0);
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const normalization of ["blur", "submit"]) {
  test(`a bare Browserbase host is canonicalized on ${normalization} before launch`, async ({ page }) => {
    const fixture = await mockManaged(page, { allowedOrigins: ["https://example.com", "https://www.iana.org", "https://browserbase.com"] });
    await page.goto("/managed");
    const target = page.getByLabel("Initial target URL");
    await expect(target).toBeEnabled();
    await page.getByLabel("Select UI/UX", { exact: true }).check();
    await target.fill("browserbase.com");
    await expect(target).toHaveValue("browserbase.com");
    await expect(target).toHaveAttribute("aria-invalid", "false");
    await expect(page.getByRole("combobox", { name: "Approved website", exact: true })).toHaveValue("https://browserbase.com");
    await expect(page.getByRole("button", { name: "Launch 1 agent", exact: true })).toBeEnabled();
    expect(fixture.submissions).toHaveLength(0);
    if (normalization === "blur") {
      await target.press("Tab");
      await expect(target).toHaveValue("https://browserbase.com/");
      await page.getByRole("button", { name: "Launch 1 agent", exact: true }).click();
    } else {
      // Exercise submit normalization without a preceding blur.
      await target.evaluate((input: HTMLInputElement) => input.form!.requestSubmit());
    }
    await expect(page).toHaveURL(/\/managed\/[a-f0-9-]+$/);
    expect(new URL(page.url()).pathname).toBe(`/managed/${fixture.run.id}`);
    expect(fixture.submissions).toHaveLength(1);
    expect(fixture.submissions[0].body.scope).toEqual({
      targetUrl: "https://browserbase.com/", pathPrefixes: ["/"], allowedSubdomains: [],
    });
    expect(JSON.parse(fixture.submissions[0].stored!).body).toEqual(fixture.submissions[0].body);
    expect(fixture.unexpected).toEqual([]);
  });
}

test("unknown, lookalike, credentialed and other unapproved origins cannot launch", async ({ page }) => {
  const fixture = await mockManaged(page, { allowedOrigins: ["https://browserbase.com"] });
  await page.goto("/managed");
  const target = page.getByLabel("Initial target URL");
  await expect(target).toBeEnabled();
  await page.getByLabel("Select UI/UX", { exact: true }).check();
  for (const value of [
    "unknown.invalid",
    "browserbase.com.attacker.invalid",
    "https://browserbase.com@attacker.invalid/",
    "https://guest:password@browserbase.com/",
    "https://www.browserbase.com/",
    "http://browserbase.com/",
    "https://browserbase.com:8443/",
    "ftp://browserbase.com/",
  ]) {
    await test.step(value, async () => {
      await target.fill(value);
      await target.press("Tab");
      await expect(target).toHaveAttribute("aria-invalid", "true");
      await expect(page.getByRole("combobox", { name: "Approved website", exact: true })).toHaveValue("");
      await expect(page.locator(".managed-target").getByRole("alert")).toContainText("This initial target is not an exact approved HTTP(S) origin.");
      await expect(page.getByRole("button", { name: "Launch 1 agent", exact: true })).toBeDisabled();
      expect(fixture.submissions).toHaveLength(0);
    });
  }
  await page.getByRole("combobox", { name: "Approved website", exact: true }).selectOption("https://browserbase.com");
  await expect(target).toHaveValue("https://browserbase.com/");
  await expect(page.locator(".managed-target").getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Launch 1 agent", exact: true })).toBeEnabled();
  expect(fixture.unexpected).toEqual([]);
});

test("an empty approved list disables the website picker and launch with an actionable message", async ({ page }) => {
  const fixture = await mockManaged(page, { allowedOrigins: [] });
  await page.goto("/managed");
  const target = page.getByLabel("Initial target URL");
  const approved = page.getByRole("combobox", { name: "Approved website", exact: true });
  await expect(target).toBeEnabled();
  await expect(target).toHaveValue("");
  await expect(approved).toBeDisabled();
  await expect(approved.locator("option:not([value=''])")).toHaveCount(0);
  await expect(page.getByText("No websites approved yet. Ask your operator to add one.", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("has no approved initial origins");
  await page.getByLabel("Select UI/UX", { exact: true }).check();
  await target.fill("browserbase.com");
  await expect(page.getByRole("button", { name: "Launch 1 agent", exact: true })).toBeDisabled();
  await advanced(page);
  await expect(page.getByRole("button", { name: "Prepare five-agent IANA demo", exact: true })).toHaveCount(0);
  expect(fixture.submissions).toHaveLength(0);
  expect(fixture.unexpected).toEqual([]);
});

test("Enter in the target URL never submits even with a launch-ready crew", async ({ page }) => {
  const fixture = await mockManaged(page, { allowedOrigins: ["https://browserbase.com"] });
  await page.goto("/managed");
  const target = page.getByLabel("Initial target URL");
  await expect(target).toBeEnabled();
  await page.getByLabel("Select Accessibility", { exact: true }).check();
  for (const value of ["browserbase.com", "https://browserbase.com/"]) {
    await target.fill(value);
    await expect(page.getByRole("button", { name: "Launch 1 agent", exact: true })).toBeEnabled();
    await target.press("Enter");
    await expect(target).toBeFocused();
    await expect(target).toBeEnabled();
    await expect(target).toHaveValue(value);
    await expect(page).toHaveURL(/\/managed$/);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), pendingKey())).toBeNull();
    expect(fixture.submissions).toHaveLength(0);
  }
  await page.getByRole("button", { name: "Launch 1 agent", exact: true }).click();
  await expect(page).toHaveURL(/\/managed\/[a-f0-9-]+$/);
  expect(fixture.submissions).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
});

test("onboarding controls fit narrow, tablet and desktop widths without horizontal overflow", async ({ page }) => {
  const fixture = await mockManaged(page, { allowedOrigins: ["https://www.browserbase.com", "https://www.iana.org"] });
  await page.goto("/managed");
  await expect(page.getByLabel("Initial target URL")).toBeEnabled();
  await page.getByLabel("Select UI/UX", { exact: true }).check();
  await advanced(page);
  await page.getByText("Customize requested scope", { exact: true }).click();
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    const controls = page.locator(".managed-composer, #managed-target-url, .managed-site-picker select, .managed-specialist, .managed-advanced textarea:visible, .launch-button");
    const boxes = await controls.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, right: rect.right, width: rect.width };
    }));
    for (const box of boxes) {
      expect(box.width).toBeGreaterThan(0);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const launch = page.getByRole("button", { name: "Launch 1 agent", exact: true });
    await launch.scrollIntoViewIfNeeded();
    await expect(launch).toBeInViewport();
  }
  expect(fixture.submissions).toHaveLength(0);
  expect(fixture.unexpected).toEqual([]);
});

for (const switchMethod of ["website picker", "typed target"]) {
  test(`switching from IANA to Browserbase through the ${switchMethod} resets only demo missions and scope`, async ({ page }) => {
    const fixture = await mockManaged(page, { allowedOrigins: ["https://example.com", "https://www.iana.org", "https://browserbase.com"] });
    await page.goto("/managed");
    await expect(page.getByLabel("Initial target URL")).toBeEnabled();
    await advanced(page);
    await page.getByRole("button", { name: "Prepare five-agent IANA demo", exact: true }).click();
    await page.getByLabel("Select Security & privacy", { exact: true }).uncheck();
    await page.getByLabel("Select Dana", { exact: true }).check();
    await page.getByLabel("Shared goal for additional personas").fill("Read the approved website without changing data.");
    await page.getByLabel("Shared criteria for additional personas (one per line, up to 6)").fill("The website purpose is clear.");
    await page.getByText("Customize requested scope", { exact: true }).click();
    await expect(page.getByLabel("Requested path prefixes (one per line)")).toHaveValue("/domains/reserved");
    if (switchMethod === "website picker") {
      await page.getByRole("combobox", { name: "Approved website", exact: true }).selectOption("https://browserbase.com");
    } else {
      await page.getByLabel("Initial target URL").fill("browserbase.com");
      await page.getByLabel("Initial target URL").press("Tab");
    }
    await expect(page.getByLabel("Initial target URL")).toHaveValue("https://browserbase.com/");
    await expect(page.getByLabel("Requested path prefixes (one per line)")).toHaveValue("/");
    await expect(page.getByText("5 / 8 selected", { exact: true })).toBeVisible();
    for (const specialist of managedSpecialists) {
      await expect(page.getByLabel(`Select ${specialist.label}`, { exact: true })).toBeChecked({ checked: specialist.personaId !== "security-minded" });
    }
    await expect(page.getByLabel("Select Dana", { exact: true })).toBeChecked();
    await expect(page.getByText("Short one-page IANA mission", { exact: true })).toHaveCount(0);
    await review(page);
    await expect(page.locator(".managed-mission-review .onboarding-target")).toHaveText("https://browserbase.com/");
    await expect(page.locator(".managed-mission-review")).toContainText("Requested paths: /");
    expect(fixture.submissions).toHaveLength(0);
    await page.getByRole("button", { name: "Launch 5 agents", exact: true }).click();
    await expect(page).toHaveURL(/\/managed\/[a-f0-9-]+$/);
    expect(fixture.submissions).toHaveLength(1);
    expect(fixture.submissions[0].body.scope).toEqual({ targetUrl: "https://browserbase.com/", pathPrefixes: ["/"], allowedSubdomains: [] });
    expect(fixture.submissions[0].body.assignments).toEqual([
      ...managedSpecialists.filter((specialist) => specialist.personaId !== "security-minded")
        .map(({ personaId, goal, criteria }) => ({ personaId, goal, criteria })),
      { personaId: profiles[0].id, goal: "Read the approved website without changing data.", criteria: ["The website purpose is clear."] },
    ]);
    expect(fixture.unexpected).toEqual([]);
  });
}

test("five-agent IANA shortcut prepares immutable missions without launching early", async ({ page }) => {
  const fixture = await mockManaged(page);
  await page.goto("/managed");
  await expect(page.getByLabel("Initial target URL")).toBeEnabled();
  await advanced(page);
  await page.getByRole("button", { name: "Prepare five-agent IANA demo" }).click();
  await expect(page.getByLabel("Initial target URL")).toHaveValue(managedIanaDemoScope.targetUrl);
  await expect(page.getByText("5 / 8 selected", { exact: true })).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const badges = page.locator(".managed-specialist-checks[data-customized=true]");
    await expect(badges).toHaveCount(5);
    for (let index = 0; index < 5; index++) {
      await expect(badges.nth(index)).toBeVisible();
      await expect(badges.nth(index)).toHaveText("Short one-page IANA mission");
    }
  }
  expect(fixture.submissions).toHaveLength(0);
  await review(page);
  await expect(page.locator(".managed-mission-review")).toContainText("Requested paths: /domains/reserved");
  await expect(page.locator(".onboarding-review > li")).toHaveCount(5);
  for (const [index, assignment] of managedIanaDemoAssignments.entries()) {
    const mission = page.locator(".onboarding-review > li").nth(index);
    await mission.getByText("Checks for this agent", { exact: true }).click();
    await expect(mission.getByText(assignment.goal, { exact: true })).toBeVisible();
    for (const criterion of assignment.criteria) await expect(mission.getByText(criterion, { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Launch 5 agents", exact: true }).click();
  await expect(page).toHaveURL(/\/managed\/[a-f0-9-]+$/);
  expect(fixture.submissions).toHaveLength(1);
  expect(fixture.submissions[0].body).toMatchObject({ scope: managedIanaDemoScope, assignments: managedIanaDemoAssignments });
  await expect(page.getByTestId("managed-live-agent")).toHaveCount(5);
  await expect(page.getByTestId("managed-live-overview")).toContainText("0 provider runs reporting RUNNING");
});

test("advanced specialist overrides are disclosed and saved without claiming the preset checks", async ({ page }) => {
  const fixture = await mockManaged(page);
  await page.goto("/managed");
  await page.getByLabel("Initial target URL").fill("https://example.com/help");
  await page.getByLabel("Select UI/UX", { exact: true }).check();
  await advanced(page);
  await page.getByText("Alex: goal, criteria & character", { exact: true }).click();
  await page.getByRole("textbox", { name: "Goal for Alex", exact: true }).fill("Read the public help page without changing data.");
  await page.getByLabel("Criteria for Alex (one per line, up to 6)").fill("The help heading is visible.");
  await page.getByText("Advanced: missions & personas", { exact: true }).click();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const badge = page.locator(".managed-specialist").first().locator(".managed-specialist-checks");
    await expect(badge).toHaveAttribute("data-customized", "true");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("Custom mission: review goals and checks in Advanced.");
  }
  await expect(page.locator(".managed-specialist").first().getByText("Clear next steps", { exact: true })).toHaveCount(0);
  await review(page);
  await expect(page.locator(".onboarding-review")).toContainText("Read the public help page without changing data.");
  await page.locator(".onboarding-review").getByText("Checks for this agent", { exact: true }).click();
  await expect(page.locator(".onboarding-review").getByText("The help heading is visible.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Launch 1 agent", exact: true }).click();
  await expect(page).toHaveURL(/\/managed\/[a-f0-9-]+$/);
  expect(fixture.submissions[0].body.assignments).toEqual([{
    personaId: "careful-first-timer", goal: "Read the public help page without changing data.",
    criteria: ["The help heading is visible."],
  }]);
  await expect(page.getByRole("heading", { name: "Alex", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "UI/UX", exact: true })).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

test("demo role missions survive an ambiguous reply without automatic resubmission or reselection", async ({ page }) => {
  const fixture = await mockManaged(page, { lostReply: true });
  await page.goto("/managed");
  await page.getByLabel("Initial target URL").fill("https://example.com/help");
  await page.getByLabel("Select Accessibility", { exact: true }).check();
  await page.getByLabel("Select Security & privacy", { exact: true }).check();
  await page.getByRole("button", { name: "Launch 2 agents", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reconcile saved launch", exact: true })).toBeEnabled();
  const saved = fixture.submissions[0];
  await page.reload();
  await expect(page.getByRole("button", { name: "Reconcile saved launch", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Select Accessibility", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Select Accessibility", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Select UI/UX", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Select UI/UX", { exact: true })).toBeDisabled();
  expect(fixture.submissions).toHaveLength(1);
  expect(saved.body.assignments.map((assignment) => assignment.personaId)).toEqual(["keyboard-only", "security-minded"]);
  await page.getByRole("button", { name: "Reconcile saved launch", exact: true }).click();
  await expect(page).toHaveURL(`/managed/${fixture.run.id}`);
  expect(fixture.submissions).toEqual([saved, saved]);
  expect(fixture.unexpected).toEqual([]);
});

test("disabled managed execution still allows preparing cards and personas without starting anything", async ({ page }) => {
  const fixture = await mockManaged(page, { enabled: false });
  await page.goto("/managed");
  await expect(page.getByRole("status")).toContainText("Managed launch is disabled by the operator");
  await page.getByLabel("Initial target URL").fill("https://example.com/help");
  await page.getByLabel("Select Security & privacy", { exact: true }).check();
  await expect(page.getByRole("button", { name: "Launch 1 agent", exact: true })).toBeDisabled();
  await advanced(page);
  await expect(page.getByText("Passive trust review, not penetration testing.", { exact: false })).toBeVisible();
  await page.getByLabel("Select Security & privacy", { exact: true }).uncheck();
  await createFromTemplate(page, "ux-review", "Offline UX reviewer");
  await expect(page.getByRole("button", { name: "Launch 1 agent", exact: true })).toBeDisabled();
  await page.getByText("Managed execution policy and limits", { exact: true }).click();
  await expect(page.getByText("Browserbase tools cannot be disabled.", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("It is not arbitrary safe browsing.", { exact: false })).toBeVisible();
  expect(fixture.personaMutations).toHaveLength(1);
  expect(fixture.submissions).toHaveLength(0);
  expect(fixture.unexpected).toEqual([]);
});

test("launch accepts terms on the final action, retains approved targets and caps the crowd at eight", async ({ page }) => {
  const fixture = await mockManaged(page);
  await configure(page);
  await expect(page.getByRole("checkbox", { name: /authorized|acknowledge/i })).toHaveCount(0);
  await page.getByLabel("Initial target URL").fill("https://example.com.attacker.invalid/help");
  await expect(page.getByRole("button", { name: "Launch 1 agent", exact: true })).toBeDisabled();
  await expect(page.getByText("This initial target is not an exact approved HTTP(S) origin.")).toBeVisible();
  await page.getByLabel("Initial target URL").fill("https://example.com/help");
  await page.getByText("Customize requested scope", { exact: true }).click();
  await page.getByLabel("Requested path prefixes (one per line)").fill("/help\n/delivery");
  for (const persona of profiles.slice(1, 8)) await page.getByLabel(`Select ${persona.name}`, { exact: true }).check();
  await expect(page.getByText("8 / 8 selected")).toBeVisible();
  await expect(page.getByLabel("Select Robin", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Select Security & privacy", { exact: true })).toBeDisabled();
  await page.getByLabel("Select Dana", { exact: true }).uncheck();
  await expect(page.getByLabel("Select Security & privacy", { exact: true })).toBeEnabled();
  await page.getByLabel("Select Dana", { exact: true }).check();
  await review(page);
  await expect(page.locator(".onboarding-review > li")).toHaveCount(8);
  await expect(page.locator(".managed-mission-review")).toContainText("Requested paths: /help, /delivery");
  await expect(page.getByLabel("Select Dana", { exact: true })).toBeChecked();
  expect(fixture.submissions).toHaveLength(0);
  await page.getByRole("button", { name: "Launch 8 agents", exact: true }).click();
  await expect(page).toHaveURL(/\/managed\/[a-f0-9-]+$/);
  expect(fixture.submissions).toHaveLength(1);
  const saved = fixture.submissions[0];
  expect(saved.body).toMatchObject({
    authorizationAcknowledged: true, managedPolicyAcknowledged: true,
    executionPolicy: MANAGED_EXECUTION_POLICY,
    scope: { allowedSubdomains: [], pathPrefixes: ["/help", "/delivery"] },
  });
  expect(saved.body.assignments).toHaveLength(8);
  expect(saved.body.assignments.find((assignment) => assignment.personaId === "impatient-mobile")).toMatchObject({ goal: "Read delivery information.", criteria: ["Delivery costs are clear."] });
  expect(saved.csrf).toBe(`csrf-${owner}`);
  expect(JSON.parse(saved.stored!)).toEqual({ ownerId: owner, key: saved.key, body: saved.body });
  expect(await page.evaluate((key) => sessionStorage.getItem(key), pendingKey())).toBeNull();
  expect(fixture.unexpected).toEqual([]);
});

test("a lost launch reply survives refresh and only explicitly reconciles the same body and key", async ({ page }) => {
  const fixture = await mockManaged(page, { lostReply: true });
  await configure(page);
  await page.getByRole("button", { name: "Launch 1 agent", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reconcile saved launch", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Shared goal for additional personas")).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("button", { name: "Reconcile saved launch", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Unresolved managed launch")).toContainText("Read delivery information.");
  await page.getByText("Your saved managed runs", { exact: true }).first().click();
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
  await page.getByRole("button", { name: "Launch 1 agent", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reconcile saved launch", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Initial target URL")).toBeDisabled();
  await page.getByText("Deliberately discard the saved request", { exact: true }).click();
  await expect(page.getByText("Discarding does not cancel a run.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Discard saved request", exact: true }).click();
  await expect(page.getByLabel("Initial target URL")).toBeEnabled();
  expect(fixture.submissions).toHaveLength(1);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), pendingKey())).toBeNull();
});

test("a different owner never reuses a pending launch or sees the previous owner's saved runs", async ({ page }) => {
  const fixture = await mockManaged(page, { lostReply: true });
  await configure(page);
  await page.getByRole("button", { name: "Launch 1 agent", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reconcile saved launch", exact: true })).toBeEnabled();
  fixture.setOwner(nextOwner);
  await page.reload();
  await expect(page.getByLabel("Initial target URL")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Reconcile saved launch", exact: true })).toHaveCount(0);
  await page.getByText("Your saved managed runs", { exact: true }).first().click();
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
  await page.getByRole("button", { name: "Launch 1 agent", exact: true }).click();
  await expect(page.locator(".error[role=alert]")).toContainText("Nothing was submitted");
  await expect(page.getByLabel("Initial target URL")).toBeDisabled();
  expect(fixture.submissions).toHaveLength(0);
  expect(fixture.unexpected).toEqual([]);
});

test("the same-panel persona editor restores the original form DOM and unsaved mission and scope", async ({ page }) => {
  const fixture = await mockManaged(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await configure(page);
  await page.getByText("Customize requested scope", { exact: true }).click();
  await page.getByLabel("Requested path prefixes (one per line)").fill("/help\n/delivery");
  await page.getByText("Dana: goal, criteria & character", { exact: true }).click();
  await page.getByRole("textbox", { name: "Goal for Dana", exact: true }).fill("Read delivery information without changing data.");
  await page.getByLabel("Criteria for Dana (one per line, up to 6)").fill("Delivery costs are clear.");
  await review(page);
  const form = await page.locator("form.managed-composer").elementHandle();
  expect(form).not.toBeNull();
  await page.getByRole("button", { name: "+ Create persona", exact: true }).click();
  await expect(page.getByRole("region", { name: "Managed persona editor", exact: true })).toBeVisible();
  await expect(page.getByLabel("Initial target URL")).toBeHidden();
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("form form")).toHaveCount(0);
  expect(await form!.evaluate((element) => element.isConnected)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByLabel("Name", { exact: true }).fill("Discard this draft");
  await page.getByRole("button", { name: "Close editor", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Managed persona editor", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Initial target URL")).toHaveValue("https://example.com/help");
  await expect(page.getByLabel("Requested path prefixes (one per line)")).toBeVisible();
  await expect(page.getByLabel("Requested path prefixes (one per line)")).toHaveValue("/help\n/delivery");
  await expect(page.getByRole("textbox", { name: "Goal for Dana", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Goal for Dana", exact: true })).toHaveValue("Read delivery information without changing data.");
  await expect(page.locator(".onboarding-review")).toBeVisible();
  await expect(page.getByLabel("Select Dana", { exact: true })).toBeChecked();
  expect(await form!.evaluate((element) => element === document.querySelector("form.managed-composer"))).toBe(true);
  expect(fixture.personaMutations).toHaveLength(0);
  await createFromTemplate(page, "ux-review", "Saved from the same panel");
  expect(await form!.evaluate((element) => element.isConnected && element === document.querySelector("form.managed-composer"))).toBe(true);
  await expect(page.getByLabel("Requested path prefixes (one per line)")).toHaveValue("/help\n/delivery");
  await expect(page.getByRole("textbox", { name: "Goal for Dana", exact: true })).toHaveValue("Read delivery information without changing data.");
  await expect(page.getByLabel("Criteria for Dana (one per line, up to 6)")).toHaveValue("Delivery costs are clear.");
  await expect(page.getByRole("button", { name: "Launch 2 agents", exact: true })).toBeEnabled();
  expect(fixture.personaMutations).toHaveLength(1);
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
    await expect(page.getByRole("button", { name: "Launch 2 agents", exact: true })).toBeEnabled();
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
  await page.getByLabel("Shared goal for additional personas").fill("");
  await page.getByRole("textbox", { name: "Shared criteria for additional personas (one per line, up to 6)", exact: true }).fill("");
  await page.getByRole("button", { name: "Launch 2 agents", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reconcile saved launch", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Initial target URL")).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Approved website", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Launch 2 agents", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "+ Create persona", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Edit saved persona", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Delete Trust reviewer", exact: true })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "Goal for Trust reviewer", exact: true })).toBeDisabled();
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
  await review(page);
  for (const [index, assignment] of request.body.assignments.entries()) {
    const mission = page.locator(".onboarding-review > li").nth(index);
    await expect(mission.getByText(assignment.goal, { exact: true })).toBeVisible();
    await mission.getByText("Checks for this agent", { exact: true }).click();
    for (const criterion of assignment.criteria) await expect(mission.getByText(criterion, { exact: true })).toBeVisible();
  }
  await expect(page.getByLabel("Select UI/UX", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Initial target URL")).toBeDisabled();
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
  await page.getByRole("button", { name: "Launch 2 agents", exact: true }).click();
  await expect(page).toHaveURL(/\/managed\/[a-f0-9-]+$/);
  const snapshot = structuredClone(fixture.run.attempts.find((attempt) => attempt.persona.id === copy.id)!.persona);
  await page.getByRole("link", { name: "Managed workspace", exact: true }).click();
  await configure(page);
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
  run.attempts[1] = { ...run.attempts[1], status: "running", providerStatus: "RUNNING", cleanup: "unconfirmed" };
  run.attempts[2] = { ...run.attempts[2], status: "running", providerStatus: "RUNNING", cleanup: "unconfirmed", cancelRequested: true };
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

test("five-agent overview stays visible and updates real status, events and frozen elapsed time", async ({ page }) => {
  const run = makeRun({ ...defaultBody, scope: managedIanaDemoScope, assignments: [...managedIanaDemoAssignments] });
  const start = Date.now() - 1000;
  run.status = "running";
  run.attempts = run.attempts.map((attempt) => ({ ...attempt, status: "running", providerStatus: "RUNNING",
    cleanup: "unconfirmed", startedAt: new Date(start).toISOString(), finishedAt: null,
    progress: [
      { sequence: 1, timestamp: new Date(start).toISOString(), kind: "tool", text: "snapshot" },
      { sequence: 2, timestamp: new Date(start).toISOString(), kind: "text", text: "IANA heading observed." },
    ],
  }));
  await mockManaged(page, { run });
  await page.goto(`/managed/${run.id}`);
  const overview = page.getByTestId("managed-live-overview");
  const agents = overview.getByTestId("managed-live-agent");
  await expect(agents).toHaveCount(5);
  await expect(overview).toContainText("5 provider runs reporting RUNNING");
  await expect(agents.nth(4)).toContainText("Latest action: snapshot");
  const bounds = await agents.nth(4).boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
  const elapsed = Number(await agents.first().getAttribute("data-elapsed-seconds"));
  await expect.poll(async () => Number(await agents.first().getAttribute("data-elapsed-seconds"))).toBeGreaterThan(elapsed);
  run.updatedAt = new Date().toISOString();
  run.status = "completed";
  run.attempts = run.attempts.map((attempt) => ({ ...attempt, status: "completed", providerStatus: "COMPLETED",
    cleanup: "closed", finishedAt: new Date(start + 2000).toISOString(), actualBrowserSeconds: 0.8 }));
  await expect(agents.first()).toHaveAttribute("data-elapsed-seconds", "2");
  await expect(agents.first()).toContainText("0.800s browser use");
  await expect(agents.first()).toContainText("Cleanup: closed");
  await expect(overview).toContainText("0 provider runs reporting RUNNING");
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
