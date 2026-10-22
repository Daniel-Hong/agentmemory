# Compression cost, recovery evidence and truthful failure metrics

Development changes only; operating acceptance and the legacy backlog remain unverified by this patch. Do not interpret this document as deployment or a claim that every fifteen-second timeout is fixed.

## Compression and ordering

Compression previously materialized a complete observation namespace inside the session lock merely to locate the old row and calculate the existing live-source budget. Reuse the observation reader's existing incrementally maintained captureSummary metadata, excluding the replaced ID, and use a point read for its previous sourceRaw/syntheticCompression. Backends without that capability retain the old list path. Uncertain metadata fails closed before replacing source. Cold metadata still needs a full validated initialization scan; this is not a positive disk-verification cache. All embedding source/intent certificates, signatures, fsync, generation checks, deadlines, global serialized inference and input budgets remain unchanged.

A repeated real session_end must preserve its original endedAt when the session is already completed. The existing API still performs feature enqueue, so a lost acknowledgement can retry without rewriting termination time or silently skipping recovery.

## Evidence and coverage

The authenticated read-only GET /agentmemory/embedding/receipts accepts only 1–32 unique bounded IDs. It reuses one query factory with four outstanding SDK-read slots and one maximum five-second query deadline. Timeouts do not claim SDK cancellation or free unsettled slots. No bodies, session IDs, fingerprints, generations, credentials or arbitrary error strings are returned.

The response separates pending, missing/mismatching source, index pending/missing, committed metadata and publication_verified_observed. The latter requires a matching bounded runtime observation made only after the existing durable index flush, committed-marker fence, latest canonical check and retry removal. Its meaning is historical proof observed by this process, not fresh disk verification at query time: diskVerified and completionConfirmed stay false. New intent preparation invalidates proof. History is capped at 512 IDs; eviction, restart or an instrumentation error yields unavailable/metadata-only evidence, never invented completion. Query scope mutation guards explicitly cover observation sources and the four fixed existing memory/retry/committed/vector-pending scopes.

Detailed certificate history stays at eight samples. Additional fixed-key since-process counters record every completed fence outcome, verified/failed/unknown and sanitized failed stage/reason independently of detailed sample initialization and eviction. They count certificate outcomes, not unique lost observations, first attempts or provider requests. Logical scan bytes remain distinct from physical disk IO.

## Current versus historical metrics

Historical function totals remain persisted across normal restarts with no fabricated collection start or counter reset. Recent function statistics are process observations with real start/end timestamps and at most fifteen minute buckets for each of 512 function IDs. Historical reads do not consume observed-function slots. No prior twenty-four-hour failure rate is reconstructed from lifetime totals. Compression internal output retries are part of one recorded function attempt; summary checkpoints and graph batches count different units. Their historical ratios are not comparable model-quality scores.

Both HEALTH and dashboard retain historical totals neutrally, including disabled functions. Highlight observed new failures rather than every historical nonzero value. Show current pending/retrying/quarantine and unknown outcome separately. Missing or reset observation history is unknown, not zero. The historical 190 append attempts have no per-attempt identity ledger; neither zero current failures nor an empty backlog proves every historical attempt recovered.

## Synthetic validation and limits

Full-path tests use the actual compression function, serialized synthetic provider, StateKV, real temporary namespace files, file fences and index persistence. They preserve original records and distinguish first function outcome, source/intent certification and final publication. Fixed 253 MB cold/warm comparisons separately report metadata warmup and scheduled writer/publication lateness. A 17-second publication delay correctly exceeds the unchanged 15-second certificate budget, reports failure and retains ownership; later recovery can still publish successfully. Such a correct deadline failure must not be converted into success.

The reduced full-list work is a CPU/latency improvement candidate. Existing positive comparisons had no certificate timeouts before or after, so they do not demonstrate a first-attempt timeout-rate improvement. Writer churn, delayed publication, non-overlap, large projections and cold metadata remain limits. No new pump/inference orchestration was introduced: coupling first certification admission to a pump waiting on slow inference could create a new head-of-line timeout.

## Rollout and upstream replacement

After aggregate checks and independent review, propose one server-only release from the actual operating .21 baseline using the existing supported candidate/recovery route. Collector files, permissions, historical counters, originals and retry state must remain unchanged. No forced replay, deletion, storage migration or notification is included. A restart interrupts service briefly and permits the existing automatic work to continue. Request operating approval only after reporting the combined scope and measured limits. Code-only recovery must preserve all current data; process-local evidence/recent windows restart as unknown coverage.

Operating acceptance requires health and generation correctness plus body-free receipt reconciliation and a comparable observed interval; a lower backlog or cleaner screen alone is insufficient. Upstream replacement must retain these safety, bounded-query, metric coverage, idempotency and source-budget tests. Personal fork only; no upstream PR. Durable memory recording remains separate manual-review policy.

### Fixed synthetic comparison (2026-10-22)

The full path used a 253 MB synthetic observation namespace, two serial compression calls, controlled foreground writes, up to four recovery items, the existing global inference lock and real temporary file fences/index persistence. One normal and one delayed-publication run per variant are useful mechanism evidence, not statistical production estimates. Metadata warmup was about 1.33 s and was reported separately.

| Condition | Frozen baseline, warm metadata | Candidate, cold metadata | Candidate, warm metadata |
|---|---:|---:|---:|
| Normal whole-scenario wall | 10.51 s | 8.51 s | 6.14 s |
| Normal CPU | 12.39 s | 9.90 s | 7.32 s |
| Publication delayed 6 s, writers and recovery, wall | 16.99 s | 15.68 s | 14.42 s |
| Same delayed scenario CPU | 14.07 s | 12.41 s | 10.96 s |

Both first calls succeeded in these positive scenarios. Certificate scan bytes did not decrease (normal 1.063 GB to 1.155 GB; delayed 1.456 GB to 1.538 GB), so this must not be reported as fewer certified bytes or a lower fifteen-second timeout rate. The removed work is the separate pre-certification whole-list materialization; changed timing also affects retries/sharing.

A separate matched writer-at-scenario-start regression reproduced the old first compression failing at 6.130 s with state_namespace_changed before any compressed write. The candidate completed both target compressions, with verified committed markers, no remaining target retry, original source retained and maximum inference concurrency one. Raw scenario wall was 11.27 s before versus 14.14 s after, but the baseline only completed one target and never exercised the first-write publication gate; it is not a same-work throughput comparison. Evidence and frozen source hashes remain outside Git in compression-first-development-evidence/budget-comparison-summary.json.

### Existing late-spool feature boundary

A small capture may transfer ownership to the managed local spool before the server receives it; session_end may therefore reach the server first. Synthetic full-flow tests confirm the original is retained by that spool and later stored. A queued feature operation reads current observations when it runs, so a late arrival before execution can be included. If the feature operation already completed before arrival, unchanged turnAt does not automatically re-enqueue it. This existing scheduling boundary is documented, not silently changed into extra inference/reprocessing or described as data loss. Fixing that policy would require an explicitly described refresh scope; no collector replacement or feature-scheduling expansion is included here.
