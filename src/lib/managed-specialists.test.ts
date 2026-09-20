import { describe, expect, it } from "vitest";
import { managedAssignmentSchema } from "./managed-contracts";
import { managedDefaultCriteria, managedDefaultGoal, managedIanaDemoAssignments, managedIanaDemoScope, managedSpecialistForAssignment, managedSpecialists } from "./managed-specialists";
import { personas } from "./personas";

describe("managed demo specialist presets", () => {
  it("maps five obvious roles to distinct existing profiles and valid read-only assignments", () => {
    expect(managedSpecialists.map((value) => value.label)).toEqual([
      "UI/UX", "Security & privacy", "Accessibility", "Loading & performance", "Content clarity",
    ]);
    expect(new Set(managedSpecialists.map((value) => value.personaId)).size).toBe(5);
    for (const { personaId, goal, criteria, checks } of managedSpecialists) {
      expect(personas.some((persona) => persona.id === personaId)).toBe(true);
      expect(managedAssignmentSchema.parse({ personaId, goal, criteria })).toEqual({ personaId, goal, criteria });
      expect(goal).toContain("read-only");
      expect(checks).toHaveLength(3);
      expect(criteria).toHaveLength(3);
    }
    expect(managedAssignmentSchema.safeParse({
      personaId: personas[0].id, goal: managedDefaultGoal, criteria: managedDefaultCriteria,
    }).success).toBe(true);
  });

  it("asks every specialist to hunt across pages and demands evidence, with fallbacks for facts the harness may not supply", () => {
    const evidence = ["name ", "quote ", "list ", "cite ", "report "], fallback = /untested|unmeasured|unknown/;
    const demandsEvidence = (criterion: string) => evidence.some((word) => criterion.toLowerCase().includes(word));
    expect(new Set(managedSpecialists.map((value) => value.goal)).size).toBe(5);
    expect(new Set(managedSpecialists.flatMap((value) => value.criteria)).size).toBe(15);
    for (const { label, goal, criteria, checks } of managedSpecialists) {
      expect(goal.length).toBeLessThanOrEqual(2000);
      for (const phrase of ["read-only", "at least three", "quote the exact visible", "name the page", "not_met", "Do not ", "authenticate", "or change data"]) expect(goal).toContain(phrase);
      expect(criteria).toHaveLength(3);
      for (const criterion of criteria) {
        expect(criterion.length).toBeLessThanOrEqual(500);
        expect(criterion).not.toContain("\n");
        expect(demandsEvidence(criterion), `${label}: ${criterion}`).toBe(true);
        if (label === "Accessibility" || label === "Loading & performance") expect(criterion, label).toMatch(fallback);
      }
      expect(checks).toHaveLength(3);
    }
    expect(managedSpecialists[0].checks[0]).toBe("Clear next steps");
    const goalOf = (label: string) => managedSpecialists.find((value) => value.label === label)?.goal;
    expect(goalOf("Security & privacy")).toContain("This is not penetration testing");
    expect(goalOf("Security & privacy")).toContain("destination host");
    expect(goalOf("Accessibility")).toContain("not certified WCAG compliance");
    expect(goalOf("Accessibility")).toContain("keys that were actually pressed");
    expect(goalOf("Loading & performance")).toContain("Do not claim packet capture, throttling");
    expect(goalOf("Loading & performance")).toContain("untested, not met");
    // A click's duration is mostly harness overhead, and an undetected outline is not proof of a missing indicator.
    const criteriaOf = (label: string) => managedSpecialists.find((value) => value.label === label)?.criteria ?? [];
    expect(criteriaOf("Loading & performance")[1]).toContain("Never judge speed from how long a click or step took");
    expect(criteriaOf("Accessibility")[1]).toContain("mark this inconclusive, not not_met");
    expect(criteriaOf("Security & privacy")[0]).toContain("outside the approved paths");
    for (const phrase of ["read-only", "at least three", "change data"]) expect(managedDefaultGoal).toContain(phrase);
    expect(managedDefaultCriteria).toHaveLength(3);
    for (const criterion of managedDefaultCriteria) expect(demandsEvidence(criterion), criterion).toBe(true);
  });

  it("offers five distinct short single-page missions without changing historical snapshots", () => {
    expect(managedIanaDemoScope).toEqual({
      targetUrl: "https://www.iana.org/domains/reserved", pathPrefixes: ["/domains/reserved"], allowedSubdomains: [],
    });
    expect(new Set(managedIanaDemoAssignments.map((assignment) => assignment.goal)).size).toBe(5);
    for (const [index, assignment] of managedIanaDemoAssignments.entries()) {
      expect(managedAssignmentSchema.parse(assignment)).toEqual(assignment);
      expect(managedSpecialistForAssignment(assignment)?.label).toBe(managedSpecialists[index].label);
      expect(managedSpecialistForAssignment({ ...assignment, goal: `${assignment.goal} changed` })).toBeUndefined();
    }
  });

  it("labels only exact preset snapshots, never historical or edited missions just because the ID matches", () => {
    const { personaId, goal, criteria } = managedSpecialists[0];
    expect(managedSpecialistForAssignment({ personaId, goal, criteria })?.label).toBe("UI/UX");
    expect(managedSpecialistForAssignment({ personaId, goal: "Historical goal", criteria })).toBeUndefined();
    expect(managedSpecialistForAssignment({ personaId, goal, criteria: [...criteria, "Extra check"] })).toBeUndefined();
    expect(managedSpecialistForAssignment({ personaId, goal, criteria: [...criteria].reverse() })).toBeUndefined();
    expect(managedSpecialistForAssignment({ personaId: "impatient-mobile", goal, criteria })).toBeUndefined();
    expect(personas.find((persona) => persona.id === personaId)?.name).toBe("Alex");
  });
});
