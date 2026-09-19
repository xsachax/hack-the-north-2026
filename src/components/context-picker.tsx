"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/client-api";
import { contextListSchema, type BrowserState, type ContextView } from "@/lib/context-contracts";
import { useOwnerSession } from "./owner-session";

export function ContextPicker({ value, onChange }: {
  value?: BrowserState; onChange: (selection: BrowserState) => void;
}) {
  const { ownerId, csrfToken } = useOwnerSession();
  const [contexts, setContexts] = useState<ContextView[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api<unknown>("/contexts").then((result) => {
      if (active) setContexts(contextListSchema.parse(result).items);
    }).catch((failure) => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [ownerId]);
  async function revoke(id: string) {
    if (!csrfToken) return;
    try {
      await api(`/contexts/${id}`, { method: "DELETE", csrfToken });
      setContexts((current) => current.map((entry) => entry.id === id ? { ...entry, revoked: true } : entry));
      if (value?.mode === "returning" && value.contextId === id) onChange({ mode: "fresh" });
    } catch (failure) { setError(errorMessage(failure)); }
  }
  return <details>
    <summary>Browser state: {value?.mode ?? "fresh"}</summary>
    <p className="muted">Fresh is the default. Saved state is private, may contain credentials, and belongs only to this owner and exact navigation scope. Fixture task state is reset separately; the synthetic demo preference uses persistent storage.</p>
    <label>State for this assignment<select value={value?.mode === "returning" ? value.contextId : value?.mode ?? "fresh"}
      onChange={(event) => {
        const selected = event.target.value;
        onChange(selected === "fresh" ? { mode: "fresh" } : selected === "save"
          ? { mode: "save", acknowledgeSensitiveStorage: true }
          : { mode: "returning", contextId: selected, persist: false, acknowledgeSensitiveStorage: true });
      }}>
      <option value="fresh">Fresh, do not save</option>
      <option value="save">I authorize saving private state in a new context</option>
      {contexts.filter((entry) => !entry.revoked && ["available", "persisting"].includes(entry.status)).map((entry) =>
        <option key={entry.id} value={entry.id}>Returning {entry.id.slice(0, 8)} — {entry.status} (exact scope required)</option>)}
    </select></label>
    {value?.mode === "returning" && <label className="check-label"><input type="checkbox" checked={value.persist}
      onChange={(event) => onChange({ ...value, persist: event.target.checked })} />Also authorize saving changes after this session</label>}
    <p className="muted">Persisted state is eligible after a 10-second synchronization delay, not a provider-confirmed save guarantee. Unknown allocation/cleanup blocks reuse. Revocation stops reuse immediately; remote deletion waits for confirmed closure and a worker. Provider contexts otherwise live indefinitely.</p>
    {contexts.filter((entry) => entry.status !== "deleted").map((entry) => <div key={entry.id}>
      <span>{entry.id.slice(0, 8)}: {entry.status}{entry.revoked ? " (revoked)" : ""}</span>{" "}
      <button type="button" disabled={entry.revoked} onClick={() => void revoke(entry.id)}>Revoke saved state</button>
    </div>)}
    {error && <p role="alert" className="error">{error}</p>}
  </details>;
}
