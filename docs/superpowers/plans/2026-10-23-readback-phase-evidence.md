# Readback phase evidence

Goal: distinguish a read waiting for admission from open/stat/stream/processing/close work without changing the verification algorithm, deadline, physical slots or fsync.

Use opt-in reader progress, a single current snapshot per physical shared read, and a whitelisted compact snapshot at certificate failure. Processing is elapsed wall time (including entry callbacks and their scheduling), not attributed CPU time. Physical-window process CPU and event-loop active/idle are overlapping process-wide context, not exclusive work attribution. No extra reads, timers or raw paths/keys/values are recorded. Reader progress failures must not affect read success/failure.

Preserve the first eight compact readback failures per process, count omitted later samples, and attach the same bounded safe evidence to the existing recovery failure checkpoint. No retry-budget change or production activation. Earlier failures cannot be reconstructed.

1. Add failing tests for phase progress, observer isolation, active abort/close, bounded retention and checkpoint validation.
2. Implement progress, shared-read snapshot forwarding and failure retention only.
3. Run small single-fork regressions, a tiny isolated installed-engine certificate and independent review. Measure overhead with a small synthetic fixture; no production data or load suite.
