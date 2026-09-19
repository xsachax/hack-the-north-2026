import { expect, test, type Page } from "@playwright/test";
import type { RunReport } from "../../src/lib/report-contracts";
import type { RunComparison } from "../../src/lib/rerun-contracts";

const parentId = "11111111-1111-4111-8111-111111111111";
const childId = "22222222-2222-4222-8222-222222222222";
const parentAttempt = "33333333-3333-4333-8333-333333333333";
const otherAttempt = "44444444-4444-4444-8444-444444444444";
const childAttempt = "55555555-5555-4555-8555-555555555555";
const time = "2026-09-19T12:00:00.000Z";
function report(): RunReport {
  return {
    version: "report-v1", signatureVersion: "finding-v2", runId: parentId, revision: "parent-revision",
    status: "target_failed", finality: "final", target: "https://fixture.flash-flood.invalid/demo",
    createdAt: time, updatedAt: time, groups: [], notices: [],
    agents: [parentAttempt, otherAttempt].map((attemptId, index) => ({
      attemptId, persona: { id: `persona-${index}`, name: index ? "Unselected reader" : "Selected reader", device: "desktop" },
      goal: "Apply both coupons", status: "target_failed", finality: "final", launchState: "settled", cleanup: "closed",
      steps: 2, modelCalls: 2, timeline: [], evidence: [], groupSignatures: [],
      criteria: [{ key: "coupon", definitionSignature: "c".repeat(64), description: "Both coupons apply",
        semantics: "milestone", status: "not_met", method: "legacy", confidence: null, confidenceMeaning: "heuristic",
        explanation: "Observed failure", uncertainty: null, citations: [] }],
    })),
  };
}
function comparison(): RunComparison {
  return {
    version: "comparison-v1", reportVersion: "report-v1", signatureVersion: "finding-v2", criterionVersion: "criterion-v1",
    parentRunId: parentId, childRunId: childId, parentRevision: "parent-revision", childRevision: "child-revision",
    parentFinality: "final", childFinality: "uncertain", context: "fresh", comparable: true,
    pairs: [{
      parentAttemptId: parentAttempt, childAttemptId: childAttempt, comparable: true,
      parentHumanAssisted: false, childHumanAssisted: false,
      criteria: (["met", "not_met", "not_observed", "inconclusive", "unsupported"] as const).map((after, index) => ({
        definitionSignature: `definition-${index}`, semantics: index ? "current" : "milestone",
        before: "not_met", after, comparable: true, tested: false, confirmedMet: false,
      })),
    }],
    groups: [{
      signature: "f".repeat(64), title: '<script>window.rerunInjected=true</script>', category: "functional_defect", state: "not_observed",
      before: { assigned: 1, eligible: 1, tested: 1, notTested: 0, affected: 1, confirmed: 0 },
      after: { assigned: 1, eligible: 1, tested: 0, notTested: 1, affected: 0, confirmed: 0 },
      explanation: "No comparable positive confirmation. Absence alone is not a fix.",
    }],
    notices: ["Only selected immutable assignments are compared.", "Unknown is not success."],
  };
}
async function fixture(page: Page, site: "store" | "project-board" = "store") {
  const state = {
    requests: [] as { body: unknown; key: string; csrf: string }[],
    lostReply: false, firstFailure: 0, comparisonStatus: 200, comparison: comparison(),
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const data = (value: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: value }) });
    const failure = (status: number) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable" } }) });
    if (path === "/session") return data({ ownerId: "owner-rerun", csrfToken: "rerun-csrf", expiresAt: Date.now() + 100000 });
    if (path === `/runs/${parentId}`) return data({
      id: parentId, cursor: 1, status: "target_failed", authorizationAcknowledged: true,
      scope: { targetUrl: site === "store" ? "https://fixture.flash-flood.invalid/demo" : "https://board.flash-flood.invalid/project-board",
        allowedSubdomains: [], pathPrefixes: [site === "store" ? "/demo" : "/project-board"] },
      createdAt: time, updatedAt: time, cancelRequestedAt: null, executionMode: "controlled-fixture", controlledSiteId: site,
    });
    if (path === `/runs/${parentId}/reports`) return data(report());
    if (path === `/runs/${parentId}/attempts/${parentAttempt}/replay`) return data({ status: "unavailable", reason: "not_recorded" });
    if (path === `/runs/${parentId}/reruns`) {
      state.requests.push({ body: request.postDataJSON(), key: request.headers()["idempotency-key"], csrf: request.headers()["x-csrf-token"] });
      if (state.lostReply && state.requests.length === 1) return failure(503);
      if (state.firstFailure && state.requests.length === 1) return failure(state.firstFailure);
      return data({ created: state.requests.length === 1, run: {
        id: childId, cursor: 2, status: "queued", authorizationAcknowledged: true,
        scope: { targetUrl: "https://fixture.flash-flood.invalid/demo", allowedSubdomains: [], pathPrefixes: ["/demo"] },
        createdAt: time, updatedAt: time, cancelRequestedAt: null, executionMode: "controlled-fixture", controlledSiteId: "store",
      } });
    }
    if (path === `/runs/${parentId}/comparisons/${childId}`) {
      return state.comparisonStatus === 200 ? data(state.comparison) : failure(state.comparisonStatus);
    }
    return failure(404);
  });
  await page.goto(`/runs/${parentId}/reports`);
  await expect(page.getByRole("heading", { name: "Rerun selected attempts" })).toBeVisible();
  return state;
}
async function selectRerun(page: Page) {
  await page.getByLabel("Selected reader · Apply both coupons", { exact: true }).check();
  await page.getByLabel("I authorize this fresh scoped rerun.").check();
}

test("actual report reruns only selected immutable assignments with CSRF and explicit fixed scenario", async ({ page }, info) => {
  const state = await fixture(page);
  const button = page.getByRole("button", { name: "Rerun selected attempts", exact: true });
  await expect(button).toBeDisabled();
  await selectRerun(page);
  await page.getByLabel("Controlled store scenario", { exact: true }).selectOption("fixed");
  await button.click();
  await expect(page.getByRole("link", { name: "Open rerun live wall" })).toHaveAttribute("href", `/runs/${childId}`);
  expect(state.requests).toHaveLength(1);
  expect(state.requests[0]).toMatchObject({
    body: { authorizationAcknowledged: true, attemptIds: [parentAttempt], scenario: "fixed" }, csrf: "rerun-csrf",
  });
  expect(state.requests[0].key).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(state.requests[0].body)).not.toContain(otherAttempt);
  await expect(page.getByRole("heading", { name: "Selected cohort comparison" })).toBeVisible();
  await expect(page.getByText("milestone: not_met → met · not tested", { exact: true })).toBeVisible();
  for (const status of ["not_met", "not_observed", "inconclusive", "unsupported"]) {
    await expect(page.getByText(`current: not_met → ${status} · not tested`, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("functional_defect · not_observed", { exact: true })).toBeVisible();
  await expect(page.getByText(/Rerun: 0 affected \/ 0 tested \/ 1 eligible · 1 not tested · 0 positively confirmed/)).toBeVisible();
  expect(await page.evaluate(() => "rerunInjected" in window)).toBe(false);
  await page.screenshot({ path: info.outputPath("reruns-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath("reruns-mobile.png"), fullPage: true });
});

test("lost reply and refresh retry the exact persisted request without a second admission", async ({ page }) => {
  const state = await fixture(page);
  state.lostReply = true;
  await selectRerun(page);
  await page.getByRole("button", { name: "Rerun selected attempts", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry same rerun" })).toBeEnabled();
  const original = structuredClone(state.requests[0]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry same rerun" })).toBeEnabled();
  await expect(page.getByLabel("Selected reader · Apply both coupons", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Unselected reader · Apply both coupons", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry same rerun" }).click();
  await expect(page.getByRole("link", { name: "Open rerun report" })).toBeVisible();
  expect(state.requests).toEqual([original, original]);
});

test("failed owner-only comparison hides stale success and never infers an outcome", async ({ page }) => {
  const state = await fixture(page);
  await page.getByLabel("Compare a scoped rerun ID").fill(childId);
  await page.getByRole("button", { name: "Refresh comparison" }).click();
  await expect(page.getByRole("heading", { name: "Selected cohort comparison" })).toBeVisible();
  state.comparisonStatus = 404;
  await page.getByRole("button", { name: "Refresh comparison" }).click();
  await expect(page.getByText("Comparison is missing or not accessible to this owner.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Selected cohort comparison" })).toHaveCount(0);
  expect(state.requests).toHaveLength(0);
});

test("board reports never offer controlled store variants", async ({ page }) => {
  const state = await fixture(page, "project-board");
  await selectRerun(page);
  await expect(page.getByLabel("Controlled store scenario", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Rerun selected attempts", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open rerun report" })).toBeVisible();
  expect(state.requests[0].body).toEqual({ authorizationAcknowledged: true, attemptIds: [parentAttempt] });
});

test("definitive nonadmission unlocks correction and uses a new idempotency key", async ({ page }) => {
  const state = await fixture(page);
  state.firstFailure = 400;
  await selectRerun(page);
  await page.getByLabel("Controlled store scenario", { exact: true }).selectOption("fixed");
  await page.getByRole("button", { name: "Rerun selected attempts", exact: true }).click();
  await expect(page.getByText(/Correct the selection and authorize a new request/)).toBeVisible();
  await expect(page.getByLabel("Controlled store scenario", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("Unselected reader · Apply both coupons", { exact: true })).toBeEnabled();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), `ff:rerun:owner-rerun:${parentId}`)).toBeNull();
  await page.getByLabel("Controlled store scenario", { exact: true }).selectOption("second-coupon");
  await page.getByLabel("I authorize this fresh scoped rerun.").check();
  await page.getByRole("button", { name: "Rerun selected attempts", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open rerun report" })).toBeVisible();
  expect(state.requests).toHaveLength(2);
  expect(state.requests[0].key).not.toBe(state.requests[1].key);
  expect(state.requests[1].body).toEqual({ authorizationAcknowledged: true, attemptIds: [parentAttempt], scenario: "second-coupon" });
});

test("rate limiting and reload retain the exact locked request and key", async ({ page }) => {
  const state = await fixture(page);
  state.firstFailure = 429;
  await selectRerun(page);
  await page.getByLabel("Controlled store scenario", { exact: true }).selectOption("fixed");
  await page.getByRole("button", { name: "Rerun selected attempts", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry same rerun" })).toBeEnabled();
  const original = structuredClone(state.requests[0]);
  await expect(page.getByLabel("Selected reader · Apply both coupons", { exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry same rerun" })).toBeEnabled();
  await page.getByRole("button", { name: "Retry same rerun" }).click();
  await expect(page.getByRole("link", { name: "Open rerun report" })).toBeVisible();
  expect(state.requests).toEqual([original, original]);
});

test("a previously saved invalid board scenario can be corrected after definitive rejection", async ({ page }) => {
  const state = await fixture(page, "project-board");
  state.firstFailure = 400;
  const invalid = {
    key: "66666666-6666-4666-8666-666666666666",
    request: { authorizationAcknowledged: true, attemptIds: [parentAttempt], scenario: "fixed" },
  };
  await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
    key: `ff:rerun:owner-rerun:${parentId}`, value: invalid,
  });
  await page.reload();
  await page.getByRole("button", { name: "Retry same rerun" }).click();
  await expect(page.getByText(/Correct the selection and authorize a new request/)).toBeVisible();
  await expect(page.getByLabel("Selected reader · Apply both coupons", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("Controlled store scenario", { exact: true })).toHaveCount(0);
  await page.getByLabel("I authorize this fresh scoped rerun.").check();
  await page.getByRole("button", { name: "Rerun selected attempts", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open rerun report" })).toBeVisible();
  expect(state.requests[0]).toMatchObject({ key: invalid.key, body: invalid.request });
  expect(state.requests[1].key).not.toBe(invalid.key);
  expect(state.requests[1].body).toEqual({ authorizationAcknowledged: true, attemptIds: [parentAttempt] });
});
