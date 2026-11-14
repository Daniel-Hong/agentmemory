# Capture inbox read recovery — daniel.60

## Evidence and goal

The deployed .59 inbox contains 5,074 retained SDK-acknowledged originals. Its serialized SDK list is 67,220,776 bytes, above the 67,108,864-byte SDK WebSocket maximum. `status: pending` alone does not mean these retained records need delivery; `storageCompletion: sdk` is a separate acknowledgement, not proof of disk persistence.

The fixed .59 package and native engine reproduced the failure with synthetic data: `state::list` exceeding the limit disconnects the requesting SDK, and a normal `/status` call disconnects the worker SDK, transiently making health return 500/404. Worker and engine PIDs survive. Recovery must allow capture, status, review and retry to work as retained originals accumulate, preserve all originals and avoid treating uncertain delivery as completion.

## Approaches and choice

- Increasing the frame limit postpones the same failure and increases peak serialization/parse memory. Completion retains originals, so the collection keeps growing even when work succeeds.
- Native keyset pagination would avoid full namespace transfers but the installed engine exposes only `state::get` and `state::list` for this path. Changing the native engine and SDK protocol is unnecessary for this incident.
- Reuse the existing local namespace streaming reader with the existing acknowledged-write overlay. Project each disk record immediately into the metadata needed by consumers; fetch selected originals individually for processing or proof. This is the implementation choice under the user's instruction to select and implement the best solution.

## Read boundaries

The file backend streams fixed-size chunks and parses one record at a time. Inbox list consumers retain metadata and bounded previews, not every payload. Existing list ordering, page limits and filters remain. Capture admission's initial size scan is cached by the controller; it is not repeated for every capture. Retry and sweep select keys and use the existing `retryOne` keyed get/lock before processing.

The shared reader overlays acknowledged changes, including deletes, until the file contains them. Reads return independent values, so a caller cannot mutate cached acknowledged state. Concurrent file replacement is detected and retried at most once; uncertain mutations fail closed. The full-list interface remains compatible for callers that explicitly need it. Redis behavior is preserved; this release does not claim native Redis pagination.

The first packaged native trial removed disconnects and completed a new capture in 124ms, but exposed another bottleneck: status performed 5,074 individual history reads and exceeded its five-second budget. The final implementation also reads a keyed review metadata projection once. Only records with reconciliation markers require the original full history/source verification. Physical keys must match the history identity; malformed or uncertain records cannot produce a completion count. Backends without that local reader keep the original SDK lookup path. The count is an informational snapshot, never an authorization or disk-completion proof.

This bounds retained disk payload memory to a record at a time, plus metadata for all records and acknowledged payloads not yet confirmed in the file. It does not make memory independent of item count or eliminate scan I/O. Pending acknowledged payloads must not be discarded just to lower memory use. Completion proofs still check source/hash/history consistency; proof paths that need payloads load only selected originals.

## Explicit source recovery

Existing pending source references use the normal delivery implementation. Selected held sources require an explicit product restore entry, exact source revalidation and an atomic owner claim. Normal hooks do not invoke restoration. Only a fully matching SDK restore response may acknowledge a reference; SDK acknowledgement remains distinct from later disk/index acceptance. A response loss leaves evidence for inspection and must not be blindly retransmitted. Original chunks remain preserved.

## Verification and rollout

Regression tests cover oversized inboxes, bounded metadata projections, current acknowledged update/delete overlays, caller mutation, uncertain writes, concurrent reads, existing pagination/preview behavior and valid/invalid resolution proofs. The packaged native trial must exceed 64MiB, include thousands of SDK-completed records, run actual status/list calls while health remains available, and confirm process and SDK connection continuity. Native raw `state::list` remains limited; product consumers must avoid it.

Build and package a separate .60 server candidate. Preserve the issued .59 bundles and installed compatibility hooks. Recheck the normal SDK shutdown/COW engine deployment path and retained WAL coverage. At 11:18 KST, .59 reported a new mutation failure; its cumulative uncertainty cannot satisfy the normal shutdown certificate. That gate must remain closed. A separately reviewed recovery transaction must preserve the failed shutdown result, current disk state and process identity, and must not claim application flush verification. Do not restore an older data backup. After administrator activation, verify exact runtime identity, capture source acknowledgement, index publication, per-item physical vectors and a stable observation window. Historical memory-only writes lost before .59 and the new uncertain mutation remain unverified unless separate evidence resolves them.

The final product bytes passed an isolated native trial with 5,074 originals (73,981,775 serialized bytes): status 790ms, 25-row list 1,377ms, review 1,248ms and new capture 70ms. All 25 concurrent health samples returned HTTP200; worker and engine identities remained unchanged, without SDK reconnects. Physical re-read verified every original against its full seed value. Peak memory was 747,687,936 bytes under a 1GiB cap with no OOM. A concurrent checkpoint replacement invalidates the whole physical read; the harness retries only that generation-change error, preserving exact equality and missing-row checks. Product and administrator acceptance remain distinct from operational collection/index acceptance.

All 39 build configurations, SDK bundle audit, documentation and skill consistency checks passed. TypeScript reports the same 30 inherited diagnostics as .59. The full regression run exposed one fixture that populated review history behind the new local reader; routing its setup through `StateKV.set` restored all 29 tests, with 55 related tests passing. The fixture changes no product bytes. The final isolated full run passed 6,408 tests in 548 files, with 69 tests skipped and no failures. It uses the default fork pool and a temporary HOME; the normal integration suite and the inherited minimum-12GiB summary SDK boundary suite are excluded, as in .59. Frozen hashes and administrator results are recorded in the November 7 incident dossier; no production success is inferred from these isolated checks.
