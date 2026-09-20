import Link from "next/link";
import { Launch } from "@/components/launch";
import { OwnerSession } from "@/components/owner-session";

export default function Home() {
  return <main className="onboarding-page">
    <header className="topbar">
      <Link className="wordmark" href="/"><span className="brand-icon">ff</span>flash flood</Link>
      <Link href="/managed">Browserbase Managed Agents</Link>
    </header>
    <div className="onboarding-entry"><OwnerSession><Launch /></OwnerSession></div>
    <footer><span>Evidence over anecdotes.</span><span>Authorized, non-destructive testing only.</span></footer>
  </main>;
}
