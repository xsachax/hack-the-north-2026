import { z } from "zod";

export const fixtureNames = [
  "phoneFold", "secondCoupon", "postalSpaces", "continueLabels", "slowCart", "keyboardFocus",
] as const;
export type FixtureName = typeof fixtureNames[number];
export const fixturesSchema = z.object({
  phoneFold: z.boolean(),
  secondCoupon: z.boolean(),
  postalSpaces: z.boolean(),
  continueLabels: z.boolean(),
  slowCart: z.boolean(),
  keyboardFocus: z.boolean(),
}).strict();
export type Fixtures = z.infer<typeof fixturesSchema>;
export const fixedFixtures: Fixtures = {
  phoneFold: false, secondCoupon: false, postalSpaces: false,
  continueLabels: false, slowCart: false, keyboardFocus: false,
};
export const products = [
  { id: "mug", name: "Maple ceramic mug", category: "home", cents: 2400, detail: "A warm speckled glaze and a generous handle. Made for slow mornings.", art: "MUG" },
  { id: "candle", name: "Cedar trail candle", category: "home", cents: 1800, detail: "A small soy candle with a soft cedar scent. A cozy gift for a new home.", art: "GLOW" },
  { id: "journal", name: "Pocket trail journal", category: "paper", cents: 1200, detail: "A recycled-paper notebook for walks, sketches and everyday plans.", art: "NOTES" },
] as const;
const productId = z.enum(["mug", "candle", "journal"]);
export const demoStateSchema = z.object({
  version: z.literal(1),
  fixtures: fixturesSchema,
  cart: z.array(productId).max(3).refine((items) => new Set(items).size === items.length),
  coupons: z.array(z.enum(["SAVE10", "COZY5"])).max(2).refine((items) => new Set(items).size === items.length),
  postal: z.string().max(16),
  giftWrap: z.boolean(),
  completed: z.boolean(),
}).strict();
export type DemoState = z.infer<typeof demoStateSchema>;
export const DEMO_STORAGE_KEY = "flash-flood-demo-v1";
export const SECOND_COUPON_SIGNATURE = "FF_DEMO_SECOND_COUPON: coupon stack unavailable";
export const SLOW_CART_MS = 1200;
export const SHIPPING_CENTS = 500;
export function freshDemo(fixtures: Fixtures = fixedFixtures): DemoState {
  return { version: 1, fixtures: { ...fixtures }, cart: [], coupons: [], postal: "", giftWrap: false, completed: false };
}
export function normalizePostal(input: string, broken: boolean): string | null {
  const postal = input.trim().toUpperCase();
  const compact = broken ? postal : postal.replace(/ /g, "");
  if (!/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/.test(compact)) return null;
  return `${compact.slice(0, 3)} ${compact.slice(3)}`;
}
export function totalCents(state: DemoState): number {
  const subtotal = products.filter((product) => state.cart.includes(product.id)).reduce((sum, product) => sum + product.cents, 0);
  const discount = (state.coupons.includes("SAVE10") ? Math.round(subtotal * 0.1) : 0)
    + (state.coupons.includes("COZY5") ? 500 : 0);
  return Math.max(0, subtotal - discount) + (state.giftWrap ? 300 : 0) + (state.cart.length ? SHIPPING_CENTS : 0);
}
export const money = (cents: number) => `CA$${(cents / 100).toFixed(2)}`;
