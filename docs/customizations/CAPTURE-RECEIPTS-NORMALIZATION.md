# Capture receipt normalization (development only)

## Problem and minimum change

A legacy outbox is already a durable owner. Its successful HTTP acknowledgement could not transfer ownership when the full record exceeded the managed spool's 256 KiB per-record ceiling. Retry failures then counted repeated failed append attempts. Those attempts do not establish missing or lost observations. Do not reset that history or remove retained originals to clear a warning.

The client now checks an oversized event's exact receipt before POST, preserving its original event ID and full payload. An authenticated, body-free receipt verifies the stored full sanitized source against a canonical SHA-256 input digest, completed-event identity, exact pinned snapshots of both state keys, file/directory fsync and final file signatures. It then rechecks current metadata and observation. Completed metadata, HTTP acknowledgement, elapsed retention time, missing/tombstoned observations, mismatches and unverifiable/Redis storage never authorize release. On failure the existing legacy original stays owned and retries use the existing backoff. No fragmentation, truncation, capacity increase, new scheduler or inference call was added.

Ordinary records continue through the existing fsynced managed-spool handoff. Known oversized records stay in the legacy outbox during outages instead of attempting an append that cannot fit. A near-boundary retained-record failure can also use the exact receipt. The generic direct-capture path has no legacy original and is unchanged; this patch cannot recover a previously lost record. A 7,034,880-byte tool output alone can duplicate to roughly 14 MB inside sourceRaw; retaining both tool_output and tool_response can exceed the existing 15 MiB safe transport budget. This patch does not claim support for such shapes or solve engine frame rejection; originals remain owned when acknowledgement/proof fails. Before any real replay, confirm shape/serialized size or design explicit lossless fragmentation separately. Do not infer ingress or full-engine safety from HTTP mock tests.

## Read-only API and cost

`GET /agentmemory/capture/receipts?key=cap_<40 lowercase hex>` returns only `key`, `state`, `durable:false`. Optional `digest=<64 lowercase hex>` requests fresh proof; optional `budgetMs=1..15000` can only shorten certification. The client shares its existing per-handoff timeout across GET/POST/GET. No raw source, preview, project/session identifier, digest or backend error text is returned. Authentication and `Cache-Control: no-store` apply. Unknown query fields fail closed. There is no positive receipt cache.

The receipt operation permits at most two outstanding requests, including timed-out underlying SDK reads. SDK reads do not expose cancellation; if they remain unresolved, proof slots remain busy rather than permitting unbounded work. Responses and further work check a common deadline; cooperative JavaScript/file IO can still return late under event-loop stalls. The fence's default 15-second semantics remain unchanged for existing callers. Only explicit receipt calls pin their expected values and shorten their deadline. Pinning prevents a superseding B from being certified when a receipt asked for A, including A→B→A memory changes.

`GET /agentmemory/capture/receipts?shard=<2 hex>&offset=0&limit=100` supports metadata-only filename correlation. It returns only capture key, event ID, normalized completion time and completed/deleted state; listing is never durable proof. It streams the completed-event namespace, with a 4 MiB file limit, 2000-entry limit, two readers and a two-second cooperative read deadline. No SDK whole-shard listing, observation/inbox body enumeration, inference or index repair occurs. Backend unavailable, concurrent replacement, invalid metadata or limits produce an unavailable response. Pages are not an atomic snapshot across requests; a missing/pruned receipt is unknown, not proof of loss. A large biased shard requires a separately designed bounded reader, not raising these limits blindly.

## HEALTH behavior

Current local legacy ownership is shown independently from historical append attempts. The local default `AGENTMEMORY_HOME/hook-outbox` directory is counted through directory-entry metadata only: no file body/stat preview, symlink following, filename disclosure or client replay. Work is single-flight and cached for 60 seconds, capped at 10,000 entries; inaccessible/incomplete checks stay visibly unverified. It does not inventory remote clients or prove any file absent on the server. Historical attempts retain their cumulative counter and existing recent-warning period. Aging out that history does not clear retained legacy ownership.

## Minimum performance improvement

The namespace scanner validated UTF-8 using `TextDecoder`, discarded that string, then decoded the same bytes again using `StringDecoder`. It now consumes the fatal decoder's output once. JSON validation of every entry, opaque archive boundary, shared/exclusive projection bounds, file-change checks, independent deadlines and fsync remain unchanged.

Reproducible comparison:

```
node benchmark/namespace-decode.mjs /absolute/path/to/frozen-.15/src/ops/namespace-reader.mjs
```

Synthetic 230,717,301-byte namespace, 880 entries, selected one entry; six alternating isolated-process pairs after one warm-up pair. Baseline median 1385.39 ms / CPU 1565.26 ms; candidate 1196.36 ms / CPU 1369.01 ms (wall -13.6%, CPU -12.5%). Read bytes and parsed entry counts are identical. Maximum observed child RSS was 116616 vs 104308 KiB; these peaks are environment-specific, not a memory guarantee. This is a parser microbenchmark, not an operating throughput or timeout improvement claim. Full parsing and concurrent file replacement remain.

The installed SDK State interfaces expose get/set/update/delete/list, with old/new values, but no disk-committed revision or indexed durable-read contract. That does not prove the engine lacks all such capabilities. A verified engine durable acknowledgement or per-key revision/index could remove full-file proof cost but needs a separate contract and recovery design. Further batching can reduce overlapping scans; it cannot eliminate changing-file retries or unshared scans. Namespace splitting changes layout and migration/recovery. No engine replacement, migration or timeout extension is included. Windows LLM serialization affects generation stages; available readback samples do not quantify its contribution to end-to-end throughput. Expectation mismatch wait includes engine publication/concurrent updates, so parser speed alone cannot eliminate it.

## Activation and recovery boundary

Development/tests only. No operating service, client installation, config, stored record or retry worker was changed. Actual preservation reconciliation remains unconfirmed until the new API is deployed and body-free metadata is examined. The retained originals are not copied into this repository.

A later approved rollout must review/register a new package by the existing SSH boundary, preserve current data, install the server and the participating compatibility `_capture.mjs` client artifact (server-only rollout cannot change an already installed client), restart only approved processes, verify health/version/auth and receipt field allowlists, and inspect metadata without creating new LLM work. Server/API deployment alone is separate from activating existing outbox retry work: report exact host, count, sizes and retry budget before any actual retransmission/deletion/mass processing. Existing in-flight workers may keep old imported code and need separately scoped client restart. Do not broadly restart Codex or replace hook configs.

Code rollback must preserve the latest legacy outbox, managed spool, completed receipts, observations and v2 background hold/recovery budgets. Use the reviewed compatible recovery package path; do not directly downgrade to an incompatible old pause-state reader or restore a data backup. No new state namespace/schema migration or administrator permission was added. External notifications, web candidate enrollment, Investment work and upstream PR remain excluded. Upstream replacement requires the same lossless handoff, body-free proof, bounded resource and parser correctness tests. Long-term memory recording awaits separate review.

## Verification record

RED tests reproduced the missing receipt endpoint, oversized ownership stall, duplicate UTF-8 work, unpinned expectation and ignored caller file limit. Focused tests cover auth/strict fields, full sanitized digest/order/Unicode, missing/deleted/mismatched observations, disk proof errors, superseding and mutable expected values, short deadlines, hung SDK/lock slots and recovery, bounded page refusal, oversized HTTP 201/413/503 retention with unchanged original body/ID, and receipt-only release without POST. The mandatory build/generation/sync/check/full-suite gates and independent read-only review are recorded in the final work report. No live engine restart, operating record or external model was used.

An additional `tsc --noEmit` comparison reports the same 24 baseline diagnostics and no new diagnostic; this repository-wide optional static check is not green. The mandatory build and test gates are separate.
