import { expect, test, type Page } from "@playwright/test";
import type { EvidenceDetail, RunReport } from "../../src/lib/report-contracts";
import type { ReplayReport } from "../../src/lib/replay-contracts";

const runId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const evidenceId = "33333333-3333-4333-8333-333333333333";
const missingId = "44444444-4444-4444-8444-444444444444";
const timestamp = "2026-09-19T09:00:00.000Z";
const injection = '<img src=x onerror="window.injected=true"> [link](javascript:alert(1))';
const reportPath = `/runs/${runId}/reports`;
const replayPath = `/runs/${runId}/attempts/${attemptId}/replay`;

function reportFixture(): RunReport {
  return {
    version: "report-v1", signatureVersion: "finding-v2", runId, revision: "revision-1",
    status: "target_failed", finality: "final", target: "javascript:alert(1)",
    createdAt: timestamp, updatedAt: timestamp, notices: [],
    agents: [{
      attemptId, persona: { id: "reader", name: "Careful reader", device: "phone" }, goal: "Find the project",
      status: "target_failed", finality: "final", launchState: "settled", cleanup: "unknown", steps: 2, modelCalls: 3,
      criteria: (["met", "not_met", "not_observed", "inconclusive", "unsupported"] as const).map((status, index) => ({
        key: `criterion-${index}`, definitionSignature: `definition-${index}`, description: `Criterion ${status}`,
        semantics: "current", status, method: index === 0 ? "structural" : index === 1 ? "legacy" : "semantic",
        confidence: index === 2 ? 0.7 : null, confidenceMeaning: "heuristic", explanation: injection,
        uncertainty: index === 3 ? "Insufficient observations" : null,
        citations: [{ step: 2, observationId: "observation-2", page: "javascript:alert(1)", excerpt: injection, evidenceIds: [evidenceId], state: "partial" }],
      })),
      timeline: [{
        sequence: 2, timestamp, kind: "attempt.observation", actor: "agent", step: 2,
        action: "inspect", commentary: injection, page: "javascript:alert(1)", evidenceId, evidenceState: "available",
      }],
      evidence: [{ id: evidenceId, attemptId, kind: "screenshot", createdAt: timestamp, state: "available", sensitivity: "private_pixels" }],
      groupSignatures: ["finding-signature"],
    }],
    groups: [{
      signature: "finding-signature", signatureVersion: "finding-v2", category: "subjective_friction",
      title: "Navigation felt unclear", explanation: "One recorded observation; not a confirmed functional defect.",
      page: "/projects", element: "navigation", criterionSignature: null,
      occurrences: [{ attemptId, personaId: "reader", evidenceIds: [evidenceId], step: 2 }],
      counts: {
        occurrences: 2, affectedAttempts: 1, affectedPersonas: 1, assignedAttempts: 3, assignedPersonas: 3,
        eligibleAttempts: 2, eligiblePersonas: 2, testedAttempts: 1, testedPersonas: 1,
        notTestedAttempts: 1, notTestedPersonas: 1, outOfCohortAttempts: 1,
      },
    }],
  };
}

async function fixture(page: Page) {
  const state = {
    report: reportFixture(), reportReads: 0, evidenceReads: 0, contentReads: 0,
    reportError: 0, evidenceError: 0, expired: false, locked: false, ownerId: "owner-one",
    replayReads: 0, replayAuthorizations: 0, replayError: 0, replayAuthorizationError: 0,
    replayAuthorizationBody: null as unknown, replayAuthorizationCsrf: "", replayAuthorizationMethod: "",
    replay: { status: "processing", format: "hls", sensitive: true, fallback: "operator-dashboard", pages: [] } as ReplayReport,
    detail: {
      runId, evidence: reportFixture().agents[0].evidence[0], text: null, references: [], notice: "Owner-only screenshot; not redacted.",
    } as EvidenceDetail,
  };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const data = (value: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: value }) });
    const error = (status: number) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable" } }) });
    if (path === "/session") {
      if (state.expired || (state.locked && route.request().postDataJSON().accessCode !== "test-code")) return error(401);
      state.locked = false;
      return data({ ownerId: state.ownerId, csrfToken: "test-csrf", expiresAt: Date.now() + 60_000 });
    }
    if (state.expired) return error(401);
    if (path === `${replayPath}/authorize`) {
      state.replayAuthorizations++;
      state.replayAuthorizationBody = route.request().postDataJSON();
      state.replayAuthorizationCsrf = route.request().headers()["x-csrf-token"];
      state.replayAuthorizationMethod = route.request().method();
      return state.replayAuthorizationError ? error(state.replayAuthorizationError) : data({ authorized: true, expiresAt: Date.now() + 60_000 });
    }
    if (path === replayPath) {
      state.replayReads++;
      return state.replayError ? error(state.replayError) : data(state.replay);
    }
    if (path === `/runs/${runId}/reports`) {
      state.reportReads++;
      return state.reportError ? error(state.reportError) : data(state.report);
    }
    if (path === `/evidence/${evidenceId}/detail`) {
      state.evidenceReads++;
      return state.evidenceError ? error(state.evidenceError) : data(state.detail);
    }
    if (path === `/evidence/${evidenceId}/content`) {
      state.contentReads++;
      return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF2kAAAAASUVORK5CYII=", "base64") });
    }
    if (path === `/runs/${runId}`) return data({
      id: runId, cursor: 0, status: "target_failed", authorizationAcknowledged: true, executionMode: "controlled-fixture",
      scope: { targetUrl: "https://example.test/projects", allowedSubdomains: [], pathPrefixes: ["/projects"] },
      createdAt: timestamp, updatedAt: timestamp, cancelRequestedAt: null,
    });
    if (path === `/runs/${runId}/attempts`) return data({ items: [{
      id: attemptId, runId, status: "target_failed", createdAt: timestamp, updatedAt: timestamp,
      goal: "Find the project", criteria: [], persona: {
        id: "reader", name: "Careful reader", character: "A careful reader", device: "phone",
        techComfort: "low", patienceSteps: 8, readingStyle: "careful", quirks: [], worries: [],
      },
    }] });
    if (path.endsWith("/sessions")) return data({ items: [] });
    if (path.endsWith("/summaries")) return data({ items: [{
      attemptId, status: "target_failed", launchState: "settled", summary: null, usage: null,
      reservedSeconds: 0, consumedSeconds: 0, releasedSeconds: 0,
    }] });
    if (path.endsWith("/events")) return data({ items: [], nextCursor: null });
    return error(404);
  });
  return state;
}

test("wall header and each attempt navigate to the real report", async ({ page }) => {
  await fixture(page);
  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole("link", { name: "Reports", exact: true })).toHaveAttribute("href", reportPath);
  await page.getByRole("link", { name: "View agent report & evidence" }).click();
  await expect(page).toHaveURL(`${reportPath}?attempt=${attemptId}`);
  await expect(page.getByRole("heading", { name: "Careful reader", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Live wall", exact: true }).click();
  await expect(page).toHaveURL(`/runs/${runId}`);
});

test("owner gate precedes report reads; exact criterion methods and denominators stay honest", async ({ page }) => {
  const state = await fixture(page);
  state.locked = true;
  await page.goto(`${reportPath}?group=finding-signature`);
  await expect(page.getByLabel("Workspace access code")).toBeVisible();
  expect(state.reportReads).toBe(0);
  await page.getByLabel("Workspace access code").fill("test-code");
  await page.getByRole("button", { name: "Unlock workspace" }).click();
  for (const status of ["met", "not_met", "not_observed", "inconclusive", "unsupported"]) {
    await expect(page.locator(`.report-state-${status}`)).toHaveText(status);
  }
  await expect(page.getByText("Heuristic confidence: 70% — not a calibrated probability.")).toBeVisible();
  for (const method of ["structural", "semantic", "legacy"]) await expect(page.getByText(method, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Affected / tested attempts")).toBeVisible();
  await expect(page.getByText("Not tested attempts / personas")).toBeVisible();
  await expect(page.getByText("Out-of-cohort attempts")).toBeVisible();
  await expect(page.getByText("Remote cleanup", { exact: true }).locator("..")).toContainText("unknown");
  await expect(page.getByRole("link", { name: "Download JSON", exact: true })).toHaveAttribute("href", `/api/v1/runs/${runId}/exports/json`);
});

test("untrusted strings stay text and screenshot pixels require explicit keyboard acknowledgement", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`${reportPath}?attempt=${attemptId}&evidence=${evidenceId}`);
  await expect(page.getByRole("heading", { name: "Private evidence", exact: true })).toBeVisible();
  await expect(page.getByText("Private screenshot — NOT redacted.")).toBeVisible();
  await expect(page.locator(".report-criteria").getByText(injection, { exact: true }).first()).toBeVisible();
  await expect(page.locator(".report-criteria img, .report-timeline img, a[href^='javascript:'], a[href^='https:']")).toHaveCount(0);
  await expect(page.locator(".report-screenshot")).toHaveCount(0);
  expect(state.contentReads).toBe(0);
  await page.getByRole("button", { name: "Show private screenshot", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".report-screenshot")).toBeVisible();
  expect(state.contentReads).toBe(1);
  await page.getByRole("button", { name: "Hide private screenshot", exact: true }).click();
  await expect(page.locator(".report-screenshot")).toHaveCount(0);
  expect(await page.evaluate(() => "injected" in window)).toBe(false);
});

test("mobile group navigation, evidence references and keyboard controls work without overflow", async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(reportPath);
  const group = page.getByRole("link", { name: /Navigation felt unclear/ });
  await group.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Navigation felt unclear", exact: true })).toBeVisible();
  await page.locator(".report-timeline").getByRole("link", { name: /Evidence 33333333/ }).click();
  await expect(page).toHaveURL(new RegExp(`evidence=${evidenceId}`));
  await expect(page.getByRole("heading", { name: "Private evidence", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("missing evidence, attempt and group never imply ready content", async ({ page }) => {
  await fixture(page);
  await page.goto(`${reportPath}?attempt=${missingId}&group=missing&evidence=${missingId}`);
  await expect(page.getByText("This attempt is missing from the current report.")).toBeVisible();
  await expect(page.getByText("This finding group is missing from the current report.")).toBeVisible();
  await expect(page.getByText("Evidence is missing or not accessible to this owner.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show private screenshot", exact: true })).toHaveCount(0);
  await expect(page.locator(".report-screenshot")).toHaveCount(0);
});

test("report and evidence failures offer retry rather than invented results", async ({ page }) => {
  const state = await fixture(page);
  state.reportError = 503;
  await page.goto(`${reportPath}?evidence=${evidenceId}`);
  await expect(page.locator(".report-notice[role='alert']")).toContainText("Report could not be loaded");
  await expect(page.getByRole("heading", { name: "Grouped findings", exact: true })).toHaveCount(0);
  state.reportError = 0;
  state.evidenceError = 503;
  await page.getByRole("button", { name: "Retry report", exact: true }).click();
  await expect(page.getByRole("region", { name: "Private evidence", exact: true }).getByRole("alert")).toContainText("Evidence could not be loaded");
  state.evidenceError = 0;
  await page.getByRole("button", { name: "Retry evidence", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show private screenshot", exact: true })).toBeVisible();
});

test("settling results refresh at a paced interval, clear revealed evidence on revision, and stop at final", async ({ page }) => {
  const state = await fixture(page);
  state.report.finality = "settling";
  state.report.agents[0].finality = "settling";
  await page.clock.install();
  await page.goto(`${reportPath}?evidence=${evidenceId}`);
  await expect(page.getByText("Checking persisted results every 5 seconds, for up to two minutes.")).toBeVisible();
  await page.getByRole("button", { name: "Show private screenshot", exact: true }).click();
  await expect(page.locator(".report-screenshot")).toBeVisible();
  const reads = state.reportReads;
  await page.clock.fastForward(4000);
  expect(state.reportReads).toBe(reads);
  state.report.revision = "revision-final";
  state.report.finality = "final";
  state.report.agents[0].finality = "final";
  await page.clock.fastForward(1100);
  await expect.poll(() => state.reportReads).toBe(reads + 1);
  await expect(page.locator(".report-screenshot")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show private screenshot", exact: true })).toBeVisible();
  await page.clock.fastForward(20_000);
  expect(state.reportReads).toBe(reads + 1);
  expect(state.contentReads).toBe(1);
});

test("empty and missing reports are distinct states", async ({ page }) => {
  const state = await fixture(page);
  state.report.agents = [];
  state.report.groups = [];
  await page.goto(reportPath);
  await expect(page.getByText("No agent reports persisted yet.")).toBeVisible();
  await expect(page.getByText("No grouped findings persisted. This does not establish that the target is defect-free.")).toBeVisible();
  state.reportError = 404;
  await page.getByRole("button", { name: "Refresh report", exact: true }).click();
  await expect(page.getByText("Report is missing or not accessible to this owner.")).toBeVisible();
});

test("owner-session retry never restores acknowledged screenshot pixels", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`${reportPath}?evidence=${evidenceId}`);
  await page.getByRole("button", { name: "Show private screenshot", exact: true }).click();
  await expect(page.locator(".report-screenshot")).toBeVisible();
  state.expired = true;
  await page.getByRole("button", { name: "Refresh report", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry existing session", exact: true })).toBeVisible();
  await expect(page.locator(".report-screenshot")).toHaveCount(0);
  state.expired = false;
  await page.getByRole("button", { name: "Retry existing session", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show private screenshot", exact: true })).toBeVisible();
  await expect(page.locator(".report-screenshot")).toHaveCount(0);
  expect(state.contentReads).toBe(1);
});

test("nonfinal refresh is bounded and can be restarted manually", async ({ page }) => {
  const state = await fixture(page);
  state.report.finality = "uncertain";
  await page.clock.install();
  await page.goto(reportPath);
  await expect.poll(() => state.reportReads).toBe(1);
  for (let read = 2; read <= 24; read++) {
    await page.clock.fastForward(5100);
    await expect.poll(() => state.reportReads).toBe(read);
  }
  await expect(page.getByText("Automatic refresh paused after two minutes. Refresh report to check again.")).toBeVisible();
  await page.clock.fastForward(60_000);
  expect(state.reportReads).toBe(24);
  await page.getByRole("button", { name: "Refresh report", exact: true }).click();
  await expect.poll(() => state.reportReads).toBe(25);
});

test("sanitized text stays escaped and unavailable artifacts have no download or reveal control", async ({ page }) => {
  const state = await fixture(page);
  state.detail.evidence = { ...state.detail.evidence, kind: "console", sensitivity: "redacted_text" };
  state.detail.text = injection;
  await page.goto(`${reportPath}?evidence=${evidenceId}`);
  await expect(page.locator(".report-text")).toHaveText(injection);
  await expect(page.locator(".report-text img, .report-text a")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Download sanitized JSON attachment" })).toHaveAttribute("href", `/api/v1/evidence/${evidenceId}/content`);
  state.detail.evidence.state = "missing";
  state.report.revision = "missing-artifact";
  await page.getByRole("button", { name: "Refresh report", exact: true }).click();
  await expect(page.getByText("This artifact is missing. No content or playback is implied.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download sanitized JSON attachment" })).toHaveCount(0);
  expect(state.contentReads).toBe(0);
});

test("invalid deep-linked evidence IDs do not trigger artifact reads", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`${reportPath}?evidence=${encodeURIComponent("https://elsewhere.invalid/private")}`);
  await expect(page.getByText("Evidence is missing or not accessible to this owner.")).toBeVisible();
  expect(state.evidenceReads).toBe(0);
  expect(state.contentReads).toBe(0);
  await expect(page.locator("a[href^='https:']")).toHaveCount(0);
});

test("evidence from a different run or an unrelated attempt is never revealed", async ({ page }) => {
  const state = await fixture(page);
  state.detail.runId = missingId;
  await page.goto(`${reportPath}?attempt=${attemptId}&evidence=${evidenceId}`);
  await expect(page.getByText("Evidence is missing or not accessible to this owner.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show private screenshot", exact: true })).toHaveCount(0);
  state.detail.runId = runId;
  state.detail.evidence.attemptId = missingId;
  await page.getByRole("button", { name: "Retry evidence", exact: true }).click();
  await expect(page.getByText("Evidence is missing or not accessible to this owner.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show private screenshot", exact: true })).toHaveCount(0);
  expect(state.contentReads).toBe(0);
});

test("a selected attempt cannot reveal another report agent's evidence", async ({ page }) => {
  const state = await fixture(page);
  state.report.agents.push({ ...structuredClone(state.report.agents[0]), attemptId: missingId, persona: { id: "other", name: "Other reader", device: "desktop" } });
  await page.goto(`${reportPath}?attempt=${missingId}&evidence=${evidenceId}`);
  await expect(page.getByText("Evidence is missing or not accessible to this owner.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show private screenshot", exact: true })).toHaveCount(0);
  expect(state.contentReads).toBe(0);
});

test("recording requires explicit sensitive consent and authorization; availability never polls automatically", async ({ page }) => {
  const state = await fixture(page);
  await page.clock.install();
  await page.goto(reportPath);
  const recording = page.getByRole("region", { name: "Session recording", exact: true });
  const load = recording.getByRole("button", { name: "Load private recording", exact: true });
  await expect(load).toBeDisabled();
  await page.clock.fastForward(30_000);
  expect(state.replayReads).toBe(0);
  expect(state.replayAuthorizations).toBe(0);
  await recording.getByRole("checkbox", { name: "I understand that this recording may contain sensitive information.", exact: true }).check();
  await expect(load).toBeEnabled();
  expect(state.replayReads).toBe(0);
  await load.focus();
  await page.keyboard.press("Enter");
  await expect(recording.getByRole("status")).toContainText("processing");
  expect(state.replayAuthorizationMethod).toBe("POST");
  expect(state.replayAuthorizationBody).toEqual({ acknowledgeSensitiveVideo: true });
  expect(state.replayAuthorizationCsrf).toBe("test-csrf");
  expect(state.replayAuthorizations).toBe(1);
  expect(state.replayReads).toBe(1);
  await expect(recording.locator("video")).toHaveCount(0);
  await expect(recording.getByText(/requires a separate provider\/operator account/)).toBeVisible();
  await expect(recording.getByRole("link", { name: "Open the authorized Browserbase dashboard", exact: true })).toHaveAttribute("href", `/api/v1${replayPath}/dashboard`);
  await page.clock.fastForward(60_000);
  expect(state.replayReads).toBe(1);
  expect(state.replayAuthorizations).toBe(1);
  await recording.getByRole("button", { name: "Hide recording", exact: true }).click();
  await expect(load).toBeDisabled();
  await expect(recording.getByRole("link", { name: "Open the authorized Browserbase dashboard", exact: true })).toHaveCount(0);
});

for (const [status, message] of [
  ["unavailable", "No recording is available through the protected provider API."],
  ["expired", "The provider reported that the recording expired."],
  ["unsupported", "This recording format or media destination is not supported"],
] as const) {
  test(`recording ${status} is an honest nonplayable state with an account-gated fallback`, async ({ page }) => {
    const state = await fixture(page);
    state.replay.status = status;
    await page.goto(reportPath);
    const recording = page.getByRole("region", { name: "Session recording", exact: true });
    await recording.getByRole("checkbox", { name: "I understand that this recording may contain sensitive information.", exact: true }).check();
    await recording.getByRole("button", { name: "Load private recording", exact: true }).click();
    await expect(recording.getByRole("status")).toContainText(message);
    await expect(recording.locator("video")).toHaveCount(0);
    await expect(recording.getByText(/requires a separate provider\/operator account/)).toBeVisible();
    expect(state.replayReads).toBe(1);
  });
}

test("failed recording reads show an error without loading video", async ({ page }) => {
  const state = await fixture(page);
  state.replayError = 503;
  await page.goto(reportPath);
  const recording = page.getByRole("region", { name: "Session recording", exact: true });
  await recording.getByRole("checkbox", { name: "I understand that this recording may contain sensitive information.", exact: true }).check();
  await recording.getByRole("button", { name: "Load private recording", exact: true }).click();
  await expect(recording.getByRole("alert")).toContainText("The service is unavailable.");
  await expect(recording.locator("video")).toHaveCount(0);
  await expect(recording.getByRole("status")).toHaveCount(0);
  expect(state.replayReads).toBe(1);
});

test("a failed recording grant never reads replay metadata", async ({ page }) => {
  const state = await fixture(page);
  state.replayAuthorizationError = 503;
  await page.goto(reportPath);
  const recording = page.getByRole("region", { name: "Session recording", exact: true });
  await recording.getByRole("checkbox", { name: "I understand that this recording may contain sensitive information.", exact: true }).check();
  await recording.getByRole("button", { name: "Load private recording", exact: true }).click();
  await expect(recording.getByRole("alert")).toContainText("The service is unavailable.");
  await expect(recording.locator("video")).toHaveCount(0);
  await expect(recording.getByRole("link", { name: "Open the authorized Browserbase dashboard", exact: true })).toHaveCount(0);
  expect(state.replayAuthorizations).toBe(1);
  expect(state.replayReads).toBe(0);
});

test("ready replay metadata with an external playlist is rejected before video or external requests", async ({ page }) => {
  const state = await fixture(page);
  state.replay = {
    ...state.replay, status: "ready",
    pages: [{ index: 0, startTimeMs: 0, endTimeMs: 1000, playlistPath: "https://untrusted.invalid/private.m3u8" }],
  };
  const externalRequests: string[] = [];
  await page.route("https://untrusted.invalid/**", (route) => {
    externalRequests.push(route.request().url());
    return route.abort();
  });
  await page.goto(reportPath);
  const recording = page.getByRole("region", { name: "Session recording", exact: true });
  await recording.getByRole("checkbox", { name: "I understand that this recording may contain sensitive information.", exact: true }).check();
  await recording.getByRole("button", { name: "Load private recording", exact: true }).click();
  await expect(recording.getByRole("alert")).toBeVisible();
  await expect(recording.locator("video")).toHaveCount(0);
  await expect(recording.getByRole("status")).toHaveCount(0);
  expect(externalRequests).toEqual([]);
  expect(state.replayReads).toBe(1);
});
