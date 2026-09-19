import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { DEMO_STORAGE_KEY, fixtureNames, fixedFixtures, freshDemo, SECOND_COUPON_SIGNATURE, type FixtureName } from "../../src/lib/demo";

type Errors = { actual: string[]; expected: string[]; console: string[] };
const test = base.extend<{ browserErrors: Errors }>({
  browserErrors: [async ({ page, context }, use) => {
    const errors: Errors = { actual: [], expected: [], console: [] };
    const externalRequests: string[] = [];
    await context.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== "http://127.0.0.1:4317") {
        externalRequests.push(route.request().url());
        await route.abort();
      } else await route.continue();
    });
    const capture = (tab: Page) => {
      tab.on("pageerror", (error) => errors.actual.push(error.message));
      tab.on("console", (message) => { if (message.type() === "error") errors.console.push(message.text()); });
    };
    capture(page);
    context.on("page", capture);
    await use(errors);
    expect(errors.actual, "All uncaught browser exceptions must be explicitly expected").toEqual(errors.expected);
    expect(errors.console.filter((message) => !errors.expected.some((expected) => message.includes(expected))), "Unexpected console errors").toEqual([]);
    expect(externalRequests, "Offline browsers must not request external services").toEqual([]);
  }, { auto: true }],
});

async function configure(page: Page, broken: FixtureName[] = []) {
  await page.goto("/demo-fixtures");
  await page.getByRole("button", { name: "Select all fixed", exact: true }).click();
  for (const name of broken) await page.getByRole("checkbox", { name, exact: true }).check();
  await page.getByRole("button", { name: "Apply scenario and reset", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Scenario applied. Shopping state reset.");
}
async function addMug(page: Page) {
  await page.goto("/demo/category/home");
  await expect(page.getByRole("heading", { name: "Home gifts", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Maple ceramic mug", exact: true }).click();
  await page.getByRole("button", { name: "Add to cart", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Maple ceramic mug added to cart.");
}
async function cart(page: Page, expectPending = false) {
  const response = page.waitForResponse((response) => response.url().includes("/demo/cart-summary?"));
  await page.getByRole("link", { name: "View cart", exact: true }).click();
  if (expectPending) {
    await expect(page.getByRole("status")).toHaveText("Checking delivery...");
    await expect(page.getByRole("button", { name: /^Continue/ })).toBeDisabled();
  }
  const result = await response;
  await result.finished();
  await expect(page.getByRole("button", { name: /^Continue/ })).toBeEnabled();
  return result;
}
async function coupon(page: Page, value: string) {
  await page.getByRole("textbox", { name: "Coupon code", exact: true }).fill(value);
  await page.getByRole("button", { name: "Apply coupon", exact: true }).click();
}
async function tabTo(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  for (let step = 0; step < 20; step++) {
    if (await locator.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(locator, "Control must be reachable with Tab").toBeFocused();
}

test("all-fixed checkout can be completed without a pointer", async ({ page }) => {
  await page.goto("/demo/category/home");
  await tabTo(page, page.getByRole("link", { name: "Maple ceramic mug", exact: true }));
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByRole("button", { name: "Add to cart", exact: true }));
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByRole("link", { name: "View cart", exact: true }));
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByRole("button", { name: "Add gift wrap (+CA$3)", exact: true }));
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Add gift wrap (+CA$3)", exact: true })).toHaveAttribute("aria-pressed", "true");
  const delivery = page.getByRole("button", { name: "Continue to delivery", exact: true });
  await expect(delivery).toBeEnabled();
  await tabTo(page, delivery);
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByRole("textbox", { name: "Canadian postal code", exact: true }));
  await page.keyboard.type("N2L 3G1");
  await tabTo(page, page.getByRole("button", { name: "Review order", exact: true }));
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByRole("button", { name: "Place demo order", exact: true }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Thank you! Your demo order is complete.", exact: true })).toBeVisible();
});

for (const mobile of [false, true]) {
  test(`safe complete all-fixed ${mobile ? "phone" : "desktop"} shopping journey`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await configure(page);
    await addMug(page);
    await cart(page);
    await coupon(page, "SAVE10");
    await coupon(page, "COZY5");
    await page.getByRole("button", { name: "Add gift wrap (+CA$3)", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Order total: CA$24.60", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Continue to delivery", exact: true }).click();
    await page.getByRole("textbox", { name: "Canadian postal code", exact: true }).fill("n2l 3g1");
    await page.getByRole("button", { name: "Review order", exact: true }).click();
    await expect(page.getByText("Deliver to: N2L 3G1", { exact: true })).toBeVisible();
    await expect(page.getByText("This is a simulated order. No payment is collected and nothing will ship.", { exact: true })).toBeVisible();
    await expect(page.locator("input")).toHaveCount(0);
    await page.getByRole("button", { name: "Place demo order", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Thank you! Your demo order is complete.", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Cart (0)", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Thank you! Your demo order is complete.", exact: true })).toBeVisible();
  });
}

for (const broken of [true, false]) {
  test(`phone fold ${broken ? "broken" : "fixed"} is visibility evidence, not a failed checkout`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await configure(page, broken ? ["phoneFold"] : []);
    await addMug(page);
    await cart(page);
    const action = page.getByRole("button", { name: "Continue to delivery", exact: true });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    if (broken) await expect(action).not.toBeInViewport();
    else await expect(action).toBeInViewport();
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeInViewport();
    await action.click();
    await expect(page).toHaveURL(/\/demo\/checkout$/);
  });
  test(`second coupon ${broken ? "broken uncaught signature" : "fixed stacked discount"}`, async ({ page, browserErrors }) => {
    await configure(page, broken ? ["secondCoupon"] : []);
    await addMug(page);
    await cart(page);
    await coupon(page, "SAVE10");
    await expect(page.getByRole("status")).toHaveText("SAVE10 applied.");
    await coupon(page, "SAVE10");
    await expect(page.getByRole("status")).toHaveText("That coupon is already applied.");
    if (broken) {
      browserErrors.expected.push(SECOND_COUPON_SIGNATURE);
      const error = page.waitForEvent("pageerror");
      await coupon(page, "COZY5");
      expect((await error).message).toBe(SECOND_COUPON_SIGNATURE);
      await expect(page.getByText("Applied coupons: SAVE10", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Order total: CA$26.60", exact: true })).toBeVisible();
    } else {
      await coupon(page, "COZY5");
      await expect(page.getByText("Applied coupons: SAVE10, COZY5", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Order total: CA$21.60", exact: true })).toBeVisible();
    }
  });
  test(`Canadian spaced postal ${broken ? "broken rejection" : "fixed normalization"}`, async ({ page }) => {
    await configure(page, broken ? ["postalSpaces"] : []);
    await addMug(page);
    await cart(page);
    await page.getByRole("button", { name: "Continue to delivery", exact: true }).click();
    await page.getByRole("textbox", { name: "Canadian postal code", exact: true }).fill("N2L 3G1");
    await page.getByRole("button", { name: "Review order", exact: true }).click();
    if (broken) {
      await expect(page.getByRole("status")).toHaveText("Enter a valid Canadian postal code.");
      await expect(page).toHaveURL(/\/demo\/checkout$/);
      await page.getByRole("textbox", { name: "Canadian postal code", exact: true }).fill("N2L3G1");
      await page.getByRole("button", { name: "Review order", exact: true }).click();
    }
    await expect(page).toHaveURL(/\/demo\/checkout\/review$/);
    await expect(page.getByText("Deliver to: N2L 3G1", { exact: true })).toBeVisible();
  });
  test(`continue labels ${broken ? "reused" : "explicit"} with distinct observable outcomes`, async ({ page }) => {
    await configure(page, broken ? ["continueLabels"] : []);
    await addMug(page);
    await cart(page);
    await page.getByRole("button", { name: broken ? "Continue" : "Continue to delivery", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Delivery", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Canadian postal code", exact: true }).fill("N2L3G1");
    await page.getByRole("button", { name: broken ? "Continue" : "Review order", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Review your order", exact: true })).toBeVisible();
  });
  test(`gift wrap ${broken ? "unreachable" : "operable"} with keyboard`, async ({ page }) => {
    await configure(page, broken ? ["keyboardFocus"] : []);
    await addMug(page);
    await cart(page);
    const wrap = page.getByRole("button", { name: "Add gift wrap (+CA$3)", exact: true });
    await page.getByRole("button", { name: "Apply coupon", exact: true }).focus();
    await page.keyboard.press("Tab");
    if (broken) {
      await expect(wrap).not.toBeFocused();
      await expect(page.getByRole("button", { name: "Continue to delivery", exact: true })).toBeFocused();
      // Traverse a full document cycle: no Tab stop may reach the broken control.
      for (let step = 0; step < 15; step++) { await page.keyboard.press("Tab"); await expect(wrap).not.toBeFocused(); }
      await expect(wrap).toHaveAttribute("aria-pressed", "false");
      await wrap.click();
      await expect(wrap).toHaveAttribute("aria-pressed", "true");
    } else {
      await expect(wrap).toBeFocused();
      await page.keyboard.press("Space");
      await expect(wrap).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("Enter");
      await expect(wrap).toHaveAttribute("aria-pressed", "false");
    }
  });
}

test("cart variants produce real bounded network timing, not fake log entries", async ({ page }) => {
  const durations: number[] = [];
  for (const broken of [false, true]) {
    await configure(page, broken ? ["slowCart"] : []);
    await addMug(page);
    const response = await cart(page, broken);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");
    const timing = response.request().timing();
    durations.push(timing.responseEnd - timing.requestStart);
  }
  expect(durations[0]).toBeLessThan(1000);
  expect(durations[1]).toBeGreaterThanOrEqual(1100);
  expect(durations[1]).toBeLessThan(10_000);
  expect(durations[1] - durations[0]).toBeGreaterThan(800);
});

test("operator switches are independent, persist on reload and reset every shopping field", async ({ page }) => {
  for (const name of fixtureNames) {
    await configure(page, [name]);
    await page.reload();
    for (const candidate of fixtureNames) await expect(page.getByRole("checkbox", { name: candidate, exact: true })).toBeChecked({ checked: candidate === name });
  }
  await configure(page, [...fixtureNames]);
  await expect(page.getByRole("checkbox")).toHaveCount(6);
  await page.evaluate(({ key, state }) => sessionStorage.setItem(key, JSON.stringify(state)), {
    key: DEMO_STORAGE_KEY,
    state: { ...freshDemo({ ...fixedFixtures, phoneFold: true }), cart: ["mug"], coupons: ["SAVE10"], postal: "N2L 3G1", giftWrap: true, completed: true },
  });
  await page.reload();
  await page.getByRole("button", { name: "Reset shopping state", exact: true }).click();
  const reset = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), DEMO_STORAGE_KEY);
  expect(reset).toEqual(freshDemo({ ...fixedFixtures, phoneFold: true }));
  await page.getByRole("link", { name: "Open store", exact: true }).click();
  await expect(page.getByRole("link", { name: "Cart (0)", exact: true })).toBeVisible();
});

test("independent tabs do not share shopping data or fixture flags", async ({ page, context }) => {
  await configure(page, ["secondCoupon"]);
  await addMug(page);
  const other = await context.newPage();
  await other.goto("/demo/cart");
  await expect(other.getByText("Your cart is empty.", { exact: false })).toBeVisible();
  await other.goto("/demo-fixtures");
  for (const name of fixtureNames) await expect(other.getByRole("checkbox", { name, exact: true })).not.toBeChecked();
  await other.getByRole("button", { name: "Apply scenario and reset", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("link", { name: "Cart (1)", exact: true })).toBeVisible();
  await other.close();
});

test("invalid stored data fails visibly and operator reset repairs it", async ({ page }) => {
  await page.goto("/demo");
  await page.evaluate((key) => sessionStorage.setItem(key, "{broken"), DEMO_STORAGE_KEY);
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Demo storage could not be read" })).toBeVisible();
  await page.getByRole("link", { name: "Demo setup", exact: true }).click();
  await page.getByRole("button", { name: "Apply scenario and reset", exact: true }).click();
  await page.getByRole("link", { name: "Open store", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A little joy, under $50.", exact: true })).toBeVisible();
});

test("public demo route rejects arbitrary delays and does not unlock protected APIs", async ({ request }) => {
  for (const query of ["variant=broken&delay=999999", "variant=broken&variant=fixed", "variant=unknown", ""]) {
    const response = await request.get(`/demo/cart-summary?${query}`);
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({ error: "Expected only variant=broken or variant=fixed." });
  }
  expect((await request.post("/demo/cart-summary", { data: {} })).status()).toBe(405);
  expect((await request.get("/api/v1/runs")).status()).toBe(503);
  expect((await request.post("/api/v1/session", { data: {}, headers: { origin: "https://offline-demo.invalid" } })).status()).toBe(503);
});
