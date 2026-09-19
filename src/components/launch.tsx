"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { api, ApiError, errorMessage } from "@/lib/client-api";
import { createRunSchema, personaSchema, runSchema, type Persona, type Run } from "@/lib/contracts";
import { controlledRunSchema, resolveControlledScope } from "@/lib/controlled-run";
import { controlledSites, type ControlledSiteId } from "@/lib/controlled-sites";
import { criterionSchema, type Criterion } from "@/lib/criteria";
import { personas as presets } from "@/lib/personas";
import { pendingLaunchKey, readPendingLaunch, type PendingLaunch } from "@/lib/launch-request";
import { capabilitiesSchema, type Capabilities } from "@/lib/ui-contracts";
import { useOwnerSession } from "./owner-session";
import { PersonaAvatar } from "./persona-avatar";
import { PersonaEditor } from "./persona-editor";
import { CriterionEditor } from "./criterion-editor";
import { ContextPicker } from "./context-picker";
import type { BrowserState } from "@/lib/context-contracts";

type AssignmentDraft = { goal?: string; criteria?: string; maxSteps?: number; maxModelCalls?: number; maxDurationMs?: number; browserState?: BrowserState };
const initialCriterion: Exclude<Criterion, string> = {
  id: "visible-outcome", kind: "visible_text", description: "The saved project name is visible in the list.",
  semantics: "current", paths: ["/project-board/projects"], text: "Garden planning", match: "contains",
};
const isPreset = (id: string) => presets.some((persona) => persona.id === id);

export function Launch() {
  const { ownerId, csrfToken, retry: retrySession } = useOwnerSession();
  const router = useRouter();
  const [profiles, setProfiles] = useState<Persona[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [recent, setRecent] = useState<Run[]>([]);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"website" | "controlled">("website");
  const [site, setSite] = useState<ControlledSiteId>("project-board");
  const [url, setUrl] = useState("");
  const [goal, setGoal] = useState("");
  const [targetPath, setTargetPath] = useState("/project-board");
  const [prefixes, setPrefixes] = useState("/project-board");
  const [subdomains, setSubdomains] = useState("");
  const [websitePrefixes, setWebsitePrefixes] = useState("/");
  const [criteria, setCriteria] = useState<Exclude<Criterion, string>[]>([{
    id: "objective-achieved", kind: "semantic", semantics: "current",
    description: "The stated objective is visibly achieved on the current page.",
  }]);
  const [selected, setSelected] = useState(["careful-first-timer"]);
  const [drafts, setDrafts] = useState<Record<string, AssignmentDraft>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingLaunch | null>(null);
  const [storageError, setStorageError] = useState("");
  const [editor, setEditor] = useState<Persona | "new" | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    try {
      const [people, readiness, runs] = await Promise.all([
        api<{ items: unknown[] }>("/personas"), api<unknown>("/capabilities"),
        api<{ items: Run[] }>("/runs?limit=100"),
      ]);
      setProfiles(z.array(personaSchema).parse(people.items));
      setCapabilities(capabilitiesSchema.parse(readiness));
      setRecent(runs.items);
      setError("");
    } catch (failure) { setError(errorMessage(failure)); }
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) void load(); });
    return () => { active = false; };
  }, [load]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!ownerId || !active) return;
      try {
        const raw = sessionStorage.getItem(pendingLaunchKey);
        if (raw) setPending(readPendingLaunch(raw, ownerId));
      } catch {
        setStorageError("An unresolved launch could not be recovered for this owner. New launches are blocked in this tab. Check existing runs before clearing this tab's session storage.");
      }
    });
    return () => { active = false; };
  }, [ownerId]);
  function chooseMode(next: "controlled" | "website") {
    setMode(next);
    if (next === "controlled" && !goal) {
      setGoal("Create a synthetic project named Garden planning in the Design category and confirm it is listed.");
      setCriteria([initialCriterion]);
    }
  }
  function chooseSite(next: ControlledSiteId) {
    setSite(next);
    setTargetPath(controlledSites[next].entryPath);
    setPrefixes(controlledSites[next].entryPath);
  }
  function updateDraft(id: string, field: keyof AssignmentDraft, value: string | number) {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], [field]: value } }));
  }
  async function send(request: PendingLaunch, reconciling = false) {
    if (inFlight.current || !csrfToken) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      // Persist BEFORE sending. A lost reply or refresh must reuse this exact key and body.
      sessionStorage.setItem(pendingLaunchKey, JSON.stringify(request));
    } catch {
      setStorageError("Session storage is unavailable. Launch was not sent: safe refresh/retry protection requires it.");
      inFlight.current = false;
      setBusy(false);
      return;
    }
    setPending(request);
    try {
      const run = runSchema.parse(await api<unknown>(request.path, {
        method: "POST", body: request.body, csrfToken, idempotencyKey: request.key,
      }));
      sessionStorage.removeItem(pendingLaunchKey);
      router.push(`/runs/${run.id}`);
    } catch (failure) {
      setError(errorMessage(failure));
      if (!reconciling && failure instanceof ApiError && [400, 401, 403, 404, 413, 415, 422, 429].includes(failure.status)) {
        sessionStorage.removeItem(pendingLaunchKey);
        setPending(null);
      }
    } finally { inFlight.current = false; setBusy(false); }
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending || busy || !ownerId || !capabilities || storageError) return;
    try {
      const assignments = selected.map((personaId) => {
        const draft = drafts[personaId];
        return {
          personaId, goal: draft?.goal || goal,
          ...(mode === "controlled" && draft?.browserState ? { browserState: draft.browserState } : {}),
          criteria: draft?.criteria ? z.array(criterionSchema).parse(JSON.parse(draft.criteria)) : criteria,
          limits: {
            maxSteps: draft?.maxSteps ?? capabilities.executionLimits.maxSteps,
            maxModelCalls: draft?.maxModelCalls ?? capabilities.executionLimits.maxModelCalls,
            maxDurationMs: draft?.maxDurationMs ?? capabilities.executionLimits.maxDurationMs,
          },
        };
      });
      if (mode === "controlled") {
        const body = controlledRunSchema.parse({
          authorizationAcknowledged: acknowledged, controlledSiteId: site,
          scope: { targetPath, pathPrefixes: prefixes.split("\n") }, assignments,
        });
        resolveControlledScope(site, body.scope);
        void send({ ownerId, key: crypto.randomUUID(), path: "/controlled-runs", body });
      } else {
        const body = createRunSchema.parse({
          authorizationAcknowledged: acknowledged, scope: {
            targetUrl: url, allowedSubdomains: subdomains ? subdomains.split("\n") : [],
            pathPrefixes: websitePrefixes.split("\n"),
          }, assignments,
        });
        void send({ ownerId, key: crypto.randomUUID(), path: "/runs", body });
      }
    } catch (failure) {
      setError(failure instanceof z.ZodError
        ? failure.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
        : "Check the scope and criteria JSON. Controlled paths must remain inside the selected registered site.");
    }
  }
  async function deletePersona(persona: Persona) {
    if (!csrfToken || deleting) return;
    setDeleting(persona.id);
    try {
      await api(`/personas/${persona.id}`, { method: "DELETE", csrfToken });
      setProfiles((current) => current.filter((value) => value.id !== persona.id));
      setSelected((current) => current.filter((id) => id !== persona.id));
      setError("");
    } catch (failure) { setError(errorMessage(failure)); } finally { setDeleting(null); }
  }
  return <section className="launch-workspace" aria-label="Launch workspace">
    {storageError && <p className="error" role="alert">{storageError}</p>}
    {pending && <div className="notice" role="status">
      <strong>An unresolved launch is saved in this tab.</strong>
      <p>The reply may have been lost. Reconcile the exact saved request; it cannot create another run with the same owner and key. New launches are blocked until this is resolved.</p>
      <button type="button" className="primary" disabled={busy} onClick={() => void send(pending, true)}>{busy ? "Reconciling..." : "Reconcile saved launch"}</button>
    </div>}
    <form className="launch-form" onSubmit={submit} noValidate>
      <fieldset disabled={busy || !!pending || !!storageError}>
        <div className="mode-switch" role="group" aria-label="Target mode">
          <button type="button" aria-pressed={mode === "website"} onClick={() => chooseMode("website")}>Your website</button>
          <button type="button" aria-pressed={mode === "controlled"} onClick={() => chooseMode("controlled")}>Controlled demo</button>
        </div>
        <label className="goal-label">What should the crowd try?
          <textarea className="goal-input" required maxLength={2000} rows={3} placeholder="Find a gift under $30 and check whether the delivery cost is clear." value={goal} onChange={(event) => setGoal(event.target.value)} />
        </label>
        {mode === "website" ? <>
          <label>Website URL<input type="url" required placeholder="https://your-site.com/shop" value={url} onChange={(event) => setUrl(event.target.value)} /></label>
          <p className="notice"><strong>Website execution is not enabled.</strong> You can save this intended scoped request, but the worker will mark it blocked without opening a browser. Public-site isolation is still a release blocker. Controlled demos are separate.</p>
        </> : <>
          <label>Controlled site<select value={site} onChange={(event) => chooseSite(event.target.value === "store" ? "store" : "project-board")}><option value="project-board">Project board</option><option value="store">Gift store (fixed)</option></select></label>
          <p className="muted">A real cloud browser on our registered, isolated demo. Never a substitute for your website.</p>
          <p className="muted">Queues work for a separate worker. Configuration readiness is not a worker heartbeat.</p>
          {capabilities && !capabilities.controlledRunsEnabled && <p className="notice">Controlled runs are disabled by this deployment. Ask the operator to enable admission and start the separate worker.</p>}
        </>}
        <details className="configuration">
          <summary>Configure scope & success criteria <span>{criteria.length} criteria</span></summary>
          <p className="muted">A small, authorized task, not an entire-site crawl. These defaults apply to every selected persona; individual overrides are below.</p>
          {mode === "controlled" ? <div className="field-row">
            <label>Starting path<select value={targetPath} onChange={(event) => setTargetPath(event.target.value)}>{controlledSites[site].navigationPaths.map((path) => <option key={path}>{path}</option>)}</select></label>
            <label>Allowed path prefixes (one per line)<textarea required value={prefixes} onChange={(event) => setPrefixes(event.target.value)} /></label>
          </div> : <div className="field-row">
            <label>Allowed path prefixes (one per line)<textarea required value={websitePrefixes} onChange={(event) => setWebsitePrefixes(event.target.value)} /></label>
            <label>Allowed subdomains (optional, one per line)<textarea value={subdomains} onChange={(event) => setSubdomains(event.target.value)} /></label>
          </div>}
          <p className="muted">Current conditions must hold now. Milestones retain observed achievement on unrelated pages, but later contradictory evidence can invalidate them.</p>
          {criteria.map((criterion, index) => <CriterionEditor key={criterion.id} criterion={criterion} onChange={(next) => setCriteria((current) => current.map((value, i) => i === index ? next : value))} onRemove={() => setCriteria((current) => current.filter((_, i) => i !== index))} />)}
          <button type="button" disabled={criteria.length >= 12} onClick={() => setCriteria((current) => [...current, {
            id: `criterion-${crypto.randomUUID().slice(0, 8)}`, kind: "semantic", semantics: "current", description: "",
          }])}>Add success criterion</button>
        </details>
        <section className="people-section" aria-labelledby="people-title">
          <div className="section-heading"><h2 id="people-title">Pick your people <span className="muted">/ {selected.length}</span></h2><button type="button" className="text-button" onClick={() => setEditor("new")}>+ Create persona</button></div>
          <div className="people-picker">
            {profiles.map((persona) => <label className={`person-chip ${selected.includes(persona.id) ? "selected" : ""}`} key={persona.id}>
              <input type="checkbox" checked={selected.includes(persona.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, persona.id] : current.filter((id) => id !== persona.id))} />
              <PersonaAvatar id={persona.id} /><span><strong>{persona.name}</strong><small>{persona.device === "phone" ? "Phone-sized" : "Desktop"} · {persona.patienceSteps}-step patience</small></span>
            </label>)}
          </div>
          {!profiles.length && <p className="muted">Personas have not loaded yet.</p>}
          {selected.map((id) => {
            const persona = profiles.find((value) => value.id === id);
            if (!persona) return null;
            const draft = drafts[id];
            return <details className="persona-config" key={id}>
              <summary>{persona.name}: objective, limits & character</summary>
              <p>{persona.character}</p><p className="muted">{persona.quirks.join(" · ")}. Worries: {persona.worries.join(", ")}.</p>
              <label>Objective for {persona.name}<textarea value={draft?.goal ?? ""} placeholder={goal || "Uses the shared goal above"} maxLength={2000} onChange={(event) => updateDraft(id, "goal", event.target.value)} /></label>
              {capabilities && <div className="field-row">
                <label>Maximum steps<input type="number" required min={1} max={capabilities.executionLimits.maxSteps} value={draft?.maxSteps ?? capabilities.executionLimits.maxSteps} onChange={(event) => updateDraft(id, "maxSteps", event.target.valueAsNumber)} /></label>
                <label>Maximum model calls<input type="number" required min={1} max={capabilities.executionLimits.maxModelCalls} value={draft?.maxModelCalls ?? capabilities.executionLimits.maxModelCalls} onChange={(event) => updateDraft(id, "maxModelCalls", event.target.valueAsNumber)} /></label>
                <label>Maximum duration (seconds)<input type="number" required min={1} max={capabilities.executionLimits.maxDurationMs / 1000} value={(draft?.maxDurationMs ?? capabilities.executionLimits.maxDurationMs) / 1000} onChange={(event) => updateDraft(id, "maxDurationMs", event.target.valueAsNumber * 1000)} /></label>
              </div>}
              <p className="muted">Independent of persona patience. Decisions and semantic evaluations share the model-call limit. Operator ceilings may further reduce these values.</p>
              {mode === "controlled" && <ContextPicker value={draft?.browserState} onChange={(browserState) =>
                setDrafts((current) => ({ ...current, [id]: { ...current[id], browserState } }))} />}
              <details><summary>Override canonical criteria JSON</summary><label>Criteria for {persona.name}<textarea className="code-input" rows={8} value={draft?.criteria ?? ""} placeholder={JSON.stringify(criteria, null, 2)} onChange={(event) => updateDraft(id, "criteria", event.target.value)} /></label><p className="muted">Leave blank to inherit. Validated with the shared API schema, including control value / selected option assertions.</p></details>
              <div className="button-row"><button type="button" onClick={() => setEditor(persona)}>{isPreset(id) ? "Customize a copy" : "Edit saved persona"}</button>
                {!isPreset(id) && <button type="button" disabled={!!deleting} onClick={() => void deletePersona(persona)}>{deleting === id ? "Deleting..." : `Delete ${persona.name}`}</button>}</div>
            </details>;
          })}
          <p className="muted">Fresh sessions by default; private returning state is explicit per assignment. Phone is a viewport, not device emulation. Throttling, uploads, tabs and subframes remain unsupported.</p>
          <details className="configuration">
            <summary>Supported testing and known limits</summary>
            <p>Agents use DOM plus viewport screenshots, not screenshot-only human perception. Structural checks use observed controls and text; semantic verdicts and confidence are heuristic, not proof or calibrated probabilities.</p>
            <p>Keyboard actions are supported, but there is no general accessibility or WCAG scanner. Only the planted second-coupon defect has verified autonomous discovery and automatic regression export; fixture tests do not mean agents found every planted problem.</p>
            <p>Returning state requires explicit consent and a later observed check; eligibility is not provider confirmation that storage finished saving. Takeover is exclusive inside this app, not revocation of external provider control links.</p>
            <p>Comparisons need matching criteria and confirming tested coverage; a missing finding alone is not a fix. Reduction reports the shortest supported path found, not a globally shortest reproduction.</p>
            <p>Screenshots and recordings are private, sensitive pixels, not redacted media. Arbitrary authorized websites remain blocked until connection-level network isolation is proven.</p>
          </details>
        </section>
        <label className="acknowledgement"><input type="checkbox" required checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span>I am authorized to test this scope and will use only non-destructive tasks.</span></label>
        <button className="primary launch-button" type="submit" disabled={!capabilities || !selected.length || (mode === "controlled" && !capabilities.controlledRunsEnabled)}>
          {busy ? "Submitting..." : mode === "controlled" ? `Launch ${selected.length} ${selected.length === 1 ? "persona" : "personas"}` : "Save website request (execution blocked)"}
        </button>
        <p className="muted center">{mode === "controlled" ? "Uses browser and model credits when the worker starts. Up to 3 live viewers." : "No paid public-site browser will be launched."}</p>
      </fieldset>
    </form>
    {error && <div className="error" role="alert"><p>{error}</p><div className="button-row"><button type="button" onClick={() => void load()}>Reload workspace data</button><button type="button" onClick={retrySession}>Refresh owner session</button></div></div>}
    {editor && <PersonaEditor key={editor === "new" ? "new" : editor.id} persona={editor === "new" ? undefined : editor} onClose={() => setEditor(null)} onSaved={(persona) => {
      setProfiles((current) => [...current.filter((value) => value.id !== persona.id), persona]);
      setSelected((current) => current.includes(persona.id) ? current : [...current, persona.id]);
      setEditor(null);
    }} />}
    <details className="recent-runs"><summary>Your saved runs</summary>
      {recent.length ? <ul>{recent.map((run) => <li key={run.id}><Link href={`/runs/${run.id}`}>{run.controlledSiteId ?? "Website"} · {new Date(run.createdAt).toLocaleString()} · {run.status.replaceAll("_", " ")}</Link></li>)}</ul> : <p className="muted">No saved runs in this owner session.</p>}
      {recent.length === 100 && <p className="muted">Showing the first 100 saved runs.</p>}
    </details>
  </section>;
}
