import { describe, expect, it } from "vitest";
import {
  hasRunCapacity, HISTORICAL_MAX_ASSIGNMENTS_PER_RUN, HISTORICAL_MAX_CONCURRENT_AGENTS,
  MAX_ASSIGNMENTS_PER_RUN, MAX_CONCURRENT_AGENTS, selectRunAssignment,
} from "./execution-capacity";

describe("product execution capacity", () => {
  it("keeps the product ceiling separate from historical wire/storage bounds", () => {
    expect(MAX_CONCURRENT_AGENTS).toBe(8);
    expect(MAX_ASSIGNMENTS_PER_RUN).toBe(8);
    expect(HISTORICAL_MAX_ASSIGNMENTS_PER_RUN).toBe(12);
    expect(HISTORICAL_MAX_CONCURRENT_AGENTS).toBe(12);
  });

  it.each([1, 8])("admits %i new assignments", (count) => {
    expect(hasRunCapacity(Array(count))).toBe(true);
  });

  it.each([0, 9, 12])("does not admit %i new assignments", (count) => {
    expect(hasRunCapacity(Array(count))).toBe(false);
  });

  it("caps both picker and newly saved persona auto-selection without mutating the selection", () => {
    const seven = Array.from({ length: 7 }, (_, index) => `persona-${index}`);
    const eight = selectRunAssignment(seven, "eighth");
    expect(eight).toHaveLength(8);
    expect(seven).toHaveLength(7);
    expect(selectRunAssignment(eight, "ninth")).toBe(eight);
    expect(selectRunAssignment(eight, "new-custom-persona")).toBe(eight);
    expect(selectRunAssignment(eight, "eighth")).toBe(eight);
    const deselected = selectRunAssignment(eight, "eighth", false);
    expect(deselected).toEqual(seven);
    expect(selectRunAssignment(deselected, "new-custom-persona")).toHaveLength(8);
  });
});
