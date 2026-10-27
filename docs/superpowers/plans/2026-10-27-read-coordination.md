# Atomic Read Coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline implementation. Existing user authorization says to continue without repeated questions; independent review is required.

**Goal:** Prevent independent observation bulk scans from overlapping certificate work without changing verification or its deadline.
**Architecture:** One in-process coordinator owned by the durability fence; shared critical leases, exclusive bulk scans, bounded fair queue, per-lease physical tails. Use existing observation reader and fence paths.
**Tech Stack:** Node ESM, AsyncLocalStorage, existing Vitest fork pool.
**Spec:** docs/customizations/READ-COORDINATION.md

## Global Constraints

- Original15second certificate deadline includes admission wait.
- Preserve1regular/1small physical slots, group sharing and SDK4limit.
- No production/body reads, rollout, hold release or budget changes.
- Low-load synthetic tests only; no real LLM/full/browser/load runs.

## Review Focus

- Expired queued work never invokes its callback; pin timeout/grant race.
- A cancelled caller cannot free a still-running physical tail; pin delayed tail.
- Bulk starvation: after five critical grants, close new admission until bulk runs.
- Nested lease acquisition rejects without deadlock; sibling groups still share.
- Bulk wrappers end before overlays, avoiding lock inversion with SDK operations.

### Task1: Coordinator and fence safety

Files: src/ops/read-coordinator.mjs, src/ops/state-durability.mjs, src/ops/durability-measurement.mjs; test/read-coordinator.test.ts, test/state-read-coordination.test.ts.
Interface: run(mode,work,{signal,deadline}), trackPhysical(work), drain(), snapshot(); fence.withBulkRead(work,options).
- [x] Add failing integration tests for missing coordination and original deadline.
- [x] Implement bounded shared/exclusive leases with per-token references and fair phase closure.
- [x] Test cancellation, races, sync/async throws, nested acquisition, queue bound and tail cleanup.
- [x] Connect fence admission before capture, account admission phase, keep deadline absolute.

### Task2: Bulk paths and actual behavior

Files: src/ops/observation-pages.mjs; focused observation tests and synthetic comparison.
- [x] Pin both list and initial captureSummary wrapping, with overlays outside leases.
- [x] Test simultaneous admission, groups and successful full validation/fsync.
- [x] Repeat the actual small list/fence comparison including bulk-first and small-request latency.
- [x] Reject if correctness, starvation or total work cost regresses materially.

### Task3: Verify and prepare

- [x] Independent source review; fix demonstrated findings with tests.
- [x] Build/skills/docs/focused regressions in temporaryHOME, one fork.
- [ ] Personal fork only; prepare minimal release from actual31 and review exact artifacts.
- [x] No registration/application/restart/resume; report measured limits and next approval scope.
