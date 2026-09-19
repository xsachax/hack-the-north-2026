# Single-persona execution (layer 03)

This reference covers the typed execution engine, the legacy fixture integration
and layer04b's reusable controlled-site execution. Layer04 integrates it with a separate
[durable worker](WORKER.md), protected demo admission, private artifact mapping
and owner SSE. The standalone layer03 command remains a separate manual ledger.
Public website admission is **hard-disabled in this offline checkpoint** (release
blocker #8), even with `ENABLE_PUBLIC_RUNS=true`. The source-level
`PUBLIC_EXECUTION_IMPLEMENTATION_READY=false` stop applies to API admission,
worker execution and both direct public/native factories. Paid public CLI modes
reject before provider operations; there is no approval-file or environment
override. The legacy controlled factory rejects public targets. This is a release blocker, not a
claim that the final product no longer needs authorized arbitrary websites.

## Offline checkpoint and deferred public execution

The user requested a mergeable checkpoint followed by a new public-browser plan.
This preserves implemented immutable admission contracts, historical idempotency,
resource journals, native composition, scoped CDP routing, bounded HTTP/Gateway
transports, source binding and offline regression coverage. Controlled execution
remains available under its existing gates. Public activation is not part of this
checkpoint, and #1, #8 and #16 remain open.

Native factory lifecycle code is an **unreachable prototype**, not approved hosted
cleanup: pinned Stagehand 4.1's branded browser `close()` can issue independently
retried provider releases, including late connection results. Do not enable it.
The separate metadata-only loopback adapter and SDK transport monitor are offline
prototypes and are not wired into that factory. A successful SDK extraction test
with synthetic Gateway responses does not establish production WSS startup,
failure cleanup or a genuine external objective.

Actual Linux diagnostics measured stopped-trace completion at 5.018–5.145 seconds,
after the former generic three-second wait had already failed. Trace completion
now has a dedicated 7.5-second budget; ordinary CDP commands retain their
three-second bound, and the longer wait checks cancellation/lease validity every
25 ms. Refusal/TCP evidence, data-loss rejection and byte/event limits are
unchanged; no retry is added. Refusal acquisition closes its finished owned probe
before ending the trace and rejects unexpected early completion. Diagnostics
retain only constant phase/reason codes, never raw NetLog.

Local composed probes have also exhibited native-worker CDP readiness timeouts
and a strict trace-format rejection whose causes remain unresolved. Offline
results are not hosted startup-reliability proof. Native-only channel tests now
require a single owned-sentinel refusal before starting the negative lane:
`chrome.proxy.settings.set()` completion alone is not a network-service barrier.

Deferred work includes a reviewed supported SDK connection/termination lifecycle,
settlement of inner HTTP retries before recycling metadata ports, actual hosted
version/profile/native-policy conformance, and a separately approved external-goal
proof with independently verified accounting and closure. Timer expiry is never
retirement evidence. No provider reads, uploads, allocations or model calls were
authorized by this checkpoint. A new plan and source changes are required before
reconsidering public activation.

## Public HTTP transport library (offline, not enabled)

`src/server/execution/public-transport.ts` is a **server-only** component used by
the combined factory's direct CDP interception adapter. The library itself does
not allocate resources, enable admission or alter controlled-fixture transport.
Public admission remains blocked pending combined verification. Interception
provides functionality, **not the security boundary**: the separately attested
native policy blocks missed requests and direct fallback. Combined real
browser/transport evidence is still required for #8; library tests do not close it.

`createPublicTransport({authorize, authorizeBrowserHeaders?, assertActive, signal,
limits})` creates exactly one bounded instance per trusted job/lease. It returns
`request({url, method, kind, headers?, body?, signal?})`, `drain()` and terminal,
idempotent `close()`. Configuration/function references are captured at creation;
request fields are copied before the first await. The caller must retain an
immutable owner/job scope in its synchronous `authorize` predicate, not use a
page-provided allow flag. The frozen context contains canonical `url`, `method`,
`kind: "navigation" | "asset"` and, when validating a redirect, `redirectFrom`.
The trusted interception layer supplies `kind`. Navigation/path grants and asset
grants must be explicit and distinct: permission to navigate one origin/path does
not authorize arbitrary cross-origin resources. Reuse the existing scope
normalization rules; neither a boolean returned by a page nor DNS admission is
request authorization. This API must never be exposed as a general-purpose proxy.

Initial HTTP/1.1 support is **bodyless GET, HEAD and OPTIONS**. A supplied body
(even empty), writes, CONNECT, WebSockets/upgrades, streaming responses, interim
responses, trailers and nonstandard redirect statuses are unsupported and fail
with fixed `PublicTransportError.code` values. Header inputs are untrusted
`readonly [name, value][]`, not an application request's headers. Only `Accept`,
`Accept-Language`, `Cache-Control`, `If-None-Match` and `If-Modified-Since` are
allowed by default. Identity encoding is generated by the transport; compressed
responses fail, never decode without limits or masquerade as decoded bytes.
Names/values, duplicate fields, controls and size are checked before dispatch.
Host/authority, caller Content-Length/Transfer-Encoding, hop-by-hop/proxy headers,
provider/API-key headers and every unknown request header are always rejected.
There is no environment proxy, credential injection, application cookie copying,
cookie jar, ordinary fetch, fallback or automatic retry.

Origin, Referer, Cookie and Authorization require an explicit
`authorizeBrowserHeaders(context, frozenHeaderTuples)` callback returning exactly
`true`. Without it, these inputs **fail**, rather than silently disappear and
change CORS/auth semantics. Origin must be a canonical HTTP(S) origin (opaque
`null` is currently unsupported); Referer must pass strict URL validation without
userinfo or fragment. The callback must attest that values came from the
intercepted browser target request, not the owner app/provider/server environment,
and that cookies/auth belong to this exact destination and browser context.
It is called again after DNS immediately before dispatch. A consumer needing
anonymous target cookies or CORS must implement this narrow provenance policy;
the default credential-free subset is not faithful arbitrary-site replay.
Request preflight-specific headers and more HTTP methods remain unsupported.

Every new connection independently resolves **both A and AAAA** with a cancellable,
bounded Node resolver; an empty/oversized/malformed/mixed public/private answer set
fails closed. A missing family may return ENODATA, not an ignored resolver failure.
The shared `public-address.ts` classification is identical to target admission,
including Azure platform metadata, reserved IPv4, mapped/NAT64/6to4/protocol IPv6.
The library never accepts admission's development-localhost exception, even in
development. Only canonical default HTTP(S) ports and unambiguous authority/path
encodings are supported; valid query order, duplicates and escaped bytes are
preserved. One checked IP is pinned to the actual Node lookup callback (or literal
destination), with its family, `autoSelectFamily:false` and `agent:false`.
There is no second resolver or pooled connection. HTTPS retains the original
hostname for SNI and certificate identity; verification is explicitly on, including
for IP SANs. IP identities use OpenSSL-backed `X509Certificate.checkIP` on the
peer's raw certificate (never DNS CN fallback); DNS names use Node's standard
identity matcher. This avoids Node 22.23's legacy matcher passing bare IPv6
through DNS-only IDNA conversion. CA-chain verification remains enabled.
Certificate failures do not trigger another address or downgrade.

Responses contain the original request `url`, actual `status`, a `Buffer` body,
and frozen header tuples preserving repeated Set-Cookie, MIME, CSP, CORS and other
end-to-end restrictions. A consumer must use fulfillment capable of preserving
duplicates; never flatten Set-Cookie to a comma-delimited map or invent permissive
CORS/CSP. Chunk framing is removed by Node, hop-by-hop/framing fields are removed,
and Content-Length reflects the complete identity bytes. HEAD/204/205/304 bodies
are empty and omit fulfillment Content-Length. Truncation, conflicting framing,
oversized headers/body and unsupported encoding are errors, not partial success.
Response headers/body may themselves contain sensitive target data; do not log them.

301/302/303/307/308 are **not followed**. Before returning one, the library validates
Location's raw authority/path (before normalization), disallows HTTPS downgrade,
checks the destination's caller authorization and resolves/classifies every answer.
`redirectUrl` is the validated next destination; `url` is never relabeled as a
fetched final URL. The original Location and response cookies are preserved for
browser URL/origin/CORS/cookie semantics. The browser must recompute headers and
be intercepted and authorized afresh on **every hop**, including fresh DNS before
its socket. Do not replay prior-hop credentials. A DNS change after the redirect
check cannot authorize the next connection. The separate native deny boundary must
block missed hops; redirect loops exhaust the instance's redirect/request budgets.

All limits are required, positive safe integers, and can only reduce the exported
`PUBLIC_TRANSPORT_LIMITS` ceilings (DNS permits up to 5 seconds):

| Limit | Maximum/default | Accounting |
| --- | --- | --- |
| Requests / concurrency | 256 / 8 | No queue; denied/failed/concurrency-rejected attempts also spend request count |
| Response body / headers | 4 MiB / 16 KiB | Per response; streamed checks precede retention/concatenation |
| Total bytes | 64 MiB | Aggregate URL + request header fields + each incoming plaintext HTTP socket byte exactly once, before parsing: status/headers, framing, body, trailers and incomplete/rejected data; not TLS/wire billing |
| Redirects | 16 | Aggregate across the instance, not reset by separate chains |
| Total / request duration | 300 / 15 seconds | From instance construction / accepted request, including DNS and redirect checks |
| DNS duration | 2 seconds default, 5 maximum | Both families for each destination; canceled on deadline/close/abort |

The caller must abort the job signal synchronously on lease revocation and call
`close()` during teardown. `assertActive` runs before dispatch, after awaits, in
the socket lookup/connect/read callbacks and on a 25 ms stalled-work watchdog.
Signals stop work immediately when observed; the watchdog is not a substitute for
delivering revocation. There is no undo of bytes already dispatched. Request aborts
and request timeouts cancel only that operation; job abort, close, lease loss,
duration and aggregate-byte exhaustion fence the entire instance. `close()` drains
in-flight DNS/socket operations; late callbacks cannot open a connection.
`drain()` waits for the current snapshot without closing or granting more work.
Errors contain only fixed codes, never URLs, DNS details, cookies, authorization,
bodies or exception causes; HTTP error statuses remain actual responses.
Standalone trusted Node consumers must use `--conditions=react-server` for the
standard `server-only` import guard (Next supplies its server resolution itself).
That module-loading condition grants no network or job authorization.

The default offline Vitest suite exercises stateful public-to-private DNS in one
process, all-answer/family rejection, actual Node lookup callback invocation,
owned HTTP/TLS listeners, SNI/certificate rejection, per-hop redirects, credentials,
framing, concurrent budgets and cancellation/late callbacks. Its socket mapping
exists **only in tests** to reach owned loopback listeners; it is not evidence that
a production socket connected to a real public IP, or that native browser egress
is enforced. No provider resources or external targets are used.

A separate [Linux namespace gate](CI.md#public-transport-namespace-acceptance)
runs the production library with **no DNS or socket mocks**. It uses the merged
native-policy launcher's verified private namespace, with synthetic public IPv4/
IPv6 aliases, reachable private/link-local/IPv6 positive controls, and owned
TTL-zero DNS. An answer flips from public to private between resolution and the
first socket; that socket must still reach its pinned public alias, and a second
request on the same transport must reject the changed answer without another
connection. The gate also exercises mixed answers, private redirects, read
cancellation, and actual TLS/SNI/IP SAN success and certificate rejection using
an ephemeral owned CA in a fresh Node child. This is real socket evidence in an
isolated synthetic network, **not external public connectivity, a browser
interception integration or a provider proof**.

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
registered-site mode described below. Context provider references are resolved
privately by the durable worker from explicit owner/scope selections; callers
cannot submit remote IDs. The loop accepts a durable execution-control adapter
for acknowledged takeover, drains in-flight inference, discards stale decisions
while charging attempts, and reobserves on handback. See
[advanced workflows](ADVANCED_WORKFLOWS.md) for the managed-control boundary.
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
cancelled; uploads, clipboard and throttling are unsupported. The low-level
driver does not manage contexts or human control; the durable worker separately
provides explicit contexts and acknowledged takeover as documented in
[advanced workflows](ADVANCED_WORKFLOWS.md). CDP diagnostics expose only selected numeric performance counters,
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

The next release requirement is a proven provider-enforced egress policy,
mandatory authenticated proxy/firewall, or independently proved native browser
policy covering **all supported** browser connections,
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

### Layer08 prerequisite refresh (2026-09-19)

Re-read the official [security architecture](https://docs.browserbase.com/account/enterprise/security.md),
[proxy configuration](https://docs.browserbase.com/platform/identity/proxies.md)
and [allowed domains](https://docs.browserbase.com/platform/browser/security/allowed-domains.md)
for release hardening. The documented contracts above are unchanged:
per-browser VM/subnet and lateral-movement firewalls, custom HTTP(S) proxy
credentials and optional trusted CAs, creation-time connectivity validation,
and top-frame-only domain restrictions. They do not establish the required
account/region-specific destination policy or all-channel no-bypass guarantee.
No hostile public-site probe, proxy deployment or account purchase was made.
The supplied application credentials do not supply external gateway hosting
or authorize guessing provider firewall behavior.

The minimal provider/operator decision before implementing public execution is:

| Required input | Evidence needed before enabling #8 |
| --- | --- |
| Provider-enforced policy, or mandatory external gateway | Exact account/region feature/configuration and a documented way to prevent direct connections; a proxy preference alone is insufficient |
| Private-destination enforcement | Deny loopback, private, link-local/metadata, reserved and non-global IPv4/IPv6 at connection time; validate all DNS answers and pin the actual socket so rebinding cannot change the destination |
| All channels and failures | Cover redirects, frames, subresources, workers/service workers, WebSockets, WebRTC/UDP, DNS/speculative connections and proxy outage; unsupported channels must be disabled below page JavaScript with no direct fallback |
| Reachable gateway, if required | Operator-approved hosting/account, authenticated endpoint, TLS and credential delivery, resource/bandwidth limits, maintenance and cost authorization; none is supplied by this repository |
| Trusted control plane | Keep Browserbase/Stagehand credentials and the narrowly authenticated extension connection unavailable to page content; no page-accessible bypass host |
| Acceptance environment | Authorized public target plus controlled forbidden-destination listeners and deterministic redirect/rebinding/non-document negative tests; prove listeners see no connections, not merely an error label |

**Separate application scope requirement:** HTTPS CONNECT protects destination
admission but cannot inspect encrypted paths or methods. Exact path/method scope
needs verified browser interception or TLS inspection with operator-approved CA
handling. TLS inspection is not inherently required to deny private destinations;
it is one possible additional path-policy mechanism, not a substitute for
mandatory all-channel egress enforcement. Do not disable certificate validation.
If no provider-supported no-bypass configuration exists, changing browser hosting
and one-key Gateway compatibility is a product/infrastructure decision, not an
unsafe opt-out. Until these inputs and real positive/negative proofs exist,
`websiteExecutionEnabled` remains false and #1/#8 remain open.

### Native browser policy candidate (offline Phase A)

#### Composed extension and trusted bootstrap

The offline integration adds `composed-extension.ts`, `native-browser.ts`,
`native-policy-session.ts`, `native-proxy-attestation.ts` and
`native-resources.ts`. These are not public API admission or hosted acceptance.
The maintained public integration CLI accepts only offline modes. Its
`--offline-preflight` checks a clean verified deployment package;
`--offline-native-probe` executes the actual TSX entry path with a local composed
browser, real SDK initialization, native attestation and read-only driver/CDP
mechanics against explicitly synthetic owned responses. It uses no provider
configuration or inference and is not public-site acceptance. Paid modes fail
before allocation.

The deployable package source fingerprint is not the proof-harness fingerprint:
release packaging intentionally omits manual integration scripts and test sources.
The separate `publicHarnessDigest` binds the existing whole-source advanced
digest plus native/public browser runner configurations and the five public
execution contracts. Any paid approval must bind both digests, the package and
composed archive digests, and the persistent ledger digest. Changing a CLI,
test/configuration, policy byte or contract invalidates that approval even if
`BUILD_ID` is unchanged.

The composer accepts only the audited Stagehand 4.1.0 archive with SHA-256
`8efc7d171a625cca95c02d02d369b59435fae776cae6c7dd2f6fe72eb19785c0`.
It bounds archive/expanded bytes, accepts the exact eight vendor entries and
manifest, and retains every vendor script byte. The root `service-worker.js`
gets one static side-effect import; its registered URL and existing Gateway
initiator identity do not change. Only `proxy` and `privacy` permissions are
added. The deterministic ZIP includes the vendor MIT license, the native module,
and input-digest provenance. There is no new page messaging, content script,
web-accessible resource, generic privileged fetch bridge, or committed vendor
archive. The vendor's existing isolated-world locator script is unchanged.

Native activation is a debugger-only operation after Stagehand's trusted
initialization. Only fresh blank/trusted extension contexts are admitted.
Returning contexts, restored tabs and persistent service workers cannot enter
this bootstrap. Before untrusted navigation or live-view publication, the
adapter verifies actual installed extension file digests, the exact measured
Chromium version, effective proxy/privacy values and control ownership, and
the actual profile's empty WebRTC per-origin override list. Unknown versions,
shapes, conflicts, restart/lost-worker state and drift fail closed. No code
clears or restores the policy while a remote browser may remain alive.

Native control uses an owned raw CDP target session for the original registered
worker, not Playwright worker-list membership as readiness. It acknowledges only
that session's startup wait with `Runtime.runIfWaitingForDebugger` after
`Runtime.enable`; this is not `Debugger.resume` and does not stop another
debugger or trace. Fresh-worker diagnostics established that a `starting/new`
worker can answer primitive evaluations while extension bindings are unavailable.
Admission therefore requires the actual matching target, worker-origin execution
context, unique context identity, extension runtime ID, initialized SDK/native
objects and installed-byte proofs. A bounded, pure binding-readiness query precedes
the full location/runtime identity guard; invoking native getters before that
readiness point can itself stall startup. Lost/replaced contexts latch failure. Only
fixed programs and JSON-encoded trusted inputs cross this control surface.
File URLs are resolved against the verified native target URL, not a page value.

Proxy refusal is not inferred merely from `ERR_PROXY_CONNECTION_FAILED`.
A short **caller-owned** CDP NetLog trace must also contain complete paired
`TCP_CONNECT` and `TCP_CONNECT_ATTEMPT` records for exactly
`127.0.0.1:65534`, Chromium `net_error=-102`, and measured Darwin/Linux
`ECONNREFUSED` values. Success, reset, timeout, other addresses, missing records,
unknown shape and truncated/lost trace data reject admission. An already
running provider trace is not stopped: conflicting tracing fails startup.
Raw trace bytes are bounded to 1 MiB, processed only in memory and discarded;
only a constant verdict may be retained. This proves an observed refusal,
not that a trusted host can never open that port later. Host/profile stability
for the session remains an explicit trust assumption. No direct private-port
scan or provider-internal destination probe is performed.

The native resource lifecycle requires a synchronous durable journal before
upload/allocation. It records archive identity, known extension/session IDs,
unknown upload outcomes and late callbacks. Upload/session creation is never
automatically retried. Cleanup drains Gateway work and reads metrics, requests
remote release while attachments and policy remain installed, and checks the
exact correlated session. An extension may be deleted after matching `COMPLETED`
readback, or trusted proof no session allocation was dispatched. Operational
retirement also permits `ERROR`/`TIMED_OUT` only when two independent reads match
the exact session, project, correlation token, terminal status, start and end
timestamps; valid timestamps must satisfy start <= end <= now. This follows the
provider's [session termination contract](https://docs.browserbase.com/platform/browser/getting-started/manage-browser-session)
and terminal states used by worker accounting. These outcomes remain failed:
they never become clean `COMPLETED` live acceptance. Missing, conflicting or
unknown closure proof quarantines the extension. Deletion itself requires
authenticated exact-ID not-found confirmation.

The absolute execution deadline starts immediately before session-create
dispatch, not after native bootstrap. It reserves 80 seconds before the provider
TTL for the bounded Gateway drain, metrics, release and readback path. The worker
must reduce its loop duration to the remaining absolute deadline. Public native
sessions with TTL <=80 seconds are rejected before any provider operation;
TTL remains capped at 300 seconds. No browser retry renews the budget.

This composition does not remove any remaining remote-policy, broker,
end-to-end public-objective or accounting proof requirement below.

The independent read-only driver option permits scoped link following, navigation,
back, scrolling and bounded waits. It rejects button/input/select/key actions,
downloads and new-tab links before dispatch, including a previously observed link
replaced with a button. A link `click` action navigates to its freshly validated
captured URL; it does not dispatch a physical click or run page click handlers.
Replacing the element after validation cannot retarget the action. The normal
controlled driver's physical clicks are unchanged. Actual
read-only driver regressions use an explicitly synthetic owned document; they
are not public-site execution evidence. Observations retain real control state:
controls are not falsely marked disabled or removed to force a model verdict.
The Gateway receives the finite action capability in its instructions, while the
driver remains the action guard and criterion/citation rules stay unchanged.

#### Combined HTTP routing surface

`public-cloud.ts` composes the native lifecycle, `public-network.ts`, the real
Node broker and the existing criterion engine. Main-document navigation uses the
immutable origin/subdomain/path scope; `public-http-readonly-v1` separately
permits bounded public HTTP(S) assets, including cross-origin CDNs and paths
outside the document prefix. Child documents do not receive an asset exception.
The supported HTTP verbs are not a guarantee that an arbitrary site's GET
handler is free of application side effects; the owner must authorize the target
and objective.

Direct, owned CDP Fetch target sessions pause and authorize every redirect hop.
No public-page request is continued to the browser's network. Fulfillment
preserves duplicate response headers, cookies, CSP, CORS, original URL and browser
redirect semantics. Header permits bind actual paused browser request provenance
to its exact destination/method/kind, including anonymous site cookies, Origin and
Referer. They never copy application/provider headers or a previous hop's values.
Authorization, unknown custom headers and unsupported preflight fields fail.
The adapter deliberately omits browser UA, enumerated Sec-Fetch/Sec-CH metadata,
priority and Upgrade-Insecure-Requests; metadata-dependent sites are unsupported,
not faithfully replayed. Compression, streaming, frames, workers, popups,
downloads, WebSocket/WebTransport and arbitrary writes remain unsupported.
Native policy, not interception, blocks the missed channels.

The sole trusted Gateway exception uses the actual registered root extension
worker or exact installed offscreen target, fixed HTTPS endpoint and POST. Page
URLs, missing frame identifiers and forged headers never grant it. Full POST
bytes come from the correlated CDP Network request, not potentially truncated
Fetch event data. Actual Chromium fixture regressions hash >512 KiB Unicode DOM
plus base64-screenshot JSON at an owned upstream from both worker and offscreen
targets, preserving body bytes and authorization/content-type headers. These
offline mechanics tests neither contact the provider nor prove remote Gateway
compatibility. Public routing and native failures are unsupported/infrastructure
diagnostics, never confirmed site defects.

An additional actual-SDK offline test connects the pinned Browserbase adapter to
owned Chromium through a synthetic local metadata record, then calls
`Stagehand.extract` against an owned Gateway-response fixture. Both extraction
and auxiliary metadata requests retain the supplied session attribution and
one-key credentials; the first request contains the actual visible heading, and
SDK token metrics include both calls. Replies are synthetic, not paid inference
or public-objective acceptance. Public wire accounting charges every additional
SDK request, including auxiliary metadata calls, against the existing `retry`
budget bucket rather than counting one SDK operation as one inference.

Gateway forwarding uses a fixed-endpoint Node HTTPS streaming transport, never the
public browser's shared cookie jar. It enforces 8 MiB request/4 MiB streamed response,
16 KiB headers, 64 requests, concurrency two, 64 MiB aggregate retained header/body
bytes and 30-second request deadlines, plus job cancellation. It rejects redirects,
compressed responses, interim responses and trailers; it does not retry or use an
environment proxy. Captured browser Cookie/Cookie2 headers are omitted
from this control request; Gateway Set-Cookie is never fulfilled into Chrome.
Public-target response cookies keep their normal browser semantics. Actual
worker/offscreen `credentials: include` regressions prove both directions using
seeded browser cookies and owned upstream Set-Cookie responses. The Browserbase
and Stagehand API control hosts are not public target/asset destinations.

An external hosted proxy is **not assumed to be the only possible solution**.
`src/server/execution/native-policy-extension/` is a maintained, isolated MV3
probe, not a runtime capability or an opt-out from #8. Its native Chrome proxy
settings send HTTP and HTTPS to an intentionally closed loopback endpoint and
set an explicit SOCKS5 fallback for other proxy-supported URL schemes. The only
bypass rule is `<-loopback>`, which subtracts Chromium's implicit localhost and
link-local bypass. There is no `DIRECT`, PAC, system-proxy fallback, page route,
CSP or JavaScript replacement providing this boundary.

Installation reads back **both the exact value and `levelOfControl`** for proxy,
`webRTCIPHandlingPolicy=disable_non_proxied_udp`, and
`networkPredictionEnabled=false`. Competing/unavailable control fails readiness;
later drift and nonfatal proxy errors latch a fault. Diagnostics are bounded
fixed codes, not request URLs or bodies. The extension exposes no content
script, host permission, page messaging, or web-accessible resource. This is
not an operating-system firewall: the privileged Chrome host, extension
installation and debugger remain trusted. Its in-memory readiness flag is
not sufficient public admission.

`npm run test:native-policy` uses Playwright 1.58.2's **full Chromium channel**,
locally measured as `145.0.7632.6`, with no interception at all. Nine independent
tests compare owned TCP/UDP listeners with policy-off positive controls:

- HTTP navigation/redirect and localhost, encoded IPv4 and IPv4-mapped aliases;
  fetch, image, frame/srcdoc, classic/module/shared/service workers and WS.
- The same live classic/module/shared worker instances and an installed service
  worker attempt fetches before and after native policy installation.
- HTTPS navigation/redirect, fetch/image/frame and WSS; only the ephemeral test
  certificate's SPKI is trusted. Production certificate checks are unchanged.
- STUN UDP and TURN UDP/TCP in both page and srcdoc realms, and WebTransport
  QUIC packets in page, classic/module/shared/service-worker realms. All four
  worker kinds expose WebTransport in the measured build; each has a separate
  owned UDP positive control and a zero-packet native-policy negative. Missing
  API availability or missing positive packets in **any** claimed realm fails
  acceptance as unsupported, never as successful native enforcement. The QUIC positive control
  proves actual packets reach the listener, **not a completed WebTransport
  session**. Its browser is closed before negatives to avoid counting unfinished
  positive-handshake retransmissions as leakage.
- A separate unused-origin preconnect TCP listener, and native enforcement while
  the extension service worker is actually stopped and after it restarts
  (CDP reports the stopped/running transitions).

No destination TCP connection/UDP datagram is observed in the corresponding
negative lanes. These are bounded regression observations, not proof about
every channel or a different remote Chrome build. The separate Linux namespace
suite and its run command are documented in [CI.md](CI.md). At implementation
revision `be1c18f`, hosted Ubuntu 24.04 passed all nine native tests and the
isolated namespace test on Chromium `145.0.7632.6`. The latter proves reachable
owned private/link-local/IPv6 listeners and same-process, same-hostname DNS
answer changes between `10.77.0.1` and `169.254.77.1`, with zero destination
connections in the policy-enabled lanes. It deliberately clears native
DNS/socket caches; natural TTL expiry, same-document rebinding and the future
HTTP broker's per-connection DNS pinning are separate requirements. The initial
`96137d4` namespace launch failed before any probe; shortening the private
Chromium scratch path resolved startup in the accepted revision.
Resolver DNS traffic
is a distinct control-plane channel: Chrome explicitly documents that disabling
prediction **does not disable page-initiated DNS-prefetch or preconnect**.
Do not describe this candidate as suppressing all DNS traffic or protecting
arbitrary secrets embedded in DNS names.

Two implementation observations prevented false assurance. MV3 workers cannot
use top-level await at entry, so bootstrap uses an explicitly caught async task.
On this Chromium build, `fallbackProxy.scheme="http"` read back as `"socks4"`;
the strict check correctly refused readiness. An explicit SOCKS5 fallback reads
back exactly and still points only to the closed endpoint.

Before any public integration, remaining gates include:

1. Independently prove that the selected proxy endpoint is nonfunctional before
   loading untrusted content. The local harness refuses an occupied port first.
   Proxy-endpoint traffic is separate from the forbidden-destination listeners;
   the candidate does not claim literally zero loopback packets. An answering
   or forwarding endpoint must reject admission, not become an implicit proxy.
2. Prove effective WebRTC routing in the actual provider configuration, including
   any managed per-origin `WebRtcIPHandlingUrl` overrides. Global privacy
   readback cannot rule those out. The maintained
   `native-policy-attestation.ts` helper reads only the global preference and
   override list from a temporary trusted `chrome://prefs-internals/` page,
   rejects missing/unknown shapes and **any** per-origin entry, and closes the
   page. It never returns or logs the whole profile. A paired owned-STUN test
   reproduces the counterexample: the same controlled global preference blocks
   UDP without an override, but a seeded matching `handling:"default"` entry
   sends packets directly. Both profiles report API-only extension readiness;
   the additional attestation rejects the unsafe profile. Repeated fresh
   internal-page reads are covered. Provider support for this internal-page
   check remains unproved; do not expose it to a model, artifact or live-view
   grant. Chromium also exempts standalone extension
   processes from WebRTC routing preferences; never expose an untrusted
   page-to-privileged-extension network bridge.
3. Establish native settings before loading any untrusted document, verify
   worker/restart/disconnect behavior, and reject missing or changed enforcement.
   Returning profiles are not a candidate public capability: restored tabs or
   workers could run before the handshake.
4. Prove the actual Browserbase build and extension packaging. The public SDK
   2.20.0 API and [extension documentation](https://docs.browserbase.com/platform/browser/core-features/browser-extensions.md)
   expose one `extensionId`, not an assumed array. The pinned Stagehand 4.1.0 ZIP
   uses that slot. A minimal license-preserving repack would require its own
   audited bootstrap, exact archive checks and real Gateway compatibility proof;
   no archive is vendored or uploaded by this phase. Bounded inspection found no
   page-to-worker messaging path in its isolated content script, not approval of
   a future combined extension.
5. Only after native enforcement holds, add a bounded server-side HTTP(S)
   fulfillment transport with per-connection public-address validation/DNS pinning,
   TLS/SNI validation, redirect/scope/method/byte/time limits and strict trusted
   Gateway initiator identity. Interception supplies functionality; native policy
   must still block traffic when interception misses a request or disconnects.
   Preserve browser origin/cookie/CORS semantics and report unsupported channels
   explicitly instead of fabricating successful responses.

Sources: Chrome [proxy API](https://developer.chrome.com/docs/extensions/reference/api/proxy),
[proxy rules and implicit bypasses](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md),
and [privacy API](https://developer.chrome.com/docs/extensions/reference/api/privacy).
The relevant upstream WebRTC routing implementation is pinned for inspection at
Chromium commit `280c10305884862b0562f68e256cd23895fa4279`
(`content/renderer/renderer_blink_platform_impl.cc`,
`chrome/browser/renderer_preferences_util.cc`,
`chrome/renderer/chrome_content_renderer_client.cc`). Source inspection informs
test design; it is not substituted for the actual running build.

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
