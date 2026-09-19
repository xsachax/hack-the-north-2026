# Owner API and durable execution contracts

Base path: `/api/v1`. These handlers **never launch a browser or call a model**;
explicit demo/controlled-site admission queues paid work for a separately running worker.
The operator dashboard consumes these owner-scoped endpoints; mock preview data
is separate from durable worker execution.

## Deployment and identity

Use a persistent, single-host Node.js 22.18+ (22.x) process with `DATA_DIR` on a
private local persistent volume. Node's `node:sqlite` is available without
`--experimental-sqlite` on the supported runtime; it is still experimental and
emits a warning. No native npm driver or new dependency is required. Do not
deploy the database on ephemeral serverless storage, a network filesystem, or
independent replicas with separate volumes.

`APP_ORIGIN` is an exact origin, not a URL prefix (no trailing slash). Development
defaults to `http://127.0.0.1:3000`; `http://localhost:3000` is also allowed when
explicitly configured. Production requires an HTTPS `APP_ORIGIN` and
`FLASH_FLOOD_ACCESS_CODE` of at least 32 characters. Generate a high-entropy random
code and provision it through your deployment's secret mechanism. The API fails
closed with `503` when its configuration is missing/invalid, even though the
preview and liveness endpoint can still render. A TLS-terminating proxy must
preserve the external `Host` authority. The API compares that authority and the
browser's exact external HTTPS `Origin`, not Next's internally rewritten URL
origin; forwarded headers are not an authentication source.
Do not enable wildcard CORS. TLS termination, request/header limits, request
timeouts and external abuse protection remain deployment responsibilities.

`POST /session` with a JSON object (`{}` locally, `{"accessCode":"..."}` when gated)
returns `{data:{ownerId,csrfToken,expiresAt}}` and a server-generated opaque
seven-day cookie. Cookies are `HttpOnly; SameSite=Strict; Path=/`; production adds
`Secure` and uses the `__Host-ff_owner` name (development: `ff_owner`). Only a
SHA-256 digest of the session cookie is stored. The CSRF token is stored privately
and returned only by same-origin bootstrap. All responses disable caching.
Calling bootstrap with a valid existing cookie recovers its CSRF token without
issuing a new identity or extending expiry.

**This is a shared admission gate plus anonymous owner isolation, not account
authentication.** Possession of a cookie grants that owner's access. Losing it
loses API access to the owner's records; no login, recovery or cross-device
identity is implemented. Rotating the access code prevents new admissions but
does not revoke existing sessions. Sessions expire after seven days. Expired
owners and their data are retained; automatic deletion, operator revocation,
retention administration and named accounts are future work. Do not treat this
as a public multi-tenant production service yet.

Every mutation, including bootstrap, requires `Origin: <APP_ORIGIN>`. All other
mutations additionally require `X-CSRF-Token` from bootstrap and the cookie.
Supplied origins must also match on reads; cross-site Fetch Metadata is rejected.
No owner identifier supplied in a body/query selects the authorization principal.
Runs, attempts, events, custom personas, evidence and findings are owner-scoped;
an absent or foreign object returns the same `404`.

JSON mutations require `Content-Type: application/json`. Bodies are limited to
32 KiB of actual bytes (not just Content-Length), valid UTF-8, and five seconds
of body reading. Unknown fields and malformed schemas fail closed. Do not log
bodies, submitted access codes, cookies, target query strings or private evidence.
Internal API diagnostics are fixed codes, not exception messages.

## Endpoints

All successes use `{data: ...}`. Errors use
`{error:{code,message}}` with generic safe messages. Statuses include `400`
invalid input/target policy, `401` missing session/wrong access code, `403`
origin/CSRF, `404` absent/foreign resource, `409` conflicting idempotency/state,
`413` oversized body, `415` wrong content type, `408` slow body, `429` quota and
`503` unavailable/configuration/storage failure. `429` includes `Retry-After: 60`;
longer-lived admission limits may not clear after one minute.

| Method | Path | Input / result |
| --- | --- | --- |
| POST | `/session` | Bootstrap described above |
| GET | `/capabilities` | Unauthenticated safe readiness booleans and public execution ceilings; same Host/Origin protections |
| GET | `/personas` | `{items:[...]}`: twelve predefined profiles and up to 50 owned custom profiles |
| POST | `/personas` | Full custom profile; returns new server-generated UUID |
| PUT | `/personas/:id` | Full replacement of owned custom profile, not a partial patch |
| DELETE | `/personas/:id` | No body; deletes custom profile; existing attempt snapshots remain intact |
| POST | `/runs` | Validated scoped request below; required `Idempotency-Key` |
| POST | `/demo-runs` | Explicit opt-in trusted fixture request below; required `Idempotency-Key` |
| POST | `/controlled-runs` | Explicit operator-gated registered site, custom criteria and optional narrowed navigation scope; required `Idempotency-Key` |
| GET | `/runs?after=0&limit=50` | `{items,nextCursor}` ordered by durable ascending creation cursor |
| GET | `/runs/:id` | Run with scope, lifecycle and cancellation-request timestamp |
| GET | `/runs/:id/attempts` | `{items}` (bounded by twelve assignments), including immutable persona/goal snapshots |
| GET | `/runs/:id/events?after=0&limit=50` | `{items,nextCursor}` ordered by per-run event sequence |
| GET | `/runs/:id/events/stream?after=0` | Owner-scoped SSE; exclusive cursor or `Last-Event-ID`, bounded connection lifetime |
| GET | `/runs/:id/summaries` | `{items}`: attempt/launch states, cleanup/count summary, remote usage and reservation/consumption/refund |
| GET | `/runs/:id/sessions` | `{items:[{attemptId,available,liveViewUrl}]}`; authorized active live-view metadata only |
| POST | `/runs/:id/cancel` | Empty JSON object; idempotent cancellation request |
| GET | `/evidence/:id` | Private owner-scoped metadata only, no file path, browser session URL or file download |
| GET | `/findings/:id` | Finding with references to same-attempt evidence |

Pagination is exclusive `after`, integer `0..Number.MAX_SAFE_INTEGER`, and
`limit` is `1..100`. Use `nextCursor` for the next available page. For polling
events, retain the last event's sequence even when `nextCursor` is `null`.
Unknown/duplicate query parameters are rejected. Persona/attempt collections
have hard size limits instead of pagination. Predefined personas cannot be
updated/deleted; create a custom copy to edit one.

Profile fields: `name`, `character`, `device` (`phone|desktop`), `techComfort`
(`low|medium|high`), `patienceSteps` (`1..30`), `readingStyle` (`skim|careful`),
`quirks`, `worries`. String/array bounds live in `src/lib/contracts.ts`. Profile
text is data describing behavior, never executable code or a replacement for
the worker's safety policy.

Example run body:

```json
{
  "authorizationAcknowledged": true,
  "scope": {
    "targetUrl": "https://example.com/shop",
    "allowedSubdomains": ["sale.example.com"],
    "pathPrefixes": ["/shop", "/checkout"]
  },
  "assignments": [{
    "personaId": "impatient-mobile",
    "goal": "Find a blue shirt without completing a purchase",
    "criteria": ["The size and total price are visible before checkout"]
  }]
}
```

An explicit authorization acknowledgement is mandatory; it is not proof of
ownership. Assign one to twelve unique predefined/owned persona IDs, each with a
goal and one to twelve evaluation criteria. The idempotency key is 16–128 ASCII
letters/digits/underscores/hyphens. Same owner/key and validated request returns
the original run (`200`, versus `201` on creation); a changed request returns
`409`. Different owners have independent keys. Validation/DNS admission is
rechecked on every create request, including retries; target unavailability can
therefore temporarily prevent an otherwise idempotent replay.

### Assignment execution limits

All three admission endpoints accept an optional assignment `limits` object:
`{maxSteps?:1..30,maxModelCalls?:1..30,maxDurationMs?:1000..240000}`. Values must
be integers; unknown fields are rejected. Each field is independently optional.
The immutable attempt JSON snapshot persists the requested limits, including
through reopening, cancellation and worker settlement. Existing snapshots with
no limits remain valid; no SQL-column migration or history rewrite is needed.
At execution each requested limit is clamped to the persisted worker policy.
Duration is additionally capped at `max(1000,(sessionSeconds-60)*1000)`, retaining
cleanup headroom. These limits never increase operator caps, change allocation
reservations, authorize website execution, or create a retry/relaunch path.

### Safe capabilities and browser contracts

`GET /capabilities` needs no owner cookie or access code; it rejects query
parameters, foreign Host/Origin and cross-site Fetch Metadata and disables
caching. Its complete `data` shape is:

```ts
{
  controlledRunsEnabled: boolean;
  websiteExecutionEnabled: false;
  maxActiveViews: 3;
  accessCodeConfigured: boolean;
  browserbaseKeyConfigured: boolean;
  executionLimits: { maxSteps: number; maxModelCalls: number; maxDurationMs: number };
  executionLimitsSource: "persisted-worker-policy" | "configuration" | "defaults";
}
```

Admission readiness means the operator flag and sufficiently long access code
are configured, not that a worker, fixture server or provider is reachable.
Key readiness only reports presence, never validity or the key itself. Persisted
worker caps take precedence; an uninitialized worker reports a clearly labelled
configuration/default ceiling. No secret, private configuration error, budget
accounting, owner identifier, or session metadata is included. Canonical
browser-safe schemas/types for this response and session/summary item lists are
exported from `src/lib/ui-contracts.ts`; clients must not import server modules.

Public observation, decision and action events may include `data.pageUrl`.
This is the latest observed page (for actions, the source page, not an asserted
destination). It excludes userinfo, query strings and fragments and redacts
known secrets and common sensitive path segments. Malformed/non-HTTP URLs are
omitted. Historical events without the optional field remain readable. Session
and replay links never populate this field.

### Explicit demo admission and UI handoff

`POST /demo-runs` requires `ENABLE_DEMO_RUNS=true` and a configured access code
of at least 32 characters, including development. All normal owner, Origin,
CSRF, JSON-size/rate-limit and idempotency guards apply. Disabled admission
returns `503 demo_disabled`; unsupported criteria return `400 unsupported_criteria`
**before allocation**. No body-supplied URL, scope, fixture port or arbitrary flags
are accepted:

```json
{
  "authorizationAcknowledged": true,
  "scenario": "fixed",
  "assignments": [{
    "personaId": "bargain-hunter",
    "goal": "Apply SAVE10 and COZY5 to the Maple ceramic mug without gift wrap or checkout.",
    "criteria": ["Both advertised coupons apply and the mug total is CA$21.60."]
  }]
}
```

Scenarios are `fixed|second-coupon`. The other supported criterion is exactly
`The demo order is visibly complete.` Assignments may use owned custom profiles;
their goals/criteria are immutable snapshots, not replacement policies. Unknown
or duplicate legacy demo criteria fail prelaunch. Custom criteria use the distinct
controlled-site route below.
The server maps this request to the synthetic fixture scope and trusted switches,
returning a Run with `executionMode:"controlled-fixture"`. Normal `/runs` returns
`executionMode:"website"` and remains queued until a worker records `blocked`
with reason `blocked_unsupported`; it never silently executes a demo instead.

The UI should retain the run ID, load attempts/summaries, replay event history
then stream from the last sequence. `attempt.observation`, `attempt.decision`
and `attempt.action` include `actor:"agent"` and a public evidence ID, with
bounded counts/action/commentary as applicable. `attempt.recovering` is not a
second start. Final statuses come from `attempt.finished`/`run.finished`, not
model text. Event payloads omit SDK IDs, storage keys, live/replay/CDP links.
Summaries expose conservative whole-second accounting separately from available
precise browser duration. Infrastructure failure is not a target bug.

The `/sessions` response is itself private, access-bearing metadata: use only for
the owning wall, do not log/cache/share it. It does not expose an API key, CDP
connection or replay URL. References are unavailable once cancellation,
recovery or completion begins. Protected evidence downloads/replays come later.

### Controlled sites and custom objectives (layer04b / UI05)

Implemented in issue #11 / PR #17, on top of merged worker PR #15.

`POST /controlled-runs` uses the same strong access-code, `ENABLE_DEMO_RUNS`,
owner, Origin, CSRF, body-size, rate-limit and idempotency protections as the demo
route. It is an **operator-selected trusted-site registry**, not the ordinary
customer URL endpoint. `controlledSiteId` is `store` or `project-board`; an
unknown ID, arbitrary origin, transport port or fixture flag is rejected.
The immutable registry selects synthetic HTTPS origin, exact document routes
and trusted loopback transport. An optional `scope` narrows navigation using
`targetPath` and segment-boundary `pathPrefixes`; it cannot enlarge the registry.
Same-origin Next static assets are transport dependencies, not navigation goals.

Choose a predefined ID from `GET /personas`, or save a profile with `POST /personas`
and use the returned ID. Both paths snapshot the entire profile, goal and
criteria; later profile edits/deletion cannot change the queued attempt.

```json
{
  "authorizationAcknowledged": true,
  "controlledSiteId": "project-board",
  "scope": {
    "targetPath": "/project-board",
    "pathPrefixes": ["/project-board"]
  },
  "assignments": [{
    "personaId": "careful-first-timer",
    "goal": "Create a synthetic project named Garden planning in the Research category and confirm it is listed.",
    "criteria": [{
      "id": "project-listed",
      "kind": "visible_text",
      "description": "The new project name is visible in the projects list.",
      "semantics": "current",
      "paths": ["/project-board/projects"],
      "text": "Garden planning",
      "match": "contains"
    }, {
      "id": "category-confirmed",
      "kind": "semantic",
      "description": "The visible project list associates Garden planning with the Research category.",
      "semantics": "current",
      "paths": ["/project-board/projects"]
    }]
  }]
}
```

Custom profile example (replace `personaId` above with its returned UUID):

```json
{
  "name": "Volunteer organizer",
  "character": "A volunteer planning a small community garden project.",
  "device": "desktop",
  "techComfort": "medium",
  "patienceSteps": 12,
  "readingStyle": "careful",
  "quirks": ["Checks the saved project title and category."],
  "worries": ["Losing work before it is visibly listed."]
}
```

Criteria are bounded strings or structured assertions. Strings retain backwards
compatibility; non-legacy strings request semantic evaluation, while the two
exact demo criteria retain their deterministic fixture oracle. Structured
assertions use an ID, description, `kind` and `semantics`. Exact canonical
`paths` declare where a condition is observable, not a navigation permission.
URL assertions match exact pathnames; visible-text assertions use literal
`exact`/`contains` matching, never caller regexes or executable selectors.
`exact` matches a measured visible text block (including inline pieces of a
heading), not the whole page or hidden DOM. `contains` searches those measured
blocks joined with spaces, excluding synthetic focus/input annotations; use a
control-state criterion for input values. Neither asserts absence from the
entire document.
Control assertions use measured control labels/state, not model-supplied code.
An outcome must be represented by observable URL/text/control evidence or
explicit semantic judgment, not an unverified model `done`.

For `kind:"control"`, use `label`, `match:"exact"|"contains"` and optional
`controlKind:"link"|"button"|"input"|"select"`. Optional `value`, `checked`,
`disabled` and `selected` assert observed state; `selected` is an exact unordered
set of option values. Disabled controls remain observable but cannot be action
targets. Missing requested state is inconclusive, not a match. The criterion
means at least one measured matching control has the requested state; it does
not identify a unique DOM element or grant an arbitrary selector.

Attempt summaries retain `passed` for compatibility and add explicit states:

| `check.status` | Meaning |
| --- | --- |
| `met` | Met, with deterministic evidence or validated semantic citations |
| `not_met` | Not met on a relevant observed page; not automatically a target bug |
| `not_observed` | Not observed here; configured relevance excludes this page |
| `inconclusive` | Missing, ambiguous, malformed or insufficient evidence, or unavailable requested state |
| `unsupported` | Required evaluation capability is unavailable |

`method` is `legacy`, `deterministic` or `semantic`. Semantic `confidence` has
`confidenceMeaning:"heuristic"`; the server does not interpret it as a probability.
Public summary citations expose observation ID, page URL, step, excerpt and an
owner-scoped screenshot `evidenceId` when available, never private storage keys.
`modelOperations` separates `decision`, `evaluation`, `retry` and `total`;
`modelCalls` equals the total. Available allowlisted numeric Gateway metrics are
reported separately from these application operations.

`milestone` means a verified achievement can survive an unrelated route;
a contradictory observation on a relevant route invalidates it. `current`
requires the condition on the latest observation. Missing, unsupported or
ambiguous observations are not silently converted to success or target bugs.
Semantic citations are checked against the actual bounded observation and its
page, step and screenshot reference. This proves provenance, **not entailment**:
the semantic verdict and confidence remain heuristic, not calibrated statistics
or deterministic proof. All decision and verification calls, including failed
calls, share the attempt's application-call ceiling.

The store accepts novel objectives too, for example `controlledSiteId:"store"`,
`scope:{"targetPath":"/demo/category/paper","pathPrefixes":["/demo"]}` and
a visible-text criterion for `Pocket trail journal`. No request is silently
mapped from `/runs` or an arbitrary customer target into one of these sites.
Public execution remains blocked by #8. Tabs, subframes, uploads, real purchases,
context reuse and human takeover are not enabled by custom prose.

### SSE resume and disconnect

SSE uses durable per-run sequence as `id`, event kind as `event`, and the
canonical event JSON as `data`. `after` and `Last-Event-ID` are exclusive integer
cursors; a valid `Last-Event-ID` takes precedence over the initial `after` query
on native EventSource automatic reconnect. Both inputs must be valid if present.
Default cursor is zero; noncanonical integers and duplicate/unknown queries are rejected. Keep the latest
received ID and deduplicate by ID when reconnecting. JSON pagination remains
available for history. Internal pages default to 50 records (maximum 100), polls
are 500ms only with pending reads, and idle keepalives are 15 seconds subject to
backpressure. Connections close after 60 seconds or owner expiry sooner. Caps
are 100 total / 5 per owner **per handler instance**, not a distributed socket
quota; reverse-proxy connection limits remain a deployment requirement.
Slow readers do not cause unbounded polling;
client disconnect clears timers/listeners. Session expiry closes the stream.
Terminal streams drain their remaining backlog before closing. Fixed safe error
events after headers close the stream; reconnect/poll rather than inventing
missing lifecycle transitions. Stream polling never appends repository events.

## State, storage and internal worker boundary

Canonical browser-safe schemas/types are in `src/lib/contracts.ts` and
`src/lib/target-scope.ts`. `src/lib/run.ts` retains in-memory preview/evidence
shapes and re-exports the canonical lifecycle; these are not private artifact
storage contracts. Statuses are `queued`, `running`, `succeeded`, `gave_up`,
`cancelled`, `blocked`, `limit_reached`, `infrastructure_failed`, `target_failed`.
`target_failed` means a target outcome, not an infrastructure problem; actual
bug findings still require supporting evidence.

Creating a run atomically snapshots profiles/objectives, creates one attempt,
job and zero-valued usage reservation per assignment, and appends `run.created`.
Updating/deleting a profile never changes prior attempts. All multi-record
transitions use SQLite `BEGIN IMMEDIATE`, foreign keys, WAL, `synchronous=FULL`,
a five-second busy timeout, and transactional `user_version` migrations.
Repository `close()` is explicit for scripts/tests; process exit releases the
server connection. SQLite recovers committed WAL state on reopen; do not delete
sidecars to "fix" a running database. The directory is mode `700`, database `600`,
and sidecars inherit database permissions. Back up using SQLite-aware tooling or
after stopping all processes and closing connections; copying only the live
main database can lose WAL transactions. Treat backups as secrets.

The repository's legacy `startAttempt`, `finishAttempt`, `recordEvidence` and
`recordFinding` are **internal worker-facing primitives, not HTTP mutation
endpoints or a paid-launch protocol**. They require an owner/run/attempt match.
Starting a non-queued or cancelled attempt conflicts. Finishing a running attempt
with the same terminal result is idempotent; terminal outcomes are otherwise
immutable. The state API does not prove objective success; layer 03 must do so
before passing `succeeded`. Legacy start/finish reject attempts with durable
launch records; the worker exclusively uses fenced transactional methods.

Queued cancellation immediately cancels attempts/jobs. Running cancellation
records intent, cancels queued peers and leaves active attempts/jobs active until
the worker confirms cleanup. A late success cannot overwrite cancellation.
Cleanup/infrastructure failure is preserved rather than presented as a clean
cancellation. Transaction ordering decides finish-versus-cancel races. Fully
terminal runs are not relabelled by a later cancel request.

Runs become terminal only when every attempt does. For mixed results the
summary priority is infrastructure failure, limit, blockage, target failure,
abandonment, cancellation, success; a cancellation request overrides non-infra
outcomes. Per-attempt results remain the source of detail. Events have monotonic
per-run integer sequences allocated in the same transaction as state changes.

Jobs include lease owner, expiry, generation and cancellation intent; reservation
rows include reserved/consumed/released seconds. Layer04 adds transactional
claiming, persistent policy, unique launch intent/correlation, generation/expiry
fences and conservative settlement. See [WORKER.md](WORKER.md) for exact crash
windows, shared two-process limits and bounded reconciliation/quarantine.
Reopening a running record does not invent success or retry a browser:
recovery verifies/releases the existing correlated session. Unknown outcomes
retain slots/reservations even after an infrastructure-failed terminal result.

Evidence records use server-generated IDs and internal 64-character hex storage
keys, never caller-supplied file paths. Finding references must exist, belong to
the same owner/run/attempt, and remain durable. Storage keys are never returned
over HTTP. This API stores references/metadata only. Layer03 adds an internal bounded
private artifact writer and execution engine, described in [EXECUTION.md](EXECUTION.md);
layer04 maps its immutable artifacts to fenced step/evidence records. Protected
artifact streaming remains later work. Untrusted summaries must be escaped on
display and are not trusted policy.

## Persisted abuse controls

Counters are in SQLite, not process memory: bootstrap (including wrong access
codes) is globally limited to 30/minute; authenticated mutations are 60/minute
per owner; reads 300/minute per owner. Fixed-window limits can allow a burst at
the window boundary. Origin-rejected traffic is rejected before storage; it
cannot allocate sessions or start DNS resolution.

Admission also caps an owner at five active runs, 100 new runs in a rolling day,
and 50 custom personas. Idempotent run retries do not consume another run slot.
There is a lifetime cap of 1,000 owner records per database. These bounds survive
restarts and multiple connections but are not a distributed DDoS defense.
Bootstrap uses a conservative global bucket rather than trusting proxy/IP
headers; one client can exhaust it. Shared-code holders can obtain multiple
owners. Demo requests can now cause paid work through the worker's atomic
per-owner/global concurrency and spending limits; shared-code ownership still
does not constitute named-account authentication or public multi-tenant billing.

## Target trust and next-layer enforcement

Initial admission checks the explicit target and allowed subdomains against
URL/IP/DNS policy. Exact allowed subdomains do not mean arbitrary sibling hosts
or wildcards. Paths match segment boundaries, not naive string prefixes.
`guardTargetUrl` is the reusable async enforcement point for each navigation,
redirect hop, popup, frame and browser request. Revalidate DNS each time and
reject out-of-scope destinations before the network operation, not after loading
the page. External CDNs/APIs are not silently exempt from the explicit scope.

**Admission and DNS rechecks do not solve DNS rebinding.** A browser can resolve
again after validation, bypass interception, or follow redirects automatically.
The arbitrary-target runner must connect the policy to the browser's actual network boundary,
prevent unchecked redirects/requests, and verify/enforce the destination at
connection time (or use a trusted egress proxy/network allowlist). Browserbase's
top-level domain setting alone is insufficient for subresource traffic.
Do not claim arbitrary remote targets are safely runnable until that capability
is demonstrated. Layer03 therefore ships only the explicit trusted fixture
transport in [EXECUTION.md](EXECUTION.md), and rejects arbitrary targets before
paid launch. The offline API's ability to store a valid target does not mean a
worker may execute it. Development-only localhost exceptions must be narrowly
configured and cannot be enabled in production. No environment-driven localhost
bypass is enabled by the API in this layer; fixture integration belongs to 02/03.

The policy functions accept trusted `PolicyOptions`: injected all-answer DNS
`lookup(hostname)`, a bounded `dnsTimeoutMs` (default 2,000; maximum 5,000), and one
exact `developmentLocalhostOrigin` (for example `http://127.0.0.1:4100`). The
exception requires a development environment, and a real production `NODE_ENV`
always rejects it, including when the test-only `environment` option says
development. These options are server configuration, never request-body fields.

Offline validation is `npm run check`, `npm run build`, then `npm run test:http`,
without `.env.local` or Browserbase credentials. Tests use temp databases,
multiple connections/processes and injected DNS. The HTTP smoke runs the actual
built Next server on loopback with a temporary database and verifies proxy Host
handling, secure sessions, CSRF, persona CRUD and owner isolation; it never
requests an external target. Ordinary CI does not contact paid providers.
