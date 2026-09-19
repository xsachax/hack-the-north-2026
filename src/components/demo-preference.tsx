"use client";

import { useState, useSyncExternalStore } from "react";

export const DEMO_PREFERENCE_KEY = "flash-flood.synthetic-preference.v1";
const subscribe = () => () => {};

export function DemoPreference() {
  const ready = useSyncExternalStore(subscribe, () => true, () => false);
  return ready ? <Preference /> : null;
}

function Preference() {
  const [initial] = useState(() => {
    try { return { saved: localStorage.getItem(DEMO_PREFERENCE_KEY) === "remembered", error: "" }; }
    catch { return { saved: false, error: "Demo preference storage is unavailable." }; }
  });
  const [saved, setSaved] = useState(initial.saved);
  const [error, setError] = useState(initial.error);
  function remember() {
    try {
      localStorage.setItem(DEMO_PREFERENCE_KEY, "remembered");
      setSaved(true);
      setError("");
    } catch { setError("Demo preference could not be saved."); }
  }
  return <details>
    <summary role="button">Returning-user demo preference</summary>
    <p role="status">{`Synthetic preference: ${saved ? "remembered" : "fresh"}.`}</p>
    <p>This nonsensitive localStorage marker is separate from tab-local task data.</p>
    <button type="button" disabled={saved || !!error} onClick={remember}>Remember this demo visit</button>
    {error && <p role="alert">{error}</p>}
  </details>;
}
