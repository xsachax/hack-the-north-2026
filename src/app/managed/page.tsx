import Link from "next/link";
import { ManagedLaunch } from "@/components/managed-launch";
import { OwnerSession } from "@/components/owner-session";
import { WaveMark } from "@/components/wave-mark";
import "@/components/managed.css";
import styles from "./onboarding.module.css";

export default function ManagedPage() {
  return <main className={styles.page}>
    <header className={styles.topbar}>
      <Link className={styles.wordmark} href="/managed"><WaveMark />flash flood<span> / playground</span></Link>
      <Link className={styles.classicLink} href="/">Classic workspace <span aria-hidden="true">↗</span></Link>
    </header>
    <div className={styles.entry}><OwnerSession><ManagedLaunch /></OwnerSession></div>
    <footer className={styles.footer}><span>Small crew. Real browsers. Fresh perspectives.</span><span>Powered by Browserbase</span></footer>
  </main>;
}
