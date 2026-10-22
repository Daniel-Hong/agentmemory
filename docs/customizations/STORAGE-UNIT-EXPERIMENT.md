# Smaller certification units: isolated experiment

## Decision and acceptance criteria

The current observation namespace is scanned in full even when one source is
certified. An unrelated writer can invalidate that scan. The first compression
path also awaits certification before the next serial enrichment item; the
existing same-pump groups therefore do not imply first-attempt coalescing.

Compare the existing layout with sixteen fixed hash units in synthetic storage
only. Keep total data, source/retry/marker work, serialized model delay, SDK slot
limits, publication timing and individual absolute deadlines identical. Measure
first-attempt failures and completed targets per elapsed minute, including the
model and certification work. Report scanned bytes and cold setup separately.
Here first-attempt failures count the first `mem::compress` return for each
synthetic target. That return is not the asynchronous publication completion:
first-drain and final committed target counts are reported separately.
Include quiet, unrelated-writer and hot-unit controls. A publication delayed
beyond the deadline must still fail and retain original/retry ownership. Keep
failure, cancellation and restart tests; never infer durability from counters.

This is not a production storage adapter or migration. Production routing,
export/import, mixed-version reads, rollback and safe migration remain separate
engineering work and require a concrete operating scope before activation.
The synthetic engine publishes independently per physical scope. A real engine
with a global flush lock may behave differently. The fixture's aggregated
summary and unit-ordered list do not implement a general consistent logical
snapshot or ordering contract. Passing this experiment cannot establish those
production guarantees.

## Observation continuity prerequisite

`scripts/personal-release/observation-evidence.py` is a local library for future
authorized observers. Create a private run file outside Git before persisting
any aliases, retain its `run_id` with report metadata, and resume that same file
for later receipt joins. It persists a random HMAC key atomically with mode0600;
reports must contain only the run identity and aliases, never the private file
or raw identifiers. Missing/invalid state is an error, not a new run. The helper
does not access operating data, grant read permission, or start an observer.

Future authorized metadata extracts can distinguish absent, unsupported and
supported retry fields. Raw errors are reduced to a bounded category. The
already-consumed one-time head read is not repeated. The two historical removed
items whose key was lost remain unknown; this helper cannot recover them.

Validation so far: four synthetic Python tests pass, including a separate
process restart, overwrite refusal, missing/partial/insecure/symlink state,
key/run mismatch and schema classification. Independent review found no
important issue.

## Initial representative result

For two sequential compression items in the same 256.003MB synthetic dataset,
with each compression and embedding inference taking two seconds and inference
concurrency one, the quiet monolith/unit comparison measured 11.79/8.53 seconds,
4.61/0.55 CPU seconds, and 755.28/63.89MB fence-scanned bytes. Completed targets
per elapsed minute were10.17/14.07. Both committed two targets with zero first
failures, preserved originals and no pending target intents. Thus this case
supports reduced verification cost, not reduced first-failure probability.
Cold metadata preparation was separate:1.31/1.37 seconds. The cohort is small
and the SDK/publication model synthetic; this is not steady-state production
throughput. Each layout ran once per condition. Fence-scanned bytes exclude
direct summary/list reads and writer output; they are not total disk IO. Writer
conditions must report compression return, publication drain and all-task wall
time separately because scheduled writers can outlive the foreground batch.

With identical unrelated writes scheduled through13 seconds after the first
compression write, both layouts again had zero first failures and two final
commits. Foreground publication drain took14.099/8.489 seconds, while all-task
wall time was16.066/15.115 seconds because both runs awaited scheduled writers.
Fence-scanned bytes were974.43/63.89MB and CPU time10.78/0.87 seconds. Whole-run
completed targets per minute were7.47/7.94. This isolates lower certification
overhead, but does not demonstrate a lower timeout probability.

The sixteen-unit hot-shard control completed both items. A canonical target
change correctly deferred one embedding: only one item completed on the first
drain, then a fresh pump completed both with three total embedding calls. A
17-second source publication delay failed the unchanged15-second certificate
deadline, invoked no embedding, wrote no committed marker and retained the
original and one durable retry intent. There is no claim that smaller units
remove publication latency or genuine ownership changes.

Six small structural tests cover routing/physical certificate selections,
delay failure, worker.stop, publication failure, foreign generation and canonical
replacement. Recovery reconstructs SDK rows, StateKV, index, fence and worker
from actual synthetic files in the same process; it is not an OS crash or
power-loss test. Existing helper regressions also pass. The benchmark's seven
bounded runs are opt-in; full reports are retained in the workspace's
`storage-unit-development-evidence` directory and its summary.json.

## Engineering decision

Do not create another production micro-release or implement a storage migration
from this fixture. The real-engine follow-up below did not confirm the synthetic
throughput gain. Smaller units reduce byte/CPU cost, but the actual first-failure
mechanism remains unreproduced. Export/import and logical snapshot/ordering
compatibility are also unimplemented.
An engine-provided durable generation/commit receipt would be a direct alternative
if its actual contract can be established; this application's current SDK return
values are not consumed as such proof. First-cert batching alone cannot reliably
coalesce the current serial arrivals without additional lifecycle changes.

Prior synthetic-commit validation: build, skills generation/check, docs synchronization/check,
3,495 application tests passed with9 skipped, and four Python observer-helper
tests passed. Independent code/result review found no important issue. No
production code was changed. Any future upstream implementation must pass the
same source/intent/marker, deadline, ownership and recovery tests before it can
replace a custom storage path; a faster write acknowledgement alone is not
durability proof.

## Actual installed engine follow-up

Installed iii and SDK0.22.1 were used with a new temporary HOME, cwd, state
directory and owned loopback listener for each trial. Only worker-manager and
state modules were configured; no application daemon, operating configuration,
private records, external models or downloads were used. The isolated file
publication interval was2,000ms and synthetic serialized compression/embedding
each took2,000ms. This is not verification of the production interval or model
arrival distribution. Application functions run locally around actual state SDK
calls; HTTP and engine function-dispatch overhead are not modeled.

Each layout was seeded through the real SDK once. Setup initially encountered a
changing file, which exposed a readiness retry bug in the test harness. That run
failed before business measurement and is excluded. Its stopped synthetic seed
had14,332 of14,388 expected rows; preparation verified every existing value and
filled only56 missing synthetic rows through the SDK. The16-unit layout was
independently seeded through the SDK. Both were fully checked and fsynced, then
stopped normally; post-stop file checksums matched the preparation proofs.

For repetitions, only those known synthetic source files were copied into fresh
temporary stores before starting each engine. Full key/value/count/checksum
validation, fresh per-unit SDK probes and a real fence precede measurement.
Setup is excluded and separately recorded. This preserves actual publication
during measured source/intent/index/marker writes while avoiding repeated large
seed costs. It is checkpoint reuse, not independent datasets or a production
migration test. Case-specific durable JSON reports retain synthetic target
correlation after process exit; no private identifier or ephemeral alias key is
involved.

Three trials per condition/layout, two targets per trial:

| Condition | Existing mean seconds |16 units mean seconds | Existing completed/min |16 units completed/min |
| --- | ---: | ---: | ---: | ---: |
| Quiet |16.563 |17.880 |7.245 |6.711 |
| Unrelated writes |16.855 |17.346 |7.119 |6.918 |

Both layouts had zero first compression failures out of12 total targets and
committed all12 targets. Node CPU means quiet3.982/1.097 seconds and writes
4.366/1.140 seconds favor smaller units; fence scan means1,024.02/63.89MB and
1,092.17/63.89MB do too. Those byte counts exclude direct summary/list reads and
engine IO. Engine CPU is separately captured including setup, not added to Node
measurement CPU. All12 trial engines exited0, no forced cleanup occurred, and
their PIDs were absent at the end.

The one-MiB/5ms-inference smoke already took about9.9 seconds in either layout.
Actual source/intent and publication fences often waited about1.9–2.0 seconds.
The code certifies source/intent before embedding, then vector data/metadata and
a newly written committed marker. These ordered publication waits remain even
when scans are smaller. Not every fence necessarily consumes a separate tick.
The fixed model delay aligns with the publication period and each cohort is
small, so do not generalize these results into a universal sharding regression.
They do establish that the current evidence does not justify implementation or
migration for speed or first-failure improvement.

Every final SDK retry list was empty, while the immediate disk snapshot retained
one retry row per trial: final deletion had not crossed its next publication
barrier. This is not a missing committed target or proof of permanent deletion.
No crash/power-loss/restart-replay claim is made from these runs.

A separate empty isolated engine advertised state::get/set/update/delete/list/
list_groups. state::set returned new_value and old_value, not a revision or
durability receipt. No flush/commit function was advertised in that listing;
undocumented/internal capabilities remain unverified. An acknowledgement cannot
replace readback/fsync based on these observations.
In particular, no journal/WAL implementation or its fsync contract was inspected.
It is unverified whether a durable journal already exists before the namespace
snapshot becomes visible. Waiting for snapshot publication does not prove that
such an earlier durable commit exists. The operating environment file has no
AGENTMEMORY_STATE_SAVE_INTERVAL_MS override, and the renderer default is2,000ms;
the effective live engine cadence was not queried or changed.

Result: **NO-GO for production sharding/migration and no further routing
implementation from this experiment.** Before another proposed fix, correlate an
actual first-certification failure with SDK capture, file publication, namespace
changes and ownership transitions. The fixed isolated load did not reproduce
that failure. It uses only two serial targets and five scheduled writers, no
capture/outbox/feature scheduler traffic, variable model latency or operating
memory/CPU pressure. Which missing condition causes the production timeout is
unknown. The next bounded diagnostic should capture a failed source/intent
fence's SDK completion, expected-generation category, file signature/publication
and recheck/deadline timestamps without bodies or raw identifiers. Retain the
existing durability checks and historical unknowns; do not start a storage
redesign or relax deadlines from this result.
Full trial metrics, manifests, setup failure and code hashes are retained in the
workspace `real-engine-unit-evidence` directory.

Follow-up required validation passed: build, skills generation/check, docs
synchronization/check,3,501 application tests passed and10 skipped. Independent
review recalculated all12 trial summaries and matched the three harness hashes.
An additional exploratory `tsc --noEmit --pretty false` failed with24 diagnostics
in untouched src files, including TS6133/TS6196, leases.ts TS2345, slots.ts
TS18048/TS2322, hybrid-search.ts/api.ts TS2339 and api.ts TS2783. No clean-baseline
typecheck comparison was run, so these are not asserted to be proven pre-existing
failures. They were not changed as part of this isolated experiment. The required
build and tests passed; this experiment is not a release candidate.
