"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { api, errorMessage } from "@/lib/client-api";
import { idSchema, personaSchema, type Persona } from "@/lib/contracts";
import { selectRunAssignment } from "@/lib/execution-capacity";
import {
  MANAGED_EXECUTION_POLICY, managedAssignmentSchema, managedCapabilitiesSchema, managedCreateSchema, managedRunSchema,
  type ManagedCapabilities, type ManagedRun,
} from "@/lib/managed-contracts";
import { managedDefaultCriteria, managedDefaultGoal, managedIanaDemoAssignments, managedIanaDemoScope, managedSpecialistForAssignment, managedSpecialists } from "@/lib/managed-specialists";
import { useOwnerSession } from "./owner-session";
import { PersonaAvatar } from "./persona-avatar";
import { PersonaEditor } from "./persona-editor";
import { WaveMark } from "./wave-mark";

const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);

const pendingSchema = z.strictObject({
  ownerId: z.string().min(1), key: z.uuid(), body: managedCreateSchema,
});
type Pending = z.infer<typeof pendingSchema>;
type AssignmentDraft = { goal?: string; criteria?: string };
const storageKey = (owner: string) => `flash-flood:managed-pending:${owner}`;
const peopleSchema = z.strictObject({ items: z.array(personaSchema) });
const runsSchema = z.strictObject({ items: z.array(managedRunSchema) });

function targetUrl(value: string) {
  try {
    const trimmed = value.trim();
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

export function ManagedLaunch() {
  const { ownerId, csrfToken, authorized, revision, retry } = useOwnerSession();
  const router = useRouter();
  const [capabilities, setCapabilities] = useState<ManagedCapabilities | null>(null);
  const [profiles, setProfiles] = useState<Persona[]>([]);
  const [recent, setRecent] = useState<ManagedRun[]>([]);
  const [loadVersion, setLoadVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [target, setTarget] = useState("");
  const [goal, setGoal] = useState(managedDefaultGoal);
  const [criteria, setCriteria] = useState(managedDefaultCriteria.join("\n"));
  const [prefixes, setPrefixes] = useState("/");
  const [selected, setSelected] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, AssignmentDraft>>({});
  const [editor, setEditor] = useState<Persona | "new" | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [storageOwner, setStorageOwner] = useState<string | null>(null);
  const [storageError, setStorageError] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const submission = useRef<AbortController | null>(null);
  const personaMutation = useRef<AbortController | null>(null);

  function assignmentFor(personaId: string) {
    const specialist = managedSpecialists.find((value) => value.personaId === personaId);
    return {
      personaId,
      goal: drafts[personaId]?.goal?.trim() || specialist?.goal || goal.trim(),
      criteria: (drafts[personaId]?.criteria?.trim() || specialist?.criteria.join("\n") || criteria)
        .split("\n").map((value) => value.trim()).filter(Boolean),
    };
  }

  useEffect(() => {
    if (!authorized || !ownerId) return;
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setLoaded(false);
      try {
        const raw = sessionStorage.getItem(storageKey(ownerId));
        const saved = raw ? pendingSchema.parse(JSON.parse(raw)) : null;
        if (saved && saved.ownerId !== ownerId) throw new Error("owner_mismatch");
        setPending(saved);
        if (saved) {
          setTarget(saved.body.scope.targetUrl);
          setGoal(saved.body.assignments[0].goal);
          setCriteria(saved.body.assignments[0].criteria.join("\n"));
          setPrefixes(saved.body.scope.pathPrefixes.join("\n"));
          setSelected(saved.body.assignments.map((assignment) => assignment.personaId));
          setDrafts(Object.fromEntries(saved.body.assignments.map((assignment) => [
            assignment.personaId, { goal: assignment.goal, criteria: assignment.criteria.join("\n") },
          ])));
        }
        setStorageOwner(ownerId);
        setStorageError("");
      } catch {
        setStorageError("The saved request cannot be read safely. New launches are locked. Check your saved runs before deliberately discarding it.");
      }
      try {
        const [readiness, people, runs] = await Promise.all([
          api<unknown>("/managed-capabilities", { signal: controller.signal }).then((value) => managedCapabilitiesSchema.parse(value)),
          api<unknown>("/personas", { signal: controller.signal }).then((value) => peopleSchema.parse(value)),
          api<unknown>("/managed-runs", { signal: controller.signal }).then((value) => runsSchema.parse(value)),
        ]);
        if (controller.signal.aborted) return;
        setCapabilities(readiness);
        setTarget((current) => current || (readiness.allowedOrigins.includes("https://www.browserbase.com")
          ? "https://www.browserbase.com/" : readiness.allowedOrigins.includes("https://browserbase.com")
            ? "https://browserbase.com/" : ""));
        setProfiles(people.items);
        setRecent(runs.items);
        setLoaded(true);
        setError("");
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof z.ZodError
          ? "The service returned an invalid managed response. New launches remain unavailable; refresh readiness to try again."
          : errorMessage(failure));
      }
    });
    return () => { controller.abort(); submission.current?.abort(); personaMutation.current?.abort(); };
  }, [ownerId, authorized, revision, loadVersion]);

  async function send(saved: Pending) {
    if (!authorized || !csrfToken || !ownerId || saved.ownerId !== ownerId || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      // Store the canonical body and key together before any potentially paid request.
      sessionStorage.setItem(storageKey(ownerId), JSON.stringify(saved));
    } catch {
      setStorageError("Session storage is unavailable. Nothing was submitted; safe retry protection requires storage.");
      inFlight.current = false;
      setBusy(false);
      return;
    }
    setPending(saved);
    const controller = new AbortController();
    submission.current = controller;
    try {
      const run = managedRunSchema.parse(await api<unknown>("/managed-runs", {
        method: "POST", body: saved.body, idempotencyKey: saved.key, csrfToken, signal: controller.signal,
      }));
      if (controller.signal.aborted) return;
      sessionStorage.removeItem(storageKey(ownerId));
      router.push(`/managed/${run.id}`);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof z.ZodError
        ? "The launch reply could not be validated. A run may already exist. Reconcile the saved request instead of launching again."
        : errorMessage(failure));
      // Even an invalid reply may follow a successful submission. Only explicit reconciliation retries.
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!authorized || !ownerId || !capabilities?.enabled || !loaded || pending || busy || editor || deleting
      || storageError || storageOwner !== ownerId) return;
    const normalizedTarget = targetUrl(target);
    if (!normalizedTarget || !capabilities.allowedOrigins.includes(normalizedTarget.origin)) {
      setError("Choose an initial URL on an exact operator-approved origin. Other hosts are not supported.");
      return;
    }
    try {
      const pathPrefixes = prefixes.split("\n").map((value) => value.trim()).filter(Boolean);
      if (pathPrefixes.some((value) => !value.startsWith("/") || value.startsWith("//") || /[?#]/.test(value))) {
        setError("Use path prefixes beginning with /, without a hostname, query, or fragment.");
        return;
      }
      const body = managedCreateSchema.parse({
        executionPolicy: MANAGED_EXECUTION_POLICY,
        authorizationAcknowledged: true, managedPolicyAcknowledged: true,
        scope: { targetUrl: normalizedTarget.href, pathPrefixes, allowedSubdomains: [] },
        assignments: selected.map(assignmentFor),
      });
      void send({ ownerId, key: crypto.randomUUID(), body });
    } catch (failure) {
      setError(failure instanceof z.ZodError
        ? failure.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
        : errorMessage(failure));
    }
  }

  function discard() {
    if (!ownerId || busy) return;
    try {
      sessionStorage.removeItem(storageKey(ownerId));
      setPending(null);
      setStorageOwner(ownerId);
      setStorageError("");
      setError("");
    } catch { setStorageError("Storage is still unavailable. Launches remain locked; no request was sent."); }
  }

  function updateDraft(id: string, field: keyof AssignmentDraft, value: string) {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], [field]: value } }));
  }

  function chooseTarget(value: string) {
    setTarget(value);
    setError("");
    if (targetUrl(value)?.href !== managedIanaDemoScope.targetUrl) {
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id, draft]) =>
        !managedIanaDemoAssignments.some((assignment) => assignment.personaId === id
          && assignment.goal === draft.goal && assignment.criteria.join("\n") === draft.criteria))));
      if (prefixes === managedIanaDemoScope.pathPrefixes.join("\n")) setPrefixes("/");
    }
  }

  async function deletePersona(persona: Persona) {
    if (!authorized || !csrfToken || pending || busy || deleting || editor || !idSchema.safeParse(persona.id).success) return;
    const controller = new AbortController();
    personaMutation.current = controller;
    setDeleting(persona.id);
    setError("");
    try {
      z.strictObject({ deleted: z.literal(true) }).parse(await api<unknown>(`/personas/${persona.id}`, {
        method: "DELETE", csrfToken, signal: controller.signal,
      }));
      if (controller.signal.aborted) return;
      setProfiles((current) => current.filter((value) => value.id !== persona.id));
      setSelected((current) => selectRunAssignment(current, persona.id, false));
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== persona.id)));
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof z.ZodError
        ? "The deletion reply could not be validated. Refresh your personas before trying again."
        : errorMessage(failure));
    } finally { setDeleting(null); }
  }

  const normalizedTarget = targetUrl(target);
  const validTarget = !!normalizedTarget && !!capabilities?.allowedOrigins.includes(normalizedTarget.origin);
  const enabled = loaded && !!capabilities?.enabled && !!capabilities.allowedOrigins.length;
  const locked = !!pending || !!storageError || storageOwner !== ownerId || busy || !authorized;
  const assignmentsReady = selected.length > 0 && selected.length <= 8
    && selected.every((id) => managedAssignmentSchema.safeParse(assignmentFor(id)).success);
  const scopeReady = !!normalizedTarget
    && managedCreateSchema.shape.scope.safeParse({
    targetUrl: normalizedTarget.href, pathPrefixes: lines(prefixes), allowedSubdomains: [],
  }).success && lines(prefixes).every((prefix) => prefix.startsWith("/") && !prefix.startsWith("//") && !/[?#]/.test(prefix));
  const editorPanel = editor && !locked ? <section className="managed-launch managed-composer managed-editor" aria-label="Managed persona editor">
    <header><p className="eyebrow">A FRESH PERSPECTIVE</p><h1>Make a persona your own.</h1>
      <p className="muted">Choose a specialty or create a completely custom perspective.</p></header>
      <PersonaEditor key={editor === "new" ? "new" : editor.id}
        persona={editor === "new" ? undefined : editor} onClose={() => setEditor(null)}
        onSaved={(value) => {
          const persona = personaSchema.parse(value);
          setProfiles((current) => [...current.filter((profile) => profile.id !== persona.id), persona]);
          setSelected((current) => selectRunAssignment(current, persona.id));
          if (editor !== "new" && editor.id !== persona.id && drafts[editor.id]) {
            setDrafts((current) => ({ ...current, [persona.id]: { ...current[editor.id] } }));
          }
          setEditor(null);
        }} />
  </section> : null;

  return <>{editorPanel}<section hidden={!!editorPanel} className="managed-launch" aria-label="Managed launch workspace">
    <header className="managed-welcome">
      <WaveMark />
      <p className="eyebrow">A FRESH SET OF EYES. A WHOLE NEW WAVE.</p>
      <h1>Make waves. <span>Find what breaks.</span></h1>
      <p>Send a crew of AI testers surfing through your website.</p>
    </header>
    <form className="managed-composer" onSubmit={submit} noValidate>
    {error && <div className="error" role="alert"><p>{error}</p>
      <button type="button" disabled={busy || !!deleting || !!editor} onClick={() => setLoadVersion((value) => value + 1)}>Refresh saved runs and readiness</button>{" "}
      <button type="button" disabled={busy || !!deleting || !!editor} onClick={retry}>Refresh owner session</button>
    </div>}
    {storageError && <p className="error" role="alert">{storageError}</p>}
    {(pending || storageError) && <section className="managed-pending" aria-label="Unresolved managed launch">
      <h2>Resolve the saved request first.</h2>
      <p>The reply may have been lost, even if a paid run was created. Inputs are locked; edits cannot replace this request. Reconciliation submits the exact saved body and key, never a new launch.</p>
      {pending && <>
        <p><strong>Saved target:</strong> <span className="managed-wrap">{pending.body.scope.targetUrl}</span><br />
          <strong>Saved goal:</strong> {pending.body.assignments[0].goal}<br />
          <strong>Personas:</strong> {pending.body.assignments.length} · <strong>Request:</strong> <code>{pending.key}</code></p>
        <button type="button" className="primary" disabled={busy || !authorized} onClick={() => void send(pending)}>{busy ? "Reconciling…" : "Reconcile saved launch"}</button>
      </>}
      <details><summary>Deliberately discard the saved request</summary>
        <p>Discarding does not cancel a run. Check saved runs below first. Launching again with a new key can create another paid run.</p>
        <button type="button" disabled={busy} onClick={discard}>Discard saved request</button>
      </details>
    </section>}
      <fieldset disabled={locked || !loaded || !!editor || !!deleting}>
        <div className="managed-target">
          <div className="managed-target-heading">
            <label htmlFor="managed-target-url">Where are we surfing?</label>
            <span className="managed-target-badge">Public websites only</span>
          </div>
          <input id="managed-target-url" aria-label="Initial target URL" type="text" inputMode="url" autoComplete="url"
            spellCheck={false} maxLength={4096} placeholder="browserbase.com" value={target}
            onChange={(event) => chooseTarget(event.target.value)}
            onBlur={() => { if (normalizedTarget) setTarget(normalizedTarget.href); }}
            onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
            aria-invalid={!!target && (!scopeReady || !validTarget)} aria-describedby="managed-target-help" />
          <div className="managed-target-toolbar">
            <label className="managed-site-picker">Approved website
              <select value={validTarget && normalizedTarget ? normalizedTarget.origin : ""} disabled={!capabilities?.allowedOrigins.length}
                onChange={(event) => chooseTarget(`${event.target.value}/`)}>
                <option value="" disabled>{loaded ? "Choose a website" : "Loading websites..."}</option>
                {capabilities?.allowedOrigins.map((origin) => <option key={origin} value={origin}>{new URL(origin).host}</option>)}
              </select>
            </label>
            <span className="muted" id="managed-target-help">{!loaded ? "Checking approved websites..." : !capabilities?.allowedOrigins.length
              ? "No websites approved yet. Ask your operator to add one."
              : "Pick an approved site, or enter a URL on that site."}</span>
          </div>
          {target && loaded && !validTarget && <p className="error" role="alert">This initial target is not an exact approved HTTP(S) origin. Choose a website from the list.</p>}
          {target && validTarget && !scopeReady && <p className="error" role="alert">Check the requested path prefixes. Use paths beginning with /, without a query or fragment.</p>}
        </div>
        <section className="managed-specialists" aria-label="Choose your specialists">
          <div className="section-heading">
            <div><h2>Choose your crew</h2><p className="muted">Different perspectives. One shared destination.</p></div>
            <span className="managed-selection-count" aria-live="polite">{selected.length} / 8 selected</span>
          </div>
          <div className="managed-specialist-grid">
            {managedSpecialists.map((specialist, slot) => {
              const checked = selected.includes(specialist.personaId);
              const available = profiles.some((profile) => profile.id === specialist.personaId);
              const customized = !managedSpecialistForAssignment(assignmentFor(specialist.personaId));
              const shortDemo = !customized && managedIanaDemoAssignments.some((assignment) =>
                assignment.personaId === specialist.personaId && assignment.goal === assignmentFor(specialist.personaId).goal);
              return <label key={specialist.personaId} className={`managed-specialist${checked ? " selected" : ""}`}>
                <input type="checkbox" aria-label={`Select ${specialist.label}`} checked={checked}
                  disabled={!available || (selected.length >= 8 && !checked)}
                  onChange={(event) => setSelected((current) => selectRunAssignment(current, specialist.personaId, event.target.checked))}
                  aria-describedby={`specialist-${specialist.personaId}`} />
                <span className="managed-specialist-top"><PersonaAvatar id={specialist.personaId} slot={slot} />
                  <span className="managed-specialist-state">{!available ? "Unavailable" : checked ? "Selected" : "Select"}</span></span>
                <strong>{specialist.label}</strong>
                <span className="managed-specialist-purpose" id={`specialist-${specialist.personaId}`}>{specialist.purpose}</span>
                <span className="managed-specialist-checks" data-customized={customized || shortDemo}>{shortDemo ? <span>Short one-page IANA mission</span> : customized
                  ? <span>Custom mission: review goals and checks in Advanced.</span>
                  : specialist.checks.map((check) => <span key={check}>{check}</span>)}</span>
              </label>;
            })}
          </div>
        </section>
        <details className="managed-advanced">
          <summary>Advanced: missions & personas</summary>
          <p className="muted">Optional. Your crew already has read-only missions and checks. Fine-tune them below.</p>
        <details className="configuration">
          <summary>Customize requested scope</summary>
          <label>Requested path prefixes (one per line)
            <textarea rows={2} value={prefixes} onChange={(event) => setPrefixes(event.target.value)} />
          </label>
          <p className="muted">Requested scope only; not enforced. No additional hosts or subdomains are added.</p>
        </details>
        {capabilities?.allowedOrigins.includes("https://www.iana.org") && <div className="managed-demo-preset">
          <button type="button" onClick={() => {
            setTarget(managedIanaDemoScope.targetUrl);
            setPrefixes(managedIanaDemoScope.pathPrefixes.join("\n"));
            setSelected(managedIanaDemoAssignments.map((assignment) => assignment.personaId));
            setDrafts(Object.fromEntries(managedIanaDemoAssignments.map((assignment) => [
              assignment.personaId, { goal: assignment.goal, criteria: assignment.criteria.join("\n") },
            ])));
          }}>Prepare five-agent IANA demo</button>
          <p className="muted">IANA&apos;s Reserved Domains page is an optional, short read-only demo, not a required destination. This only prepares the crew.</p>
        </div>}
          <p className="muted managed-role-limits">Passive trust review, not penetration testing. Observed accessibility, not WCAG certification. Visible loading, not benchmarks.</p>
          <p className="muted">Optional. The five specialists already have goals and checks. Additional personas use the shared mission below. Every launch saves immutable persona, goal and criteria snapshots.</p>
          <label>Shared goal for additional personas
            <textarea className="goal-input" rows={3} maxLength={2000} placeholder="Find delivery information and explain whether the cost is clear." value={goal} onChange={(event) => setGoal(event.target.value)} />
          </label>
          <label>Shared criteria for additional personas (one per line, up to 6)
            <textarea rows={3} maxLength={3005} placeholder="Delivery costs are stated before checkout." value={criteria} onChange={(event) => setCriteria(event.target.value)} />
          </label>
          <p className="muted">Criteria are evaluated by the agent, not independently verified by Flash Flood.</p>
          <section className="people-section" aria-label="Managed personas">
            <div className="section-heading"><h2>All personas</h2>
              <button type="button" className="text-button" onClick={() => setEditor("new")}>+ Create persona</button></div>
            <div className="people-picker">
              {profiles.map((persona) => <label key={persona.id} className={`person-chip${selected.includes(persona.id) ? " selected" : ""}`}>
                <input type="checkbox" aria-label={`Select ${persona.name}`} checked={selected.includes(persona.id)}
                  disabled={selected.length >= 8 && !selected.includes(persona.id)}
                  onChange={(event) => setSelected((current) => selectRunAssignment(current, persona.id, event.target.checked))} />
                <PersonaAvatar id={persona.id} slot={selected.includes(persona.id) ? selected.indexOf(persona.id) : undefined} />
                <span>{persona.name}<small>{persona.character}</small></span>
              </label>)}
            </div>
            <p className="muted">Choose 1–8 existing personas. Persona behavior and device preferences are instructions, not guaranteed emulation.</p>
            <p className="muted">Analysis focus does not grant tools or permissions. Security reviews are read-only trust/privacy checklists, not penetration tests. Networking reviews describe observed loading and visible errors, not packet capture, DNS analysis, or timing instrumentation.</p>
            {selected.map((id) => {
              const persona = profiles.find((profile) => profile.id === id);
              if (!persona) return null;
              const custom = idSchema.safeParse(id).success;
              return <details className="persona-config managed-persona-config" key={id}>
                <summary>{persona.name}: goal, criteria & character</summary>
                <p>{persona.character}</p>
                <p className="muted">{persona.quirks.join("; ")}. Worries: {persona.worries.join(", ")}.</p>
                <label>Goal for {persona.name}<textarea maxLength={2000} rows={2} value={drafts[id]?.goal ?? ""}
                  placeholder={assignmentFor(id).goal} onChange={(event) => updateDraft(id, "goal", event.target.value)} /></label>
                <label>Criteria for {persona.name} (one per line, up to 6)<textarea maxLength={3005} rows={3} value={drafts[id]?.criteria ?? ""}
                  placeholder={assignmentFor(id).criteria.join("\n")} onChange={(event) => updateDraft(id, "criteria", event.target.value)} /></label>
                <p className="muted">Leave an override blank to use the specialist preset, or the shared mission for additional personas. Agent-reported criteria are not independently verified.</p>
                <div className="button-row">
                  <button type="button" onClick={() => setEditor(persona)}>{custom ? "Edit saved persona" : "Customize a copy"}</button>
                  {custom && <button type="button" disabled={!!deleting} onClick={() => void deletePersona(persona)}>{deleting === id ? "Deleting…" : `Delete ${persona.name}`}</button>}
                </div>
              </details>;
            })}
            <p className="muted">Preset customization saves a separate profile. Editing or deleting a saved persona does not change snapshots in existing runs.</p>
          </section>
        </details>
        <details className="managed-mission-review">
          <summary>Review selected missions{selected.length ? ` (${selected.length})` : ""}</summary>
          <p className="onboarding-target managed-wrap">{target}</p>
          <p className="muted">Requested paths: {lines(prefixes).join(", ")}</p>
          <ul className="onboarding-review">
            {selected.map((id, slot) => {
              const assignment = assignmentFor(id);
              const specialist = managedSpecialistForAssignment(assignment);
              return <li key={id}>
              <PersonaAvatar id={id} slot={slot} />
              <div><strong>{specialist?.label ?? profiles.find((persona) => persona.id === id)?.name ?? id}</strong>
                <p>{specialist?.purpose ?? assignment.goal}</p>
                <details><summary>Checks for this agent</summary>
                  {specialist && <p>{assignment.goal}</p>}
                  <ul>{assignment.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
                </details>
              </div>
            </li>;
            })}
          </ul>
        </details>
      </fieldset>
      <div className="managed-launch-footer">
        <div className="managed-launch-summary">
          <span className="managed-ready-dot" data-ready={enabled && validTarget && scopeReady && assignmentsReady} aria-hidden="true" />
          <span>{selected.length ? `${selected.length} agent${selected.length === 1 ? "" : "s"} in your crew` : "Your next wave starts here"}
            <small>{selected.length ? "Ready when you are. Nothing launches automatically." : "Pick a website and the perspectives you need."}</small>
          </span>
        </div>
        <button type="submit" className="primary launch-button" disabled={locked || !!deleting || !enabled || !validTarget || !scopeReady || !assignmentsReady}>
          {busy ? "Saving managed launch…" : `Launch ${selected.length || ""}${selected.length ? " " : ""}agent${selected.length === 1 ? "" : "s"}`}
          <span aria-hidden="true">↗</span>
        </button>
      </div>
      <div className="managed-launch-notes">
        <p className="muted">By launching, you confirm authorization to test this scope and accept the managed execution policy. No credentials or sensitive data.</p>
        <details className="managed-policy-details">
            <summary>Managed execution policy and limits</summary>
            <p className="muted">{capabilities?.notice}</p>
            <p className="muted">Browserbase tools cannot be disabled. Read-only and scope prompts are instructions, not enforced browser or network boundaries. Hard model-call and browser-time caps are unavailable. A cancellation request does not itself confirm browser cleanup.</p>
            <p className="muted">This MVP accepts only an allowlisted initial target. It is not arbitrary safe browsing.</p>
          </details>
      <p className="muted center" role="status">{!loaded ? "Checking managed execution readiness…" : enabled
        ? "Browserbase-managed · up to 8 agents per run · no automatic paid retries"
        : "Managed launch is disabled by the operator or has no approved initial origins. You can prepare goals and personas, but no browser will be started."}</p>
      </div>
    </form>
    <details className="managed-recent recent-runs">
      <summary>Your saved managed runs</summary>
    <section aria-labelledby="managed-recent-heading">
      <div className="section-heading"><h2 id="managed-recent-heading">Your saved managed runs</h2>
        <button type="button" className="text-button" disabled={busy || !!deleting || !!editor} onClick={() => setLoadVersion((value) => value + 1)}>Refresh list</button>
      </div>
      <p className="muted">Only runs belonging to this browser&apos;s current owner session. A lost cookie cannot recover previous runs.</p>
      {loaded && !recent.length && <p className="muted">No managed runs saved yet.</p>}
      <ul className="managed-run-list">{recent.map((run) => <li key={run.id}>
        <Link href={`/managed/${run.id}`}><strong>{run.attempts[0].goal}</strong><span className="managed-wrap">{run.scope.targetUrl}</span>
          <small>{run.attempts.length} persona{run.attempts.length === 1 ? "" : "s"} · {new Date(run.createdAt).toLocaleString()}</small></Link>
        <span className="managed-status">{run.status.replaceAll("_", " ")}</span>
      </li>)}</ul>
    </section>
    </details>
  </section></>;
}
