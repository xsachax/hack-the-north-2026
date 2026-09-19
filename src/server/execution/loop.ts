import { z } from "zod";
import { assignmentSchema, personaSchema } from "../../lib/contracts";
import { criterionKey } from "../../lib/criteria";
import { ModelBudget } from "./budget";
import { deterministicCheck, inconclusive, mergeCriterionCheck, unsupported, validateSemanticChecks } from "./evaluator";
import {
  decisionSchema, ExecutionError,
  type BrowserAction, type CleanupOutcome, type CriterionCheck, type Decision,
  type ExecutePersonaInput, type ExecutionDependencies, type ExecutionEvent,
  type ExecutionResult, type HistoryEntry, type Observation, type TerminalOutcome,
} from "./types";

const limitsSchema = z.strictObject({
  maxSteps: z.int().min(1).max(30).default(30),
  maxModelCalls: z.int().min(1).max(30).default(30),
  maxDurationMs: z.int().min(1).max(300_000).default(300_000),
  stallThreshold: z.int().min(1).max(30).default(3),
  historyLimit: z.int().min(1).max(30).default(10),
  rushDelayMs: z.int().min(0).max(5000).default(0),
  carefulDelayMs: z.int().min(0).max(5000).default(250),
});
const keys = new Set([
  "Tab", "Shift+Tab", "Enter", "Space", "Escape", "ArrowUp", "ArrowDown",
  "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Backspace", "Delete",
]);

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

class InternalFailure extends Error {
  constructor(readonly kind: "brain" | "event" | "evaluator") {
    super(kind);
  }
}

function terminal(error: unknown): TerminalOutcome {
  if (error instanceof InternalFailure) {
    return {
      status: "infrastructure_failed",
      reason: {
        brain: "Brain failed", event: "Event sink failed", evaluator: "Semantic evaluation failed",
      }[error.kind],
    };
  }
  if (error instanceof ExecutionError) {
    const status = {
      block: "blocked", target: "target_failed", infra: "infrastructure_failed",
      limit: "limit_reached", unsupported: "blocked",
    } as const;
    const reasons = {
      block: "block: Driver policy blocked execution",
      target: "target: Trusted driver reported target failure",
      infra: "infra: Execution infrastructure failed",
      limit: "limit: Execution limit reached",
      unsupported: "unsupported: Unsupported browser action",
    } as const;
    return { status: status[error.code], reason: reasons[error.code] };
  }
  return { status: "infrastructure_failed", reason: "Execution infrastructure failed" };
}

function validateDecision(raw: Decision, observation: Observation): Decision {
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) throw new ExecutionError("infra", "Invalid brain decision");
  const decision = parsed.data;
  const { action, candidateId, value } = decision;
  const targeted = ["click", "type", "select"].includes(action);
  if (targeted) {
    if (!candidateId || !observation.candidates.some((candidate) => candidate.id === candidateId && !candidate.disabled)) {
      throw new ExecutionError("unsupported", "Action references an unknown candidate");
    }
  } else if (candidateId !== null) {
    throw new ExecutionError("unsupported", "This action cannot reference a candidate");
  }
  if (["click", "back", "done", "give_up"].includes(action) && value !== null) {
    throw new ExecutionError("unsupported", "Unexpected action value");
  }
  if (["type", "select", "navigate", "scroll", "key"].includes(action) && value === null) {
    throw new ExecutionError("unsupported", "Missing action value");
  }
  if (action === "key" && !keys.has(value!)) throw new ExecutionError("unsupported", "Unsupported key");
  if (action === "scroll" && value !== "up" && value !== "down") {
    throw new ExecutionError("unsupported", "Scroll value must be up or down");
  }
  if (action === "wait" && value !== null && (!/^\d{1,4}$/.test(value) || Number(value) > 5000)) {
    throw new ExecutionError("unsupported", "Wait must be milliseconds from 0 to 5000");
  }
  if (action === "navigate") {
    let url: URL;
    try { url = new URL(value!); } catch { throw new ExecutionError("unsupported", "Invalid navigation URL"); }
    if (!["https:", "http:"].includes(url.protocol)) {
      throw new ExecutionError("unsupported", "Unsupported navigation protocol");
    }
  }
  return freeze(decision);
}

/** Execute only the original objective; page content and brain commentary are untrusted data. */
export async function executePersona(
  input: ExecutePersonaInput,
  deps: ExecutionDependencies,
): Promise<ExecutionResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let expired = false;
  let modelCleanupFailed = false;
  let steps = 0;
  let budget: ModelBudget | undefined;
  let outcome: TerminalOutcome = { status: "infrastructure_failed", reason: "Execution did not start" };
  let cleanup: CleanupOutcome = { status: "failed", errors: ["Cleanup did not finish"] };
  const errors: string[] = [];
  const checks = new Map<string, CriterionCheck>();
  const cancel = () => { cancelled = true; controller.abort(); };

  function interrupted(): never {
    throw new ExecutionError(expired ? "limit" : "infra", expired ? "Duration limit reached" : "Operation aborted");
  }

  // Both handlers remain attached to late operations, so late rejection cannot
  // escape. The driver close() contract fences browser side effects before return.
  async function operation<T>(run: () => Promise<T>): Promise<T> {
    if (controller.signal.aborted) interrupted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        controller.signal.removeEventListener("abort", abort);
        reject(new ExecutionError(expired ? "limit" : "infra", expired ? "Duration limit reached" : "Operation aborted"));
      };
      controller.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => {
        if (controller.signal.aborted) interrupted();
        return run();
      }).then(
        (value) => { controller.signal.removeEventListener("abort", abort); resolve(value); },
        (error) => { controller.signal.removeEventListener("abort", abort); reject(error); },
      );
    });
  }

  async function emit(event: ExecutionEvent): Promise<void> {
    if (!deps.onEvent) return;
    await operation(async () => {
      try { await deps.onEvent!(freeze(event), controller.signal); }
      catch { throw new InternalFailure("event"); }
    });
  }

  async function delay(ms: number): Promise<void> {
    if (!ms) return;
    await operation(() => new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      controller.signal.addEventListener("abort", finish, { once: true });
    }));
  }

  try {
    const persona = freeze(personaSchema.parse(input.persona));
    const assignment = assignmentSchema.parse({
      personaId: persona.id, goal: input.goal, criteria: input.criteria,
    });
    if (new Set(assignment.criteria.map(criterionKey)).size !== assignment.criteria.length) {
      throw new ExecutionError("infra", "Criteria must be unique");
    }
    const goal = assignment.goal;
    const criteria = freeze(assignment.criteria);
    const limits = limitsSchema.parse(input.limits ?? {});
    budget = new ModelBudget(limits.maxModelCalls, controller.signal);
    for (const criterion of criteria) checks.set(criterionKey(criterion), freeze({ criterion: criterionKey(criterion), passed: false, evidence: "" }));
    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted) cancel();
    deadline = setTimeout(() => { expired = true; controller.abort(); }, limits.maxDurationMs);
    const history: HistoryEntry[] = [];
    const repeats = new Map<string, number>();

    await emit({ kind: "started", actor: "agent", personaId: persona.id });
    let observation = freeze(structuredClone(await operation(() => deps.driver.observe(controller.signal))));
    while (true) {
      const semantic = [];
      const observedChecks: CriterionCheck[] = [];
      let verificationFailure: ExecutionError | InternalFailure | undefined;
      for (const criterion of criteria) {
        const check = deterministicCheck(criterion, observation);
        if (check) {
          observedChecks.push(check);
          checks.set(criterionKey(criterion), freeze(mergeCriterionCheck(criterion, checks.get(criterionKey(criterion)), check)));
        }
        else semantic.push(criterion);
      }
      const failure = observation.signals.find((signal) => signal.kind === "functional_failure");
      if (failure) {
        observation = freeze({ ...observation, checks: observedChecks });
        await emit({ kind: "observation", actor: "agent", observation });
        outcome = { status: "target_failed", reason: "Trusted observation reported functional failure" };
        break;
      }
      if (semantic.length) {
        const evaluator = deps.evaluator ?? (deps.brain.evaluate ? deps.brain : undefined);
        const evaluationInput = freeze({ criteria: semantic, observation, step: steps });
        let evaluated = semantic.map(unsupported);
        if (evaluator?.evaluate) {
          try {
            evaluated = validateSemanticChecks(await operation(async () => {
              if (!evaluator.managesModelBudget) budget!.charge("evaluation", controller.signal);
              return evaluator.evaluate!(evaluationInput, controller.signal, budget);
            }), evaluationInput);
          } catch (error) {
            evaluated = semantic.map((criterion) => inconclusive(criterion,
              error instanceof ExecutionError && error.code === "limit" ? "Model-call budget exhausted" : "Semantic evaluation failed"));
            for (let index = 0; index < semantic.length; index++) {
              checks.set(criterionKey(semantic[index]), freeze(evaluated[index]));
            }
            if (controller.signal.aborted) throw error;
            verificationFailure = error instanceof ExecutionError && error.code === "limit"
              ? error : new InternalFailure("evaluator");
          }
        }
        for (let index = 0; index < semantic.length; index++) {
          const criterion = semantic[index];
          observedChecks.push(evaluated[index]);
          checks.set(criterionKey(criterion), freeze(mergeCriterionCheck(criterion, checks.get(criterionKey(criterion)), evaluated[index])));
        }
      }
      observation = freeze({ ...observation, checks: observedChecks });
      await emit({ kind: "observation", actor: "agent", observation });
      if (verificationFailure) throw verificationFailure;
      if ([...checks.values()].every((check) => check.passed)) {
        outcome = { status: "succeeded", reason: "All criteria have trusted evidence" };
        break;
      }
      if (steps >= limits.maxSteps || budget.total >= limits.maxModelCalls) {
        outcome = { status: "limit_reached", reason: "Step or model-call limit reached" };
        break;
      }
      if (steps >= persona.patienceSteps) {
        outcome = { status: "gave_up", reason: "Persona patience exhausted" };
        break;
      }
      const decision = validateDecision(await operation(async () => {
        try {
          if (!deps.brain.managesModelBudget) budget!.charge("decision", controller.signal);
          return await deps.brain.decide(freeze({
            persona, goal, criteria, observation, history: [...history],
          }), controller.signal, budget);
        } catch (error) {
          if (error instanceof ExecutionError && error.code === "limit") throw error;
          throw new InternalFailure("brain");
        }
      }), observation);
      await emit({ kind: "decision", actor: "agent", decision, modelCalls: budget.total });
      if (decision.action === "done" || decision.action === "give_up") {
        outcome = {
          status: "gave_up",
          reason: decision.action === "done" ? "Brain declared done without trusted criterion evidence" : "Persona gave up",
        };
        break;
      }
      const signature = JSON.stringify([
        observation.url, observation.title, observation.text, observation.candidates,
        [...checks.values()].map((check) => [check.criterion, check.passed]),
        decision.action, decision.candidateId, decision.value,
      ]);
      const count = (repeats.get(signature) ?? 0) + 1;
      repeats.set(signature, count);
      if (count > limits.stallThreshold) {
        outcome = { status: "gave_up", reason: "Repeated state/action stall detected" };
        break;
      }
      await delay(persona.readingStyle === "careful" ? limits.carefulDelayMs : limits.rushDelayMs);
      const action: BrowserAction = freeze({ ...decision, actor: "agent" });
      steps++;
      await operation(() => deps.driver.act(action, controller.signal));
      history.push(freeze({ observation, decision }));
      if (history.length > limits.historyLimit) history.shift();
      await emit({ kind: "action", actor: "agent", action, steps });
      // Always observe the final action. Semantic verification still requires
      // inference budget; deterministic verification does not.
      observation = freeze(structuredClone(await operation(() => deps.driver.observe(controller.signal))));
    }
  } catch (error) {
    outcome = cancelled
      ? { status: "cancelled", reason: "Execution cancelled" }
      : expired ? { status: "limit_reached", reason: "Duration limit reached" } : terminal(error);
    if (outcome.status === "infrastructure_failed") errors.push(outcome.reason);
  } finally {
    if (deadline) clearTimeout(deadline);
    input.signal?.removeEventListener("abort", cancel);
    controller.abort();
    budget?.close();
    const drainers = new Set([deps.brain, deps.evaluator].filter((value) => value?.drain));
    const drained = await Promise.allSettled([...drainers].map((value) => Promise.resolve().then(() => value!.drain!())));
    if (drained.some((result) => result.status === "rejected")) {
      modelCleanupFailed = true;
      errors.push("Model cleanup failed");
    }
    try {
      const raw = await deps.driver.close();
      const parsed = z.strictObject({
        status: z.enum(["closed", "failed"]), errors: z.array(z.string()),
      }).parse(raw);
      cleanup = freeze({
        status: parsed.status,
        errors: parsed.errors.map(() => "Driver cleanup operation failed"),
      });
    } catch {
      cleanup = freeze({ status: "failed", errors: ["Driver cleanup failed"] });
    }
    if (cleanup.status === "failed" || cleanup.errors.length) {
      errors.push(...(cleanup.errors.length ? cleanup.errors : ["Driver cleanup failed"]));
    }
  }
  const originalTerminal = freeze({ ...outcome });
  if (cleanup.status === "failed" || cleanup.errors.length) {
    outcome = { status: "infrastructure_failed", reason: "Driver cleanup failed" };
  } else if (modelCleanupFailed) {
    outcome = { status: "infrastructure_failed", reason: "Model cleanup failed" };
  }
  let result: ExecutionResult = freeze({
    ...outcome, originalTerminal, checks: [...checks.values()], steps, modelCalls: budget?.total ?? 0,
    modelOperations: budget?.snapshot() ?? { decision: 0, evaluation: 0, retry: 0, total: 0 },
    durationMs: Math.max(0, Date.now() - startedAt), cleanup, errors: [...errors],
  });
  if (deps.onEvent) {
    // Final reporting is outside the execution deadline and uses its own bounded
    // signal because browser cleanup has already fenced the session.
    const reporting = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => deps.onEvent!(freeze({ kind: "finished", actor: "agent", result }), reporting.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reporting.abort();
            reject(new Error("Final event sink timed out"));
          }, 1000);
        }),
      ]);
    } catch {
      const reason = "Event sink failed";
      result = freeze({
        ...result, status: "infrastructure_failed", reason,
        errors: [...result.errors, reason], durationMs: Math.max(0, Date.now() - startedAt),
      });
    } finally {
      if (timer) clearTimeout(timer);
      reporting.abort();
    }
  }
  return result;
}
