import { setTimeout as delay } from "node:timers/promises";
import { SHIPPING_CENTS, SLOW_CART_MS } from "@/lib/demo";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const variant = query.get("variant");
  const headers = { "Cache-Control": "no-store" };
  if ([...query.keys()].some((key) => key !== "variant") || query.getAll("variant").length !== 1 || (variant !== "broken" && variant !== "fixed")) {
    return Response.json({ error: "Expected only variant=broken or variant=fixed." }, { status: 400, headers });
  }
  if (variant === "broken") await delay(SLOW_CART_MS);
  return Response.json({ shippingCents: SHIPPING_CENTS }, { headers });
}
