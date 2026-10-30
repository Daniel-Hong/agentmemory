# Observation projection sharing implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, as parent requested.

**Goal:** Remove duplicate projection parsing without removing checks.
**Architecture:** Per-reader/per-scope revision-bound shared disk projection; SDK overlay applied independently after physical lease. Existing held-start gate retained; rejected journal pool preserved outside candidate.
**Tech Stack:** Node ESM/TypeScript/Vitest, existing file adapter.
**Spec:** docs/superpowers/specs/2026-10-30-observation-projection-sharing-design.md

## Global Constraints
No operating payload tests or additional large API scans, original/history/budget preserved, no temporary auto-pause, no guard weakening. Completed cache8scopes/4096rows/1MiB per scope. Existing current-path semantics/retry and15MiB record validation unchanged.

## Review Focus
Atomic file replacement; pending publication and unknown mutation; failed scans must not cache; legacy nonstring IDs/caller mutation; cache overflow and request timeout survival.

### Task1: Projection sharing and exact-path timeout reproduction
Files: src/ops/observation-pages.mjs; test/observation-projection-sharing.test.ts.
- [x] Add real temporary-file concurrent ids/indexCandidates test and reporter timeout + feature enqueue test; observe duplicate physical chunks before change.
- [x] Share disk projection by scope revision, bounded successful reuse, overlay after physical exclusion; preserve invalidation/errors.
- [x] Test same/changed generation, pending changes, cache limits, malformed data, caller isolation. Run related adapter/status/lifecycle tests.

### Task2: Held migration update boundary
Files: existing src/index.ts,src/state/graph-index-migration.ts; focused held-start regression.
- [x] Retain and verify held boot performs no job/cursor mutation; explicit resume same job after data guard; no journal pool.
- [x] Obtain independent whole-change review, then ordered AGENTS gates once on final source. Report all failed/unexecuted cases without reusing .45 exception.

Final scope additionally prevents new deep scans on periodic health events only; explicit checks and unknown warnings remain. Actual compiled held-worker test and5715/13/0final whole gate completed. Operating package activation and same-job throughput are still pending.
