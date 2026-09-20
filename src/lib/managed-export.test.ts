import { describe, expect, it } from "vitest";
import { managedRunSchema, MANAGED_EXECUTION_POLICY } from "./managed-contracts";
import { managedRunFilename, managedRunMarkdown } from "./managed-export";
import { managedSpecialists } from "./managed-specialists";
import { personas } from "./personas";

const specialist = managedSpecialists[1];
const attempt = (extra: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111", persona: personas.find((persona) => persona.id === specialist.personaId)!,
  goal: specialist.goal, criteria: [...specialist.criteria], status: "completed", providerStatus: "COMPLETED",
  cleanup: "closed", cancelRequested: false, error: null, reservedSeconds: 120, actualBrowserSeconds: 67.07, modelCalls: null,
  startedAt: "2026-09-20T09:10:41.000Z", finishedAt: "2026-09-20T09:11:49.000Z",
  progress: [{ sequence: 1, timestamp: "2026-09-20T09:10:44.000Z", kind: "tool", text: "goto:home" }],
  result: {
    summary: "The privacy policy is hosted | elsewhere.\nSecond line.", finalUrl: "https://www.iana.org/about",
    criteria: specialist.criteria.map((criterion, index) => ({
      criterion, status: ["not_met", "inconclusive", "met"][index], observation: `Observation ${index + 1} on /`,
    })),
    limitations: ["Model-authored report, not independently verified."],
  },
  ...extra,
});
const run = (attempts: unknown[]) => managedRunSchema.parse({
  id: "22222222-2222-4222-8222-222222222222", executionPolicy: MANAGED_EXECUTION_POLICY, status: "completed",
  scope: { targetUrl: "https://www.iana.org/", pathPrefixes: ["/"], allowedSubdomains: [] },
  createdAt: "2026-09-20T09:10:40.000Z", updatedAt: "2026-09-20T09:12:00.000Z", attempts,
});

describe("managed findings export", () => {
  it("organises verdicts, problems and per-agent detail without adding claims", () => {
    const text = managedRunMarkdown(run([attempt()]), new Date("2026-09-20T09:15:00.000Z"));
    expect(text.startsWith("# Flash Flood findings: https://www.iana.org/\n")).toBe(true);
    expect(text).toContain("Agent-reported, not independently verified");
    expect(text).toContain("| Security & privacy | completed | 1 | 1 | 1 | 68 s | 67.07 s |");
    expect(text).toContain("## Problems reported (criteria marked not met)\n\n- **Security & privacy**: Observation 1 on /");
    expect(text).toContain(`1. **NOT MET**: ${specialist.criteria[0]}`);
    expect(text).toContain("3. **MET**:");
    expect(text).toContain("- 2026-09-20T09:10:44.000Z [tool] goto:home");
    expect(text).toContain("- Model calls: unknown (not reported)");
    expect(text).toContain("The privacy policy is hosted | elsewhere. Second line.");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toMatch(/browserbase\.com\/(devtools|sessions)/);
  });
  it("states plainly when nothing was reported", () => {
    const text = managedRunMarkdown(run([attempt({ status: "failed", result: null, error: "managed_run_failed", progress: [] })]),
      new Date("2026-09-20T09:15:00.000Z"));
    expect(text).toContain("No criterion was reported not met.");
    expect(text).toContain("| Security & privacy | failed | - | - | - |");
    expect(text).toContain("**Recorded error:** managed_run_failed");
    expect(text).toContain("No agent-reported result is available.");
    expect(text).toContain("No provider progress was recorded.");
  });
  it("names the file after the run", () => {
    expect(managedRunFilename(run([attempt()]))).toBe("flash-flood-findings-22222222.md");
  });
});
