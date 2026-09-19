import { controlledNavigationScope, controlledSite } from "../../lib/controlled-sites";
import { SECOND_COUPON_SIGNATURE } from "../../lib/demo";
import {
  couponRecipeSchema, fixtureNavigationMarkerSchema, type CouponRecipe, type CouponStep,
  type FixtureNavigationMarker, type ReproductionReason,
} from "../../lib/reproduction-contracts";
import type { ReportSource } from "../repository";
import type { LoadedEvidence } from "../reports/aggregate";

export type ReproductionSource = {
  source: ReportSource;
  evidence: readonly LoadedEvidence[];
  /** Trusted lookup must also consult takeover history, which is not necessarily in RunEvent. */
  humanActions: boolean;
};
export type GroundingResult =
  | { status: "ready"; recipe: CouponRecipe }
  | { status: "unsupported" | "setup_required"; reason: ReproductionReason };
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const navigationPaths: Readonly<Record<FixtureNavigationMarker, string>> = Object.freeze({
  "store-home": "/demo",
  "store-home-category": "/demo/category/home",
  "store-mug": "/demo/product/mug",
  "store-cart": "/demo/cart",
});

/** Trusted runtime calls this only after a successful guarded navigate action, before URL redaction. */
export function fixtureNavigationMarker(rawValue: unknown): FixtureNavigationMarker | null {
  if (typeof rawValue !== "string") return null;
  for (const marker of fixtureNavigationMarkerSchema.options) {
    if (rawValue === controlledSite("store").origin + navigationPaths[marker]) return marker;
  }
  return null;
}

/**
 * Deliberately narrow trusted-fixture compiler. It never emits a selector, URL,
 * prose, credential, or JavaScript taken from evidence. Other workflows fail closed.
 */
export function groundCouponReproduction(input: ReproductionSource, attemptId: string): GroundingResult {
  const deny = (reason: ReproductionReason): GroundingResult => ({ status: "unsupported", reason });
  const { source, evidence } = input;
  if (input.humanActions !== false) return deny("human_actions");
  const site = controlledSite("store");
  let target: URL;
  try { target = new URL(source.run.scope.targetUrl); } catch { return deny("unsupported_target"); }
  if (source.run.executionMode !== "controlled-fixture" ||
    (source.run.controlledSiteId && source.run.controlledSiteId !== "store") ||
    target.origin !== site.origin || target.search || target.hash || target.username || target.password ||
    !site.navigationPaths.includes(target.pathname)) return deny("unsupported_target");
  try {
    const scope = controlledNavigationScope(site, source.run.scope.targetUrl, source.run.scope);
    if (!["/demo/product/mug", "/demo/cart"].every((path) => scope.navigationPaths.includes(path))) {
      return deny("unsupported_target");
    }
  } catch { return deny("unsupported_target"); }
  const attempt = source.attempts.find((entry) => entry.id === attemptId);
  const summary = source.summaries.find((entry) => entry.attemptId === attemptId);
  if (!attempt || attempt.status !== "target_failed" || summary?.launchState !== "settled" ||
    summary.summary?.cleanup.status !== "closed") {
    return deny("unavailable_evidence");
  }
  const events = source.events.filter((entry) => entry.attemptId === attemptId);
  if (events.some((event) => String(event.data.actor) === "human")) return deny("human_actions");
  const registered = new Map(source.evidence.filter((entry) => entry.metadata.attemptId === attemptId)
    .map((entry) => [entry.metadata.id, entry]));
  const loaded = new Map(evidence.filter((entry) => entry.metadata.attemptId === attemptId &&
    entry.metadata.runId === source.run.id && registered.get(entry.metadata.id)?.storageKey === entry.storageKey)
    .map((entry) => [entry.metadata.id, entry]));
  let observation: Record<string, unknown> | null = null;
  let observationConsumed = false;
  let page = "";
  let exactFailure = false;
  let failureAfterSteps = 0;
  const steps: CouponStep[] = [];
  for (const event of events) {
    if (!["attempt.action", "attempt.observation"].includes(event.kind)) continue;
    const item = event.data.evidenceId ? loaded.get(event.data.evidenceId) : undefined;
    if (!item || item.state !== "available") return deny("unavailable_evidence");
    const data = object(item.data);
    if (data?.actor === "human" || object(data?.action)?.actor === "human") return deny("human_actions");
    if (event.kind === "attempt.observation") {
      observation = object(data?.observation);
      observationConsumed = false;
      if (!observation || !Array.isArray(observation.candidates)) return deny("unavailable_evidence");
      page = typeof event.data.pageUrl === "string" ? event.data.pageUrl : "";
      if (page !== `${site.origin}/demo/cart` && steps.length) return deny("unsupported_action");
      if (Array.isArray(observation.signals) && observation.signals.some((signal) => {
        const entry = object(signal);
        return entry?.kind === "functional_failure" &&
          (entry.message === "FF_DEMO_SECOND_COUPON" || entry.message === SECOND_COUPON_SIGNATURE);
      })) {
        exactFailure = true;
        failureAfterSteps = steps.length;
      }
      continue;
    }
    const action = object(data?.action);
    if (!action || action.actor !== "agent" || !observation || observationConsumed) return deny("ambiguous_evidence");
    observationConsumed = true;
    if (exactFailure) return deny("ambiguous_evidence");
    if (action.action === "wait") {
      if (steps.length) steps.push({ kind: "wait" });
      continue;
    }
    const candidates = (observation.candidates as unknown[]).map(object)
      .filter((candidate) => candidate?.id === action.candidateId);
    const candidate = candidates[0];
    if (action.action === "type") {
      if (candidates.length !== 1 || candidate?.kind !== "input" || candidate.label !== "Coupon code" ||
        candidate.disabled || candidate.inputType === "password" ||
        !["SAVE10", "COZY5"].includes(String(action.value))) {
        return { status: "setup_required", reason: "secret_setup_required" };
      }
      if (page !== `${site.origin}/demo/cart`) return deny("ambiguous_evidence");
      if ((observation.candidates as unknown[]).map(object).filter((entry) =>
        entry?.kind === "input" && entry.label === "Coupon code").length !== 1) return deny("ambiguous_evidence");
      steps.push({ kind: "fill_coupon", coupon: action.value === "SAVE10" ? "SAVE10" : "COZY5" });
      continue;
    }
    if (action.action === "click") {
      if (candidates.length !== 1 || !candidate || candidate.disabled) return deny("ambiguous_evidence");
      if (typeof candidate.label !== "string") return deny("ambiguous_evidence");
      if (/purchase|place.*order|buy|delete|remove|checkout|continue/i.test(candidate.label)) return deny("destructive_action");
      if (page === `${site.origin}/demo/cart` && candidate.kind === "button" && candidate.label === "Apply coupon") {
        if ((observation.candidates as unknown[]).map(object).filter((entry) =>
          entry?.kind === "button" && entry.label === "Apply coupon").length !== 1) return deny("ambiguous_evidence");
        steps.push({ kind: "apply_coupon" });
        continue;
      }
      if (steps.length || !["Home gifts", "Paper goods", "Maple ceramic mug", "Add to cart", "View cart", "Cart (1)"]
        .includes(candidate.label)) return deny("unsupported_action");
      continue;
    }
    if (action.action === "navigate" && !steps.length) {
      const rawMarker = fixtureNavigationMarker(action.value);
      if (data?.fixtureNavigation !== undefined) {
        const persisted = fixtureNavigationMarkerSchema.safeParse(data.fixtureNavigation);
        if (!persisted.success || (action.value !== "[REDACTED_URL]" && rawMarker !== persisted.data)) {
          return deny("ambiguous_evidence");
        }
        continue;
      }
      if (rawMarker) continue;
    }
    return deny("unsupported_action");
  }
  if (!exactFailure || failureAfterSteps !== steps.length || !steps.some((step) => step.kind === "fill_coupon" && step.coupon === "SAVE10") ||
    !steps.some((step) => step.kind === "fill_coupon" && step.coupon === "COZY5") ||
    steps.filter((step) => step.kind === "apply_coupon").length < 2) return deny("missing_failure_predicate");
  const parsed = couponRecipeSchema.safeParse({
    version: "coupon-reproduction-v1", fixture: "store", predicate: "second-coupon-error-and-missing-discount-v1", steps,
  });
  return parsed.success ? { status: "ready", recipe: parsed.data } : deny("unsupported_action");
}
