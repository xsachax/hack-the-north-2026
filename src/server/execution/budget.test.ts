import { describe, expect, it } from "vitest";
import { ModelBudget } from "./budget";

describe("shared application inference budget", () => {
  it("charges every initiated operation and retry against one cap", () => {
    const signal = new AbortController().signal;
    const budget = new ModelBudget(3, signal);
    budget.charge("decision", signal);
    budget.charge("evaluation", signal);
    budget.charge("retry", signal);
    expect(budget.snapshot()).toEqual({ decision: 1, evaluation: 1, retry: 1, total: 3 });
    expect(budget.remaining).toBe(0);
    expect(() => budget.charge("evaluation", signal)).toThrow("budget exhausted");
    expect(budget.total).toBe(3);
  });
  it("fences both lease/execution cancellation and local request cancellation before charging", () => {
    const controller = new AbortController();
    const budget = new ModelBudget(3, controller.signal);
    const local = AbortSignal.abort(new Error("local cancelled"));
    expect(() => budget.charge("evaluation", local)).toThrow("local cancelled");
    controller.abort(new Error("lease lost"));
    expect(() => budget.charge("decision", new AbortController().signal)).toThrow("lease lost");
    expect(budget.total).toBe(0);
  });
  it("fences closed budgets and returns detached operation snapshots", () => {
    const signal = new AbortController().signal;
    const budget = new ModelBudget(2, signal);
    budget.charge("decision", signal);
    const before = budget.snapshot();
    budget.charge("evaluation", signal);
    expect(before.total).toBe(1);
    budget.close();
    expect(() => budget.charge("retry", signal)).toThrow("closed");
  });
});
