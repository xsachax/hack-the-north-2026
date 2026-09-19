import { notFound } from "next/navigation";
import { DemoStore } from "../store";

const routes = new Set(["", "category/home", "category/paper", "product/mug", "product/candle", "product/journal", "cart", "checkout", "checkout/review", "complete"]);

export default async function DemoPage({ params }: { params: Promise<{ path?: string[] }> }) {
  const route = (await params).path?.join("/") ?? "";
  if (!routes.has(route)) notFound();
  return <DemoStore route={route} />;
}
