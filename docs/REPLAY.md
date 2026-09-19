# Protected Browserbase replay adapter (layer 06)

> **Trust boundary:** Browserbase's fixed, authenticated session/page replay API
> is trusted to return that session's media. Application clients cannot supply
> provider identifiers, manifests, CDN URLs, or provider implementations.
> A CDN allowlist constrains destinations; it does not independently prove media
> ownership or replace authorization.

## Verified provider interface

Verified against the official documentation and the **pinned SDK 2.20.0 source**
on September 19, 2026:

- [Session replay](https://docs.browserbase.com/platform/browser/observability/session-replay):
  recorded video, HLS VOD, fragmented MP4 segments, one playlist per recorded tab.
- [Replay metadata](https://docs.browserbase.com/reference/api/session-replays):
  `GET /v1/sessions/{id}/replays`, returning `{ pageCount, pages:
  [{ pageId, url, startTimeMs, endTimeMs }] }`. Times are relative to session start.
- [Replay page](https://docs.browserbase.com/reference/api/session-replay-page):
  `GET /v1/sessions/{id}/replays/{pageId}` returns an M3U8 document.
- [SDK v2.20.0 replays.ts](https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/sessions/replays.ts):
  `bb.sessions.replays.retrieve(id)` and `retrievePage(id, pageId)` exist.
- [SDK v2.20.0 recording.ts](https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/sessions/recording/recording.ts):
  `sessions.recording.retrieve` is **deprecated rrweb event retrieval**. This
  adapter deliberately does not use it. No rrweb dependency/client is needed.
- [Recording downloads](https://docs.browserbase.com/reference/api/list-session-recording-downloads)
  and [SDK v2.20.0 downloads.ts](https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/sessions/recording/downloads.ts):
  per-page `pageId`, `status`, optional `completedAt` and `downloadUrl`. This is
  another signed-URL response, not an independent media-binding mechanism.

This is not a hypothetical HLS endpoint or a live-view embed. The SDK and current
official docs both support HLS. Offline fixtures are synthetic representations
of the documented response format. Separately authorized live readback is
documented below; CI never calls the provider.

### Provider-backed session binding

The official replay-page OpenAPI operation states: **"Returns an HLS VOD media
playlist (.m3u8) for a specific page of a session replay."** Its path is
`GET /v1/sessions/{id}/replays/{pageId}`, with required UUID `id`, a numeric
`pageId`, and `BrowserbaseAuth` API-key authentication. The official guide says
"Each recorded tab appears as its own page in the metadata response, with its
own playlist URL" and instructs callers to retrieve that session's metadata,
then call `retrievePage(sessionId, firstPage.pageId)`.

The application relies on that authenticated API contract, not on a guessed CDN
path or local signature verification. The chain is:

1. The HTTP layer authorizes the current owner, run and exact attempt; it resolves
   the persisted provider session through the real job/session binding.
2. The SDK provider retrieves metadata at the fixed authenticated API origin for
   that UUID. Each returned relative page URL must exactly match that same
   session and validated page ID; the adapter never follows the metadata URL.
3. The SDK constructs the fixed session/page endpoint itself. Only this
   authenticated response can populate the private map of media URLs.
4. The map, its URL array and rewritten lines are immutable. The private cache is
   keyed by session UUID, then page index, and explicitly retains/checks the
   authenticated session/page identity alongside the parsed manifest.
5. Clients can request only bounded local integer page/asset indexes. Every
   request repeats authorization and resolves the index under that exact
   session's cached manifest. CDN origins, redirects and DNS are separately
   constrained before fetching the selected URL.

An injected provider that returns B's valid signed URLs from A's playlist call
violates the trusted provider contract. That reproduction assumes incorrect or
compromised server/provider code; it is not an owner-controlled URL or cache
substitution path. The public API does not expose media digests or a separately
verifiable session claim; the adapter does **not** claim to defend against a
lying authenticated provider, compromised CDN, or arbitrary server-code
replacement. No filename/UUID heuristic or fake attestation callback is added.
If such a stronger trust boundary becomes a requirement, independently trusted
media ingestion or a new provider verification contract would be needed.

The official guide says segment signatures last six hours, recording sources last
up to 31 days for non-BYOS projects and 24 hours for BYOS. A provider 404 cannot
distinguish retention expiry from a never-recorded session. The adapter reports
`expired` only for a trusted stored expiration deadline or provider 410, not 404.

## Server integration boundary

`src/server/reports/replay.ts` is server-only. Construct one long-lived adapter:

```ts
const replay = createReplayAdapter({
  provider: createBrowserbaseReplayProvider(serverConfig.BROWSERBASE_API_KEY),
  segmentOrigins: verifiedDeploymentCdnOrigins,
});
```

`segmentOrigins` must contain **exact HTTPS origins verified by the operator** for
the deployment. The docs do not promise a universal CDN hostname; no hostname is
invented here. An empty list deliberately returns `unsupported`. Do not derive
this allowlist from HTTP input, provider metadata, or a playlist. Do not use a
wildcard. The adapter never follows a metadata URL.

The application reads this allowlist from the server-only
`BROWSERBASE_REPLAY_ORIGINS` environment variable (comma-separated, at most eight
exact origins). Empty configuration leaves embedded replay explicitly unsupported.
The server never derives this setting from request input or a returned playlist.

For the bounded layer06 proof, the coordinator explicitly approved pinning the
exact origin observed through the fixed authenticated recording API for an
independently re-read, known closed session. This establishes **provider-selected
provenance**, not independent proof that Browserbase owns the CDN. The exact host
and signed URLs remain private operator configuration. Production must never
auto-learn or expand this allowlist from a response, and suffix wildcards are not
supported. The authenticated session/page API is the authority for which media
belongs to that session; CDN allowlisting separately constrains destinations.
Neither an origin pin nor a session-looking filename is independently verifiable
asset-ownership proof.

After each HTTP request has passed owner, run, assignment, and **exact attempt**
authorization, load that attempt's private persisted session reference and supply:

```ts
const association: AuthorizedReplayAssociation = {
  sessionId: storedReference.sessionId, // UUID, never request input
  state: trustedRunIsStillRunning ? "running" : "ended",
  recordingEnabled: trustedRecordingConfiguration,
  sensitivePlaybackAuthorized: explicitlyAuthorizedForSensitivePlayback,
  playbackBasePath: "/api/reports/RUN/ATTEMPT/replay",
  // expiresAt: trusted retention deadline in epoch milliseconds, if known
};
```

The association is **not** a capability token and does not perform HTTP auth.
Never spread an untrusted request or the entire private session reference into it.
The strict schema rejects extra keys (including `liveViewUrl` / `replayUrl`).
All metadata, playlist, and segment routes must repeat application authorization;
knowing a same-origin path does not grant access. Revoked authorization must apply
even if the adapter has cached provider metadata.

### Exact methods and route shape

| Method | Result / suggested route |
| --- | --- |
| `inspect(association)` | Browser-safe `ReplayReport`; `status`, `format: "hls"`, `sensitive: true`, `fallback: "operator-dashboard"`, pages with app-local indexes, relative times, and same-origin `playlistPath` |
| `playlist(association, pageIndex)` | M3U8 string; `BASE/pages/INDEX/playlist` |
| `segment(association, pageIndex, segmentIndex, range?)` | `{ status: 200 \| 206, body: Uint8Array, contentType: "video/mp4", contentRange? }`; `BASE/pages/INDEX/segments/INDEX` |

Index zero in the segment route can be the MP4 initialization segment. Indexes
are local array positions, never provider IDs or signed URLs. No route accepts a
URL. Return only the adapter output, not input associations or provider errors.
Metadata extras, playlist comments/titles, signed URLs, and provider IDs are not
emitted. `ReplayError.status` is a safe public category; do not serialize errors,
causes, request objects, upstream headers, or provider exception messages.

Suggested response protections for **all** routes:

- authenticated same-origin GET only; no public CORS;
- `Cache-Control: private, no-store`, `Vary: Cookie`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`;
- playlist `Content-Type: application/vnd.apple.mpegurl`;
- segment type from the adapter; forward only adapter status/body/content-range,
  calculate content length locally;
- no upstream cookies, redirects, ETags, error text, or location headers;
- reject unsupported ranges with HTTP 416 (safe `unsupported` body), and avoid
  treating provider/app errors as a successful playlist response.

`parseReplayRange` allows one explicit `bytes=START-END` range within the 16 MiB
limit. Open-ended, suffix and multipart ranges are intentionally unsupported.
The segment is fetched within the cap and then sliced locally; client ranges
are never forwarded upstream.

## Player and sensitive-content policy

The video is **not redacted**. It can contain credentials, typed values, page
content or personal information. Ordinary report authorization is insufficient:
the caller must explicitly authorize sensitive playback. Deny this permission by
default and never mark recording as sanitized. This video-only path exposes no
rrweb events, DOM snapshots, HTML, CSS URLs, or executable page content.

The player checks `Hls.isSupported()`, loads the protected playlist path and
attaches it to `<video controls playsInline preload="none">`. It falls back to
native HLS only where supported and destroys playback on unmount/page changes.
It never autoplays sensitive content.
Never render M3U8 as HTML, embed the provider dashboard/live-view URL in an iframe,
or load an external player script.

The application uses pinned **hls.js 1.7.3**, with native HLS fallback where
supported. Its inert video player never autoplays. The report route enforces
`connect-src 'self'`, `media-src 'self' blob:`, `object-src 'none'`, no frames,
and no workers; the bundled player disables its worker and rejects external
request paths. Next's hydration/style scripts still require inline allowances.
There is no raw HTML injection or DOM replay. Video codecs run in the browser's
media decoder: this is not protection against browser decoder vulnerabilities.

The viewer must check the sensitive-content acknowledgement and press **Load
private recording**. That triggers an exact-origin, CSRF-protected POST creating
a 15-minute opaque HttpOnly/SameSite cookie scoped to this attempt's replay path.
Only its digest is stored, bound to the current owner, attempt and actual provider
session. Every metadata/playlist/segment/dashboard request repeats owner and
binding checks as well as consent expiry. An owner change cannot reuse the grant.
Loading the report alone never calls the recording provider. Readback is manual,
at most twelve checks per mounted viewer and at least five seconds apart.
Owner revision, hiding the recording, or changing attempts destroys playback.

Browser-safe statuses:

- `processing`: trusted session still running, provider 202/409/429, or local
  request/concurrency budget; retry with a bounded UI policy.
- `unavailable`: disabled/unapproved recording, unknown provider/network failure,
  malformed association, 404, empty recording.
- `expired`: trusted expiry deadline elapsed or provider 410.
- `unsupported`: no configured CDN origins, unknown provider format, unsafe
  metadata/playlist/assets or safety limits exceeded.
- `ready`: metadata and the first page's playlist passed validation under the
  authenticated provider contract. Later tabs are validated on demand and can
  individually fail. This is not a claim of provider-independent media attestation.

`REPLAY_POLLING` recommends at most 12 attempts, five seconds apart; then stop and
offer a manual retry. There is no server polling, retry loop, or paid session
allocation. Share a single adapter per server process; HTTP-layer per-owner rate
limits and deployment-wide request budgets remain the caller's responsibility.

## Limits and threat model

SDK API retrieval is fixed to `https://api.browserbase.com`, GET-only, no
environment base-URL override, no redirects, zero retries, bounded response
buffering and ten-second operation deadlines. Metadata URLs must exactly match
the requested session's documented relative page path. Legacy rrweb events,
download-link objects and cross-session metadata fail closed.
The provider refuses to run with `DEBUG=true`, because the pinned SDK's debug
logger prints authentication headers. Keep keys and diagnostics server-only.

HLS playlists are capped at 256 KiB / 2,000 assets. Only finite VOD media playlists
using a single MP4 initialization map and basic numeric timing tags are supported.
Master playlists, encryption keys, nested manifests, byte-range tags, alternate
audio, live playlists, custom extensions and unexpected tags are rejected.
This deliberately conservative subset may reject a valid provider playlist when
the provider adds tags; extend only after verifying official format/fixtures.

CDN downloads carry no API key, cookies or application credentials. They use
exact configured HTTPS origins, reject URL credentials/fragments/nonstandard
ports, resolve IPv4 DNS, reject private/reserved/non-global addresses, and pin
the selected public address to the TLS connection. Redirects are never followed.
IPv6-only CDN origins are currently unsupported. Media bodies are capped at
16 MiB and must start with an expected MP4 box; they are served only as video.
The MP4 header check is not ownership proof or a full codec/container validator.

Memory is bounded by 32 session cache entries, four manifests per entry, 64 KiB
metadata, and at most four concurrent operations. Success caching lasts one
minute; failures can retry after five seconds. A combined process-local budget
of 100 metadata/playlist/segment requests per minute bounds proxy traffic.
Configure app limits to account for multiple processes; caching is neither
authorization nor a durable artifact store.

## Honest dashboard fallback

`fallback: "operator-dashboard"` is a UX hint, **not a public replay URL**.
The protected attempt's `/replay/dashboard` route repeats ownership and sensitive
playback-grant checks, loads the exact trusted attempt's provider UUID, constructs
`https://www.browserbase.com/sessions/UUID` server-side, and redirects there.
Viewing that dashboard requires a separate Browserbase account with access to
the session/project; the application grant does not confer provider access.
Do not imply every report viewer can use this fallback. Do not accept a redirect
destination from the client or reuse stored arbitrary replay/live-view URLs.

## Offline validation

`npx vitest run src/server/reports/replay.test.ts`

The provider and CDN transport are injectable trusted server dependencies.
Tests use synthetic metadata, playlists and small MP4-header fixtures; SDK tests
replace global fetch. No CI test needs a provider account, API key, live session,
secret or network call.

Provenance regression tests cover two actual distinct session caches sharing the
same CDN/page numbers/asset indexes, interleaved completion, map and segment
isolation, rejection of A metadata pointing to B without poisoning B's cache,
snapshotting provider metadata, and rejecting client-supplied URL/UUID selectors.
An HTTP regression creates two existing attempts in the same owned run: A's
opaque consent grant cannot read B's metadata, playlist, map, segment or dashboard;
B's own grant succeeds and resolves B's provider session.
An explicit boundary test documents that replacing the trusted provider with
lying server code is outside the client authorization threat model.
The `replay-api.test.ts` suite exercises public owner/cross-attempt access
and consent checks; these checks cannot be inferred from adapter-only fixtures.
Offline test success is not evidence that live browser playback was observed.

## Read-only provider check

The existing closed UI proof was used only for explicitly authorized operator
readback, not as an authenticated application-owner proof: its original opaque
owner cookie was intentionally not retained. Seven bounded reads independently
reconfirmed `COMPLETED`, retrieved real session/page HLS twice (raw API and
protected adapter), and fetched one initialization asset and one MP4 fragment
through the pinned public-address transport. The adapter reported `ready`; the
assets were 860 and 2,455,113 bytes. This allocated **zero browsers** and made
zero inference calls. Metadata, signed URLs, media and the exact origin remain
in ignored private storage; original proof files/database were not modified.
This verifies readback/proxy availability under the authenticated provider trust
contract, not browser playback or authenticated owner-report acceptance. Those
require the separate legitimate-owner proof. It is not independent attestation
against a lying provider. No new provider calls were made for boundary research.

## Authenticated application playback proof

The final supported adapter also passed a new genuine-owner application proof,
not just the older operator readback. The durable attempt's recording was
`ready` on one manual metadata check. After explicit sensitive consent and
keyboard activation, the actual browser advanced 3.898913 seconds and decoded
119 frames with visible project-board pixels. The browser received one
same-origin protected playlist and three protected media responses, never an
upstream signed URL. Private desktop/mobile and decoded-frame captures were
inspected, not published. Both layer06 sessions were independently remotely
`COMPLETED`; exact accounting, including the first downstream harness failure,
is in [WORKER.md](WORKER.md#layer06-accepted-proof-2026-09-19).

This verifies the current pinned SDK/HLS player/transport path under the
authenticated provider contract. It does not guarantee future provider
availability, another plan's features, arbitrary playlist extensions or
provider-independent media attestation. Missing configuration and processing,
unavailable, expired and unsupported recordings still use the explicit states
and account-gated fallback above.
