# SDK native release compatibility implementation plan

> **For agentic workers:** Use executing-plans or subagent-driven-development, with independent review of the combined diff.

**Goal:** Install the SDK completion candidate without implicitly changing engine0.22.1/native lifecycle, source ownership or release authentication.

**Architecture:** Keep 4fd5566 immutable. In this follow-up worktree, repair child environment isolation, add an explicitly selected compatible native lifecycle, and make the development release-kit distinguish SDK completion from disk proof. Never install the kit or operate live services here.

**Spec:** docs/customizations/SDK-COMPLETION-RETURN.md and the approved bounded follow-up recorded in SDK33-PREDEPLOY-REPORT.md outside Git.

**Constraints:** Installed engine0.22.1 only; no download, operating write/restart/replay, privileged guard installation, permissions change, source deletion, false verified/synced flags or budget reset. Default upstream Compose stays unchanged unless the explicit native mode is selected. SDK shutdown is not disk durability. .32 rollback must preserve SDK sources and remain held. Synthetic tests only, isolated paths, low parallelism.

- [x] Prove the two known real spool files match the synthetic test internally without emitting source/IDs/digests or modifying files. Report before further runtime tests.
- [x] Repair the leaking hook test child environment; probe native HOME plus all config/data/spool paths before capture, reject escaping overrides, and clean its own temporary root. Test the missing-HOME regression without running an unsafe hook.
- [x] Define explicit native-engine0.22.1 selection with fail-closed version/config/identity checks and no Compose/download fallback. Reuse the previous proven native lifecycle where compatible; test start/stop/restart failure boundaries.
- [x] Develop SDK-aware release and code-only rollback protocol using exact process exit and stable source preservation, truthful SDK receipts, and held rollback. Preserve the existing strict-disk path and authentication/ownership checks.
- [x] Independent review and focused regressions, build/skills/docs, then previously approved full npm test after isolation is proved. Keep real spool file metadata unchanged.
- [x] Commit follow-up separately; provide package/three-client-file scope and operating approval boundary. No enrollment/deployment/push.
