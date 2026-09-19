import { describe, expect, it } from "vitest";
import { demoStateSchema, fixedFixtures, fixtureNames, freshDemo, normalizePostal, products, SLOW_CART_MS, totalCents } from "./demo";

describe("deterministic demo state", () => {
  it("starts fixed, empty and independently resettable", () => {
    const first = freshDemo();
    first.fixtures.phoneFold = true;
    first.cart.push("mug");
    expect(freshDemo()).toEqual({ version: 1, fixtures: fixedFixtures, cart: [], coupons: [], postal: "", giftWrap: false, completed: false });
    expect(fixtureNames).toHaveLength(6);
  });
  it.each(fixtureNames)("switches only %s without mutating defaults", (name) => {
    const configured = freshDemo({ ...fixedFixtures, [name]: true });
    expect(Object.entries(configured.fixtures).filter(([, value]) => value).map(([key]) => key)).toEqual([name]);
    expect(demoStateSchema.parse(configured)).toEqual(configured);
  });
  it.each(["N2L 3G1", "n2l 3g1", " N2L3G1 "])("normalizes fixed postal %s", (input) => {
    expect(normalizePostal(input, false)).toBe("N2L 3G1");
  });
  it("rejects spaced postal only in broken mode", () => {
    expect(normalizePostal("N2L 3G1", true)).toBeNull();
    expect(normalizePostal("N2L3G1", true)).toBe("N2L 3G1");
  });
  it.each(["90210", "D2L 3G1", "N2L XXX", "N2L\t3G1", ""])("rejects invalid postal %s", (input) => {
    expect(normalizePostal(input, false)).toBeNull();
  });
  it("keeps products below $50 and computes deterministic fake totals", () => {
    expect(products.every((product) => product.cents > 0 && product.cents < 5000)).toBe(true);
    expect(totalCents(freshDemo())).toBe(0);
    expect(totalCents({ ...freshDemo(), cart: ["mug"] })).toBe(2900);
    expect(totalCents({ ...freshDemo(), cart: ["mug"], coupons: ["SAVE10", "COZY5"], giftWrap: true })).toBe(2460);
  });
  it("rejects unknown state, invalid quantities, products and unsafe timer input", () => {
    expect(demoStateSchema.safeParse({ ...freshDemo(), cart: ["mug", "mug"] }).success).toBe(false);
    expect(demoStateSchema.safeParse({ ...freshDemo(), cart: ["unknown"] }).success).toBe(false);
    expect(demoStateSchema.safeParse({ ...freshDemo(), delay: 99999999 }).success).toBe(false);
    expect(demoStateSchema.safeParse({ ...freshDemo(), fixtures: { ...fixedFixtures, slowCart: 10000 } }).success).toBe(false);
    expect(SLOW_CART_MS).toBe(1200);
  });
});
