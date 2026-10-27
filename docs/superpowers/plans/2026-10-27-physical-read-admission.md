# Physical read admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Permit a safe late waiter to join an existing physical read before arbitration of new reads, without extending any caller deadline or weakening proof.

**Architecture:** Move critical coordination from the complete certificate to the shared reader's owned job. Joining an existing compatible job creates no new critical admission. A queued job carries its abort signal and retains its lease until physical settlement. Bound each shared job's lifetime independently of later joins; keep caller-specific expected values, fsync and final signatures outside the job proof result.

**Tech Stack:** Existing ESM reader/coordinator/fence, Vitest default fork pool and one worker, synthetic temporary files.

**Spec:** Workspace evidence `upstream-integration-evidence/LATEJOIN-REALTIME-REPORT.md` and the user's approved no-operating-change implementation scope.

## Global Constraints

- Preserve original15second absolute deadlines, SDK/expected-value checks, full JSON validation, generation freshness, file/directory fsync, originals, histories and budgets.
- No operating data/services/hooks, deployment, candidate, push, new dependencies, timeout increase or unbounded concurrency.
- Small synthetic data, one worker; real-time regression≤8MiB store / worker RSS256MiB; stop on I/O or preservation risk.
- Existing shared-reader projection/key/waiter/read and coordinator queue/burst limits remain.

## Review Focus

- A short caller expiry/cancellation must not cancel a surviving compatible waiter.
- Last waiter expiry must remove queued work and retain active physical exclusion until cleanup.
- Job deadline must not slide as waiters join; no stale success or timer/listener leak.
- Source replacement / wrong expected value / fsync error must fail closed, without duplicate success ACK.
- Distinct-file overload remains bounded and safe; bulk fairness must count new work, not free joins.

### Task1: Fix the regression fixture first
- [x] Add the actual6MiB, fixed9s pacing, first5+late6+small-proof regression using real clock/parser/fence/list. Require one main read, six matching proofs, and small proof completion while main read is still active.
- [x] Run before source edits and preserve the expected late timeout/duplicate-read RED. Keep baseline3pairs as separate diagnostic evidence.

### Task2: Move job ownership with bounded cancellation
- [x] Modify `src/ops/state-durability.mjs` to run critical work at `readSharing.trackRead`, not around the complete certificate. Preserve capture/compare/fsync/final verification code and caller budget math.
- [x] Modify `src/ops/shared-namespace-reader.mjs` to pass job signal to coordination and optionally cap shared job lifetime from creation; the fence supplies a fixed15second physical job cap independent of a caller's shorter budget. Never extend the cap on join. Clear timers on every settlement.
- [x] Add/execute focused tests for late joining, caller expiry/cancellation, queued cancellation, physical tail ownership, failure release, per-waiter expectations and immutable job lifetime. Adjust old whole-certificate exclusion test only to pin the intentionally new physical-job boundary, retaining proof assertions.
- [x] Run relevant reader/fence/observation/receipt/hold regressions and the exact real-time regression. Compare measured baseline/candidate without generalizing to293MiB or operating compression.

### Task3: Review and save validated development
- [x] Obtain independent correctness and safety review; resolve confirmed issues with regression tests.
- [x] Run build, skills generation/check, original docs sync/check in temporary HOME and one worker; bounded focused tests only per user's low-load scope.
- [x] Record actual results, risks and distinct-file/stability limits in customization notes/changelog. Commit locally only after required checks pass; no push or operating action.
