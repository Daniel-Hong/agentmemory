# Certification failure correlation

Development-only diagnostics; no production deployment or settings change.

## Evidence and gap

The retained .22 observation window was 2026-10-22 06:14:30–06:34:30 UTC.
Complete counters counted 197 failed certificates (196 readback, one verify),
while polling retained detailed samples for 106 distinct failures. These are
not independent failure populations. Of those samples, 96 selected two keys
across observations and embedding_retry namespaces. That shape is compatible
with compression source/intent certification but also occurs on other paths.
Their SDK capture phase ranged from 0.431 to 79.227 ms. Readback dominated their
15-second deadline. Their retry-reason occurrences included readback_timeout95,
namespace_changed91 and not_committed1; these overlap within certificates.
The six compression errors cannot be individually joined to those samples.

For example, sample103 elapsed15,008.49ms, capture6.80ms, readback14,994.42ms,
one check and no recheck; its scan count was zero. This does not prove no read:
a shared follower previously missed the creator's onRead callback, and a caller
can time out before its shared physical read completes. We cannot determine
whether this particular compression failed due to publication delay, scanning
cost, generation replacement or their interaction. No durable journal contract
was established. SDK response is not a durable acknowledgement.

## Minimum diagnostic change

Reuse the process-random counter epoch plus certificate sequence as
certificateRef. Compression's existing safe error details retain only this
strictly formatted reference. No user/session/content identifier is encoded.
The existing authenticated health storage snapshot gains failureTraces:
32 failures, 15-minute retention, 32 events and eight namespace tokens per
failure. Tokens are existing process-salted HMACs; no raw scope, key, signature,
generation or body is exported. No persistent diagnostic file is written.

Events use monotonic offsets from certificate start: SDK capture completion,
local revision recapture with value/generation-change booleans, physical read
queue/join/start/open/completion/failure/abort, unchanged-mismatch skip, typed
missing/value/retry-generation mismatch, signature change by stage and deadline.
A readId joins active shared readers; use it only within the same certificate
epoch. Read age at late join distinguishes existing work from a newly started
scan. Local revision recapture is not an engine commit revision. Signature
change proves a file identity/metadata change between checks, not its cause or
an exact publication timestamp.

Each active consumer receives completed scan metadata. Per-certificate scan
counts therefore measure participation; use readSharing.startedReads/scanBytes
for physical work and do not sum participating samples as physical I/O.
Callback payload copies isolate observers. Observer failures remain diagnostic
failures and cannot produce a successful acknowledgement or suppress errors.
There are no additional SDK calls, filesystem reads, stats, syncs or writes.

## Limits and operational next step

Successes keep the existing recent-eight summary, not long timelines. Failures
can expire or be evicted; missing references mean unknown. Event/namespace
omission and unavailable clock/measurement coverage are explicit. A physical
read completing after its last consumer times out is not retained; that outcome
remains unknown. Expiry uses the wall clock; clock failure leaves coverage unknown, and clock rollback can delay expiry. The count bound remains in force. Process restart loses this diagnostic ring and epoch. No
historical failure or the unidentified190 spool attempts becomes recoverable
through this change.

If separately approved, activate only the server diagnostic build through the
existing release route, preserving collector, permissions, deadlines, ACK and
original data. On one natural compression failure, match its reference against
health failureTraces before expiry/eviction, then compare SDK completion,
read/join age, typed mismatch, signature-change stage and deadline. Preserve
only sanitized metadata and coverage counts. Do not start a forced compression
or another storage redesign to collect it. Restore previous code only through
the supported compatible recovery path; no data rollback or counter reset.

Upstream replacement criterion: an equivalent bounded privacy-safe correlation
facility with demonstrated callback/failure isolation and the same durability
semantics. This change diagnoses the failure; it does not resolve or prove its
production cause.

## Development cost and validation

Three alternating CPU-only rounds of 2,000 failed certificates with 11 events
each compared the original recorder with this implementation: added wall time
was approximately 5–12 microseconds per certificate. This excludes SDK, file I/O
and HTTP serialization and is sensitive to JIT/GC. With 32 such failures the
health JSON grew from about 6 KB to 84 KB; maximum-event/namespace histories
can be larger. The bounds limit retention, not a fixed byte payload guarantee.
Additional SDK and filesystem operations: zero. Do not infer operating latency
or failure-rate improvement from this diagnostic microbenchmark.

Focused tests include real temporary files, missing/mismatched values, local
revision recapture, shared lifecycle attribution, cancellation, observer throws,
rejected promises and payload mutation, metadata getter/clock failure, expiry,
eviction, privacy, and immediate SDK error versus actual deadline exhaustion.
Independent review found and corrected a false deadline event on immediate
capture errors. Required build, skills generation/check, docs synchronization/check passed. The default fork-pool application suite passed 3,523 tests with 10 skipped under a temporary HOME. No operational activation was performed.
