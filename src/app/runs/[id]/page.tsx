import { OwnerSession } from "@/components/owner-session";
import { RunWall } from "@/components/run-wall";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OwnerSession><RunWall key={id} runId={id} /></OwnerSession>;
}
