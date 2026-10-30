# Capture Completion Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** prove and minimally implement truthful selected SDK completion for rebuild-excluded empty text and eligible retrying originals.
**Architecture:** share existing rebuild eligibility, add explicit index evidence, extend versioned resolution state machine and its existing consumers. No index/text repair or operating mutation.
**Tech Stack:** TypeScript/ESM, existing .mjs state helpers, Vitest forks/in-memory KV and small temp fixtures.
**Spec:** docs/superpowers/specs/2026-10-30-capture-completion-contract-design.md

## Global Constraints
- Installed42 stays paused; no operating/API/engine/network/raw data, candidate, registration, deployment, resume, index writes,19 state adoption or backup deletion.
- No title/narrative rewrite, source replay/deletion, false verified/synced/durable claims, guard bypass or budget/circuit/history reset.
- Keep existing admitted/backgroundPaused/writer gates and source/marker/pending/vector checks.
- New v2 is not evidence that old42 active rollback is safe; surface unresolved rollback/admission boundary before any candidate.
- Preserve v1/dead format and original/user work. No version bump/dependency install.
- Default Vitest fork pool/maxWorkers1/real temporary HOME; existing dependencies only.

## Review Focus
- Empty strings vs whitespace/non-string values: normal policy stays unchanged; malformed cannot gain eligibility.
- Index owner changes across awaited writes: no fresh successful return on failed final proof.
- Retrying manual request/nextAttemptAt/attempt history changes: remain bound and refuse rather than lose history.
- Partial committed review but pending archive: status never claims complete until terminal markers match.
- Old42 generic SDK consumers: counterexample must remain documented; no blanket rollback-safe claim.

### Task 1: Minimal completion contract and regressions
**Files:** shared ops observation-index-policy.mjs/.d.mts; functions/search.ts, ops/observation-pages.mjs; capture/sdk-reconciliation.ts, sdk-resolution-record.ts; functions/capture.ts; capture/review.ts; types.ts; relevant existing capture SDK/review/source/search tests and one focused policy fixture. Modify sdk-source-restore only if needed to use the shared validated completion evidence, not to bypass paused gates.
**Interfaces:** shared observation eligibility matches existing Boolean(title&&narrative); structured evidence distinguishes keyword requirement/exclusion and actual member/owner, vector owner mandatory; v1/v2 resolution validates prior state/digests and all four writes. Keep REST selection shape and SDK-only result contract; recorded evidence explicitly historical, not live revalidation.
- [x] Write small real-code characterization proving rebuild skips empty narrative while live SearchIndex.add can accept it; normal nonempty and whitespace remain indexed.
- [x] Write RED regression for truthful excluded-empty source adoption and retrying four-stage continuation, retaining nonempty-missing refusal. Record exact expected failures before changing product code.
- [x] Implement only the shared eligibility/evidence and versioned state machine/consumer changes in the Spec.
- [x] Exercise required negative cases, each of four writes before/after acknowledgement for dead and retrying, same-ID recovery and other-ID refusal, v1 continuation/idempotency and immutable state checks. Keep source/index generations uncertain when changed; no global atomicity claim.
- [x] Self-review diff, run focused tests on a real temporary HOME/default forks and report files/commands/RED/GREEN/output. No commit until all required precommit checks; controller may combine final checks after review to avoid duplicate full runs.
- [x] Independent spec+quality review, resolve only concrete findings. Final build/skillsgen/docssync/skillscheck/npmtest/docscheck in required order, preserve failures by name. Commit only owned code with verified existing Codex identity after passing.
- [x] Report implemented scope, future state-write/rollback/admission approval boundaries, remaining operating snapshot/UI limits; do not create a candidate.
