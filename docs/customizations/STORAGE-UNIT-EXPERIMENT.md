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

Do not create another production micro-release from this fixture. Smaller units
are a promising structural direction for byte/CPU cost, but first-failure
improvement is not established and actual engine publication behavior is still
unverified. The next gate is an isolated real-engine experiment of the same
units, including export/import and logical snapshot/ordering compatibility,
before designing any original-preserving migration or mixed-version rollback.
An engine-provided durable generation/commit receipt would be a direct alternative
if its actual contract can be established; this application's current SDK return
values are not consumed as such proof. First-cert batching alone cannot reliably
coalesce the current serial arrivals without additional lifecycle changes.

Final validation: build, skills generation/check, docs synchronization/check,
3,495 application tests passed with9 skipped, and four Python observer-helper
tests passed. Independent code/result review found no important issue. No
production code was changed. Any future upstream implementation must pass the
same source/intent/marker, deadline, ownership and recovery tests before it can
replace a custom storage path; a faster write acknowledgement alone is not
durability proof.
