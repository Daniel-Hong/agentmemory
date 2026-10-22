# Certification and recovery correctness implementation plan

> **For agentic workers:** Use the existing isolated development checkout and task-specific parallel workers. Follow TDD and independent review; aggregate checks and the personal-fork push are owned by the coordinator.

**Goal:** Reduce demonstrated compression first-attempt certification failures while preserving original data and durable acknowledgement, and expose truthful current and historical recovery evidence.

**Constraints:** No production changes, restart, forced replay/deletion, historical counter reset, collector replacement, permission expansion, storage migration, external notification or upstream PR. Preserve fsync/final signatures, per-item generation/currentness, idempotency, ordering, original deadlines and serial inference. Unknown historical append outcomes remain unknown.

## Issues and completion criteria

1. Compression writes its revision before the embedding prepare certificate; first attempts still use independent whole-namespace fences. Reproduce the actual serial compression arrival plus concurrent capture/recovery/publication. Compare candidate and baseline with identical synthetic data. Accept a fix only when initial certification failure or work decreases without shifting failures to capture, bypassing verification or extending deadlines. Non-overlap and continuous-churn limits must be reported.
2. Legacy backlog is progressing but remains unaccepted. Cover existing session-end lock, handoff budget, failed certification/restart ownership and head backoff/eligibility regressions. Fix only a newly demonstrated blocker; do not force operating processing or promise every historical append is recoverable.
3. Recent-eight sample eviction loses failure coverage and item-level publication proof is missing. Add bounded since-observation aggregates and a bounded read-only item metadata query using existing state, separating observed verified publication from unverified marker metadata and unknown outcomes. No bodies/session identifiers/raw errors in API or UI.
4. Persisted failure totals are mistaken for current failed jobs. Show recent measured attempts/failures with real timestamps, current pending/blocked/unknown state separately, and preserved historical totals whose start is unknown.

## Work and ownership

- [x] Main: capture a safe current status; integrate baseline scenario evidence and choose the minimum supported certification change.
- [x] Reproduction worker: real compression/recovery/fence full-path synthetic baseline, controlled serial model timing and publication/writer conditions; no inference calls.
- [x] Metrics worker: bounded recent metric buckets and tests without changing persisted cumulative data.
- [x] Evidence worker: metadata-only embedding receipt status helper and fail-closed tests, without production mutation.
- [x] UI worker: align existing HEALTH/dashboard metrics and current-state semantics; browser regression evidence.
- [x] Main: implement demonstrated initial-certification fix with failure, generation, cancellation, per-request deadline and restart tests.
- [x] Main: retain bounded observed-publication evidence only after the existing persistence/certification/latest-generation success path; invalidate on superseding work. Add independent aggregate certificate outcomes without relying on recent samples.
- [x] Main: wire bounded authenticated read-only evidence route into existing API/function registration; no new privileges.
- [x] Main: integrate, obtain independent safety/performance review, run required build/generated/docs/full fork-pool tests with synthetic HOME.
- [x] Main: inspect committed diff for secrets/operating evidence, commit and push personal only. Describe combined server rollout, compatibility/rollback and required operating approval; do not deploy.

## Measurements and acceptance

Record fixed input size/layout, arrival/write/publication timing, initial attempts separately from retries, exact failure count across the fixed cohort, parser bytes/scans, wall/CPU, sharing and publication/receipt outcome. Synthetic results are not production claims. Invalid/missing/stale values, changed generation, corruption, cancellation and failure must never yield a false ACK. Runtime evidence must label its process/time coverage and become unknown rather than fabricated after restart/eviction. Existing historical counters and unknown 190 append-attempt outcomes must remain intact.

## Verified result and limits

Required ordered checks passed: build, skills generation, docs sync, skills check, 3,489 tests (8 skipped), docs check. Independent review findings were repaired and rechecked. The first aggregate run exposed a source-extraction wiring fixture missing the new dependency; the fixture was corrected and the full ordered checks rerun successfully.

The minimum compression change removes redundant pre-certification whole-list work; it does not batch first certification or eliminate valid fifteen-second deadline failures. Matched prewrite churn changed one initial failure to zero; positive timing comparisons had zero failures before and after. See the customization evidence document for exact work, scan-byte and late-spool scheduling limits. Commit/push completion is recorded in the final delivery rather than assumed by these task checkboxes. Operating acceptance remains pending.
