# Record gate ALS lifetime implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline; independent final review is explicitly requested.

**Goal:** Release only finished per-record ALS instances without weakening write/recovery ownership.

**Architecture:** Each queued/running/reentrant record use owns a reference. At zero references, require the inner gate to have no reader/writer/queue, disable its ALS, then remove that entry. Keep the record-wide exclusive ALS and unrelated gate contexts alive.

**Tech stack:** existing TypeScript/Node22.23.3, iii-sdk0.25.0/engine0.22.1.

**Spec:** delegated 2026-11-01 ALS minimal-fix request and ../observation-work-selection-development/performance50-isolated/ROOT-CAUSE.md.

## Global constraints

No production pause/restart/deploy/signals/inspector/security change. Preserve .50 source, original/unknown/backup/graph job. No Graph UI changes. Tests use isolated HOME/state and synthetic data, normal own-process shutdown only; existing12GiB SDK gate unchanged.

## Review focus

- Awaited callback still live after caller timeout/abort: keep ownership until actual callback settles.
- Escaped async descendant: cannot inherit an old exclusive bypass.
- Concurrent/queued/nested uses: never disable early.
- Error/abort cleanup: successor must progress and no stale entry.
- Other ALS instances: preserve trace and unrelated record/gate contexts.

## Task 1 — narrow product fix

- [ ] Add a release regression to test/recovery-write-gate.test.ts; run RED with the existing source. Add behavioral tests for review focus, not performance thresholds.
- [ ] Modify only src/state/recovery-write-gate.ts: guarded dispose at last reference; run focused recovery/capture tests GREEN.
- [ ] Independently review the lifetime/invariants and official Node disable contract.

## Task 2 — measured comparison and final verification

- [ ] Actual SDK old/new comparison: same synthetic initial state and operation counts, bounded test processes. Keep data generation outside timings; test long-repeat and post-write reads. Record CPU/wall/SDK in-flight and cleanup separately.
- [ ] Whole build/test/default fork pool with real temporary HOME. Respect existing large SDK memory condition and report any unrun/failure without inherited exceptions.
- [ ] Update changelog/customization evidence; no new candidate until verified. Prepare read-only operating admission/drain conditions, no execution.
