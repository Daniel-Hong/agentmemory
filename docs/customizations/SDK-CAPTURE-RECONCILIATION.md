# Selected SDK capture reconciliation

Development baseline: d1e3f442 (.40). No operating deployment or capture status update has been performed.

## Contract

The read-only membership endpoint accepts at most 32 explicit observation IDs and reads the current keyword/vector Maps synchronously. It returns membership and hashed session ownership, not raw source, embeddings, disk commitment or a stable future generation. No StateKV list or provider request is added.

The per-key POST requires configured bearer authentication, explicit `x-agentmemory-capture-reconcile: 1`, `captureCompletion: sdk-v1`, a UUID request ID and the pinned original digest. Existing file-writer admission and capture drain apply. The operation checks the selected original, canonical source identity/digest, deletion marker, current keyword/vector session ownership and publication fingerprint. A missing or conflicting dependency stops it.

Four SDK-acknowledged metadata writes publish pending review intent, a pending original link, completed review resolution and the completed SDK-original archive link. Each boundary is rechecked under the record gate. A failed acknowledgement does not mean success: preserve the request ID, inspect its read-only recorded status, and resume only after writer safety is established. Recorded status verifies its source/history pair but is not fresh index or disk proof. Same-key requests serialize; completed repeats verify rather than replay.

The original payload, old errors/failure requests/counters and automatic-recovery checkpoints remain. No observation replay, source deletion, provider call, strict disk receipt, budget reset or automatic recovery enable is performed. A completed original is retained by the existing SDK archive policy. Only an exact completed resolution link permits its existing selected conditional source-restore route; unresolved legacy remains protected.

## Viewer scope

Independent phase parallelization was rejected: unchanged RPC count can still overlap cold scans and increase peak SDK/memory contention. The retained change shares one metrics-read promise with the existing status report. Existing phase ordering and time limits are preserved. This removes one duplicate read; it does not establish the cause or cure of every live 502/504.

## Evidence and limits

The prior bounded source audit matched all 351 selected originals/observations/markers. Existing selected live vector queries proved 18 inclusions; 333 were unavailable, not absent. Full BM25 membership was not proven. These historical results do not authorize operating writes or replace the new per-key checks.

Focused tests cover partial failure before/after each write, process/helper recreation, conflicting requests, source/history tampering, deletion/index absence, original preservation, actual Map membership and capture shutdown/drain. Final broad verification and review results are recorded in the implementation ledger. Real-engine validation must be reported separately from mock StateKV tests.

## Operating boundary and rollback

A later approved server-only deployment is needed before the new endpoints exist in production. Then query current selected index ownership and reconcile only explicitly matched keys, stopping on any storage uncertainty. No operating mutation is currently authorized. This cannot resolve unidentified historical write calls or legacy session downstream queues by relabeling them.

Optional SDK-resolution fields survive code rollback as retained data. Older binaries do not understand this new resolution contract; rollback must stay held until compatibility is explicitly checked, and must never delete source/history to recreate an old state.

Upstream replacement: remove this customization only after upstream provides equivalent selected source/index checks, resumable acknowledgement handling and original/history retention tests. A generic retry or status reset is not equivalent.
