# Controlled demo store (layer 02)

Little Maple is a synthetic Canadian gift shop at `/demo`. Products cost
CA$12-24, delivery is CA$5, optional gift wrap CA$3, and displayed demo prices
include tax. Browse home/paper collections, open a product, add to cart, apply
coupons, enter a postal code, review and place a **demo** order. No accounts,
street addresses, cards, payments, real orders or external services exist.
One of each product is allowed. The footer and final action identify this as a
demonstration without revealing planted problems to shoppers.

## Run and configure

```sh
nvm use
npm ci
npm run dev
# Open http://127.0.0.1:3000/demo-fixtures, then Open store.
```

`/demo-fixtures` is the separate operator interface, not linked from ordinary
shopping pages. Each checked switch enables one broken variant. Select
individual switches or all broken/fixed, then **Apply scenario and reset**.
**Reset shopping state** retains the applied switches and clears cart, coupons,
postal code, gift wrap and completion. Changing checkbox selections alone does
not apply them. New browser contexts/tabs without an opener start all-fixed.

State is validated, versioned JSON under `sessionStorage["flash-flood-demo-v1"]`.
It survives same-tab document navigation/reload and is not stored on the server
or in owner cookies. Independent tabs/contexts cannot mutate one another.
Browser duplicate-tab or opener semantics may initially *copy* sessionStorage;
always use fresh contexts for independent runs, not a cloned/opener tab. A
corrupted or unavailable storage area shows an error; operator reset can repair
corrupted data, but cannot override browser-disabled storage. No global mutable
scenario flags, query-controlled scripts, random seeds, clocks or cloud state
influence the catalog/outcomes.

For a trusted deterministic runner, import `freshDemo`, `fixedFixtures` and
`DEMO_STORAGE_KEY` from `src/lib/demo.ts`. After navigating to this demo origin
and **before** handing control to the persona, write
`JSON.stringify(freshDemo({...fixedFixtures, secondCoupon: true}))` to that
sessionStorage key, then navigate to the target route. Do this once per fresh
browser context, not on every page load (which would erase the journey).
Alternatively drive `/demo-fixtures` during trusted setup and leave it before
starting the scoped attempt. Never tell the persona which fixture is enabled.

## Fixture and evidence matrix

| Switch | Broken signature | Fixed expectation | Evidence interpretation |
| --- | --- | --- | --- |
| `phoneFold` | At 390x844, cart checkout action starts below viewport; scrolling reveals an operable control | Action intersects the initial phone viewport | Geometry/scroll friction heuristic, **not** functional failure or JS exception |
| `secondCoupon` | Apply SAVE10 then COZY5: uncaught `FF_DEMO_SECOND_COUPON: coupon stack unavailable`; only SAVE10 applied | Both apply; mug total CA$21.60 before wrap | Confirmed browser exception; same coupon twice is a normal non-error message |
| `postalSpaces` | `N2L 3G1` is rejected at Delivery; `N2L3G1` works | Spaced/lowercase input accepted and normalized to `N2L 3G1` | Observable incorrect validation; regex checks format, not actual postal deliverability |
| `continueLabels` | Cart and Delivery both say `Continue`, but navigate to delivery and review respectively | `Continue to delivery` and `Review order` | Assert labels and outcomes; ambiguity is a human/usability interpretation, not an automated model judgment |
| `slowCart` | Actual GET `/demo/cart-summary?variant=broken` delays response by a fixed 1,200ms; checkout disabled while pending | `variant=fixed` has no intentional delay | Real request timing, HTTP 200 in both variants; slowness does not automatically prove abandonment/failure |
| `keyboardFocus` | Gift-wrap control works with pointer but is absent from Tab order and lacks keyboard activation | Native button reachable by Tab and operable with Space/Enter | Confirmed keyboard-operability defect; CA$3 total and `aria-pressed` expose the outcome |

Variants are independent and can be combined. Regression tests isolate each
switch to attribute signatures; all-broken is not proof of six findings from one
journey (for example, postal rejection may block review). This layer has **not**
run autonomous personas or claimed agents found any of the six problems.

The slow endpoint returns only constant shipping data. It accepts exactly one
`variant=broken|fixed`, rejects arbitrary/duplicate query fields with 400, does
not accept a user-controlled duration, sets `Cache-Control: no-store`, and
supports GET only. The timer is capped at 1,200ms; observed latency includes
scheduling/network overhead. It has no DB, owner, paid-client or API handler
dependency. Public hosting still needs proxy-level request/concurrency limits:
a per-request bounded timer is not global abuse protection.

## Layer 03 objective handoff

Use the authorized origin of **your** demo deployment, replacing
`https://demo.example.test` below. No such deployment is provisioned by this PR.

| Persona/task | Initial target and category | Goal and observable criteria |
| --- | --- | --- |
| Ordinary gift buyer | `/demo/category/home`, home gifts | Find a gift under CA$50, add it, deliver to N2L 3G1 and place a demo order. Item price and total visible; postal accepted; explicit demo completion heading; no payment or real personal data requested. |
| Coupon shopper | `/demo/category/home`, home gifts | Buy the Maple ceramic mug using the advertised SAVE10 and COZY5 offers. Both codes applied; total CA$21.60 without wrap; record any genuine browser exception. |
| Phone shopper | `/demo/category/home`, home gifts; 390x844 | Add the mug and reach Delivery. Record initial checkout visibility, scroll actions and eventual navigation separately; never equate below-fold placement with impossible checkout. |
| Keyboard shopper | `/demo/category/home`, home gifts | Add mug, add gift wrap with keyboard, and complete a demo order. Tab reaches wrap; Space/Enter toggles it; total CA$32.00 without coupons; completion is visible. |
| Impatient shopper | `/demo/category/paper`, paper goods | Add the Pocket trail journal and reach Delivery. Measure actual cart request elapsed time and pending UI. Persona patience/abandonment must be observed, not inferred solely from 1.2 seconds. |
| Careful checkout reader | `/demo/category/home`, home gifts | Reach order review without placing the order. Record action labels and destinations, and whether the model expresses uncertainty. Label reuse alone is not proof the model was confused. |

Suggested canonical scope:

```json
{
  "targetUrl": "https://demo.example.test/demo/category/home",
  "allowedSubdomains": [],
  "pathPrefixes": ["/demo", "/_next"]
}
```

`/demo` covers products, category browsing, cart-summary and checkout.
`/_next` is needed for same-origin Next.js scripts/CSS; it is an asset dependency,
not a browsing objective. The driver must differentiate navigations (only
`/demo` shopping routes) from permitted same-origin asset requests. Do not allow
`/api/v1`, `/demo-fixtures`, other origins or unrelated routes to persona tools.
Layer 03 must enforce scope at the actual browser/network boundary as described
in [API.md](API.md), including redirects/popups/subresources; this layer does not
solve browser egress/DNS rebinding. Fixture setup is trusted harness work outside
the persona scope. Do not weaken API target admission just to reach localhost.

## Offline regressions and CI

```sh
npm run check
npm run build
npm run test:http
npx playwright install chromium --only-shell
npm run test:e2e
```

The browser suite owns a production Next server on `127.0.0.1:4317` (port must
be free), never reuses a dev server, and blocks/reports external browser requests.
No `.env.local` is needed; cloud credentials and production API admission are
explicitly disabled in that process. Regular CI installs only Chromium headless
shell with system dependencies and runs these same gates without secrets.
Each browser test gets a fresh context; two workers, no retries, fixed viewports.
Expected second-coupon page errors are captured and asserted by exact signature;
unexpected page/console errors fail tests. Full desktop, phone and pointer-free
keyboard journeys, reset/isolation/corrupt-state handling, and protected API
fail-closed behavior are covered. Existing built-server HTTP smoke separately
exercises valid owner sessions, CSRF and cross-owner isolation.

Network regressions use browser request timings, not mocked responses: fixed
under 1,000ms, broken at least 1,100ms and under 10 seconds including overhead,
with at least 800ms separation. Source/unit checks pin the intentional timer at
1,200ms. Severe host saturation can fail the performance test; do not silently
retry or relabel that infrastructure failure as a fixture finding.
Playwright traces on failure are local/ignored under `test-results`; CI does not
publish traces or screenshots. Chromium phone viewport is not full mobile-device
emulation. WebKit/Firefox and real assistive technology remain untested.

## Cloud reachability and authorization

Remote Browserbase browsers **cannot reach your developer's localhost**.
When layer 03 is authorized to spend, use a controlled public demo deployment
or an explicitly authorized, temporary tunnel with a reverse-proxy allowlist
exposing only `/demo` shopping routes and required `/_next` assets (and only
operator-approved setup if needed). Never expose the entire developer server,
owner APIs, environment files, private data or credentials. Prefer trusted
sessionStorage seeding rather than exposing `/demo-fixtures`. Keep HTTPS, limit
requests/concurrency, verify the externally reachable path allowlist, and stop
the tunnel after the authorized test. This PR does **not** deploy or tunnel.

The demo is intentionally public and synthetic; it cannot grant owner sessions
or bypass `/api/v1` authentication/CSRF/access-code checks. Deploying a demo does
not authorize paid browser launch. Keep Browserbase secrets server-side in the
runner, never in page data/storage, fixture URLs, screenshots or public logs.
Paid usage for layer 02: **zero Browserbase sessions and zero model calls**.
