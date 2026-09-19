import { createHash } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { ScopedBrowserDriver, fixtureCapabilities, readOnlyCapabilities } from "../../src/server/execution/driver";
import type { ArtifactSinks } from "../../src/server/execution/artifacts";
import type { BrowserAction } from "../../src/server/execution/types";

const origin = "https://readonly-driver.invalid";
const signal = new AbortController().signal;
const reference = (bytes: Uint8Array, kind: "screenshot" | "json") => {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { key: sha256, sha256, bytes: bytes.length, kind };
};
const artifacts: ArtifactSinks = {
  screenshot: async (bytes) => reference(bytes, "screenshot"),
  json: async (value) => reference(Buffer.from(JSON.stringify(value)), "json"),
  telemetry: async (value) => reference(Buffer.from(JSON.stringify(value)), "json"),
};
const action = (name: BrowserAction["action"], candidateId: string | null = null, value: string | null = null): BrowserAction =>
  ({ actor: "agent", action: name, candidateId, value, commentary: "" });

async function setup(page: Page, readOnly = true) {
  await page.route("**/*", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><title>Owned read-only driver fixture</title>
      <a href="/next">Next page</a><a href="/next" download>Download</a><a href="/next" target="_blank">New tab</a>
      <button onclick="window.dispatches++">Change state</button>
      <input aria-label="Name" oninput="window.dispatches++">
      <select aria-label="Choice" onchange="window.dispatches++"><option>A</option><option>B</option></select>
      <script>window.dispatches=0;document.addEventListener('keydown',()=>window.dispatches++);</script>`,
  }));
  await page.goto(origin);
  return new ScopedBrowserDriver({
    page, artifacts, readOnly, networkErrors: [],
    scope: { allowedOrigins: [origin], navigationPaths: ["/", "/next"] },
    close: async () => ({ status: "closed", errors: [] }),
  });
}

test("read-only driver rejects mutations before any input dispatch without falsifying observed controls", async ({ page }) => {
  const driver = await setup(page);
  const observed = await driver.observe(signal);
  expect(driver.capabilities).toEqual(readOnlyCapabilities);
  for (const label of ["Change state", "Name", "Choice"]) {
    expect(observed.candidates.find((candidate) => candidate.label === label)?.disabled).toBe(false);
  }
  const id = (label: string) => observed.candidates.find((candidate) => candidate.label === label)!.id;
  await expect(driver.act(action("click", id("Change state")), signal)).rejects.toThrow("read_only_link_required");
  await expect(driver.act(action("type", id("Name"), "synthetic"), signal)).rejects.toThrow("read_only_action_required");
  await expect(driver.act(action("select", id("Choice"), "B"), signal)).rejects.toThrow("read_only_action_required");
  await expect(driver.act(action("key", null, "Enter"), signal)).rejects.toThrow("read_only_action_required");
  expect(await page.evaluate(() => Reflect.get(window, "dispatches"))).toBe(0);
  await driver.close();
});

test("read-only driver permits scoped links, navigation, back, scroll and wait but not downloads or new tabs", async ({ page }) => {
  const driver = await setup(page);
  const observed = await driver.observe(signal);
  for (const label of ["Download", "New tab"]) {
    const candidate = observed.candidates.find((item) => item.label === label)!;
    await expect(driver.act(action("click", candidate.id), signal)).rejects.toThrow("read_only_link_required");
  }
  const next = observed.candidates.find((item) => item.label === "Next page")!;
  await driver.act(action("click", next.id), signal);
  expect(page.url()).toBe(`${origin}/next`);
  await driver.observe(signal);
  await driver.act(action("back"), signal);
  expect(page.url()).toBe(`${origin}/`);
  await driver.observe(signal);
  await driver.act(action("navigate", null, `${origin}/next`), signal);
  await driver.observe(signal);
  await driver.act(action("scroll", null, "down"), signal);
  await driver.act(action("wait", null, "0"), signal);
  await driver.close();
});

test("read-only link checks the current element and controlled actions remain unchanged", async ({ page }) => {
  const readonly = await setup(page);
  const observed = await readonly.observe(signal);
  const next = observed.candidates.find((item) => item.label === "Next page")!;
  await page.locator(`[data-ff-candidate="${next.id}"]`).evaluate((element) => {
    const replacement = document.createElement("button");
    replacement.textContent = "Replacement";
    for (const attribute of element.attributes) replacement.setAttribute(attribute.name, attribute.value);
    replacement.onclick = () => { Reflect.set(window, "dispatches", Reflect.get(window, "dispatches") + 1); };
    element.replaceWith(replacement);
  });
  await expect(readonly.act(action("click", next.id), signal)).rejects.toThrow("read_only_link_required");
  expect(await page.evaluate(() => Reflect.get(window, "dispatches"))).toBe(0);
  await readonly.close();
  const controlled = await setup(page, false);
  expect(controlled.capabilities).toEqual(fixtureCapabilities);
  const button = (await controlled.observe(signal)).candidates.find((item) => item.label === "Change state")!;
  await controlled.act(action("click", button.id), signal);
  expect(await page.evaluate(() => Reflect.get(window, "dispatches"))).toBe(1);
  await controlled.close();
});
