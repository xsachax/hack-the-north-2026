"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "@/lib/client-api";

type Session = { ownerId: string; csrfToken: string; expiresAt: number };
type OwnerContext = { ownerId: string | null; csrfToken: string | null; authorized: boolean; revision: number; retry: () => void };
const Context = createContext<OwnerContext>({ ownerId: null, csrfToken: null, authorized: false, revision: 0, retry: () => {} });
export const useOwnerSession = () => useContext(Context);

export function OwnerSession({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [locked, setLocked] = useState(false);
  const [code, setCode] = useState("");
  const inFlight = useRef(false);
  const bootstrap = useCallback(async (accessCode?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setLocked(true);
    setError("");
    try {
      const next = await api<Session>("/session", { method: "POST", body: accessCode ? { accessCode } : {} });
      setSession(next);
      setRevision((current) => current + 1);
      setLocked(false);
      setCode("");
    } catch (failure) {
      setLocked(true);
      setError(failure instanceof ApiError && failure.status === 401
        ? (accessCode ? "That access code was not accepted." : "") : errorMessage(failure));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) void bootstrap(); });
    return () => { active = false; };
  }, [bootstrap]);
  const retry = useCallback(() => { void bootstrap(); }, [bootstrap]);
  return <Context.Provider value={{ ownerId: session?.ownerId ?? null, csrfToken: session?.csrfToken ?? null, authorized: !!session && !locked, revision, retry }}>
    {(!session || locked) && <section className="access-panel" aria-labelledby="access-title">
      <p className="eyebrow">YOUR PRIVATE WORKSPACE</p>
      <h2 id="access-title">{busy ? "Opening your workspace..." : "Let the right crowd in."}</h2>
      {!busy && <form onSubmit={(event) => { event.preventDefault(); void bootstrap(code); }}>
        <label>Workspace access code<input type="password" autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)} maxLength={512} /></label>
        <button className="primary" type="submit">Unlock workspace</button>
      </form>}
      {error && <p className="error" role="alert">{error}</p>}
      <p className="muted">Access stays in an HttpOnly cookie on this browser, not an account. Losing or expiring that cookie loses access to your saved runs. Codes are never saved in browser storage.</p>
      {!busy && <button type="button" className="text-button" onClick={retry}>Retry existing session</button>}
    </section>}
    {session && <div key={session.ownerId} hidden={locked}>{children}</div>}
  </Context.Provider>;
}
