# Private returning-user contexts

Fresh browsers remain the default. An assignment can explicitly authorize a
new saved context, or select an existing **application context UUID** belonging
to the same owner and exact navigation scope. Provider UUIDs are private and
cannot be submitted through the API. Contexts never authorize arbitrary website
execution; issue #8 remains enforced.

## Provider contract

Verified against pinned Browserbase SDK **2.20.0** and official documentation on
September 19, 2026:

- [Contexts guide](https://docs.browserbase.com/platform/browser/core-features/contexts):
  context creation followed by `browserSettings.context: {id, persist}` during
  session creation. `persist:true` saves changes when the session closes.
- [Pinned SDK source](https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/contexts.ts):
  `contexts.create`, `retrieve` and `delete` are supported. Deprecated uploads
  return a nonfunctional sentinel URL and are not used.
- [Get context](https://docs.browserbase.com/reference/api/get-a-context):
  returns ID, project, creation/update timestamps and optional name, **not**
  a persistence-ready state or content digest.
- [Delete context](https://docs.browserbase.com/reference/api/delete-a-context):
  HTTP 204 confirms the documented deletion operation. No immediate erasure of
  an already running browser, backup-erasure SLA or provider-wide credential
  revocation is claimed.

The current guide describes the Chromium user-data directory, including cookies,
localStorage, IndexedDB, session storage, service workers, form data and browser
preferences, excluding HTTP cache. This application does **not** infer that a
new tab restores a previous tab's sessionStorage. Controlled task fixtures
continue to use separately seeded tab-local state. A nonsensitive synthetic
localStorage preference, exposed under **Returning-user demo preference** on
both fixtures, provides an independent returning-state observation.

The guide requires waiting "a few seconds" after closing before reuse. Flash
Flood imposes **10 seconds after confirmed remote closure**. The state is labelled
`delay_elapsed_unverified`, not "provider confirmed saved": neither a successful
GET nor `updatedAt` proves contents synchronized. An actual application
observation must establish whether the desired state returned.

## Owner API and lifecycle

Optional per-assignment `browserState`:

```json
{"mode":"fresh"}
```

```json
{"mode":"save","acknowledgeSensitiveStorage":true}
```

```json
{"mode":"returning","contextId":"APPLICATION-UUID","persist":false,"acknowledgeSensitiveStorage":true}
```

Omitting the field is fresh. `save` starts a newly created empty context and
authorizes persistence. Returning use is explicit and saving further changes
requires `persist:true`; read-only returning use does not update the saved
context. Website assignments cannot request non-fresh state. Reruns and
reproduction candidates never implicitly inherit a parent's context.

`GET /api/v1/contexts` lists up to 100 owned references with safe state, exact
scope signature, timestamps, revocation and persistence status. No provider
identifier, cookie or content is returned. `DELETE /api/v1/contexts/:id` uses
the usual exact Origin, opaque owner and CSRF checks; it idempotently revokes
reuse and requests retirement, not an optimistic remote-deleted response.
Known active use is cancelled and must settle before remote deletion.

Assignment admission and worker claim use the same SQLite transaction boundary
as immutable snapshots and launch reservation. A context hold belongs to the
durable job, **not a renewable local timeout**. Two workers cannot simultaneously
use it. Lease loss, crashes and unknown browser allocation preserve the hold.
Only confirmed remote closure or trusted proof of no browser allocation can
release it. Recovery can prove closure but cannot prove saved state; affected
contexts are quarantined rather than silently adopted.

Creation intent is durable before the one no-retry provider request. A lost
creation reply is `creation_unknown`; no retry can quietly create another
context. A late known ID is preserved privately for cleanup but cannot authorize
a stale worker. Startup/adoption/cleanup failures are explicit. SDK error text
and context contents never enter public events.

## Retention and retirement

Browserbase contexts otherwise live indefinitely. Application eligibility ends
at the earlier of seven days from creation and the original owner's expiry.
A running worker revokes expired contexts, cancels active use and deletes known
closed contexts after their synchronization delay. Without a running worker,
remote retention continues; expiry is not proof of deletion.

Deletion has durable one-shot intent. Failure, a lost response or a process
crash becomes `deletion_unknown`; the worker does not blindly repeat it.
Known remote IDs, operation counts and fixed statuses remain in private SQLite
for operator reconciliation. If context creation succeeded with a lost reply
and no ID, automatic deletion is impossible: use the unique
`flash-flood-APPLICATION-UUID` project context name through a trusted operator
workflow. Do not submit a remote ID through the owner API or edit local status
to manufacture proof. A retained unknown context is not reported as erased.

Deleting a context does not revoke credentials at the target service, wipe a
running browser or delete already protected screenshots/recordings. Context
data and private database backups must be handled as credentials. Never put
them in logs, browser storage, exports or a public repository.
