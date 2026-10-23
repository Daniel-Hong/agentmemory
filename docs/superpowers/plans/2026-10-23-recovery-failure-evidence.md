# Preserve bounded automatic recovery failure evidence

Confirmed defect: coordinator discards durability diagnostics and only retains VERIFICATION_PENDING; global 32-trace ring evicted the three initial failures before investigation. Current production compression logs prove eight STATE_READBACK_TIMEOUT results, but no reliable join identifies automatic-recovery failures. No production content reads are needed to fix this observation loss.

Smallest choice: retain one whitelisted stage/code/elapsed diagnostic in each existing item checkpoint, expose aggregate failure categories only. Reuse existing checkpoint persistence; no extra write or scan, no raw error, IDs, digest or correlation token. Do not enlarge the global ring, change deadlines/budgets, replay data, alter correctness or deploy.

1. Failing synthetic regression for diagnostic retention across coordinator recreation; hostile error fields must not escape and success/attempt/outbox semantics remain unchanged.
2. Add optional bounded checkpoint diagnostic; aggregate only for unresolved rows, validate loaded metadata strictly.
3. Run low-load single-fork relevant tests, build/generators/checks and independent review. Full/browser/load/actual data tests remain excluded.
4. Personal fork only; report measurement gap and minimal later operating scope separately. This is an observability correction, not a demonstrated throughput fix.

Validation: diagnostic regression failed before implementation and passed afterward; seven single-fork files / 108 cases passed, build/skills/docs checks passed, independent review found no important issue. A tiny isolated real-engine reconciliation completed with receipt, preserved structured source and normal inbox removal; actual index readiness was a synthetic callback, so this is not a real index integration or production-load proof. Initial test compared JSON serialization order and was corrected to deep structural equality; its failed report is retained. No operating deployment or circuit reset performed.
