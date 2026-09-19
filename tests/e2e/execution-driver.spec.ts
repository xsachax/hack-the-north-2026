import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test, expect, type Page } from "@playwright/test";
import type { ArtifactSinks } from "../../src/server/execution/artifacts";
import { FixtureDriver, COUPON_CRITERION, COMPLETE_CRITERION, demoVerifier } from "../../src/server/execution/driver";
import { executePersona } from "../../src/server/execution/loop";
import { personas } from "../../src/lib/personas";
import { FIXTURE_ORIGIN, installFixtureNetwork, localFixtureSource } from "../../src/server/execution/fixture-network";
import type { BrowserAction, Observation } from "../../src/server/execution/types";
import { DEMO_STORAGE_KEY, fixedFixtures, freshDemo } from "../../src/lib/demo";

const signal = () => new AbortController().signal;
const artifact = (bytes: Uint8Array, kind: "screenshot" | "json") => {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { key: sha256, sha256, bytes: bytes.length, kind };
};
const sinks: ArtifactSinks = {
  screenshot: async (bytes) => artifact(bytes, "screenshot"),
  json: async (value) => artifact(Buffer.from(JSON.stringify(value)), "json"),
  telemetry: async (value) => artifact(Buffer.from(JSON.stringify(value)), "json"),
};
async function setup(page: Page, broken = false, criteria = [COUPON_CRITERION], cartDelayMs = 0) {
  const source = localFixtureSource(4317);
  const network = await installFixtureNetwork(page.context(), page, async (url) => {
    const response = await source(url);
    if (url.pathname === "/demo/cart-summary" && cartDelayMs) await delay(cartDelayMs);
    return response;
  }, () => {});
  await page.goto(`${FIXTURE_ORIGIN}/demo/category/home`);
  await page.evaluate(({ key, state }) => sessionStorage.setItem(key, state), {
    key: DEMO_STORAGE_KEY, state: JSON.stringify(freshDemo({ ...fixedFixtures, secondCoupon: broken })),
  });
  await page.reload();
  await page.getByRole("link", { name: "Maple ceramic mug", exact: true }).waitFor();
  const driver = new FixtureDriver({
    page, artifacts: sinks, verify: demoVerifier(criteria), networkErrors: network.errors,
    close: async () => { await page.close(); return { status: "closed", errors: [] }; },
  });
  return driver;
}
async function act(driver: FixtureDriver, action: BrowserAction["action"], label?: string, value: string | null = null): Promise<Observation> {
  const before = await driver.observe(signal());
  const candidate = before.candidates.find((candidate) => candidate.label === label);
  if (label) expect(candidate, `Visible candidate ${label}`).toBeDefined();
  await driver.act({ action, candidateId: candidate?.id ?? null, value, commentary: "", actor: "agent" }, signal());
  return driver.observe(signal());
}

test("actual verifier and loop retain observed coupon milestones through demo completion", async ({ page }) => {
  const criteria = [COUPON_CRITERION, COMPLETE_CRITERION];
  const driver = await setup(page, false, criteria, 2500);
  const actions: [BrowserAction["action"], string, string | null][] = [
    ["click", "Maple ceramic mug", null], ["click", "Add to cart", null], ["click", "View cart", null],
    ["type", "Coupon code", "SAVE10"], ["click", "Apply coupon", null],
    ["type", "Coupon code", "COZY5"], ["click", "Apply coupon", null],
    ["click", "Continue to delivery", null], ["type", "Canadian postal code", "N2L 3G1"],
    ["click", "Review order", null], ["click", "Place demo order", null],
  ];
  const observations: Observation[] = [];
  let missingLabel: string | undefined;
  let waits = 0;
  const wait = () => {
    waits++;
    return { action: "wait" as const, candidateId: null, value: "500", commentary: "Waiting for the fixture to be ready." };
  };
  const result = await executePersona({
    persona: { ...personas.find((persona) => persona.id === "bargain-hunter")!, patienceSteps: 20 },
    goal: "Apply both advertised coupons, then complete a synthetic demo order.",
    criteria, limits: { maxSteps: 20, maxModelCalls: 20, maxDurationMs: 20000, carefulDelayMs: 0, stallThreshold: 5 },
  }, {
    driver,
    brain: {
      decide: async ({ observation }) => {
        if (observation.text.includes("Opening the store...")) return wait();
        const [action, label, value] = actions[0];
        const candidate = observation.candidates.find((item) => item.label === label);
        if (!candidate && label === "Continue to delivery" && observation.text.includes("Checking delivery...")) return wait();
        if (!candidate) missingLabel = label;
        expect(candidate, label).toBeDefined();
        actions.shift();
        return { action, candidateId: candidate!.id, value, commentary: "" };
      },
    },
    onEvent: async (event) => { if (event.kind === "observation") observations.push(event.observation); },
  });
  expect(result.status, JSON.stringify({ reason: result.reason, steps: result.steps, missingLabel, lastText: observations.at(-1)?.text })).toBe("succeeded");
  expect(waits).toBeGreaterThan(0);
  expect(result.steps).toBe(11 + waits);
  expect(actions).toHaveLength(0);
  expect(result.checks).toEqual(criteria.map((criterion) => ({
    criterion, passed: true, evidence: expect.stringMatching(/^observation:/),
  })));
  const cartChecks = observations.filter((observation) => observation.url.endsWith("/demo/cart")).map((observation) => observation.checks);
  expect(cartChecks.some((checks) => checks.some((check) => check.criterion === COUPON_CRITERION && !check.passed))).toBe(true);
  expect(cartChecks.at(-1)).toEqual([{ criterion: COUPON_CRITERION, passed: true, evidence: expect.any(String) }]);
  expect(observations.at(-1)?.checks).toEqual([{ criterion: COMPLETE_CRITERION, passed: true, evidence: expect.any(String) }]);
});

for (const [broken, reverse] of [[false, false], [true, false], [false, true]]) {
  test(`driver grounds coupons: broken=${broken} reverse=${reverse}`, async ({ page }) => {
    const driver = await setup(page, broken);
    await act(driver, "click", "Maple ceramic mug");
    await act(driver, "click", "Add to cart");
    await act(driver, "click", "View cart");
    await act(driver, "type", "Coupon code", reverse ? "COZY5" : "SAVE10");
    await act(driver, "click", "Apply coupon");
    await act(driver, "type", "Coupon code", reverse ? "SAVE10" : "COZY5");
    const observation = await act(driver, "click", "Apply coupon");
    expect(observation.checks[0].passed).toBe(!broken);
    expect(observation.signals.some((event) => event.kind === "functional_failure")).toBe(broken);
    expect(observation.screenshotKey).toMatch(/^[a-f0-9]{64}$/);
    expect((await driver.diagnostics()).some((metric) => metric.name === "Nodes")).toBe(true);
    expect(await driver.close()).toEqual({ status: "closed", errors: [] });
  });
}

test("driver rejects ungrounded input, off-scope navigation and unsupported keys", async ({ page }) => {
  const driver = await setup(page);
  await driver.observe(signal());
  const action = { actor: "agent", commentary: "", candidateId: null, value: null } as const;
  await expect(driver.act({ ...action, action: "click", candidateId: "invented" }, signal())).rejects.toThrow("ungrounded_candidate");
  await expect(driver.act({ ...action, action: "navigate", value: "http://127.0.0.1:4317/api/v1/session" }, signal())).rejects.toThrow("navigation_out_of_scope");
  await expect(driver.act({ ...action, action: "key", value: "Control+L" }, signal())).rejects.toThrow("key_denied");
  const aborted = new AbortController();
  aborted.abort();
  await expect(driver.observe(aborted.signal)).rejects.toThrow();
  expect(await driver.close()).toEqual({ status: "closed", errors: [] });
  await expect(driver.observe(signal())).rejects.toThrow("driver_closed");
});

test("tsx CLI loader runs self-contained browser callbacks", async () => {
  const program = `
    import assert from "node:assert/strict";
    import { chromium } from "playwright-core";
    import { FixtureDriver } from "./src/server/execution/driver.ts";
    import { installFixtureNetwork, localFixtureSource, FIXTURE_ORIGIN } from "./src/server/execution/fixture-network.ts";
    const browser = await chromium.launch({headless:true});
    try {
      const context = await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:"block"});
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      const network = await installFixtureNetwork(context,page,localFixtureSource(4317),()=>{});
      await page.goto(FIXTURE_ORIGIN+"/demo/category/home");
      await page.getByRole("link",{name:"Maple ceramic mug",exact:true}).waitFor();
      const ref = {key:"a".repeat(64),sha256:"a".repeat(64),bytes:1,kind:"screenshot"};
      const driver = new FixtureDriver({page,artifacts:{screenshot:async()=>ref,json:async()=>ref,telemetry:async()=>ref},
        verify:async()=>[],networkErrors:network.errors,close:async()=>({status:"closed",errors:[]})});
      const observed = await driver.observe(new AbortController().signal);
      assert(observed.candidates.some(candidate => candidate.label==="Maple ceramic mug"));
      assert.equal(await page.evaluate(()=>{try {new Worker("x"); return false;} catch(e){return e instanceof TypeError;}}),true);
      assert.deepEqual(errors,[]);
    } finally {await browser.close();}
  `;
  const { stderr } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { timeout: 20000 });
  expect(stderr).toBe("");
});

test("keyboard focus is observable progress and waits honor duration and cancellation", async ({ page }) => {
  const driver = await setup(page);
  const initial = await driver.observe(signal());
  const first = await act(driver, "key", undefined, "Tab");
  const second = await act(driver, "key", undefined, "Tab");
  expect(first.id).not.toBe(initial.id);
  expect(second.id).not.toBe(first.id);
  const started = Date.now();
  await act(driver, "wait", undefined, "600");
  expect(Date.now() - started).toBeGreaterThanOrEqual(600);
  await act(driver, "wait");
  const abort = new AbortController();
  const waiting = driver.act({ actor: "agent", action: "wait", candidateId: null, value: "5000", commentary: "" }, abort.signal);
  abort.abort();
  await expect(waiting).rejects.toThrow();
  await driver.close();
});

test("cancellation during asynchronous candidate validation prevents dispatch", async ({ page }) => {
  const driver = await setup(page);
  const observation = await driver.observe(signal());
  const candidate = observation.candidates.find((item) => item.label === "Maple ceramic mug")!;
  const originalLocator = page.locator.bind(page);
  let release!: () => void;
  let validating!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { validating = resolve; });
  page.locator = (...args) => {
    const locator = originalLocator(...args);
    const boundingBox = locator.boundingBox.bind(locator);
    locator.boundingBox = async (...options) => {
      validating();
      await blocked;
      return boundingBox(...options);
    };
    return locator;
  };
  const abort = new AbortController();
  const action = driver.act({ actor: "agent", action: "click", candidateId: candidate.id, value: null, commentary: "" }, abort.signal);
  await entered;
  abort.abort();
  release();
  await expect(action).rejects.toThrow();
  expect(page.url()).toBe(`${FIXTURE_ORIGIN}/demo/category/home`);
  await driver.close();
});

test("driver offers only viewport candidates and handles select, keyboard, scroll, back and dialogs", async ({ page }) => {
  const html = `<!doctype html><title>Capabilities</title><body>
    <label>Size<select><option>Small</option><option>Large</option></select></label>
    <button onclick="alert('Synthetic dialog')">Dialog</button>
    <a href="/demo/cart">Cart</a><div style="height:1400px"></div><button>Below fold</button></body>`;
  const network = await installFixtureNetwork(page.context(), page, async () => ({
    status: 200, contentType: "text/html", body: Buffer.from(html),
  }), () => {});
  await page.goto(`${FIXTURE_ORIGIN}/demo`);
  const driver = new FixtureDriver({
    page, artifacts: sinks, verify: async () => [], networkErrors: network.errors,
    close: async () => { await page.close(); return { status: "closed", errors: [] }; },
  });
  expect((await driver.observe(signal())).candidates.map((candidate) => candidate.label)).not.toContain("Below fold");
  await act(driver, "select", "Size", "Large");
  await expect(page.getByRole("combobox")).toHaveValue("Large");
  await act(driver, "key", undefined, "Tab");
  await act(driver, "click", "Dialog");
  await act(driver, "click", "Cart");
  expect(page.url()).toBe(`${FIXTURE_ORIGIN}/demo/cart`);
  await act(driver, "back");
  expect(page.url()).toBe(`${FIXTURE_ORIGIN}/demo`);
  await act(driver, "scroll", undefined, "down");
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await driver.close();
});
