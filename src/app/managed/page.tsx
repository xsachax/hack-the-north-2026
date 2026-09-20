import Link from "next/link";
import { ManagedLaunch } from "@/components/managed-launch";
import { OwnerSession } from "@/components/owner-session";
import "@/components/managed.css";

export default function ManagedPage() {
  return <main className="onboarding-page">
    <header className="topbar">
      <Link className="wordmark" href="/"><span className="brand-icon">ff</span>flash flood</Link>
      <Link href="/">Classic workspace</Link>
    </header>
    <div className="onboarding-entry"><OwnerSession><ManagedLaunch /></OwnerSession></div>
    <footer><span>Agent-reported outcomes, clearly labelled.</span><span>Approved public targets only. No credentials or sensitive data.</span></footer>
  </main>;
}
