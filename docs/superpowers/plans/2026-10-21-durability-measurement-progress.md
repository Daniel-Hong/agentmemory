# SDD ledger — plan: docs/superpowers/plans/2026-10-21-durability-measurement.md

Baseline: b45645b43aea5855cf2707f6bf3a497955387631, clean separate clone on personal. Original source has CHANGELOG.md and two Viewer/test edits; none copied or modified.

Ruling: Use an independent development clone under the writable task directory rather than a managed worktree: the native worktree tool targets the calling task, which is not the AgentMemory repository. Cost: the finished commit must later be transferred/reviewed before integration.

Ruling: Use snapshot-only bounded diagnostics rather than automatic logging: existing authenticated health already exposes the fence snapshot, so no logging frequency/IO or caller changes are required. Cost: only the latest eight certifications survive and measurements reset on restart.

Pre-flight: one implementation task; collector/reader/fence interfaces are tested together. Implementation and synthetic tests were explicitly approved; no new deployment permission is inferred.

Baseline: first attempt before build/local socket permission was invalid (missing dist and denied synthetic listeners); terminated only that development Vitest process. Built baseline and reran with temporary HOME and approved local test sockets: 303 test files passed, 2 skipped; 3101 tests passed, 4 existing opt-in skipped, exit 0.

Task 1 RED: 10 missing measurement assertions failed / 3 existing-semantics assertions passed; GREEN 13/13. Boundary RED: two failures plus async observer rejection; GREEN fixed monotonic-clock invalidation, own-key category maps and async observer isolation. Namespace-category RED 3/3 before mapping actual schema scopes; GREEN new tests 20/20. Relevant fence/namespace regressions initially 69/69 passed.

Checks before review correction: build/skills:gen/docs:sync/skills:check/docs:check exit 0. tsx's default-sandbox IPC EPERM was resolved by an approved isolated generator run; no persistent execution blocker. Baseline and modified tsc --noEmit --incremental false both exit 2 with byte-identical 25-line pre-existing diagnostics; no new type diagnostics. Full suite 3121 passed / 4 existing skipped, 0 failures.

Independent fresh-context review: one Important finding (revision recapture GET failure classified as disk IO/deadline). Two new synthetic regressions reproduced rejection/timeout with no namespace read or sync (RED 2/2). Measurement-only active-phase classification fixes both; focused GREEN 74/74. Existing storage errors/results remain unchanged. No Critical findings. Reviewer verified bounds, keyed privacy tokens, zero added read/sync calls, unchanged original storage checks and late capture handling.

Final: minor (deferred): measurement callback coverage for reader abort and replacement-specific failure; existing reader correctness tests and new malformed-input/observer tests cover related paths, but not these callback assertions.

Final: minor (deferred): exceptional failure inside final sample construction/storage may drop a sample without incrementing unavailable; storage outcome remains isolated.

Final: Ruling: reviewer excluded production performance/deployment and full-suite/build judgment — correct because this task authorizes synthetic development work only; coordinator owns the actual build/full-suite evidence. Cost: no claim that operating timeout or throughput improved.

Task 1: complete. Final post-review build → skills:gen → docs:sync → skills:check → npm test all exit 0. Full suite: 305 test files passed / 2 skipped, 3123 tests passed / 4 existing skipped, 0 failed. Focused fence/reader regressions: 74/74 passed. Type baseline: 24 existing errors (25 diagnostic lines), byte-identical before/after; typecheck is not globally green.

Ruling: preserve this development clone and evidence for review instead of merging or deleting it. Deployment/integration was excluded by the user's approval; no production rollback is necessary. Cost: original source retains its three user modifications and requires a later reviewed integration step, especially for CHANGELOG.md.

Original source HEAD remains b45645b43aea5855cf2707f6bf3a497955387631 with exactly its initial three modified files. No production files/settings/data, services, provider calls or Investment work changed. Final development commit and patch path are reported in the final response.

## Approved follow-up: close both deferred minors

Task 2 RED: three loss-accounting assertions failed because final sample construction exceptions left unavailable at zero. Reader pre/mid-abort and deterministic inode replacement callback tests require one callback, complete:false, original file size, truthful partial/full scan bytes and no private strings. An asynchronous rename fixture could reach an existing reader EBADF close boundary, so synchronous replacement is used to isolate the signature-rejection path without changing reader behavior.

Task 2 implementation: complete the next bounded history before assigning it, increment unavailable once if final construction/history preparation fails, and preserve the previous history/eviction count. Do not change reader/fence/timeout/operating code. Added success/failure dirty-key, duplicate finalization, next-sample recovery and injected history-preparation failure regressions.

Task 2 focused GREEN: 82 related regressions passed, including 30 measurement tests. Build/skills:gen/docs:sync/skills:check passed; current type diagnostics remain byte-identical to baseline (24 existing errors). Full-suite final result is recorded below when complete.

Second independent fresh-context review: no Critical, Important or Minor findings. Reviewer ran both measurement files (30 tests passed), checked privacy/bounds/atomic history and matched operating runbook arguments/shutdown/rollback/API behavior to repository scripts. No production commands or original source used. Both earlier deferred minor items are closed; earlier ledger entries remain as history.

Task 2 Ruling: keep the operating procedure as a preparation document with explicit unresolved live baseline/candidate/admin inputs, rather than inventing paths, issuing a root kit or exercising an update. Cost: deployment eligibility, actual downtime/current helper state and live acceptance still require separately approved inspection and execution. Reviewer excluded these live matters correctly; no production improvement is claimed.

Task 2: complete. Final full suite: 305 test files passed / 2 skipped, 3131 tests passed / 4 existing skipped, 0 failures, exit 0. Focused regressions 82/82, independent review 30/30; build/generators/skills passed. Typecheck remains the same 24 pre-existing errors, not a globally passing typecheck. No deployment, registration, pause/resume, service restart, actual memory-data test or new model job occurred. New development commit and combined patch are reported in the final response.
