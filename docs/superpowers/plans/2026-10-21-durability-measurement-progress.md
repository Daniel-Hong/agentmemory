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
