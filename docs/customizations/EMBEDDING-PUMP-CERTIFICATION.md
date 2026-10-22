# Same-pump embedding intent certification (development)

## Change and safety boundary

The embedding recovery pump already selects at most five items. It now prepares that same bounded selection, groups only matching canonical namespaces, and certifies independent source/intent pairs together. Each pair independently captures current SDK values. Its reader request selects the bounded union of group keys, allowing later ready pairs to join an already active scan without waiting for slower SDK captures. Every pair keeps its own expected values, revision recapture, complete namespace parsing, fsync, final signatures and failure outcome. One wrong pair cannot certify itself or make a correct pair fail. Capture/readback consume the unchanged maximum 15-second absolute budget. There is no completed-result cache.

The group reader admits at most five pairs / 200 keys. Four real SDK gets can be in progress per fence's grouped API; a timed-out but unresolved SDK call retains its slot until it actually settles. Queued expired work never starts. Existing shared-reader bounds remain eight readers/waiters, 200 selected keys and 4 MiB selected projections; larger unions fall back to existing independent verification, never unverified success. Separate ordinary waitForKeys callers retain their existing independent admission; this is not a global SDK concurrency claim.

The pump acquires its at-most-five model locks in sorted order. Intent locks are short and released before inference. LLM calls remain sequential. Before each call it rechecks stop/pause, queued generation/fingerprint and canonical text. After inference it checks ownership and canonical text again under the intent lock before mutating the vector or retry phase. Foreign generations survive success and error paths. Failed SDK preparation/certification keeps pending state and other items remain eligible. Stop/pause prevents further inference; already started readback finishes or expires normally, without pretending the SDK call was cancelled. Foreground enqueue and backfill acknowledgement paths are unchanged and must still complete their actual certificates before returning success. Publication still needs durable index flush and committed-marker verification before retry deletion.

## Measured synthetic comparison

2026-10-22, development checkout versus its .18 HEAD, scheduled before/after/after/before. The last baseline trial briefly overlapped targeted tests and is excluded from timing conclusions; the first baseline and both new-code trials ran without that overlap. Identical 253,004,357-byte mixed numeric/text namespace, 14,083 filler entries, four source/intent pairs, delayed synthetic SDK gets, real parser/stat/fsync/final signatures. Default 15-second deadline. No engine or model calls, private input or operating changes. The baseline starts four independent pair certificates concurrently; the new API requests their bounded union of keys without a capture barrier. This measures certification, not end-to-end embedding throughput.

| Metric | .18 independent pairs (1 timing run) | Grouped independent pairs (2 runs) |
|---|---:|---:|
| Wall time | 8.69 s | 2.21–2.22 s |
| CPU time | 9.29 s | 2.41–2.42 s |
| Scanned bytes | 1,012,018,008 | 253,004,502 |
| Physical reads incl. tiny retry namespace | 8 | 2 |
| Shared requests / total requests | 0 / 8 | 6 / 8 |
| Successful pairs | 4 / 4 each run | 4 / 4 each run |

Raw development-only evidence is outside the repository in `../pump-batch-development-evidence/comparison.json`; its reproduction script is `compare.mjs`. Endpoint RSS was ~102–103 MiB after grouped runs and is not a peak-memory guarantee; the projection limits above are the actual code bounds. Temporary-filesystem results do not model real engine publication timing, disk contention or production CPU pressure. Both modes succeeded, so these trials demonstrate less work and latency, not a measured timeout-rate improvement. Existing synthetic replacement/cancellation/fsync tests and new group mismatch/deadline/revision tests cover correctness separately.

## Warning semantics and limits

Legacy outbox warning remains while retained ownership is pending or its metadata is unavailable/incomplete. Fewer retries might help existing delivery, but this development test proves no operating record delivered. Historical 190 failed append attempts are aggregate attempts, not 190 unique identities or proven losses. There is no per-failure ledger enabling complete retrospective reconciliation. Later receipts or an empty legacy queue do not establish recovery of every past failed attempt. Existing 24-hour warning visibility expiry is a display policy, not acknowledgement or recovery; original counters remain intact. Tests pin these distinctions. No warning or counter is acknowledged, hidden or reset by this patch.

A slow/mismatching pair does not prevent healthy pairs certifying within their own deadline. The pump still waits for all per-item results before serial inference, so inference for already-certified peers can wait until the slow pair finishes or expires (up to the existing deadline). Namespace replacements may still cause full rechecks. Single-item or disjoint-namespace batches may see no benefit. Small files or SDK captures arriving after a physical scan completes can require fresh reads; completion results are never cached. Large selected projections may fall back. No timeout, input budget, LLM serialization, engine format or administrative trust/permission changes are included.

## Rollout proposal, not executed

Server-only replacement via the existing reviewed SSH candidate/recovery route, based on the actual live .18 baseline after revalidation. Collector hashes must remain unchanged. Preserve all current data, outbox, spool, retry/committed state and historical counters; code rollback must never restore old data. Deployment/restart requires separate operating approval. Recheck health/version/holds and existing workload, then compare a bounded 20-minute window of durable receipts, outbox ownership delta, new drops, per-item readback failures, scan bytes and sharing with workload/file-size caveats. Do not clear a manual/protective hold or mark acceptance complete merely because no new warning appeared. Recovery restores compatible server code with current state preserved.

Upstream replacement is suitable only after equivalent independent per-item file verification, lifecycle/ownership, failure isolation and acknowledgement tests pass. External notifications, Windows changes, web candidate registration and upstream PRs remain excluded.

## Independent review and regression evidence

An independent AI source/fixture review identified and verified fixes for foreign-generation writes after inference, invalid provider responses and hinted projection fallback ownership. The final review found no remaining important issue; it did not claim to execute operating tests. Targeted regressions include a hanging capture with healthy peer completion, unresolvable SDK slots across repeated batch deadlines, actual 6 MiB projection fallback to item-specific keys, cancellation isolation, delayed real-file pump certification, partial failures, restart and unchanged foreground ACK. Required aggregate gate results are recorded in the external validation receipt.
