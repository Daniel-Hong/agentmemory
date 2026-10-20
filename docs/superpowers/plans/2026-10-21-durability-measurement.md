# Storage certification measurement implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline and one fresh reviewer after verification.

**Goal:** Distinguish capture, readback, sync, verification and retry waiting without changing certification results or exposing operational content.
**Architecture:** Keep a bounded in-memory history on the existing fence snapshot, exposed by the existing authenticated health API. Reuse namespace reader metadata; do not add reads, logs, services or dependencies. Separate monotonic measurement time from the unchanged deadline clock.
**Tech Stack:** ESM, Node standard library, Vitest with temporary HOME and synthetic files/mocks.
**Spec:** User-approved delegated scope and bounded design in the current conversation; details below are the implementation brief.

## Global Constraints

- Work only in this development copy at baseline b45645b43aea5855cf2707f6bf3a497955387631; preserve original dirty files.
- No production data, credentials, settings, provider calls, jobs, restart, deployment or Investment work.
- Keep timeout 15000ms, poll behavior, capture concurrency, fsync/signature/revision checks and dirty key retention unchanged.
- No raw namespace, key, path, value, session identifier, arbitrary exception text or stable identifier in new measurements.
- Use fixed namespace categories and random-key HMAC scope tokens, ephemeral to one fence instance. Cap history at 8 publications and namespace detail at 8 per publication; report overflow counts.
- No automatic log emission or additional IO. Observer failures must not change success/failure; incomplete reader bytes must be marked incomplete.
- Phase durations are disjoint wall times, including parallel capture as wall time; report retry waiting and cleanup separately, not as disk latency.

## Review Focus

- Timeouts during parallel capture: late promises cannot mutate a finalized publication sample.
- Concurrent certifications and multi-namespace failure: samples correlate to their own publication without overwriting another outcome.
- Unknown error messages and namespace strings: fixed categories only; no arbitrary text leaks.
- Reader abort/replacement failures: available file size/bytes are reported without extra IO and without claiming a completed scan.
- High publication/namespace counts and telemetry exceptions: memory/output remain bounded; original storage semantics survive.

### Task 1: Add bounded measurements and regression coverage

**Files:** modify src/ops/state-durability.mjs and its .d.mts; modify src/ops/namespace-reader.mjs; create src/ops/durability-measurement.mjs; create test/state-durability-measurement.test.ts and test/namespace-reader-measurement.test.ts; document in CHANGELOG.md and docs/customizations/DURABILITY-MEASUREMENT.md.

**Interfaces:** Existing fence methods and result fields remain intact. snapshot() adds `measurements` containing safe, bounded completed publication samples. Namespace reader accepts an optional internal `onRead` callback with numeric IO metadata only, called once at completion/failure and isolated from the read outcome.

- [x] Run baseline suite in isolated HOME; record existing failures separately.
- [x] Write tests for all four phase times, retry-wait/cleanup time, reasons, bytes, ephemeral correlation, bounds, failure isolation and retained dirty keys.
- [x] Run tests before implementation; expect missing measurements/onRead assertions to fail.
- [x] Implement the collector, reader metadata reuse and fence phase transitions; leave original return/error meanings unchanged.
- [x] Run focused tests and relevant namespace/durability/health regressions; compare added IO to the uninstrumented contract.
- [x] Run build, skills:gen, docs:sync, skills:check, full npm test, docs:check and focused type-baseline comparison.
- [x] Obtain fresh independent review; fix important findings with RED/GREEN tests; record limitations and evidence.
- [x] Commit only development changes after required checks, retaining all generated docs. No merge or deployment.
