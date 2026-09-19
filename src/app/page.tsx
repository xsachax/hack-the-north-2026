import Link from "next/link";
import { Launch } from "@/components/launch";
import { OwnerSession } from "@/components/owner-session";

export default function Home() {
  return <main>
    <header className="topbar">
      <Link className="wordmark" href="/"><span className="brand-icon">ff</span>flash flood</Link>
      <span className="muted">Small tasks. Fresh eyes.</span>
    </header>
    <section className="intro">
      <p className="eyebrow">USER TESTING BEFORE YOU HAVE USERS</p>
      <h1>A little crowd.<br /><span>A different perspective.</span></h1>
      <p>Give real browsers a small mission. Watch different personas find their way.</p>
    </section>
    <OwnerSession><Launch /></OwnerSession>
    <footer><span>Evidence over anecdotes.</span><span>Authorized, non-destructive testing only.</span></footer>
  </main>;
}
