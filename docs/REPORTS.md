# Evidence-backed reports (layer 06)

Open **Reports & evidence** from a run's wall, or `/runs/:id/reports`.
The report is owner-only and uses the immutable persona/criterion snapshots,
authoritative returned worker result, persisted action events, and registered
private artifacts. It does not call a model, infer a conversion rate, or turn
an HTTP error into a bug. The ordinary website gate #8 remains enforced.

## Persistence and finality

The repository reads one transactional SQLite snapshot of the run, attempts,
results, events and evidence relationships. The deterministic projection is
saved in `report_snapshots` with a content revision. Reads rebuild from durable
sources and check the private files again: a cached projection cannot make a
deleted screenshot available. Worker/server restarts and browser refresh do not
depend on in-memory worker reports. Concurrent activity cannot commit an older
projection after a newer durable event sequence.

`finality` is `in_progress`, `settling`, `uncertain`, or `final`. Recovery and
quarantine remain uncertain even if an attempt is terminal. A terminal model
hook or old summary cannot replace the authoritative attempt outcome. No
cancelled, blocked, infrastructure-failed, running or unsettled attempt creates
a target-defect or criterion-unmet group. Its actually recorded criterion
observations remain visible, not relabelled as overall success.

Every configured criterion has exactly one report row, including missing
evaluations. Statuses are exactly `met`, `not_met`, `not_observed`,
`inconclusive`, and `unsupported`. `structural` is the report spelling of the
execution contract's `deterministic` method; `semantic` and `legacy` retain
their meaning. Confidence is recorded only when supplied by the evaluator,
labelled heuristic, never interpreted as calibrated probability.

Structural/legacy citations resolve the matching persisted observation and its
recorded action count. Semantic citations additionally match observation ID,
step and recorded page. Screenshot keys resolve only to registered evidence in
that same actual attempt. Missing files yield `partial`/`missing` citations and
an explicit inventory state; they never create fabricated pixels. Milestone
citations can legitimately point to an earlier page. Provenance does not prove
semantic entailment.

Citation observation IDs retain the driver's SHA-256 state identity so reports
can be reconciled with the persisted source. These are observation hashes, not
filesystem artifact keys; only registered public evidence IDs select artifacts.
Freeform quotes still redact internal keys and typed-value variants.

## Classification and denominators

| Category | Evidence rule |
| --- | --- |
| `functional_defect` | Currently only the trusted store verifier's exact second-coupon failure signal, on its recorded cart page, with a settled `target_failed` attempt. No general exception-to-bug heuristic. |
| `criterion_unmet` | A terminal `not_met` criterion with a persisted observation citation. May mean an incomplete task, not a defect. |
| `performance_signal` | Persisted fixed-code slow-request telemetry meeting the driver's 1,000 ms threshold. Not a user-facing latency verdict. |
| `diagnostic_signal` | Recorded HTTP/console/network signal. Not independently proof of a functional defect. |
| `subjective_friction` | A persisted `give_up` decision with a settled `gave_up` outcome. Describes a simulated persona, not real users. |
| `accessibility_observation` | Reserved contract category; no accessibility evaluator exists, so the report does not invent these findings. |

Counts distinguish occurrences, distinct affected attempts/personas, all
assigned attempts/personas, eligible same-definition cohorts, tested
attempts/personas, not-tested attempts/personas, and assignments outside the
cohort. Repeated signals do not multiply the number of affected personas.
An eligible attempt is tested only with relevant persisted evidence and a
settled, non-infrastructure/non-cancelled outcome. For criterion groups its
definition and cited page must match. Diagnostic/performance cohorts require
observed contextual evidence; absent telemetry is not proof a request was fast.
There are no affected-user percentages, conversion estimates, or severity scores.

## Stable layer07 comparison API

Browser-safe schemas live in `src/lib/report-contracts.ts`.
`version:"report-v1"` and `signatureVersion:"finding-v2"` are explicit.
`criterionSignature()` hashes canonical sorted-key JSON containing
`version:"criterion-v1"`, the complete immutable criterion definition, and
navigation scope (including target and allowed paths/subdomains).
Changing assertion text/value, semantics, observation paths, ID, description
or scope changes the definition signature rather than silently merging it.

`finding-v2` hashes canonical category, full scope, observed page, relevant
element, criterion definition signature where applicable, and failure code.
Run/attempt/persona IDs and timestamps are not part of known-page signatures,
so identical evidence signatures can be compared on a scoped rerun. Unknown
page context deliberately includes the attempt ID to avoid false cross-agent
merging: such groups are not evidence of cross-run recurrence.
Array order is preserved except navigation allowlists, which are sorted.
This conservative identity is not a semantic equivalence engine.

Identity uses the original immutable persisted page context (normalized HTTP(S)
origin/path, without URL credentials/query/fragment) and original criterion
control label, **not** run-dependent redacted display strings. Private context
also determines tested page cohorts. Unrelated typed values, changing secret
configuration or a missing unrelated action artifact can change presentation
but cannot change these identities or merge redacted pages into one cohort.
Canonical values are held only in server-local maps and hash inputs, never
added to report/export fields. Known sensitive display values remain redacted.
Genuinely unknown page context is attempt-specific for both identity and tested
denominators; a known page whose display is hidden is not an unknown page.

`finding-v1` used redacted presentation in its hash and is incompatible with v2.
The upgrade invalidates saved report projections and rebuilds them from unchanged
durable source records; original evidence/results remain intact. Old v1 group
links/exports are not silently treated as v2 matches. The report shape and
`criterion-v1` definition hash remain unchanged.

Use compatible signature versions plus exact definition/scope, all five
criterion statuses and tested/not-tested counts for layer07 comparison.
Absence of a group alone never proves a fix. The report UI now provides selected
immutable reruns, lineage-checked comparison and a separate supported
reproduction panel. JSON/Markdown report downloads remain reports, not
ready-to-run tests. [Advanced workflows](ADVANCED_WORKFLOWS.md) documents the
distinct regression-test export, exact coverage requirements and human-assisted
comparison limitations.

## Privacy and supported evidence

All routes apply the ordinary opaque HttpOnly owner cookie, exact Host/Origin,
Fetch Metadata and no-cache controls. Nested IDs must agree with actual SQL
run/attempt relationships, not just JSON metadata. Session IDs are bound to a
single durable job. Foreign, corrupt and absent objects share a `404`.
Files are selected only by registered opaque keys beneath the trusted
private data root; callers never supply paths. See the artifact reader for
size, mode, symlink, MIME and range restrictions.

Screenshots require an explicit reveal in the UI and are labelled **private
pixels, not redacted**. Structured details omit typed values and raw page text,
replace internal artifact keys with same-attempt evidence IDs, and redact known
credentials/URLs. Quotes, logs, model commentary and JSON remain escaped
untrusted text. Fixed-code telemetry preserves bounded safe URL context without
query strings, fragments, authentication, headers or bodies.

JSON/Markdown downloads preserve comparison signatures and stable evidence
references, with available/missing/redacted indicators. They omit screenshot
pixels, recording events, provider IDs/URLs, raw artifacts and typed values.
Markdown metacharacters and HTML delimiters are escaped; downloads use attachment
disposition, `nosniff`, no-store and a restrictive CSP. Text redaction is
best effort, not a claim to recognize every secret in arbitrary user prose:
inspect an export before sharing it.

Supported provider recording behavior and explicit readiness/fallback states
are documented in [REPLAY.md](REPLAY.md). Live browser control URLs are never
treated as recordings. All playback remains owner-only; no provider key belongs
in a browser, public asset, exported report or CI artifact.
