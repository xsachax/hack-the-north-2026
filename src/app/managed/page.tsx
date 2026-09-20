import Link from "next/link";
import { ManagedLaunch } from "@/components/managed-launch";
import { OwnerSession } from "@/components/owner-session";
import { WaveDivider } from "@/components/wave-divider";
import "@/components/managed.css";

export default function ManagedPage() {
  return <main>
    <header className="topbar">
      <Link className="wordmark" href="/"><span className="brand-icon">ff</span>flash flood</Link>
      <Link href="/">Classic workspace</Link>
    </header>
    <section className="intro managed-intro">
      <p className="eyebrow">BROWSERBASE MANAGED AGENTS · MVP</p>
      <h1>Real browsers.<br /><span>A managed little crowd.</span></h1>
      <p>Choose an approved starting point. Give each persona a goal. Follow what the provider actually reports.</p>
      <WaveDivider />
    </section>
    <OwnerSession><ManagedLaunch /></OwnerSession>
    <footer><span>Agent-reported outcomes, clearly labelled.</span><span>Approved public targets only. No credentials or sensitive data.</span></footer>
  </main>;
}
