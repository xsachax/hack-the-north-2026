"use client";

import { useState, useSyncExternalStore } from "react";
import { DEMO_STORAGE_KEY, demoStateSchema, freshDemo, type DemoState } from "@/lib/demo";

const subscribe = () => () => {};
export function BrowserOnly({ children }: { children: React.ReactNode }) {
  const ready = useSyncExternalStore(subscribe, () => true, () => false);
  return ready ? children : <p role="status">Opening the store...</p>;
}

export function useDemoState() {
  const [initial] = useState(() => {
    try {
      const stored = sessionStorage.getItem(DEMO_STORAGE_KEY);
      return { state: stored === null ? freshDemo() : demoStateSchema.parse(JSON.parse(stored)), error: "" };
    } catch {
      return { state: null, error: "Demo storage could not be read. Enable browser storage or reset this tab in /demo-fixtures." };
    }
  });
  const [state, setState] = useState<DemoState | null>(initial.state);
  const [error, setError] = useState(initial.error);
  function save(next: DemoState): boolean {
    try {
      sessionStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(demoStateSchema.parse(next)));
      setState(next);
      setError("");
      return true;
    } catch {
      setError("Demo state could not be saved. Enable browser storage before continuing.");
      return false;
    }
  }
  return { state, error, save };
}
