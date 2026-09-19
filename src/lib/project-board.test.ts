import { describe, expect, it } from "vitest";
import { addProject, readBoardState } from "./project-board";

describe("bounded synthetic tab-local board", () => {
  it("round trips a new project without requiring seed state", () => {
    const state = addProject(readBoardState(null), { name: "  Aurora  ", category: "Research" });
    expect(readBoardState(JSON.stringify(state))).toEqual({
      version: 1, projects: [{ name: "Aurora", category: "Research" }],
    });
  });

  it.each(["bad json", "{}", JSON.stringify({ version: 2, projects: [] }), " ".repeat(4097),
    JSON.stringify({ version: 1, projects: [{ name: "X", category: "Unknown" }] }),
  ])("rejects malformed or unbounded stored data", (raw) => {
    expect(() => readBoardState(raw)).toThrow();
  });

  it("rejects duplicates, unsafe fields, and more than twelve projects", () => {
    const initial = addProject(readBoardState(null), { name: "Aurora", category: "Research" });
    expect(() => addProject(initial, { name: "AURORA", category: "Design" })).toThrow("already exists");
    expect(() => addProject(initial, { name: "a".repeat(61), category: "Design" })).toThrow();
    expect(() => addProject(initial, { name: "line\nbreak", category: "Design" })).toThrow();
    let full = initial;
    for (let i = 1; i < 12; i++) full = addProject(full, { name: `Project ${i}`, category: "Engineering" });
    expect(() => addProject(full, { name: "Another", category: "Research" })).toThrow("full");
  });
});
