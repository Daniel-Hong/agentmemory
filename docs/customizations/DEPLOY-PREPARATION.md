# Remaining customization and deployment preparation plan

Spec: root docs/feedback/DESIGN.md, SOL-HANDOFF.md, outputs/pre-fork-2026-10-19/AUTOMATION-DESIGN.md and frozen reviewed-source archive.
Base: e85681da4c60cd8388da22f3bb07cfb5ee249124 (personal). No production activation.

## Task 1: PORT-06 bounded readers and operations Viewer
Interfaces: StateKV observationReader/auditReader, authenticated API, Viewer proxy, capture progress, CPU metrics.
Copy relevant acceptance tests first; run isolated tests (Expected: missing implementation failures). Port approved modules and narrowly merge shared callers; add scoped declarations. Run targeted tests and build (Expected: pass, no new TypeScript diagnostics). Preserve PORT-01..05 fences/receipts/source data.

## Task 2: PORT-07 background and provider admission
Interfaces: background control/lifecycle, feature workers, pressure, readiness, snapshot, structured model consumers.
Run reference tests RED, port independent modules and merge registrations without reverting prior fixes. Persistent pause, shutdown, per-feature recovery, native schemas and scoped slots must retain originals. Run targeted and full suites (Expected: green except documented upstream skips).

## Task 3: PORT-08 source-native feedback
Reuse outputs/feedback-v1 modules and tests; discard hashed bundle patching. Add approved append-only relationships and exception decisions with revision/replay validation. Wire SDK, authenticated proxy and Viewer. Test all feedback store/API/scheduler/browser/history/relationships with temporary roots and mock executor (Expected: green and zero memory writes).

## Task 4: integration and review
Build, generate/check skills/docs, compare type baseline, full fork suite. Run isolated API/proxy/browser, recovery/scale and packaged CLI checks where available. Fresh independent reviewer examines entire remaining change; fix important findings with RED/GREEN evidence. Record unavailable live OS/model checks.

## Task 5: frozen deployment candidate
Build server/client package and secret-free instructions; same final hash sets in manifest, real guard/preservation execution against synthetic npm-shaped tree; archive readback and deliberate mismatch rejection. No production data in code archive and no rollback of current data. Record changelog, receipts, manual memory review status. Actual deployment excluded.

## Review Focus
Preserve immutable raw reports/observations, retry and receipt state; no silent durable memory overwrite; authenticate bounded APIs; model output never gains tools; original and alternative providers; stop/drain durability; final artifact hash agreement and rollback safety.
