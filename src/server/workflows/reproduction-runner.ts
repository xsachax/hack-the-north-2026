import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright-core";
import { DEMO_STORAGE_KEY, freshDemo, SECOND_COUPON_SIGNATURE } from "../../lib/demo";
import { couponStepSchema, type CouponStep } from "../../lib/reproduction-contracts";
import {
  FIXTURE_ORIGIN, installFixtureNetwork, localFixtureSource,
} from "../execution/fixture-network";
import type { BrowserAction, BrowserDriver, ExecutionEvent, Observation } from "../execution/types";

export const REPRODUCTION_SIGNATURE = "second-coupon-error-and-missing-discount-v1" as const;
export const REPRODUCTION_SETUP_STEPS = 3;
export type CandidateInput = {
  reproductionId: string;
  candidateId: string;
  steps: readonly CouponStep[];
  signature: typeof REPRODUCTION_SIGNATURE;
  maxDurationMs: number;
  /** Runtime must pass the inherited worker/attempt bound, including the three setup actions. */
  maxSteps?: number;
  reservationSeconds: number;
  signal: AbortSignal;
};
export type CandidateResult = {
  outcome: "reproduced" | "not_reproduced" | "unknown";
  signature: typeof REPRODUCTION_SIGNATURE | null;
  cleanup: "confirmed" | "unknown";
  environment: "trusted_fixture" | "uncertain";
  /** Private uniqueness fence; never exported. A worker must supply its actual fresh allocation identity. */
  sessionIdentity: string;
};
export type CandidateRunner = (input: CandidateInput) => Promise<CandidateResult>;
export type CouponObservation = {
  exactFailure: boolean; unexpectedError: boolean;
  couponsApplied: boolean; expectedTotal: boolean; fixtureHealthy: boolean;
};

export async function observeCouponOutcome(page: Page, errors: readonly string[]): Promise<CouponObservation> {
  return {
    exactFailure: errors.includes(SECOND_COUPON_SIGNATURE),
    unexpectedError: errors.some((error) => error !== SECOND_COUPON_SIGNATURE),
    couponsApplied: await page.getByText(/^Applied coupons: (?:SAVE10, COZY5|COZY5, SAVE10)$/).isVisible(),
    expectedTotal: await page.getByRole("heading", { name: "Order total: CA$21.60", exact: true }).isVisible(),
    fixtureHealthy: await page.getByRole("heading", { name: "Your cart", exact: true }).isVisible() &&
      await page.getByText("Maple ceramic mug - CA$24.00", { exact: true }).isVisible(),
  };
}

export async function replayCouponSteps(page: Page, raw: readonly CouponStep[], signal: AbortSignal): Promise<void> {
  const steps = couponStepSchema.array().max(30).parse(raw);
  for (const step of steps) {
    signal.throwIfAborted();
    if (step.kind === "fill_coupon") await page.getByRole("textbox", { name: "Coupon code", exact: true }).fill(step.coupon);
    else if (step.kind === "apply_coupon") await page.getByRole("button", { name: "Apply coupon", exact: true }).click();
    else await page.waitForTimeout(25);
  }
}

/**
 * Used only with an explicitly allocated browser. The source can reach one
 * trusted loopback fixture port; browser requests never continue to the network.
 */
export async function prepareCouponFixture(
  browser: Browser, port: number, variant: "broken" | "fixed", options: { seedCart?: boolean } = {},
) {
  if (variant !== "broken" && variant !== "fixed") throw new Error("Invalid fixture variant");
  const source = localFixtureSource(port);
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(3000);
    page.setDefaultNavigationTimeout(5000);
    const denied: string[] = [];
    const network = await installFixtureNetwork(context, page, source, () => denied.push("network_denied"));
    const state = freshDemo();
    state.fixtures.secondCoupon = variant === "broken";
    state.cart = options.seedCart === false ? [] : ["mug"];
    await context.addInitScript(({ key, seed, origin }) => {
      if (location.origin === origin && sessionStorage.getItem(key) === null) {
        sessionStorage.clear();
        localStorage.clear();
        sessionStorage.setItem(key, JSON.stringify(seed));
      }
    }, { key: DEMO_STORAGE_KEY, seed: state, origin: FIXTURE_ORIGIN });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${FIXTURE_ORIGIN}/demo/cart`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Your cart", exact: true }).waitFor({ state: "visible" });
    return {
      page, errors, networkHealthy: () => !denied.length && !network.errors.length,
      close: async () => { await network.close(); await context.close(); },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export function classifyCouponOutcome(observed: CouponObservation): Pick<CandidateResult, "outcome" | "signature"> {
  if (!observed.fixtureHealthy || observed.unexpectedError) return { outcome: "unknown", signature: null };
  if (observed.exactFailure && !observed.couponsApplied && !observed.expectedTotal) {
    return { outcome: "reproduced", signature: REPRODUCTION_SIGNATURE };
  }
  if (observed.exactFailure) return { outcome: "unknown", signature: null };
  return { outcome: "not_reproduced", signature: null };
}

/**
 * Explicit offline CI adapter, never selected by the service or API. No provider
 * imports/calls and a genuinely new Chromium process for every candidate.
 */
export function createOfflineReproductionRunner(options: {
  fixturePort: number; variant?: "broken" | "fixed"; executablePath?: string;
}): CandidateRunner {
  localFixtureSource(options.fixturePort);
  return async (input) => {
    input.signal.throwIfAborted();
    let browser: Browser | undefined;
    let cleanup: CandidateResult["cleanup"] = "unknown";
    let environment: CandidateResult["environment"] = "uncertain";
    let outcome: Pick<CandidateResult, "outcome" | "signature"> = { outcome: "unknown", signature: null };
    const sessionIdentity = randomUUID();
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.maxDurationMs)]);
    let closeOnAbort: (() => void) | undefined;
    try {
      if (input.signature !== REPRODUCTION_SIGNATURE) throw new Error("Unsupported predicate");
      browser = await chromium.launch({ headless: true, executablePath: options.executablePath, timeout: input.maxDurationMs });
      const allocated = browser;
      closeOnAbort = () => { void allocated.close().catch(() => undefined); };
      signal.addEventListener("abort", closeOnAbort, { once: true });
      signal.throwIfAborted();
      const fixture = await prepareCouponFixture(browser, options.fixturePort, options.variant ?? "broken");
      await replayCouponSteps(fixture.page, input.steps, signal);
      const observed = await observeCouponOutcome(fixture.page, fixture.errors);
      if (fixture.networkHealthy() && !signal.aborted) {
        environment = "trusted_fixture";
        outcome = classifyCouponOutcome(observed);
      }
      await fixture.close();
    } catch {
      outcome = { outcome: "unknown", signature: null };
    } finally {
      if (closeOnAbort) signal.removeEventListener("abort", closeOnAbort);
      if (browser) {
        try { await browser.close(); cleanup = "confirmed"; } catch { /* No further candidates after uncertain cleanup. */ }
      }
    }
    return { ...outcome, cleanup, environment, sessionIdentity };
  };
}

/**
 * Production adapter contract: reserve MUST debit the existing durable worker
 * lifetime/session ledger before execute allocates. execute MUST use a fresh
 * worker-owned browser and settle/reconcile cleanup before returning. This
 * wrapper deliberately has no cloud or local-browser fallback.
 */
export function createReservedReproductionRunner<Reservation>(hooks: {
  reserve(input: CandidateInput): Promise<Reservation>;
  execute(input: CandidateInput, reservation: Reservation): Promise<CandidateResult>;
}): CandidateRunner {
  return async (input) => {
    input.signal.throwIfAborted();
    const reservation = await hooks.reserve(input);
    // Even cancellation after reservation must enter execute's cleanup/reconciliation fence.
    return hooks.execute(input, reservation);
  };
}

/**
 * Deterministic production execution seam for the EXISTING worker BrowserDriver.
 * Parent creates a fresh store driver with fixed fixtures except secondCoupon,
 * empty storage/cart, desktop viewport, and a durable reservation first. No Brain
 * methods are called. onEvent can persist the normal worker evidence stream.
 * The three setup actions seed a mug using actual guarded fixture UI actions.
 */
export async function runCouponWithWorkerDriver(input: CandidateInput, options: {
  driver: BrowserDriver;
  sessionIdentity: string;
  onEvent?: (event: ExecutionEvent, signal: AbortSignal) => Promise<void>;
}): Promise<CandidateResult> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.maxDurationMs)]);
  const driver = options.driver;
  let observation: Observation;
  let exactFailure = false, unexpectedError = false, steps = 0;
  let result: CandidateResult = {
    outcome: "unknown", signature: null, environment: "uncertain", cleanup: "unknown",
    sessionIdentity: options.sessionIdentity,
  };
  const observe = async () => {
    observation = await driver.observe(signal);
    signal.throwIfAborted();
    for (const entry of observation.signals) {
      if (entry.kind === "functional_failure" && entry.message === "FF_DEMO_SECOND_COUPON") exactFailure = true;
      else if (entry.kind !== "info") unexpectedError = true;
    }
    await options.onEvent?.({ kind: "observation", actor: "agent", observation }, signal);
    return observation;
  };
  const act = async (action: BrowserAction) => {
    signal.throwIfAborted();
    await driver.act(action, signal);
    await options.onEvent?.({ kind: "action", actor: "agent", action, steps: ++steps }, signal);
    await observe();
  };
  const action = (kind: BrowserAction["action"], value: string | null = null, candidateId: string | null = null): BrowserAction =>
    ({ actor: "agent", action: kind, value, candidateId, commentary: "Deterministic controlled-fixture reproduction" });
  const candidate = (kind: "input" | "button", label: string) => {
    const eligible = observation.candidates.filter((item) => item.kind === kind && item.label === label && !item.disabled);
    if (eligible.length !== 1) throw new Error("Ambiguous fixture candidate");
    return eligible[0].id;
  };
  try {
    if (input.signature !== REPRODUCTION_SIGNATURE) throw new Error("Unsupported predicate");
    couponStepSchema.array().min(1).max(27).parse(input.steps);
    const maxSteps = input.maxSteps ?? 30;
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 30 ||
      input.steps.length + REPRODUCTION_SETUP_STEPS > maxSteps) throw new Error("Inherited step budget exceeded");
    await observe();
    await act(action("navigate", FIXTURE_ORIGIN + "/demo/product/mug"));
    await act(action("click", null, candidate("button", "Add to cart")));
    await act(action("navigate", FIXTURE_ORIGIN + "/demo/cart"));
    for (const step of input.steps) {
      if (step.kind === "fill_coupon") await act(action("type", step.coupon, candidate("input", "Coupon code")));
      else if (step.kind === "apply_coupon") await act(action("click", null, candidate("button", "Apply coupon")));
      else await act(action("wait", "25"));
    }
    const final = await observe();
    const observed: CouponObservation = {
      exactFailure, unexpectedError,
      couponsApplied: /Applied coupons: (?:SAVE10, COZY5|COZY5, SAVE10)/.test(final.text),
      expectedTotal: final.text.includes("Order total: CA$21.60"),
      fixtureHealthy: final.url === FIXTURE_ORIGIN + "/demo/cart" &&
        final.text.includes("Your cart") && final.text.includes("Maple ceramic mug"),
    };
    result = { ...result, ...classifyCouponOutcome(observed), environment: "trusted_fixture" };
  } catch {
    result = { ...result, outcome: "unknown", signature: null, environment: "uncertain" };
  } finally {
    try {
      const cleanup = await driver.close();
      result.cleanup = cleanup.status === "closed" ? "confirmed" : "unknown";
    } catch { result.cleanup = "unknown"; }
  }
  return result;
}
