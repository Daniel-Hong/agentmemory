# Viewer initial snapshot recovery

Development branch: `fix/viewer-snapshot-recovery-20261028`, based on release `.38` (`3e4f9d8`). Not installed or deployed.

## Evidence and scope

Actual Chrome reproduced Overview connecting indefinitely and Health showing skeletons. Separate production health metadata reported RUNNING, normal memory and zero current mutation failures. Viewer snapshot and adjacent list/status APIs returned HTTP 500/504; one later session query recovered. The internal backend cause remains unresolved. The blank view itself has two confirmed frontend causes: initial snapshot failure is rendered as loading, and the periodic refresh skips snapshot recovery whenever SSE is live.

Show failure/unknown explicitly without inventing a healthy snapshot. Independently loaded operations remain visible. Reuse the current refresh cadence and manual read-only refresh. OFF still disables automatic refresh. Snapshot queries share one in-flight request with finally release; graph invalidation retains its one bounded reread. No client, engine, guard, state, receipt, retry budget or backend API changes.

## Validation

- Initial RED: 3 new failure/recovery tests failed, 49 passed. Review RED: overlapping requests made two calls instead of one.
- Final focused Vitest: 90 passed across viewer-operations, viewer-dashboard-reliability and viewer-streams (single worker, temporary HOME). Includes bounded graph-reset reread and release after failure.
- Build passed; whitespace check passed.
- Actual Chrome, isolated loopback HTML with synthetic fetch/SSE only: LIVE plus snapshot 503 displayed explicit failure and running operations; synthetic API recovery plus manual refresh rendered Overview and Health, preserving unknown health when report was absent. Console error count zero. No production credentials/data used in fixture.
- Independent source review: duplicate request race corrected; unintended Activity/Profile changes removed; no remaining important findings.
- Whole suite and production installation intentionally not repeated/performed. Backend HTTP failures are not resolved by this frontend change.

## Replacement and operational boundary

Replace this customization when upstream proves equivalent initial-failure recovery, OFF semantics and single-flight behavior. Any operating application requires a separate approved frontend/server release and read-only verification. No operating code or settings have been changed by this development work; the later protective pause is described below.

## Later operating metadata

A subsequent health read returned 503 while background remained RUNNING, with current mutationFailures1 and normal host memory protection. Vector persistence logged SDK_MUTATION_UNCERTAIN. The originating mutation and the snapshot failing await remain unknown; do not treat this frontend change as API/storage recovery or prepare an operating candidate from it. A further expensive snapshot request was denied before execution and was not retried. Normal populated synthetic Overview and Health data also rendered in actual Chrome, with zero console errors.

## Ordinary list overlap — experiment excluded from candidate

Subsequent non-content process metadata found six concurrent file streams of the same 293,504,728-byte observation namespace, with advancing positions, one saturated Node core and several GiB of heap. These are ordinary `observationReader.list` scans, separate from the disabled SDK-mode disk certificate reader. Existing bulk coordination covers chunks, not the lifetime of these streams. Summary, enrichment, status and search paths can call this ordinary list; metadata does not identify the exact owners or the original failed write.

The preserved experiment `1d88538` shares an unfinished list only for matching scope, consistency, file signature and SDK mutation revision. Eight callers may share one parse; additional callers retain the independent path. The original parser, one change retry, SDK overlay/deletion reconciliation and record-size checks remain. No finished result is cached. Before any caller receives rows, followers receive independent per-record clones; the first caller owns the parsed rows. Clone failure rejects every waiter and releases the job. Copying yields between records/consumers after the small elapsed-time budget; an individual clone is still synchronous.

This reduces duplicated parsing/streams in overlapping requests, not the number of result copies ultimately held by consumers. It is not a hard RSS limit, does not prove lower peak memory, and may delay the first caller until followers finish copying. New arrivals during copying start a new read; the group cap is not a global admission limit. Deadlines, cancellation contracts, fsync and completion semantics are unchanged. Independent review required moving the yield check inside the follower loop; that correction is included.

Focused combined regression: 189 tests passed in nine files with one worker and a temporary HOME. Small real-file tests cover six consumers/one open, no completed cache, caller mutation isolation, read/clone failure release, SDK revision changes, pending deletion, consistency separation and atomic replacement of an opened generation. This is not a production-scale performance result. Production remains under its existing protective pause request; no deployment or historical failure reset has occurred.

Final combined validation: build, skills generation/check, docs synchronization and the full default-fork suite passed with one test worker and a temporary HOME (5,465 passed; 13 existing conditional skips; zero failures). Independent review found no remaining blocker after the clone-yield correction. Source-only operating guard review found that mutationFailures1 blocks ordinary apply with STORAGE_FAILURE_PRESENT; existing noninteractive enrollment supports the old 0.9.30 contract, while the current SDK candidate registration path needs interactive administrator authentication. Neither guard nor authentication was bypassed.

## Final minimal routing change

Independent review recommended excluding the ordinary-list experiment: the copy barrier can increase peak memory near the existing heap limit. Its commit, tests and patch remain preserved on `experiment/ordinary-list-sharing-20261028`; the candidate restores the ordinary list implementation to `.38`. The experimental 189/5,465-test results above are not the final candidate test count.

A source-backed minimal replacement moves the unchanged five incremental-checkpoint predicates before full observation admission reads. Six same-session requests previously performed seven lists before existing job coalescing; five small actual-handler RED cases demonstrate this for session progress, revision, processed IDs, offsets and source pins. The corrected handler performs one list in the unchanged owner, with five duplicate requests joining the active job. Eight summary regression files passed 55 tests. Source reading, selected-source hashes, session identity, summary revision, provider deadlines/backoff and publication checks remain unchanged. Unknown sessions retain the existing full admission path. This is not proof that every operating slowdown or the original mutation failure is resolved.

## ID-only and count-only consumers

Feature enqueue needed only sorted observation IDs but loaded every source body under a per-session lock. A private streaming projection now supplies exact IDs with the same namespace validation, current-path check, one generation retry, record limit and pending SDK overlay behavior. Missing/null/nonstring IDs retain their previous semantics. Unsupported readers/Redis keep the prior list fallback. No new cache or capture-budget authority is introduced.

Health state-change events also run status reporting independently of browser polling. That reporter previously cached the entire `findUnindexedObservations().missing` raw result although it used only its length. A separate count function now consumes ID/eligibility projections and caches only numeric counts. It preserves duplicate counting, index membership and the indexed-session shortcut. The original full-source finder remains unchanged for reconciliation; source validation before summary publication remains unchanged. Projections still scan/parse files and do not prove bounded total CPU/RSS or resolve every SDK timeout.

Combined small final-batch regression: 211 passed in eleven files. Real reporter tests cover a nonzero missing count, its warning and cache reuse. Independent final source review found no blocker. Earlier `.39` whole-suite execution (before these projections) had 5,460 passed, two unchanged disk-path failures and 13 pre-existing skips; a single focused run of those two files passed five tests with four existing opt-in skips. The failures and logs are retained; they are not converted into a whole-suite pass. Final-batch whole-suite results are recorded separately after execution.

Operating pause/drain reached activeOperations0 at 17:48:24 UTC and then stopped on the preserved SDK_MUTATION_UNCERTAIN history (mutationFailures1). No reset, restart, deployment or hold release occurred. The exact originating mutation and snapshot500 exception remain unknown. Own protection polling ended at terminal state, synthetic browser tabs/servers were already closed, and the remaining user tab was left untouched. A32MiB offline comparison was prepared/reviewed but did not start because its host-memory precondition was not met.

Final source-batch verification: build, skill generation/check and docs synchronization passed. The first final-batch invocation lost its execution session and has no terminal summary/exit evidence; it is not a pass. After confirming no duplicate test process, one durable-result run completed with exit0: 493 test files passed, four existing conditional file skips, 5,476 tests passed, 13 existing conditional test skips, zero failures (330.94s). Earlier two disk-path failures and their focused results remain retained above. Fresh independent source review found no blocker; operating authentication and failure-history guards still block application. No production performance or UI recovery claim is made.
