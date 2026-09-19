import { z } from "zod";
import {
  citationSchema, criterionCheckSchema, criterionKey, isLegacyCriterion,
  type Criterion, type CriterionCheck,
} from "../../lib/criteria";
import type { EvaluationInput, Observation } from "./types";

// Stagehand rewrites URL-formatted extraction fields into DOM-link IDs. This
// provenance URL must stay literal; criterionCheckSchema validates it locally.
const semanticCitationSchema = citationSchema.extend({ pageUrl: z.string().min(1).max(4096) });
export const semanticResponseSchema = z.strictObject({
  checks: z.array(z.strictObject({
    criterion: z.string().min(1).max(500),
    status: z.enum(["met", "not_met", "inconclusive", "not_observed"]),
    citations: z.array(semanticCitationSchema).max(12),
    confidence: z.number().min(0).max(1),
    uncertainty: z.string().max(1000),
  })).max(12),
});

/** This is the entire observation available to inference and citation validation. */
export function boundedObservation(observation: Observation): Observation {
  let blockCharacters = 0;
  const textBlocks = observation.textBlocks?.slice(0, 80).filter((block) => {
    blockCharacters += block.length;
    return block.length <= 1000 && blockCharacters <= 12000;
  });
  return {
    id: observation.id.slice(0, 200), url: observation.url.slice(0, 4096),
    title: observation.title.slice(0, 500), text: observation.text.slice(0, 16000),
    ...(textBlocks !== undefined ? { textBlocks } : {}),
    candidates: observation.candidates.slice(0, 80).map((candidate) => ({
      id: candidate.id.slice(0, 200), kind: candidate.kind, label: candidate.label.slice(0, 200),
      ...(candidate.href ? { href: candidate.href.slice(0, 2000) } : {}),
      ...(candidate.inputType ? { inputType: candidate.inputType.slice(0, 100) } : {}),
      ...(candidate.disabled !== undefined ? { disabled: candidate.disabled } : {}),
      ...(candidate.value !== undefined ? { value: candidate.value.slice(0, 200) } : {}),
      ...(candidate.checked !== undefined ? { checked: candidate.checked } : {}),
      ...(candidate.selected ? { selected: candidate.selected.slice(0, 80).map((value) => value.slice(0, 200)) } : {}),
    })),
    ...(observation.screenshotKey ? { screenshotKey: observation.screenshotKey.slice(0, 1000) } : {}),
    signals: [], checks: [],
  };
}

export function inconclusive(criterion: Criterion, uncertainty: string): CriterionCheck {
  return { criterion: criterionKey(criterion), passed: false, evidence: "", status: "inconclusive", method: "semantic", citations: [], uncertainty };
}

export function unsupported(criterion: Criterion): CriterionCheck {
  return {
    criterion: criterionKey(criterion), passed: false, evidence: "", status: "unsupported",
    method: "semantic", citations: [], uncertainty: "Semantic evaluator capability unavailable",
  };
}

export function relevant(criterion: Criterion, observation: Observation): boolean {
  if (typeof criterion === "string" || !criterion.paths) return true;
  try { return criterion.paths.includes(new URL(observation.url).pathname); } catch { return false; }
}

export function deterministicCheck(criterion: Criterion, observation: Observation): CriterionCheck | undefined {
  const key = criterionKey(criterion);
  if (!relevant(criterion, observation)) {
    return { criterion: key, passed: false, evidence: "", status: "not_observed", method: typeof criterion === "string" || criterion.kind === "semantic" ? "semantic" : "deterministic" };
  }
  if (isLegacyCriterion(criterion)) {
    const matches = observation.checks.filter((check) => check.criterion === key);
    if (!matches.length) return { criterion: key, passed: false, evidence: "", status: "not_observed", method: "legacy" };
    const passed = matches.every((check) => check.passed && check.evidence.trim());
    return {
      criterion: key, passed, status: passed ? "met" : "not_met", method: "legacy",
      evidence: matches.map((check) => check.evidence.trim()).filter(Boolean).join("\n").slice(0, 4096),
    };
  }
  if (typeof criterion === "string" || criterion.kind === "semantic") return undefined;
  const bounded = boundedObservation(observation);
  let passed = false;
  let evidence = "";
  const matches = (actual: string, expected: string, match: "exact" | "contains") =>
    match === "exact" ? actual === expected : actual.includes(expected);
  if (criterion.kind === "url") {
    try { passed = new URL(bounded.url).pathname === criterion.path; } catch { /* Invalid URLs cannot prove a match. */ }
    evidence = bounded.url;
  } else if (criterion.kind === "visible_text") {
    passed = criterion.match === "exact"
      ? (bounded.textBlocks ?? bounded.text.split("\n")).some((line) => line.trim() === criterion.text)
      : (bounded.textBlocks?.join(" ") ?? bounded.text).includes(criterion.text);
    evidence = passed ? criterion.text : "Requested text was not present in the bounded observation";
  } else {
    const candidates = bounded.candidates.filter((candidate) =>
      (!criterion.controlKind || criterion.controlKind === candidate.kind) &&
      matches(candidate.label, criterion.label, criterion.match));
    const requested = (["value", "checked", "disabled", "selected"] as const)
      .filter((field) => criterion[field] !== undefined);
    const candidate = candidates.find((candidate) => requested.every((field) => {
      if (field === "selected") {
        const actual = candidate.selected;
        return actual !== undefined && actual.length === criterion.selected!.length &&
          criterion.selected!.every((value) => actual.includes(value));
      }
      return candidate[field] === criterion[field];
    }));
    passed = !!candidate;
    if (!passed && candidates.some((candidate) => requested.some((field) => candidate[field] === undefined))) {
      return {
        criterion: key, passed: false, evidence: "", status: "inconclusive", method: "deterministic",
        uncertainty: "Requested control state was not available in the bounded observation",
      };
    }
    evidence = candidate
      ? requested.length ? JSON.stringify({
        label: candidate.label, ...Object.fromEntries(requested.map((field) => [field, candidate[field]])),
      }) : candidate.label
      : "Requested control or state did not match the bounded observation";
  }
  return { criterion: key, passed, evidence, status: passed ? "met" : "not_met", method: "deterministic" };
}

export function validateSemanticChecks(raw: unknown, input: EvaluationInput): CriterionCheck[] {
  const observation = boundedObservation(input.observation);
  const parsed = z.array(criterionCheckSchema).max(12).safeParse(raw);
  if (!parsed.success) return input.criteria.map((criterion) => inconclusive(criterion, "Malformed evaluator response"));
  const allowed = new Set(input.criteria.map(criterionKey));
  if (parsed.data.some((check) => !allowed.has(check.criterion))) {
    return input.criteria.map((criterion) => inconclusive(criterion, "Evaluator returned an unknown criterion"));
  }
  return input.criteria.map((criterion) => {
    const matches = parsed.data.filter((check) => check.criterion === criterionKey(criterion));
    if (matches.length !== 1) return inconclusive(criterion, "Missing or ambiguous evaluator result");
    const check = matches[0];
    const citations = check.citations ?? [];
    const valid = citations.every((citation) =>
      citation.observationId === observation.id && citation.pageUrl === observation.url &&
      citation.step === input.step && citation.excerpt.trim().length > 0 &&
      observation.text.includes(citation.excerpt) &&
      (citation.screenshotKey === undefined || citation.screenshotKey === observation.screenshotKey));
    if (!valid || !check.status || check.method !== "semantic" ||
      (["met", "not_met"].includes(check.status) && (!citations.length || !!check.uncertainty?.trim()))) {
      return inconclusive(criterion, "Ungrounded or ambiguous evaluator result");
    }
    // Only configured relevance can establish that a page is unrelated. A model
    // cannot preserve a prior milestone by declaring relevant evidence invisible.
    if ((check.status === "not_observed" || check.status === "unsupported") && relevant(criterion, observation)) {
      return inconclusive(criterion, "Evaluator could not observe the criterion on a relevant page");
    }
    return {
      ...check, evidence: citations.map((citation) => citation.excerpt).join("\n").slice(0, 4096),
      citations: citations.map((citation) => ({
        ...citation, ...(observation.screenshotKey ? { screenshotKey: observation.screenshotKey } : {}),
      })),
      ...(check.confidence !== undefined ? { confidenceMeaning: "heuristic" as const } : {}),
    };
  });
}

export function parseSemanticResponse(raw: unknown, input: EvaluationInput): CriterionCheck[] {
  const parsed = semanticResponseSchema.safeParse(raw);
  if (!parsed.success) return input.criteria.map((criterion) => inconclusive(criterion, "Malformed semantic response"));
  return validateSemanticChecks(parsed.data.checks.map((check) => ({
    ...check, method: "semantic", passed: check.status === "met", evidence: "",
  })), input);
}

export function mergeCriterionCheck(criterion: Criterion, previous: CriterionCheck | undefined, current: CriterionCheck): CriterionCheck {
  const milestone = typeof criterion === "string" ? isLegacyCriterion(criterion) : criterion.semantics === "milestone";
  return milestone && previous?.passed && current.status === "not_observed" ? previous : current;
}

export function evaluationCacheKey(input: EvaluationInput): string {
  const state = boundedObservation(input.observation);
  return JSON.stringify([input.criteria, state.url, state.title, state.text, state.textBlocks, state.candidates]);
}
