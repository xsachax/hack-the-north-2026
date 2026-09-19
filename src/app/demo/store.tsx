"use client";

/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-location-assign-relative-destination -- Document navigation intentionally reloads validated tab-local fixture state, without router prefetch. */

import { useEffect, useState } from "react";
import { money, normalizePostal, products, SECOND_COUPON_SIGNATURE, SHIPPING_CENTS, totalCents, type DemoState } from "@/lib/demo";
import { BrowserOnly, useDemoState } from "./browser-state";
import "./store.css";
import { DemoPreference } from "@/components/demo-preference";

export function DemoStore({ route }: { route: string }) {
  return <div className="demo"><BrowserOnly><Shop route={route} /></BrowserOnly></div>;
}

function Shop({ route }: { route: string }) {
  const { state, save, error } = useDemoState();
  const [notice, setNotice] = useState("");
  if (!state) return <main><h1>Store unavailable</h1><p role="alert">{error}</p><a href="/demo-fixtures">Demo setup</a></main>;
  const product = products.find((item) => route === `product/${item.id}`);
  const cartProducts = products.filter((item) => state.cart.includes(item.id));
  const continueLabel = state.fixtures.continueLabels;
  function navigate(next: DemoState, path: string) {
    if (save(next)) window.location.assign(path);
  }
  return <>
    <header className="shop-header">
      <a className="shop-brand" href="/demo">Little Maple</a>
      <nav aria-label="Store"><a href="/demo/category/home">Home gifts</a><a href="/demo/category/paper">Paper goods</a><a href="/demo/cart">Cart ({state.cart.length})</a></nav>
    </header>
    <main>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {(route === "" || route.startsWith("category/")) && <>
        <section className="shop-intro"><p className="eyebrow">Small things, thoughtfully chosen</p>
          <h1>{route === "category/home" ? "Home gifts" : route === "category/paper" ? "Paper goods" : "A little joy, under $50."}</h1>
          <p>Everyday gifts for your favourite people. Flat CA$5 delivery across Canada.</p>
        </section>
        <div className="product-grid">{products.filter((item) => !route.startsWith("category/") || item.category === route.split("/")[1]).map((item) =>
          <article className="product-card" key={item.id}>
            <div className={`product-art art-${item.id}`} aria-hidden="true">{item.art}</div>
            <h2><a href={`/demo/product/${item.id}`}>{item.name}</a></h2><p>{item.detail}</p><strong>{money(item.cents)}</strong>
          </article>)}</div>
      </>}
      {product && <section className="product-detail">
        <div className={`product-art art-${product.id}`} aria-hidden="true">{product.art}</div>
        <div><a href={`/demo/category/${product.category}`}>Back to collection</a><h1>{product.name}</h1><p>{product.detail}</p>
          <p>{money(product.cents)}</p><p>In stock. One of each item per order.</p>
          <button disabled={state.cart.includes(product.id)} onClick={() => {
            if (save({ ...state, cart: [...state.cart, product.id], completed: false })) setNotice(`${product.name} added to cart.`);
          }}>{state.cart.includes(product.id) ? "Added to cart" : "Add to cart"}</button>
          <p><a href="/demo/cart">View cart</a></p>
        </div>
      </section>}
      {route === "cart" && <>
        <h1>Your cart</h1>
        {!state.cart.length ? <p>Your cart is empty. <a href="/demo">Find a gift</a></p> : <>
          <ul className="cart-items">{cartProducts.map((item) => <li key={item.id}><span>{item.name} - {money(item.cents)}</span>
            <button className="secondary" onClick={() => save({ ...state, cart: state.cart.filter((id) => id !== item.id), completed: false })}>Remove {item.name}</button>
          </li>)}</ul>
          <CartControls state={state} save={save} />
        </>}
      </>}
      {route === "checkout" && <>
        <h1>Delivery</h1>
        {!state.cart.length ? <p>Add a gift to your cart first. <a href="/demo">Browse gifts</a></p> : <>
          <p>Canadian delivery is CA$5. Total: {money(totalCents(state))}.</p>
          <form onSubmit={(event) => {
            event.preventDefault();
            const raw = new FormData(event.currentTarget).get("postal");
            const postal = normalizePostal(typeof raw === "string" ? raw : "", state.fixtures.postalSpaces);
            if (!postal) { setNotice("Enter a valid Canadian postal code."); return; }
            navigate({ ...state, postal }, "/demo/checkout/review");
          }}>
            <label htmlFor="postal">Canadian postal code</label>
            <input id="postal" name="postal" autoComplete="off" maxLength={16} defaultValue={state.postal} required />
            <button type="submit">{continueLabel ? "Continue" : "Review order"}</button>
          </form>
          <p>No street address or payment details are collected.</p>
        </>}
      </>}
      {route === "checkout/review" && <>
        <h1>Review your order</h1>
        {!state.cart.length || !state.postal ? <p>Complete delivery first. <a href="/demo/checkout">Delivery details</a></p> : <>
          <ul>{cartProducts.map((item) => <li key={item.id}>{item.name}</li>)}</ul>
          <p>Deliver to: {state.postal}</p><p>Gift wrap: {state.giftWrap ? "Yes" : "No"}</p>
          <p>Total: <strong>{money(totalCents(state))}</strong></p>
          <p>This is a simulated order. No payment is collected and nothing will ship.</p>
          <button onClick={() => navigate({ ...state, completed: true, cart: [] }, "/demo/complete")}>Place demo order</button>
        </>}
      </>}
      {route === "complete" && <><h1>{state.completed ? "Thank you! Your demo order is complete." : "No order placed yet"}</h1>
        <p>No payment was taken. Nothing will ship.</p><a href="/demo">Browse gifts</a></>}
    </main>
    <footer><span>Little Maple is a synthetic demonstration store. No real purchases.</span><span>Prices in CAD. Demo totals include tax.</span></footer>
    <DemoPreference />
  </>;
}

function CartControls({ state, save }: { state: DemoState; save: (state: DemoState) => boolean }) {
  const [shipping, setShipping] = useState<"loading" | "ready" | "failed">("loading");
  const [couponMessage, setCouponMessage] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/demo/cart-summary?variant=${state.fixtures.slowCart ? "broken" : "fixed"}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok || (await response.json()).shippingCents !== SHIPPING_CENTS) throw new Error("Invalid cart response");
        setShipping("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setShipping("failed");
      });
    return () => controller.abort();
  }, [state.fixtures.slowCart]);
  const toggleWrap = () => save({ ...state, giftWrap: !state.giftWrap });
  return <>
    <div className="cart-options">
      <form onSubmit={(event) => {
        event.preventDefault();
        const raw = new FormData(event.currentTarget).get("coupon");
        const coupon = typeof raw === "string" ? raw.trim().toUpperCase() : "";
        if (coupon !== "SAVE10" && coupon !== "COZY5") { setCouponMessage("That coupon is not available."); return; }
        if (state.coupons.includes(coupon)) { setCouponMessage("That coupon is already applied."); return; }
        if (state.fixtures.secondCoupon && state.coupons.length === 1) throw new Error(SECOND_COUPON_SIGNATURE);
        if (save({ ...state, coupons: [...state.coupons, coupon] })) setCouponMessage(`${coupon} applied.`);
      }}>
        <label htmlFor="coupon">Coupon code</label><input id="coupon" name="coupon" maxLength={20} />
        <button type="submit">Apply coupon</button>
      </form>
      <p>Seasonal offers: SAVE10 for 10% off items; COZY5 for CA$5 off. Offers can be combined.</p>
      {couponMessage && <p role="status">{couponMessage}</p>}
      <p>Applied coupons: {state.coupons.join(", ") || "None"}</p>
      {state.fixtures.keyboardFocus
        ? <div className="wrap-control" role="button" aria-pressed={state.giftWrap} onClick={toggleWrap}>Add gift wrap (+CA$3)</div>
        : <button className="wrap-control" aria-pressed={state.giftWrap} onClick={toggleWrap}>Add gift wrap (+CA$3)</button>}
    </div>
    <section className={state.fixtures.phoneFold ? "cart-checkout below-fold" : "cart-checkout"}>
      <h2>Order total: {money(totalCents(state))}</h2><p>Includes CA$5 delivery and {state.giftWrap ? "CA$3 gift wrap" : "no gift wrap"}.</p>
      {shipping === "loading" && <p role="status">Checking delivery...</p>}
      {shipping === "failed" && <p role="alert">Delivery could not be loaded. Reload the cart to try again.</p>}
      <button disabled={shipping !== "ready"} onClick={() => window.location.assign("/demo/checkout")}>{state.fixtures.continueLabels ? "Continue" : "Continue to delivery"}</button>
    </section>
  </>;
}
