import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { controlledNavigationScope, controlledSite, type ControlledSiteId } from "../../src/lib/controlled-sites";
import type { Criterion } from "../../src/lib/criteria";
import { DEMO_STORAGE_KEY, freshDemo } from "../../src/lib/demo";
import { ArtifactWriter } from "../../src/server/execution/artifacts";
import type { CloudUsage } from "../../src/server/execution/cloud";
import { ScopedBrowserDriver } from "../../src/server/execution/driver";
import { controlledRequestPolicy, installControlledNetwork, localControlledSource } from "../../src/server/execution/fixture-network";
import type { Decision } from "../../src/server/execution/types";
import { WorkerRepository } from "../../src/server/worker/repository";
import { DurableWorker, type WorkerDependencies } from "../../src/server/worker/runtime";

type PlannedAction = [Decision["action"], string, string | null];
const journeys: { site: ControlledSiteId; goal: string; criteria: Criterion[]; actions: PlannedAction[] }[] = [
  {
    site: "store", goal: "Put a pocket journal in the cart, without applying coupons or checking out.",
    criteria: [
      { id: "cart", kind: "url", description: "Cart is open", semantics: "current", path: "/demo/cart" },
      { id: "journal", kind: "visible_text", description: "Journal is in the cart", semantics: "current",
        paths: ["/demo/cart"], text: "Pocket trail journal - CA$12.00", match: "contains" },
    ],
    actions: [
      ["click", "Paper goods", null], ["click", "Pocket trail journal", null],
      ["click", "Add to cart", null], ["click", "View cart", null],
    ],
  },
  {
    site: "project-board", goal: "Create Telescope as a Design project and find it in All projects.",
    criteria: [
      { id: "selected-category", kind: "control", description: "Design was selected before submission", semantics: "milestone",
        paths: ["/project-board/new"], label: "Category", match: "exact", controlKind: "select",
        value: "Design", selected: ["Design"], disabled: false },
      { id: "list", kind: "url", description: "Projects list is open", semantics: "current", path: "/project-board/projects" },
      { id: "project", kind: "visible_text", description: "Telescope is visible", semantics: "current",
        paths: ["/project-board/projects"], text: "Telescope", match: "contains" },
      { id: "category", kind: "visible_text", description: "Design category is visible", semantics: "current",
        paths: ["/project-board/projects"], text: "Category: Design", match: "contains" },
    ],
    actions: [
      ["click", "New project", null], ["type", "Project name", "Telescope"],
      ["select", "Category", "Design"], ["click", "Create project", null],
    ],
  },
];

for (const journey of journeys) {
  test(`durable worker executes a custom persona's novel ${journey.site} goal in the actual browser`, async ({ page }, testInfo) => {
    const directory = testInfo.outputPath("durable-worker");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const repository = new WorkerRepository(directory);
    const writer = new ArtifactWriter({ dataDir: directory });
    const owner = repository.createSession().ownerId;
    const persona = repository.createPersona(owner, {
      name: "Custom planner", character: "An independent visitor completing a specific small task.",
      device: "desktop", techComfort: "medium", patienceSteps: 16, readingStyle: "skim",
      quirks: ["Follows visible labels"], worries: ["Losing the new item"],
    });
    const run = repository.createControlledRun(owner, randomUUID(), {
      authorizationAcknowledged: true, controlledSiteId: journey.site,
      assignments: [{ personaId: persona.id, goal: journey.goal, criteria: journey.criteria }],
    }).run;
    const actions = [...journey.actions];
    const diagnostics: string[] = [];
    const privateSessionId = randomUUID();
    let closeCount = 0;
    let selectedCategoryObserved = false;
    const dependencies: WorkerDependencies = {
      artifacts: (runId, attemptId) => writer.createSinks(runId, attemptId),
      recover: async () => ({ confirmed: false, sessions: [] }),
      diagnostic: (code) => diagnostics.push(code),
      launch: async (options) => {
        expect(options.controlledSiteId).toBe(journey.site);
        expect(options.personaId).toBe(persona.id);
        expect(options.criteria).toEqual(journey.criteria);
        if (journey.site === "project-board") expect(options.fixtures).toBeUndefined();
        const site = controlledSite(journey.site);
        const scope = controlledNavigationScope(site, options.targetUrl, options.scope);
        const policy = controlledRequestPolicy(site, scope);
        const holder: { driver?: ScopedBrowserDriver } = {};
        const network = await installControlledNetwork(page.context(), page, localControlledSource(options.fixturePort, policy),
          (event) => holder.driver?.policySignal(event.url, event.code), policy);
        options.assertActive?.();
        await page.setViewportSize(options.viewport);
        await page.goto(options.targetUrl);
        if (options.fixtures) {
          await page.evaluate(({ key, state }) => sessionStorage.setItem(key, state), {
            key: DEMO_STORAGE_KEY, state: JSON.stringify(freshDemo(options.fixtures)),
          });
          await page.reload();
        }
        await page.getByRole("heading", { level: 1 }).waitFor();
        await options.onSession({
          sessionId: privateSessionId, liveViewUrl: "https://www.browserbase.com/private-live",
          replayUrl: `https://www.browserbase.com/sessions/${privateSessionId}`, timeoutSeconds: 240,
        });
        const usage: CloudUsage = { allocationAttempted: true, reservedSeconds: 240, elapsedSeconds: 1 };
        const driver = new ScopedBrowserDriver({
          page, scope, artifacts: options.artifacts, cleanupJson: options.cleanupJson,
          networkErrors: network.errors, assertActive: options.assertActive,
          close: async () => {
            closeCount++;
            await page.close();
            await network.close();
            usage.remoteStatus = "COMPLETED";
            usage.actualBrowserSeconds = 1;
            return { status: "closed", errors: [] };
          },
        });
        holder.driver = driver;
        return {
          driver, usage,
          brain: {
            decide: async ({ observation }): Promise<Decision> => {
              expect(observation.checks.every((check) => check.method === "deterministic")).toBe(true);
              if (observation.candidates.some((candidate) => candidate.label === "Category"
                && candidate.value === "Design" && candidate.selected?.includes("Design"))) selectedCategoryObserved = true;
              if (/Opening the (?:store|project board)/.test(observation.text)) {
                return { action: "wait", candidateId: null, value: "250", commentary: "Waiting for hydration." };
              }
              const next = actions[0];
              if (!next) return { action: "done", candidateId: null, value: null, commentary: "" };
              const [action, label, value] = next;
              const candidate = observation.candidates.find((candidate) => candidate.label === label && !candidate.disabled);
              expect(candidate, label).toBeDefined();
              actions.shift();
              return { action, candidateId: candidate!.id, value, commentary: "" };
            },
          },
        };
      },
    };
    try {
      const worker = new DurableWorker(repository, dependencies, 4317);
      const claim = repository.claim(worker.id)!;
      expect(claim.attempt.persona.id).toBe(persona.id);
      expect(claim.attempt.persona.name).toBe("Custom planner");
      await worker.executeClaim(claim, new AbortController().signal);
      expect(repository.getRun(owner, run.id).status, JSON.stringify(diagnostics)).toBe("succeeded");
      expect(actions).toHaveLength(0);
      expect(closeCount).toBe(1);
      expect(diagnostics).toEqual([]);
      if (journey.site === "project-board") expect(selectedCategoryObserved).toBe(true);
      const summary = repository.attemptSummaries(owner, run.id)[0].summary!;
      expect(summary.steps).toBeGreaterThanOrEqual(journey.actions.length);
      expect(summary.cleanup.status).toBe("closed");
      expect(summary.checks).toHaveLength(journey.criteria.length);
      expect(summary.checks.every((check) => check.passed && check.method === "deterministic")).toBe(true);
      const events = repository.events(owner, run.id, { after: 0, limit: 100 }).items;
      for (const kind of ["attempt.observation", "attempt.decision", "attempt.action", "evidence.recorded", "attempt.finished", "run.finished"]) {
        expect(events.some((event) => event.kind === kind), kind).toBe(true);
      }
      expect(JSON.stringify(events)).not.toContain(privateSessionId);
      expect(JSON.stringify(events)).not.toContain("private-live");
      expect(repository.sessionViews(owner, run.id)[0].liveViewUrl).toBeNull();
      expect(repository.accounting().consumedSeconds).toBe(1);
    } finally {
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
