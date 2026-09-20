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
