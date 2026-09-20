import Link from "next/link";
import { ManagedWall } from "@/components/managed-wall";
import { OwnerSession } from "@/components/owner-session";
import "@/components/managed.css";

export default async function ManagedRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main>
    <header className="topbar">
      <Link className="wordmark" href="/"><span className="brand-icon">ff</span>flash flood</Link>
      <Link href="/managed">Managed workspace</Link>
    </header>
    <OwnerSession><ManagedWall key={id} runId={id} /></OwnerSession>
    <footer><span>Provider progress, not invented reasoning.</span><span>Browser cleanup is separate from goal success.</span></footer>
  </main>;
}
