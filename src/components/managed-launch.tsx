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
import { managedDefaultCriteria, managedDefaultGoal, managedSpecialistForAssignment, managedSpecialists } from "@/lib/managed-specialists";
import { useOwnerSession } from "./owner-session";
import { PersonaAvatar } from "./persona-avatar";
import { PersonaEditor } from "./persona-editor";
import { OnboardingFrame } from "./onboarding-frame";

const steps = ["Website", "Specialists", "Launch"];
const titles = ["Where are we surfing?", "Choose your specialists.", "Ready to make waves?"];
const descriptions = [
  "Start with one website and a small scope.",
  "Pick the perspectives you want. Their missions are ready to go.",
  "Review the mission. Your next click sends it to the worker.",
];
const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);

const pendingSchema = z.strictObject({
  ownerId: z.string().min(1), key: z.uuid(), body: managedCreateSchema,
});
type Pending = z.infer<typeof pendingSchema>;
type AssignmentDraft = { goal?: string; criteria?: string };
const storageKey = (owner: string) => `flash-flood:managed-pending:${owner}`;
const peopleSchema = z.strictObject({ items: z.array(personaSchema) });
const runsSchema = z.strictObject({ items: z.array(managedRunSchema) });

function targetAllowed(value: string, origins?: string[]) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && (!origins || origins.includes(url.origin));
  } catch { return false; }
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
  const [step, setStep] = useState(0);
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
          setStep(2);
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
    if (step < steps.length - 1) {
      if (locked || !loaded || editor || deleting) return;
      if (!stepValid) { setError("Complete this section before continuing."); return; }
      navigate(step + 1);
      return;
    }
    if (!authorized || !ownerId || !capabilities?.enabled || !loaded || pending || busy || editor || deleting
      || storageError || storageOwner !== ownerId) return;
    if (!targetAllowed(target, capabilities.allowedOrigins)) {
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
        scope: { targetUrl: new URL(target).href, pathPrefixes, allowedSubdomains: [] },
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
      setStep(0);
      setError("");
    } catch { setStorageError("Storage is still unavailable. Launches remain locked; no request was sent."); }
  }

  function updateDraft(id: string, field: keyof AssignmentDraft, value: string) {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], [field]: value } }));
  }

  function navigate(next: number) {
    setStep(next);
    setError("");
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

  const validTarget = !!capabilities && targetAllowed(target, capabilities.allowedOrigins);
  const enabled = loaded && !!capabilities?.enabled && !!capabilities.allowedOrigins.length;
  const locked = !!pending || !!storageError || storageOwner !== ownerId || busy || !authorized;
  const assignmentsReady = selected.length > 0 && selected.length <= 8
    && selected.every((id) => managedAssignmentSchema.safeParse(assignmentFor(id)).success);
  const scopeReady = targetAllowed(target)
    && managedCreateSchema.shape.scope.safeParse({
    targetUrl: target, pathPrefixes: lines(prefixes), allowedSubdomains: [],
  }).success && lines(prefixes).every((prefix) => prefix.startsWith("/") && !prefix.startsWith("//") && !/[?#]/.test(prefix));
  const stepValid = step === 0 ? scopeReady && (!capabilities?.enabled || validTarget)
    : assignmentsReady;
  const editorPanel = editor && !locked ? <section className="managed-launch onboarding-stage" aria-label="Managed persona editor">
    <OnboardingFrame steps={steps} step={step} title="Make a persona your own."
      description="Choose a specialty or create a completely custom perspective." onStep={navigate} navigationLocked>
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
    </OnboardingFrame>
  </section> : null;

  return <>{editorPanel}<section hidden={!!editorPanel} className="managed-launch onboarding-stage" aria-label="Managed launch workspace">
    <form className="onboarding-form" onSubmit={submit} noValidate>
    <OnboardingFrame steps={steps} step={step} title={titles[step]} description={descriptions[step]}
      onStep={navigate} navigationLocked={locked || !!deleting} actions={<>
        {step > 0 && <button type="button" disabled={locked || !!deleting} onClick={() => navigate(step - 1)}>Back</button>}
        <span className="muted onboarding-save-hint">Nothing launches until the final step.</span>
        {step < 2 ? <button type="submit" className="primary" disabled={locked || !loaded || !!deleting || !stepValid}>Continue</button>
          : <button type="submit" className="primary launch-button" disabled={locked || !!deleting || !enabled || !validTarget || !scopeReady || !assignmentsReady}>
            {busy ? "Saving managed launch…" : `Launch ${selected.length || ""}${selected.length ? " " : ""}agent${selected.length === 1 ? "" : "s"}`}
          </button>}
      </>}>
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
        <div hidden={step !== 0} data-onboarding-step="Website">
        <label>Initial target URL
          <input type="url" maxLength={4096} placeholder="https://approved-site.example/help" value={target} onChange={(event) => setTarget(event.target.value)}
            aria-invalid={!!target && (!scopeReady || !!capabilities?.enabled && !validTarget)} aria-describedby="managed-target-help" />
        </label>
        <div id="managed-target-help" className="muted">
          <strong>Operator-approved initial origins:</strong>
          {capabilities?.allowedOrigins.length ? <ul className="managed-origins">{capabilities.allowedOrigins.map((origin) => <li key={origin}><code>{origin}</code></li>)}</ul> : <p>No initial origins are approved.</p>}
          {target && capabilities?.enabled && !validTarget && <p className="error">This initial target is not an exact approved HTTP(S) origin.</p>}
        </div>
        <details className="configuration">
          <summary>Customize requested scope</summary>
          <label>Requested path prefixes (one per line)
            <textarea rows={2} value={prefixes} onChange={(event) => setPrefixes(event.target.value)} />
          </label>
          <p className="muted">Requested scope only; not enforced. No additional hosts or subdomains are added.</p>
        </details>
        </div>
        <div hidden={step !== 1} data-onboarding-step="Specialists">
        <section className="managed-specialists" aria-label="Choose your specialists">
          <div className="section-heading">
            <p className="muted">Every specialist has a read-only mission.</p>
            <span className="managed-selection-count" aria-live="polite">{selected.length} / 8 selected</span>
          </div>
          <div className="managed-specialist-grid">
            {managedSpecialists.map((specialist, slot) => {
              const checked = selected.includes(specialist.personaId);
              const available = profiles.some((profile) => profile.id === specialist.personaId);
              const customized = !managedSpecialistForAssignment(assignmentFor(specialist.personaId));
              return <label key={specialist.personaId} className={`managed-specialist${checked ? " selected" : ""}`}>
                <input type="checkbox" aria-label={`Select ${specialist.label}`} checked={checked}
                  disabled={!available || (selected.length >= 8 && !checked)}
                  onChange={(event) => setSelected((current) => selectRunAssignment(current, specialist.personaId, event.target.checked))}
                  aria-describedby={`specialist-${specialist.personaId}`} />
                <span className="managed-specialist-top"><PersonaAvatar id={specialist.personaId} slot={slot} />
                  <span className="managed-specialist-state">{!available ? "Unavailable" : checked ? "Selected" : "Select"}</span></span>
                <strong>{specialist.label}</strong>
                <span className="managed-specialist-purpose" id={`specialist-${specialist.personaId}`}>{specialist.purpose}</span>
                <span className="managed-specialist-checks">{customized
                  ? <span>Custom mission: review goals and checks in Advanced.</span>
                  : specialist.checks.map((check) => <span key={check}>{check}</span>)}</span>
              </label>;
            })}
          </div>
          <p className="muted managed-role-limits">Passive trust review, not penetration testing. Observed accessibility, not WCAG certification. Visible loading, not benchmarks.</p>
        </section>
        <details className="managed-advanced">
          <summary>Advanced: missions & personas</summary>
          <p className="muted">Optional. The four specialists already have goals and checks. Additional personas use the shared mission below. Every launch saves immutable persona, goal and criteria snapshots.</p>
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
        </div>
        <div hidden={step !== 2} data-onboarding-step="Launch">
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
          <p className="muted">By launching, you confirm authorization to test this scope and accept the managed execution policy. Use only non-destructive tasks, without credentials or sensitive data.</p>
          <details className="configuration">
            <summary>Managed execution policy and limits</summary>
            <p className="muted">{capabilities?.notice}</p>
            <p className="muted">Browserbase tools cannot be disabled. Read-only and scope prompts are instructions, not enforced browser or network boundaries. Hard model-call and browser-time caps are unavailable. A cancellation request does not itself confirm browser cleanup.</p>
            <p className="muted">This MVP accepts only an allowlisted initial target. It is not arbitrary safe browsing.</p>
          </details>
        </div>
      </fieldset>
      <p className="muted center" role="status">{!loaded ? "Checking managed execution readiness…" : enabled
        ? "Browserbase-managed · up to 8 agents per run · no automatic paid retries"
        : "Managed launch is disabled by the operator or has no approved initial origins. You can prepare goals and personas, but no browser will be started."}</p>
    <details hidden={step !== 0 && !pending} className="managed-recent recent-runs">
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
    </OnboardingFrame>
    </form>
  </section></>;
}
