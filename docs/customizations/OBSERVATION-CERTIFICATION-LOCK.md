# Observation certification and the session lock

## Bounded change

Operating .20 supplied one slow session_end sample: still at session_lock_wait after 4.005 seconds, server completion at 27.331 seconds. It does not identify the lock owner, full phase durations, or the legacy head request. Source inspection found observe holding obs:session while enqueueing and certifying an embedding intent, including the large observation namespace readback/fsync. Compression and summary inference run outside this session lock.

The observe path now mutates the observation, session counters and prompt ledger, and prepares the durable embedding intent while holding the same session lock. A prepared certificate is awaited only after releasing that lock. The intent generation is retained; a legacy/new intent without one receives a UUID. Short intent-lock checks before and after the long existing fence ensure a replaced or deleted intent is never overwritten or acknowledged as the old generation. Certification is memoized per request, including rejection; no completed-result cache is retained. Existing enqueue and background pump behavior remain unchanged.

Source identity must exist and match id/session. A monotonic observation-reader mutation epoch and active scope count reject any source mutation overlapping preparation/certification. StateKV marks mutation start synchronously and finalizes on success, rejection and synchronous exception, covering SDK apply-before-response and response-loss windows. Finalization is idempotent and active scope entries are removed at zero. The epoch is independent of the fence touched-key pruning. No raw source is copied into a new diagnostic or logged.

Observe and duplicate restoration return success only after the original file fence, final source guard and ownership checks succeed. Failure leaves the original source and durable retry/inbox paths available. File readers lacking the guard retain the old locked certification path. The existing non-deferred restoreIndexEntries behavior remains compatible for other callers. No global LLM, timeout, retry/backoff, capture receipt identity, final-signature or fsync rule changes.

## Synthetic evidence and limits

The pre-change .20 source and development change ran identical new-capture and duplicate fixtures twice in alternating order. A controlled 250 ms certificate delay yielded session-end waits of 250.57–251.46 ms before and 0.19–0.38 ms after. Capture acknowledgement remained after the gate in every trial (about 301–305 ms including test synchronization). This measures the isolated locking mechanism, not file scanner throughput, production completion latency or a five-second response guarantee. Full metrics are retained outside the repository in the workspace session-lock-development dossier.

Regression tests exercise real observation/recovery/session functions; source/intent replacement and deletion; simultaneous duplicates; failure retention; abandoned caller waits; restart from current canonical rows; actual file readback/fsync/signature mismatch and timeout; and real StateKV with a synthetic SDK applying a write before holding/rejecting its response, both before and after preparation begins. No private record, production workload or model inference is used.

A scope-wide mutation conservatively fails this request even if another observation changed. Concurrent compaction therefore retains/retries instead of accepting a potentially changed certificate; a later retry certifies the canonical state. Pending SDK calls can conservatively block certification. Other existing enqueue/pump paths may still hold an intent lock for longer; initial namespace scans, stream RPCs and SDK waits remain. This patch does not prove that the observed 27-second request or all legacy backlog will be fixed.

## Proposed operating scope

Not deployed. A later approved server-only release would use the actual operating baseline and existing compatible code-only recovery route. Compatibility scripts/manifest and collector worker stay unchanged; no permission or enrollment policy expansion is required. Verify startup/health/holds, unchanged client hashes and original preservation, then observe natural retries and completed delivery evidence with body-free metadata. Preserve historical counters and keep acceptance pending unless real criteria pass. Roll back code only; never rewind or delete outbox/state.
