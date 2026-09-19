import { notFound } from "next/navigation";
import { ProjectBoard } from "../board";

export default async function BoardPage({ params }: { params: Promise<{ path?: string[] }> }) {
  const route = (await params).path?.join("/") ?? "";
  if (!["", "new", "projects"].includes(route)) notFound();
  return <ProjectBoard route={route} />;
}
