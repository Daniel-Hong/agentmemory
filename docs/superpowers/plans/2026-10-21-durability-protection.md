# Durability and protection implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce wasted readback scans and safely recover memory-only holds without weakening certification.
**Architecture:** Negative mismatch reuse only while full file signature and expected-value generation agree; early reader invalidation. Independent durable cause-aware control and pressure recovery using existing serialized verified admission.
**Tech Stack:** Existing ESM/TypeScript, Vitest default forks, Node fs, no dependency additions.
**Spec:** ../specs/2026-10-21-durability-protection-design.md

## Global Constraints

- Development clone personal only; production .11/running workers untouched; no production data, provider calls, external notifications.
- Original15sdeadline/poll100ms/captureconcurrency4/fsync+finalsignature/LLMserialization/inputlimits unchanged.
- Legacy/manual/deployment/storage-error holds never auto-cleared. No new rootpolicy/permissions.
- Every commit requires build, skills:gen, docs:sync, skills:check, full default-fork suite and docs:check with a real temporary HOME.

## Review Focus

- Unchanged file but changed captured expectation must rescan and can certify correctly (Task1).
- Replacement/deletion/in-place writer at scan and fsync boundaries must never yield stale success (Task1/2).
- Shared/full signatures must not hide malformed JSON, duplicate keys or invalidUTF8 (Task2).
- Manual/deployment hold concurrent with auto recovery or restart must stay closed (Task3).
- Clock jumps, stale samples, persist failure or repeated memory degradation must stop automatic admission (Task3).
- Pending pause/resume must not block pressure polling; stale normal samples must not override newer critical readings. Recheck continuous stability after storage waits, and drain both transitions at shutdown.

### Task1: Unchanged negative readback reuse
Files src/ops/state-durability.mjs, durability-measurement.mjs, test/state-durability-readback-cost.test.ts.
- [x] RED: bad disk value unchanged untildeadline fails with one actualscan, nofsync; baseline rescansmultiple times.
- [x] GREEN: per-call negative signature+expected generation; signature check onlyskipsfailure; capture invalidates.
- [x] Regression: publication/replacement/recaptureinvalidates; stable correct data stillverified+fsynced; missing/corrupt/deadline stayfail.
- [x] Compare synthetic immutable mismatch scan counts without claiming operationalthroughput.

### Task2: Early invalidation
Files src/ops/namespace-reader.mjs, test/namespace-reader-early-change.test.ts, benchmark/durability-readback.mjs.
- [x] RED: replace real synthetic16MiB file afterfirstentry; assert failure beforefullscan with1MiB enabled.
- [x] GREEN: optionalpositivebyteinterval and fullsignature checks, preserve finalvalidation andcleanup.
- [x] Regression: tinychunks/largeentries/in-placechange/deletion/abort/corrupt/UTF8/duplicates.
- [x] Run baseline-vs-new synthetic compare; record bytes/time/extra stat cost and scope limitations.

### Task3: Cause-aware protection recovery
Files background-control/memory-pressure modules + declarations, relevant tests, minimal Viewer status, PROTECTION-RECOVERY.md. Ownership delegated independently; no storagefile overlap.
- [x] Write precise cause/state/recovery interface and conservative parameters.
- [x] RED thenGREEN synthetic durableholds/fakeclock tests; preserve verifiedresume andcrashguard.
- [x] Test manual/deploy/legacy overlap/restart/pressure recurrence/persist error/backoffcap/timeboundary.

### Task4: Integration and review
- [x] Fresh reviewer examines source+test+contracts, fixes before completion.
- [x] Build/skills/docs/fullsuite/typecheckbaselinecomparison; changelog/customization notes and upstream replacement criteria.
- [x] Commit devcode only; report deployment prerequisites/rollback/codepolicyreview and remaining limitations. No deployment or operationalcontrol.
