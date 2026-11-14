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


## 2026-10-30 completion contract development

The existing rebuild/recovery policy is shared as `Boolean(title && narrative)` without changing live publication. SDK reconciliation separately requires string fields. New v2 metadata distinguishes required keyword membership from empty-title/narrative exclusion and records actual membership/owner plus mandatory vector owner. It binds the initial text projection, applicability/membership, original failure history and preserved inbox fields throughout the four existing writes. Eligible dead and retrying records retain their prior state until the final SDK archive; no retry, source replay, receipt creation, text/index repair, budget/circuit reset or pause bypass is introduced. Historical v1 dead resolution remains readable and resumable under its original both-index contract. Completed v1/v2 records describe historical SDK completion; legitimate later derived-text changes do not invalidate the original completion metadata or source protection.

Validation before independent review: real `indexRecords`/`SearchIndex.add` characterization; focused in-memory failure injection before/after all four writes for dead/retrying; empty/present/missing/wrong-owner, pending vector/clear, changed projection/inbox/history, admission loss, v1 continuation and consumer checks. Full precommit validation remains assigned to the controller after review. A separate immutable old42 source harness confirms its validator rejects v2 while generic duplicate/count consumers still report SDK completion. Thus old42 active rollback after v2 state writes is unsupported. Preserve originals/state and pause for compatible forward repair, or obtain a compatible rollback build before separately approving adoption.

Deployment state: development only; installed42, its pause/admission gates, operating data and client settings remain unchanged. A later approved maintenance/admission window must satisfy the existing writer/background gates; general background resume is not approved. Index observations are bounded per-item checks across awaited writes, not a global transaction or disk-durability guarantee. No candidate/version bump is created. Replace this customization only when upstream passes the same eligibility/evidence, v1/v2 partial-write and immutable-history/source preservation tests with compatible stored records and consumers.

Final whole-review corrections: the preserved-original inbox digest excludes the existing mutable SDK source-restore request/state/attempt counter fields, while original payload, capture attempt counters/schedule, manual request and unknown original fields remain bound. Actual registered restore consumer tests cover both present and missing observations after v2 completion. Fresh reconciliation attempts retain initial evidence binding through the final post-write proof; only completion already committed on entry uses historical evidence semantics. No global index lock or new recovery behavior is introduced.


Final development verification (2026-10-30): build, skills generation/check, docs sync/check and the final default-fork single-worker suite passed: 5,659 tests, 13 existing conditional skips, zero failures. Status history validation now runs in batches of four; a delayed-read regression first observed peak10, then passed with the same count9 and ten validations. The prior broad pre-batch suite5658/13/0 is retained separately. Full tsc was not green:30 diagnostics outside changed files were recorded without a separate baseline-equivalence run.

A bounded native integration used installed SDK0.25.1/engine0.22.1, isolated HOME/store and two synthetic originals (empty-narrative dead and ordinary retrying). Seed/restart/verify completed25.268s, peak observed aggregateRSS193077248B/disk378510B, both v2 records survived normal restart and repeated reconciliation performed zero additional writes. All test processes/ports exited and temporary data was removed; logs remain outside cleanup. The first preparation attempt stopped before seed writes on an incorrectly early test admission assertion, then the reviewed fixture restored the existing ordinary-seed/recovery-restart distinction. This is normal-restart SDK persistence evidence, not power-loss/fsync proof, native restore-endpoint coverage, operating adoption or a full-worker test. Real registered restore consumers (including repeat calls, present/missing observations) were covered by isolated synthetic SDK/KV tests.

Current deployment distinction: installed42 at source04c9daef already has v1 reconciliation and the snapshot-input/read-only-index changes; the earlier v1 operating-boundary/audit paragraphs are historical. This new v2 development commit is not installed, no candidate/version bump was prepared, and remaining10/19 state transitions were not executed. Existing pause admission still requires a separately approved normal resume before selected reconciliation; no maintenance bypass was added. Any future deployment must finish while held before v2 adoption starts. Automatic rollback during that pre-adoption deployment does not authorize active old42 rollback after v2 state writes.
