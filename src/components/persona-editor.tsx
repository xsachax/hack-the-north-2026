"use client";

import { useEffect, useRef, useState } from "react";
import { idSchema, personaProfileSchema, type Persona } from "@/lib/contracts";
import { api, errorMessage } from "@/lib/client-api";
import { useOwnerSession } from "./owner-session";

export function PersonaEditor({ persona, onSaved, onClose }: {
  persona?: Persona; onSaved: (persona: Persona) => void; onClose: () => void;
}) {
  const { csrfToken } = useOwnerSession();
  const [profile, setProfile] = useState({
    name: persona?.name ?? "", character: persona?.character ?? "",
    device: persona?.device ?? "desktop", techComfort: persona?.techComfort ?? "medium",
    patienceSteps: persona?.patienceSteps ?? 12, readingStyle: persona?.readingStyle ?? "careful",
    quirks: persona?.quirks.join("\n") ?? "Checks the result before moving on",
    worries: persona?.worries.join("\n") ?? "Losing progress",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    nameInput.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const custom = persona && idSchema.safeParse(persona.id).success;
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !csrfToken) return;
    const parsed = personaProfileSchema.safeParse({ ...profile,
      quirks: profile.quirks.split("\n").filter(Boolean), worries: profile.worries.split("\n").filter(Boolean),
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      return;
    }
    setBusy(true);
    setError("");
    try {
      onSaved(await api<Persona>(custom ? `/personas/${persona.id}` : "/personas", {
        method: custom ? "PUT" : "POST", body: parsed.data, csrfToken,
      }));
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  return <section className="editor-panel" aria-labelledby="persona-editor-title">
    <h3 id="persona-editor-title">{custom ? "Edit persona" : persona ? "Make your own version" : "Meet someone new"}</h3>
    <form onSubmit={save}>
      <fieldset disabled={busy}>
        <div className="field-row">
          <label>Name<input ref={nameInput} required maxLength={80} value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} /></label>
          <label>Viewport<select value={profile.device} onChange={(event) => setProfile({ ...profile, device: event.target.value === "phone" ? "phone" : "desktop" })}><option value="desktop">Desktop</option><option value="phone">Phone-sized</option></select></label>
        </div>
        <label>Character<textarea required maxLength={1000} value={profile.character} onChange={(event) => setProfile({ ...profile, character: event.target.value })} /></label>
        <div className="field-row">
          <label>Tech comfort<select value={profile.techComfort} onChange={(event) => setProfile({ ...profile, techComfort: personaProfileSchema.shape.techComfort.parse(event.target.value) })}>{["low", "medium", "high"].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Reading style<select value={profile.readingStyle} onChange={(event) => setProfile({ ...profile, readingStyle: event.target.value === "skim" ? "skim" : "careful" })}><option value="careful">Careful</option><option value="skim">Skim</option></select></label>
          <label>Patience (steps)<input type="number" min={1} max={30} required value={profile.patienceSteps} onChange={(event) => setProfile({ ...profile, patienceSteps: event.target.valueAsNumber })} /></label>
        </div>
        <label>Quirks (one per line)<textarea required value={profile.quirks} onChange={(event) => setProfile({ ...profile, quirks: event.target.value })} /></label>
        <label>Worries (one per line)<textarea required value={profile.worries} onChange={(event) => setProfile({ ...profile, worries: event.target.value })} /></label>
      </fieldset>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="button-row"><button className="primary" disabled={busy} type="submit">{busy ? "Saving..." : "Save persona"}</button><button type="button" onClick={onClose} disabled={busy}>Close editor</button></div>
    </form>
  </section>;
}
