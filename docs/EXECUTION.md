# Single-persona execution (layer 03)

This reference covers the typed execution engine, the legacy fixture integration
and layer04b's reusable controlled-site execution. Layer04 integrates it with a separate
[durable worker](WORKER.md), protected demo admission, private artifact mapping
and owner SSE. The standalone layer03 command remains a separate manual ledger.
Arbitrary website execution is disabled (release blocker #8). Passing a public target to the cloud
factory fails before a browser is launched. This is a release blocker, not a
claim that the final product no longer needs authorized arbitrary websites.

## Run the real integration

Use Node 22.18+ and the pinned dependencies. Provision `.env.local` privately as
described in the README. A Browserbase key alone is sufficient; no model-provider
key or generic OpenAI-compatible endpoint is used.

```sh
npm ci
npm run build
npm run start -- --port 4321
# In a second terminal, run ONE selected scenario:
npm run persona:integration -- --confirm-paid --scenario=fixed
npm run persona:integration -- --confirm-paid --scenario=second-coupon
```

Stop the local server after testing. No tunnel or public deployment is necessary:
the remote browser sees `https://fixture.flash-flood.invalid`, whose requests are
fulfilled from the locally built **real Next.js demo** through the trusted
transport. Browserbase never attempts to connect to developer localhost. Only
known demo routes, the bounded cart-summary endpoint and static Next assets are
served; `/api/v1`, `/demo-fixtures`, all other origins, methods and routes are denied.
Trusted setup seeds validated sessionStorage once before handing over to the
persona. The decision prompt does not contain the selected fixture scenario or
the exception signature.

Each command creates one fresh browser with a 240-second remote TTL, at most 14
decisions/actions and 180 seconds of loop time. Persona patience may stop it
earlier. The local harness serializes commands with a private exclusive lock and
caps its **lifetime conservative reservations at 1,800 seconds** per data
directory, without refunding failed launches. Do not delete the ledger to evade
the cap. A crash leaves a stale lock: reconcile recorded sessions in Browserbase
before an operator removes that specific lock. This is intentionally not
layer04's durable, multi-process project spending authorization.

SIGINT/SIGTERM cancels the active loop and releases the browser. Stagehand's
startup factory has its own 60-second initialization deadline; an abort during
launch is acted on when that factory returns, before navigation/model work.
If launch rejects without returning an ID, cleanup is **unconfirmed**, not
reported as closed. Remote TTL and later metadata reconciliation are backstops.
Private session hooks have a five-second bound; malformed criteria/viewports
are rejected before launch. Browser operations in progress may already have
dispatched before cancellation, but no newly validated action is dispatched
after the abort/closed guard observes it.
The manual Actions workflow runs only by explicit confirmation on `main`, with
one chosen scenario and no artifact uploads. Ordinary CI is offline.

## Next-layer API

`src/server/execution/types.ts` defines the contracts; `loop.ts` exports:

```ts
executePersona(
  { persona, goal, criteria, limits, signal },
  { driver, brain, onEvent }
): Promise<ExecutionResult>
```

`BrowserDriver` implements `observe(signal)`, `act(action, signal)` and an
idempotent `close()` cleanup fence. `Brain.decide(input, signal)` supplies one
strict-schema decision. The brain cannot supply code or replace policy or
criterion verifiers. `onEvent(event, signal)` is awaited and receives `started`,
`observation`, `decision`, `action`, `finished` events, all with actor `agent`.
These are internal execution events, not directly browser-safe payloads.
Layer04 persists fenced observation/decision/action evidence and bounded canonical
events, and acquires/fences jobs and money before calling the factory.

`createFixtureExecution(config, options)` in `cloud.ts` returns `{driver, brain,
usage}`. Its options require `mode: "controlled-fixture"`, run/persona IDs,
registered target URL/port, optional trusted store fixture configuration, viewport, criteria, private
artifact sinks, abort signal and a private `onSession` hook. `usage` is populated
during cleanup with Gateway token counters, elapsed time, available remote
browser duration and final remote status. Startup failures throw
`CloudStartupError` with cleanup and usage metadata. SDK live/replay references
belong only in the private hook, never in browser-safe event payloads.
Optional `correlationToken` and synchronous `assertActive` hooks let the worker
tag launches and fence dispatch at the actual driver guard. Unsupported/duplicate
legacy fixture criteria fail before launch; custom criteria require the explicit
registered-site mode described below. Context reference and human actor seams reject unsupported use rather than
pretending reuse/takeover is implemented.
Layer04 uses explicit no-retry session allocation plus connection rather than
the SDK launch convenience function. Its optional `cleanupJson` hook persists
teardown telemetry after cancellation without relaxing lease fencing. Existing
Gateway RPCs drain before metrics/SDK teardown; errors remain fixed-code
diagnostics and failures, not clean cancellation. See [the worker runbook](WORKER.md)
for the pinned extension archive dependency and the complete live acceptance ledger.

`ExecutionResult` contains canonical terminal status, reason, criterion checks,
step/model counts, elapsed time, cleanup outcome and the original terminal
outcome if cleanup/reporting forced infrastructure failure. A `done` decision
cannot prove success. Only complete trusted criterion checks with observed
evidence can. HTTP 4xx and generic page errors are signals, not automatically
confirmed bugs. The demo verifier checks visible applied coupons and the
displayed total; only the exact planted coupon exception becomes a confirmed
functional-failure signal. Unsupported criteria cannot become successful.
Milestone checks are omitted on unrelated routes, preserving earlier observed
achievement; a negative check on its relevant route still invalidates that
milestone. This permits a coupon objective followed by demo-order completion.
The **returned result is authoritative**: if the `finished` hook itself rejects
or times out, that result becomes an infrastructure failure even if a previously
emitted event contained success. Layer04 must finalize durable state from the
returned result, not from the `finished` event alone.

### General criteria and the inference budget

`ScopedBrowserDriver` receives an explicit navigation scope, artifact sinks,
transport errors, cleanup/lease guards and optional trusted verifier/setup.
The immutable controlled-site registry and transport choose origins/routes;
the driver does not guess a site from the objective. `FixtureDriver` remains a
compatibility wrapper around that same driver, and `demoVerifier` is only the
legacy deterministic oracle. `createControlledExecution` uses the same cloud
factory/fences with an explicit registry selection and no board fixture seed.

`src/lib/criteria.ts` defines bounded literal URL/text/control assertions and
explicit semantic criteria. The loop evaluates structural assertions without
inference and invokes `brain.evaluate` (or an injected evaluator) only for
relevant semantic criteria. `GatewayBrain` uses the same supported Stagehand
`extract` path as decisions, not a second provider API. A strict response schema
and server validation check criterion identity, observation ID, exact page URL,
step, screenshot key when supplied, and verbatim nonempty excerpts in the
bounded observed text. After validation, the server attaches the current
observation's screenshot reference even when the model omitted it; this links
evidence, not a claim that Stagehand used that exact independently captured image.
Unknown/duplicate/forged citations and ambiguous verdicts
cannot become success. Provenance checks do not prove semantic entailment.

The Gateway wire schema deliberately represents a citation's `pageUrl` as a
bounded plain string. Stagehand 4.1.0's extraction service rewrites URL-formatted
schema fields into DOM-link IDs and injects linked destinations afterward;
that behavior is appropriate for extracting links, not copying a provenance
URL. The server still validates a real URL and exact equality to the observed
page using the canonical local citation schema. This is a wire compatibility
choice, not weaker admission or citation policy. The JSON-schema round-trip and
invalid-local-URL regressions protect this distinction.

Every initiated application decision/evaluation is charged before dispatch to
one `ModelBudget`. Failed calls consume their charge; a trusted adapter that
initiates a retry must charge `retry` before dispatch. There are no automatic
application retries. Unmarked injected adapters consume one call per invocation;
an adapter marked `managesModelBudget` is trusted server code responsible for
charging each initiated inference. Neither page text nor a persona can set it.
The loop closes the shared budget at cancellation/termination. Gateway cleanup
drains both decision and evaluation RPCs before metrics/SDK teardown.

Initial success can require zero browser actions, while a semantic evaluation
still consumes a model call. Structural verification after the last allowed
action is free; semantic verification must fit the **same** remaining budget.
If it cannot, the outcome is limit reached, not uncharged success. Results and
owner summaries expose operation counts; Gateway token counters may omit failed
calls and provider-internal retries are outside the application counter.
The recorded metrics are not a price estimate or invoice.

Gateway semantic verdicts are deliberately re-evaluated rather than cached.
The SDK supplies its own DOM representation and captures its own screenshot;
matching bounded text, URL, candidates, or even a separately captured artifact
digest cannot establish that those model inputs are unchanged. This includes
adapters without a screenshot artifact key: `screenshot:true` still supplies
visual input. Structural checks are deterministic and call-free on the current
observation. Semantic caching is deferred until complete input identity can be
proven, rather than reusing stale UI judgments to save calls.

Observation events contain the current evaluation verdicts/citations, including
negative and inconclusive results. Terminal milestone accumulation is separate:
an unrelated-page observation can be unobservable while an earlier verified
milestone remains met. A relevant contradiction or inconclusive result invalidates
that milestone. A current-condition criterion never inherits old success on an
unrelated page. A model cannot declare a relevant page unrelated to preserve a
milestone. Plain non-legacy strings default to current-page semantic conditions.

`ArtifactWriter.createSinks(runId, attemptId)` writes immutable generated keys
under the private data directory. The current CLI persists events/evidence and
session/accounting manifests there; it does not mutate queued repository jobs.
Layer04 maps keys to owner-scoped repository evidence and reserves before
launch. Layer06 deterministically classifies/groups those persisted records;
see [REPORTS.md](REPORTS.md). Execution itself makes no grouped-bug or globally
shortest reproduction claims.

## Perception and behavior

Gateway decisions use the supported Stagehand v4
`extract(prompt, decisionSchema, {page, screenshot: true, timeout: 25000})`.
Stagehand supplies its **DOM representation plus a screenshot**. The prompt
also contains driver-measured viewport-intersecting candidates, bounded visible
text, immutable persona/objective/criteria and recent decisions. The screenshot
is viewport-sized, but Stagehand's DOM input can include offscreen information:
**this is not screenshot-only or strictly human-visible perception**.
Actions are restricted to current measured candidates and known navigation.
Screenshots are captured independently as evidence, never used alone as success.

The pinned 4.1.0 SDK also exposes `locator` and `ignoreLocators` for extraction.
Its shipped option descriptions say these scope/exclude elements and subtrees;
`screenshot:true` adds a viewport screenshot. Inspection of the client schema
and serialization confirms these options exist, but does **not** establish that
excluding `html`/`body` produces a usable screenshot-only prompt on the hosted
Gateway. This layer does not enable root exclusion or claim strict viewport
perception. Grounded action candidates and server-checked semantic citations
remain necessary even when the model receives additional DOM context.

Each observation records a state digest, bounded text, grounded candidate IDs,
criterion checks, telemetry signals and a private screenshot key. Patience,
step/model/time ceilings and repeated state/action detection bound the loop.
Skim/careful profiles use different bounded delays; this is modest behavioral
variation, not a claim to accurately simulate people. A phone is a viewport,
not a mobile device emulator. Keyboard-only policy disables pointer actions;
there is no fabricated slow-network persona capability.

Supported adapter actions: click, fill/type, select, scoped navigation, back,
bounded scrolling, a small keyboard allowlist and wait. Dialogs are dismissed,
new tabs/popups are denied, and only the main frame is supported. Downloads are
cancelled; uploads, clipboard, context reuse, human control and throttling are
unsupported. CDP diagnostics expose only selected numeric performance counters,
not arbitrary CDP or browser evaluation tools to the model.

## Network boundary and release limitation

`fixture-network.ts` is a transport for **our trusted fixture code**, not a
general hostile-site browser sandbox:

- Context-wide interception fulfills every allowed page request. It never
  continues page traffic to browser DNS/network; unknown requests abort.
  The server-side fixture client connects only to literal `127.0.0.1` at a
  trusted operator-supplied port. It forwards no browser headers/cookies/body,
  follows no redirects and bounds response bytes/time.
- Documents are limited to the primary tab/main frame. Additional pages,
  frame documents, arbitrary hosts/paths, POSTs and redirects are denied.
  CSP denies frames, workers, objects, forms and external connections.
  Init scripts explicitly disable workers, service-worker registration,
  WebTransport, WebRTC and `window.open`; WebSockets are intercepted/closed.
  Unexpected worker creation closes the page and fails execution.
- Stagehand v4 actually sends Gateway requests from its installed browser
  extension. The sole control-plane exception requires the **CDP-derived
  launched extension origin** and known extension worker/offscreen path, exact
  Gateway URL and POST. Page/frame/worker URLs, headers and referrers cannot
  grant it. A missing initiator is denied. The Gateway request is fetched with
  zero redirects/retries and fulfilled; page requests to the identical endpoint
  remain blocked. SDK example trace destinations remain blocked.

Why not enable arbitrary sites with this? JavaScript API replacements and CSP
are defense in depth, not a independently verified browser-process egress
firewall. Arbitrary content can open new execution targets; Chromium channels
such as WebRTC, speculative connections, workers and redirects require a
stronger end-to-end proof. Browserbase domain restrictions cover main-frame
navigation only. Admission DNS checks followed by `route.continue()` are
insufficient for DNS rebinding and must not replace this gate.

The next release requirement is a proven provider-enforced egress policy or
mandatory authenticated proxy/firewall covering **all** browser connections,
with public-IP pinning per connection, redirects revalidated, scope checked
for every request and unsupported channels denied outside page JavaScript.
A server-side pinned HTTP(S) fulfillment client is a useful component but does
not by itself prove every browser channel is intercepted. Existing
`target-policy.ts` defaults are unchanged.

### Concrete #8 deployment handoff

Browserbase documents a dedicated browser VM, isolated subnet and firewalls
against lateral movement ([security architecture](https://docs.browserbase.com/account/enterprise/security.md)).
That is useful existing protection, but the inspected documentation does not
state the exact private/loopback/link-local/metadata denylist or no-bypass
coverage needed here. Do not infer that the protection is absent or that it is
an Enterprise-only feature; obtain the precise account/region guarantee.

`proxies` defaults to false. `proxies: true` enables managed residential routing
with provider-specific acceptable-use restrictions, **not a documented private
destination isolation contract**. A feasible next implementation is one
catch-all authenticated external HTTP(S) proxy, omitting `domainPattern` and
providing no `none`/direct-fallback rule. Browserbase checks proxy connectivity
at creation, but runtime outage behavior and non-HTTP channel coverage still
need confirmation. Custom proxies are documented for Developer plans and above;
the published Developer base price is $20/month. The gateway must be publicly
reachable or reachable through a tunnel; SOCKS5 is unsupported. Optional TLS
inspection uses uploaded CA certificates and `proxySettings.caCertificates`,
not disabled certificate verification.
Sources: [proxy support](https://docs.browserbase.com/platform/identity/proxies.md),
[deployment requirements](https://docs.browserbase.com/platform/browser/security/ip-allowlisting.md),
[plans](https://docs.browserbase.com/account/billing/plans.md).

The focused follow-up can implement in this repo: a proxy that authorizes each
HTTP/CONNECT destination, validates all DNS answers, pins the actual socket,
preserves TLS SNI/certificate validation, rejects special-use IPs/ports, bounds
connections/bytes/time, and tests private addresses, rebinding and redirects.
The external dependency is a reachable authenticated gateway deployment and a
provider-confirmed/configured no-direct-egress policy covering worker traffic,
WebSockets, WebRTC/UDP, loopback and metadata targets, DNS/prefetch/preconnect,
and runtime proxy outage. Preserve the tested narrow Stagehand control plane.
If Browserbase cannot provide the necessary enforcement, a controlled Chromium
host with an outbound firewall is the fallback; compatibility with the
Browserbase-hosted one-key Gateway would then need a separate product decision.

A destination-only CONNECT gateway can preserve native HTTPS redirects and
browser origin semantics, but cannot inspect encrypted paths/methods. Therefore
full per-request path/method policy requires TLS inspection or a separate
verified interception layer; it is not satisfied by CONNECT admission alone.
Hosting, bandwidth and any account upgrade are additional costs; no deployment
quote or provider guarantee was obtained, so only the published base-plan cost
is known. Implement and test the transport first, then use a separately capped
provider integration to prove the network configuration rather than repeating
open-ended browser experiments.

Specific SDK evidence rules out treating Playwright as that firewall:
v1.58.2 [continues redirected requests without another route callback](https://github.com/microsoft/playwright/blob/v1.58.2/packages/playwright-core/src/server/chromium/crNetworkManager.ts#L336-L350),
and contains continuation paths for
[missing network IDs](https://github.com/microsoft/playwright/blob/v1.58.2/packages/playwright-core/src/server/chromium/crNetworkManager.ts#L240-L245)
and [unassociated frames](https://github.com/microsoft/playwright/blob/v1.58.2/packages/playwright-core/src/server/chromium/crNetworkManager.ts#L329-L333).
These are architectural limits, not a claim of a reproduced bypass against this
trusted fixture. The existing CDP default context cannot be configured with
`serviceWorkers: "block"` via `connectOverCDP`; worker registration shims and
WebSocket routing are JavaScript-level controls. Browserbase's
[domain restriction](https://docs.browserbase.com/platform/browser/security/allowed-domains.md)
does not cover resources/subframes. #8 remains open until the external guarantee
and deterministic network acceptance tests establish a real public-URL path.

## Evidence privacy and diagnostics

Private directories/files require modes 700/600; opaque storage keys are
generated, not page/file paths. Screenshots are limited to 2 MiB, JSON to 128 KiB,
each attempt to 128 files/32 MiB. Artifact writes are exclusive, budget-checked,
and symlinks/unsafe existing permissions are rejected. Same-UID hostile file
replacement is outside this single-host storage trust boundary.

Console/page errors, request failures, HTTP errors and slow requests have fixed
diagnostic codes, timestamps, page/action identity and bounded metadata. Raw
console arguments, stacks, request/response bodies, cookies and auth headers
are not emitted. URLs are stripped/redacted. Screenshots and arbitrary unknown
secrets in page prose cannot be comprehensively redacted; the shipped path
therefore accepts only synthetic fixtures. Live/replay links stay in private
manifests. Cleanup failure is infrastructure failure even after objective success.

## Recorded live acceptance (2026-09-19)

All seven sessions were verified remotely `COMPLETED`; no remote browser, tunnel
or fixture server was left running. Evidence, screenshots, session IDs and
access-bearing references remain in the private data directory, not this repo.

| Attempt | Observed outcome | Actual browser seconds |
| --- | --- | --- |
| Three initial Gateway probes | Two rejected control-plane requests, then grounded structured decision and observed destination | 38.424 combined |
| First fixed journey | Criterion proved after seven actions; cleanup failure correctly overrode success | 79.427 |
| First broken journey | Gateway transport failure on decision four; infrastructure failure, clean release | 72.198 |
| Fixed acceptance | `succeeded`, both applied coupons and CA$21.60 visibly checked, seven actions/decisions, clean release | 78.576 |
| Broken acceptance | `target_failed`, planted second-coupon exception observed after seven actions/decisions, clean release | 81.615 |

Total: **350.240 actual browser seconds** (5.84 minutes), with **1,320 seconds
conservatively reserved** including failed attempts, below the layer's
60-browser-minute authorization. Available metrics totaled 132,609 prompt and
7,645 completion tokens. Metrics for failed calls/probes may be unavailable;
these numbers are not a provider invoice or a claim those failures cost zero.
There were no automatic paid retries. The final proof used one concurrent
browser and the same persona goal for both scenarios, without revealing the
planted scenario to the persona.

An independent correctness review identified and prompted regression fixes for
actual `tsx` callback serialization, late action dispatch after abort, reverse
coupon order, keyboard-focus stall detection and ignored wait duration. Startup
and cleanup failures remain observable; stopping the sole page before disposing
Stagehand was rejected after a real cleanup failure. The driver instead fences
future dispatch immediately, checks abort after asynchronous eligibility work,
and awaits both SDK/session cleanup before returning.

Final offline gates: **773 unit/API tests**, lint/types, production build,
built-app HTTP smoke and **38 Chromium E2E tests**, including the actual `tsx`
CLI loader and real network-listener negative tests. No paid credentials are
required for these checks.
Vitest files run sequentially so real SQLite and artifact `fsync` stress tests
do not compete for disk throughput on small CI runners; explicit within-test
concurrency remains covered. The CLI-loader browser regression waits for the
actual hydrated fixture control, rather than treating document load as React
readiness. A real driver/verifier/loop E2E proves coupon milestones survive the
subsequent checkout and completion routes.

## Layer04b acceptance and next-layer boundary

Issue #11 / PR #17 extends the merged worker in PR #15; #8 remains open.

The final layer04b gates pass **1,290 unit/API tests and 48 Chromium E2E tests**,
plus lint/types, production build and built-app HTTP/SSE smoke. Both registered
sites have real driver/loop/durable-worker regressions with custom personas and
novel criteria. Hidden, transparent, clipped and offscreen text cannot become
visible-text or semantic citation evidence; exact text preserves inline pieces
and rendered line breaks. Partial controls remain action candidates only when
their measured visible region intersects the viewport.

The capped real Gateway/worker proof on the second site succeeded in four
actions and six application model calls, including two semantic evaluations.
Its known empty list produced a grounded negative; its saved project produced
a grounded positive that also passed an independent exact fixture oracle.
An earlier rejected attempt exposed the SDK URL-field transform and incorrect
verification-failure taxonomy; both were fixed offline before the corrective
paid attempt. The complete two-session ledger, token limitations and remote
cleanup evidence are documented in [WORKER.md](WORKER.md#layer04b-live-ledger).

UI05 can now use the canonical examples in [API.md](API.md), select a registered
site explicitly, and show immutable criteria, five-way verdicts, method,
heuristic confidence, owner evidence references and operation counts. It must
not present ordinary public URLs as executable, semantic judgments as
deterministic proof, the dashboard preview as a live wall, or disabled browser
capabilities as implemented. Layer06 reports preserve these distinctions;
takeover/context/reproduction features remain later layers.
