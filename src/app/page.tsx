import Link from "next/link";
import { personas } from "@/lib/personas";
import { getConfigurationStatus } from "@/server/config";

export const dynamic = "force-dynamic";

export default function Home() {
  const config = getConfigurationStatus();
  return (
    <main>
      <header className="topbar">
        <Link className="wordmark" href="/" aria-label="Flash Flood home"><span className="brand-icon">ff</span>flash flood<span className="edition">/ HTN 2026</span></Link>
        <span className="status"><span className="dot" /> Foundation preview</span>
      </header>

      <section className="intro">
        <p className="eyebrow">REAL BROWSERS. DIFFERENT PERSPECTIVES.</p>
        <h1>It works for you.<br /><span>What about everyone else?</span></h1>
        <p className="lede">Meet the crowd that gets confused, goes off-script, and finds what you missed. User testing before you have users.</p>
      </section>

      <section className="setup panel" aria-labelledby="setup-title">
        <div>
          <p className="eyebrow">01 / FOUNDATION</p>
          <h2 id="setup-title">The stage is set.</h2>
          <p>Cloud browser integration and the persona library come first. The live crowd, demo store, and evidence reports are next.</p>
        </div>
        <div className="setup-details">
          <div className="config-line"><span>Browserbase key</span><strong className={config.configured ? "ready" : "warning"}>{config.configured ? "Configured locally" : "Setup needed"}</strong></div>
          <div className="config-line"><span>Active cloud browsers</span><strong>None started by this page</strong></div>
          <div className="config-line"><span>Planned run limits</span><strong>{config.configured ? `${config.concurrency} concurrent / ${config.maxSteps} steps / ${config.timeoutSeconds}s` : "Configure .env.local"}</strong></div>
          {!config.configured && <p className="warning" role="alert">Missing or invalid: {config.invalidFields.join(", ")}. See .env.example.</p>}
          <p className="command-label">Run the capped integration smoke test from your terminal:</p>
          <code className="command">npm run browserbase:smoke</code>
          <p className="fine-print">Uses Browserbase credits. Configuration does not mean connectivity has been verified. This page never starts a paid session.</p>
        </div>
      </section>

      <section className="crowd" aria-labelledby="crowd-title">
        <div className="section-heading">
          <div><p className="eyebrow">02 / YOUR FUTURE TEST CROWD</p><h2 id="crowd-title">Twelve people. Twelve ways to get stuck.</h2></div>
          <span className="muted-label">Persona library / not live sessions</span>
        </div>
        <div className="persona-grid">
          {personas.map((persona, index) => (
            <article className="persona-card" key={persona.id}>
              <div className="card-top"><span className={`avatar tone-${index % 4}`}>{persona.name.slice(0, 1)}</span><span className="device">{persona.device === "phone" ? "MOBILE" : "DESKTOP"}</span></div>
              <h3>{persona.name}</h3>
              <p>{persona.character}</p>
              <div className="card-bottom"><span>{persona.patienceSteps}-step patience</span><span className="waiting">Not started</span></div>
            </article>
          ))}
        </div>
      </section>
      <footer><span>Evidence over anecdotes.</span><span>Authorized targets only. Non-destructive testing.</span></footer>
    </main>
  );
}
