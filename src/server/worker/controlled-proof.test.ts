import { describe, expect, it } from "vitest";
import { boardSemanticProof, singleSessionProof } from "../../../scripts/controlled-proof";

const negativeText = "Your projects No projects yet. Start with New project. 0 of 12 synthetic projects in this tab.";
const positiveText = "Your projects Garden planning Category: Design 1 of 12 synthetic projects in this tab.";
const check = (id: string, passed: boolean, excerpt: string) => ({
  criterion: "project-category", passed, status: passed ? "met" : "not_met", method: "semantic",
  citations: [{ observationId: id, excerpt }],
});
const negative = {
  id: "empty", text: negativeText, checks: [check("empty", false, "No projects yet.")],
  textBlocks: ["Your projects", "No projects yet. Start with New project.", "0 of 12 synthetic projects in this tab."],
};
const positive = {
  id: "saved", text: positiveText, checks: [check("saved", true, "Garden planning")],
  textBlocks: ["Your projects", "Garden planning", "Category: Design", "1 of 12 synthetic projects in this tab."],
};

describe("controlled live acceptance oracle", () => {
  it("requires the known empty and correctly saved board states independently of model judgments", () => {
    expect(boardSemanticProof([negative, positive], positive.checks[0])).toEqual({ negative: true, positive: true });
  });
  it("rejects a confidently grounded but semantically wrong category", () => {
    const wrong = {
      ...positive, text: positive.text.replace("Design", "Research"),
      textBlocks: positive.textBlocks.map((text) => text.replace("Design", "Research")),
    };
    expect(boardSemanticProof([negative, wrong], wrong.checks[0])).toEqual({ negative: true, positive: false });
  });
  it("cannot associate a later fixture success with an earlier model verdict", () => {
    expect(boardSemanticProof([negative, { ...positive, id: "later" }], positive.checks[0]).positive).toBe(false);
  });
  it("requires the negative verdict to be grounded in the known empty list", () => {
    const wrong = { ...negative, text: "Garden planning Category: Research", textBlocks: ["Garden planning", "Category: Research"] };
    expect(boardSemanticProof([wrong, positive], positive.checks[0]).negative).toBe(false);
  });
  it("does not pass missing, forged or wrong-observation citations", () => {
    for (const final of [
      undefined, { ...positive.checks[0], citations: [] },
      check("saved", true, "Nonexistent text"), check("empty", true, "Garden planning"),
    ]) expect(boardSemanticProof([negative, positive], final).positive).toBe(false);
  });
  it("accepts a grounded inconclusive negative but never an inconclusive positive", () => {
    expect(boardSemanticProof([{
      ...negative, checks: [{ ...negative.checks[0], status: "inconclusive" }],
    }, positive], positive.checks[0]).negative).toBe(true);
    expect(boardSemanticProof([negative, positive], {
      ...positive.checks[0], passed: false, status: "inconclusive",
    }).positive).toBe(false);
  });
  it.each([
    ["Other Garden planning", "Design"],
    ["Garden planning Category: Design", "Research"],
  ])("rejects substring-spoofed project name %s in %s", (name, category) => {
    const wrong = {
      ...positive, text: `${name} Category: ${category} 1 of 12 synthetic projects in this tab.`,
      textBlocks: [name, `Category: ${category}`, "1 of 12 synthetic projects in this tab."],
    };
    expect(boardSemanticProof([negative, wrong], wrong.checks[0]).positive).toBe(false);
  });
});

describe("single remote session proof", () => {
  const session = { sessionId: "expected", status: "COMPLETED" };
  it("accepts exactly one closed remote matching the persisted reference", () => {
    expect(singleSessionProof([{ confirmed: true, sessions: [session] }], "expected")).toBe(true);
  });
  it("rejects extra allocations under one launch correlation", () => {
    expect(singleSessionProof([{ confirmed: true, sessions: [session, { ...session, sessionId: "extra" }] }], "expected")).toBe(false);
    expect(singleSessionProof([{ confirmed: true, sessions: [session, session] }], "expected")).toBe(false);
  });
  it("rejects absent, mismatched, nonterminal or unconfirmed references", () => {
    expect(singleSessionProof([], "expected")).toBe(false);
    expect(singleSessionProof([{ confirmed: true, sessions: [session] }], undefined)).toBe(false);
    expect(singleSessionProof([{ confirmed: true, sessions: [session] }], "different")).toBe(false);
    expect(singleSessionProof([{ confirmed: false, sessions: [session] }], "expected")).toBe(false);
    expect(singleSessionProof([{ confirmed: true, sessions: [{ ...session, status: "RUNNING" }] }], "expected")).toBe(false);
  });
});
