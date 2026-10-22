# Capture review metadata candidate (development only)

`GET /agentmemory/capture/review-metadata` uses existing REST authentication and
does not retry, acknowledge, delete, reset, or change history. It is not installed
or called on the operating service as part of development.

## Privacy and evidence

The query lists only `mem:capture:review`, then reads completion-event metadata,
embedding retry intent and committed marker metadata. It never lists/reads capture
inbox, canonical observations, preview, source text, provider credentials or the
legacy outbox. No actual operating data is used in fixtures or committed files.

Returned fields are fixed metadata: recorded status, attempt counters, sanitized
recorded failure code, timestamps, receipt/intent/marker classification and next
required verification. Identifiers, generations, fingerprints/digests, project,
session, raw errors and preview are not returned. `reviewRef` is a random,
non-authenticating correlation reference; it is not an encoded identifier or a
digest. It remains stable only in the current process epoch. Restart or loss of
the recorded history invalidates it; an old reference is never reassigned.

History may lag the live inbox. `inboxState` and `canonicalState` therefore remain
`not_checked`, and `intentGenerationRelation` is `not_recorded`. All responses keep
`retryAuthorized:false` and `diskVerified:false`. A committed marker or completed
receipt is metadata, not proof of a current durable original. Unknown shapes,
read errors, unsupported receipt states and identity conflicts cannot become a
verified completion or recovery claim. Legacy coarse failure codes are not
retroactively upgraded to specific intent-change evidence.

## Bounds and semantics

- Default recorded status is `dead`, page25; maximum50. Offset0..5000. Optional
  process-local `reviewRef` selects a recorded row without exposing its real key.
- One active query per controller; two-second budget. An uncancellable SDK read
  keeps the slot occupied until it actually settles. No subsequent reads start
  after the budget. A selected row can report unavailable metadata.
- At most5000 history rows are accepted; larger results fail closed. **The SDK
  `state::list` API retrieves the whole metadata scope before this check. This is
  not a hard disk-read or SDK-memory bound.** No new paged store is introduced.
- Reference memory is bounded by accepted history keys and pruned for removed
  keys. Pagination and metadata reads are live/non-atomic. Recorded totals are
  not current inbox totals, and changes between pages can affect coverage.
- Every HTTP outcome is `Cache-Control:no-store`. Invalid/unknown fields,
  preview, real IDs, digest or key filters are rejected before SDK lookup. The
  existing preview/retry endpoints and their permissions are unchanged.

## Validation

Synthetic tests forbid inbox/observation scopes and poison content/preview fields
so accidental access fails. They cover existing auth, strict filters, read-only
behavior, redacted errors, deleted/completed/conflicting/unknown metadata, live
pagination, reference expiry, list capacity and outstanding SDK calls. This is
query correctness validation; it is not recovery of operating dead letters.

## Exact next operating approvals

1. If accepted, prepare the existing server-only release route from the actual
   operating baseline and compatible recovery package. Installing/restarting the
   server and calling only this authenticated metadata GET require operating
   approval. No collector, policy, timeout, storage format or root permission
   change is necessary. A process restart invalidates review references.
2. Use metadata and the already permitted aggregate status to select a candidate.
   This does **not** prove it is safe to replay. Stop on deletion, conflict,
   unavailable metadata or an unknown original.
3. Before a single-item canary, obtain explicit approval for internally checking
   that selected item's current inbox and canonical identity/original, current
   generation and durable state, without returning their bodies/IDs. This is an
   additional internal-read scope; it is not authorized by this development task.
4. Bind that selected item internally to the existing retry function using one
   fresh request UUID, retain its original/history, and verify source+intent and a
   completed receipt before reporting success. The present candidate has no
   `reviewRef`→retry write bridge, and an opaque reference is not accepted by the
   existing retry endpoint. That bridge/operating canary must be concretely
   reviewed and authorized before execution. Do not invent a retry command now.

No bulk replay, dead-letter release, audit migration, counter reset, content read,
deployment or restart is performed by this candidate. Historical190attempts lack
individual recovery evidence and are not resolved by metadata visibility.

Upstream replacement: remove this custom route only after an authenticated,
body-free upstream review path passes the same privacy/unknown/read-only tests.
