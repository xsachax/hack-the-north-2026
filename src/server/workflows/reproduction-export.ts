import { couponRecipeSchema, type CouponRecipe } from "../../lib/reproduction-contracts";

/** Only strict, finite fixture vocabulary crosses into source code as JSON data. */
export function exportCouponRegression(input: CouponRecipe): string {
  const recipe = couponRecipeSchema.parse(input);
  return `// Save as tests/e2e/coupon-regression.spec.ts in this repository.
// npm run build && FF_REPRO_VARIANT=fixed npx playwright test tests/e2e/coupon-regression.spec.ts
// The identical test must fail with FF_REPRO_VARIANT=broken (the default).
// Fixture setup: fresh browser context, cleared storage, one mug, no coupons.
// This is a controlled-store regression, NOT an arbitrary-target replay.
import { test, expect } from "@playwright/test";
import { prepareCouponFixture, replayCouponSteps, observeCouponOutcome } from "../../src/server/workflows/reproduction-runner";

const recipe = ${JSON.stringify(recipe, null, 2)} as const;
test("both fixture coupons apply without the recorded second-coupon failure", async ({ browser }) => {
  const variant = process.env.FF_REPRO_VARIANT ?? "broken";
  if (variant !== "broken" && variant !== "fixed") throw new Error("Invalid fixture variant");
  const port = Number(process.env.FF_REPRO_FIXTURE_PORT ?? "4317");
  const fixture = await prepareCouponFixture(browser, port, variant);
  try {
    await replayCouponSteps(fixture.page, recipe.steps, AbortSignal.timeout(15000));
    const observed = await observeCouponOutcome(fixture.page, fixture.errors);
    expect(fixture.networkHealthy(), "Only trusted fixture transport is permitted").toBe(true);
    expect(observed.fixtureHealthy, "Seeded mug must be visible").toBe(true);
    expect(observed.unexpectedError, "Unrelated errors are not the target failure").toBe(false);
    expect(observed.exactFailure, "Recorded second-coupon signature must be absent").toBe(false);
    expect(observed.couponsApplied, "Both advertised coupons must visibly apply").toBe(true);
    expect(observed.expectedTotal, "Independent order-total oracle must show CA$21.60").toBe(true);
  } finally {
    await fixture.close();
  }
});
`;
}
