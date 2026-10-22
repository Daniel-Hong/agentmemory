# Session-end retry diagnostics

## Established operational evidence

The explicitly authorized one-time body-excluding head query succeeded at 2026-10-22T02:07:49Z. The 326-byte head was a session_end request with 22 attempts, a timeout/abort classification, no HTTP status, and nextAttemptAt 02:11:19Z. No body, session identifier, raw error or credential was returned. The tiny head is distinct from oversized observation capture and the 15-second namespace certification deadline. The 5-second caller budget and session ordering explain repeated retention; the server stage responsible remains unmeasured.

## Added development diagnostics

Only the legacy drain worker enables the client sink. It atomically replaces a 0600 `.legacy-retry-diagnostics` file in the existing outbox, at most once per minute. Eight snapshots, four operation summaries per snapshot and a 16 KiB serialized ceiling bound retained metadata. The filename is not a queue JSON file. Counts describe selection, ordering/backoff skips, budget/limit stops, sanitized request/error classes and acknowledgement/retention outcomes. Temporary diagnostic files are removed best effort; crashes may leave a small nonqueue temporary file. Diagnostic IO has no durability/fsync requirement and failure does not alter ACK/unlink/retry results. No extra HTTP requests occur.

The server warns for session-end requests still pending after four seconds and for slow completion/failure. Allowlisted stages distinguish session lock/read/write and feature lock/session/observation/state operations. Timers are capped at eight; logs at two lines per minute. Spans are process-local sequence numbers, with no persistent identity or matching client/session identifier. Emission exceptions are ignored. No request, LLM or storage deadline, ordering, retry policy or durability verification changes.

## Limits and activation

The four-second timer can itself be delayed by a busy event loop. Stage time includes awaited SDK work and is not a CPU/I/O breakdown. feature_lock_wait includes initialization readiness and keyed-lock waiting. Eight permanently hung requests suppress subsequent spans. Rate limits suppress some events; client and server events cannot be individually joined. Process restart resets diagnostic rings/sequences. Historical aggregate 190 spool attempts still have no individual identities, and diagnostics do not prove recovery or clear warnings. .19 acceptance remains pending while the legacy backlog is unresolved.

No operating files or service were changed. Server activation needs a reviewed server candidate and restart through the existing release path. Collector activation additionally changes `long-session-hook-client.mjs` plus its generated manifest and requires the appropriate worker restart. The current exact client-transition allowlist covers `_capture.mjs` and the manifest, so it does **not** authorize this client-script replacement. Do not expand that policy implicitly or replace the script through another route. A separately approved exact transition or a server-only diagnostic rollout must be chosen before activation. Preserve outbox originals and historical counters. Code rollback removes the diagnostic behavior; do not rewind or delete stored records.

Synthetic tests cover retry/ACK preservation, thrown/rejected diagnostic callbacks, same-session ordering, backoff, bounded rings/concurrent writes/privacy, timer limits, and actual API through feature observation-read stage wiring. They do not establish the production server bottleneck.
