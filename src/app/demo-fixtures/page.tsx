"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- Enter the store with fresh document state after applying the fixture. */

import { useState } from "react";
import { fixtureNames, fixedFixtures, freshDemo, type Fixtures } from "@/lib/demo";
import { BrowserOnly, useDemoState } from "../demo/browser-state";
import "../demo/store.css";

export default function FixturesPage() {
  return <div className="demo"><BrowserOnly><FixtureControls /></BrowserOnly></div>;
}

function FixtureControls() {
  const { state, save, error } = useDemoState();
  const [fixtures, setFixtures] = useState<Fixtures>(state?.fixtures ?? fixedFixtures);
  const [message, setMessage] = useState("");
  return <main>
    <h1>Demo fixture setup</h1>
    <p>Operator interface, outside the shopping journey. Checked means broken. Configuration and shopping data belong only to this browser tab.</p>
    <p>Applying a scenario resets the cart, coupons, delivery, gift wrap and order. A new independent browser context starts all-fixed.</p>
    {error && <p role="alert">{error}</p>}
    <div className="fixture-options">{fixtureNames.map((name) =>
      <label key={name}><input type="checkbox" checked={fixtures[name]} onChange={(event) => setFixtures({ ...fixtures, [name]: event.target.checked })} />{name}</label>)}</div>
    <form onSubmit={(event) => { event.preventDefault(); if (save(freshDemo(fixtures))) setMessage("Scenario applied. Shopping state reset."); }}>
      <button type="button" onClick={() => setFixtures({ ...fixedFixtures })}>Select all fixed</button>
      <button type="button" onClick={() => setFixtures({ phoneFold: true, secondCoupon: true, postalSpaces: true, continueLabels: true, slowCart: true, keyboardFocus: true })}>Select all broken</button>
      <button type="submit">Apply scenario and reset</button>
      <button type="button" onClick={() => { if (save(freshDemo(state?.fixtures ?? fixtures))) setMessage("Shopping state reset. Scenario unchanged."); }}>Reset shopping state</button>
    </form>
    {message && <p role="status">{message}</p>}
    <a href="/demo">Open store</a>
  </main>;
}
