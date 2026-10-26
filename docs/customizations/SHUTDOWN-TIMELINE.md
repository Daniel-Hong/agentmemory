# Bounded shutdown timeline

The installed .28 service took about 145 seconds to produce a verified worker shutdown receipt on 2026-10-26. Existing receipts preserve the last stage and unfinished workers, not the durations of completed stages. This development change retains the existing progress callbacks in that same receipt; it does not explain the historical delay or improve storage performance.

## Scope and contract

- `verifiedShutdown` records at most 128 whitelisted events and 32 pending worker entries. Excess events are counted; pending-worker overflow is explicit. No key, path, content, raw error, token or record identifier is recorded. Worker ordinals refer only to this process's lifecycle registration order.
- `startedAt` is wall-clock milliseconds; event `elapsedMs` uses the existing wall-clock progress timing. Clock adjustments can distort durations, so these are diagnostic intervals, not deadline authority. Invalid or throwing diagnostic clocks mark coverage unavailable without deciding durability.
- Sequential phase transitions close the preceding phase and start the next. Worker start/done/failed callbacks remain independent, because workers stop concurrently. Stage names describe the pending operation: boot admission, lifecycle workers, ingress, control settling, index saving, durability draining, disk fences and restart guard.
- A work error does not prove the last phase caused it. The last phase is marked interrupted; the overall work result records failed or interrupted. Worker failures have their own explicit callbacks. A completed work event is not a successful durability certificate: `verified`, `errorCode`, `synced` and `mutationFailures` retain their original authority.
- This adds no timer, SDK invocation, file read or per-event disk write. The existing one-file final receipt and atomic write/fsync path are reused. A later shutdown replaces this one receipt as before; there is no new history directory or retention job. The timeline does not survive a crash before that receipt is written.
- Coverage is bounded and non-authoritative. Diagnostic callback failure, clock failure, overflow or late callbacks must not change the work outcome, bypass engine-liveness checking or extend the timeout. Existing receipt I/O failure still makes shutdown unverified.

## Validation and operating status

Run the focused shutdown tests in a temporary HOME with one fork. Cover success, failure, timeout, late callbacks, observer/clock faults, bounded metadata, sticky mutation failure and receipt publication errors. Full/browser/load tests are excluded under the existing low-load requirement.

The earlier readback phase candidate and .28 import compatibility remain separate existing changes; this adds only final shutdown phase retention and the missing lifecycle phase callback. No deployment, restart, hold release, replay, proof-budget reset or data migration is performed. The present normal release path is still blocked by unresolved durability/mutation evidence. A future diagnostic deployment must preserve those guards rather than claiming that this timeline resolves them.
