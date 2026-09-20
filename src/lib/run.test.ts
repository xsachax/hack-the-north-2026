import { describe, expect, it } from "vitest";
import { personas } from "./personas";
import { remainingSteps, runStatusSchema } from "./run";

describe("persona foundation", () => {
  it("has twelve unique profiles with valid patience and distinct behaviors", () => {
    expect(personas).toHaveLength(12);
    expect(new Set(personas.map((persona) => persona.id)).size).toBe(12);
    for (const persona of personas) {
      expect(persona.patienceSteps).toBeGreaterThan(0);
      expect(persona.quirks.length).toBeGreaterThan(0);
      expect(persona.worries.length).toBeGreaterThan(0);
    }
  });

  it("uses the stricter of persona patience and the global step cap", () => {
    expect(remainingSteps(3, 6, 12)).toBe(3);
    expect(remainingSteps(3, 12, 5)).toBe(2);
    expect(remainingSteps(10, 6, 12)).toBe(0);
  });

  it.each([-1, 0.5, NaN, Infinity])("rejects invalid step count %s", (steps) => {
    expect(() => remainingSteps(steps, 6, 12)).toThrow();
  });

  it("distinguishes infrastructure failures from bugs and usability problems", () => {
    for (const status of ["target_failed", "infrastructure_failed", "gave_up", "blocked", "limit_reached"]) {
      expect(runStatusSchema.parse(status)).toBe(status);
    }
  });
});
