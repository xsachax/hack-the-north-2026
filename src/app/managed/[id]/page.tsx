import Link from "next/link";
import { ManagedWall } from "@/components/managed-wall";
import { OwnerSession } from "@/components/owner-session";
import { WaveMark } from "@/components/wave-mark";
import "@/components/managed.css";
import shell from "../onboarding.module.css";
import styles from "./wall.module.css";

export default async function ManagedRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main className={`${shell.page} ${styles.wall}`}>
    <header className={shell.topbar}>
      <Link className={shell.wordmark} href="/managed"><WaveMark />flash flood<span> / playground</span></Link>
      <Link className={shell.classicLink} href="/managed">Managed workspace</Link>
    </header>
    <div className={styles.content}><OwnerSession><ManagedWall key={id} runId={id} /></OwnerSession></div>
    <footer className={shell.footer}><span>Provider progress, not invented reasoning.</span><span>Browser cleanup is separate from goal success.</span></footer>
  </main>;
}
