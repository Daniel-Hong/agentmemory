# Snapshot failure diagnostics

The operating .33 snapshot failure was logged only as SNAPSHOT_FAILED before replacement of the existing export. Known lowercase reader codes and code-less exceptions lost their classification. This development change records only a bounded phase, allowlisted reader code, and Error/TypeError/RangeError class. It never records error messages, stacks, actual identifiers or source contents. Success, retry, publication, fsync, Git and original retention rules are unchanged.

TDD reproduces loss for source changes and serialization RangeError without large allocations; malformed UTF-8, code-less graph uncertainty, unknown codes and graph pinning are covered. Atomic-file/Git preservation regression and independent review are required. This is diagnostic correction, not evidence that the operating failure is solved.

The operating Node22.23.3 x64 string limit is 536870888 UTF-16 code units. Namespace file bytes are not final pretty JSON string code units: selected session membership, binary trailers, omitted keys, included graph edges, whitespace and UTF-8 encoding differ. File metadata alone cannot prove a string-limit exception.

Deployment is not authorized by preparation. Current .33 is paused, automatic recovery OFF, quarantine114/legacy1 preserved. Existing release Runtime.stop accepts SDK shutdown only after start_attempted; therefore applying from an already-SDK .33 baseline currently fails its strict pre-candidate disk guard after stopping the old service. Do not apply or force verified/synced flags. The follow-up development guard now addresses SDK-to-SDK predecessor compatibility in the separately reviewed scope documented in SDK-PREDECESSOR-SHUTDOWN.md. The installed .33 guard is unchanged.

Upstream replacement criterion: remove this correction when upstream safely retains equivalent phase/code/class evidence while keeping the same no-content logging and preservation tests.

## Candidate validation

Initial diagnostic implementation: focused47 passed; full5369 passed/13pre-existing conditional skipped; build/docs/skill checks passed. After version34 synchronization: full5368 passed/13skipped/1failed in unchanged compression-first-certification serial vector publication (STATE_DURABILITY_TIMEOUT, state_namespace_not_committed,2s). The unchanged spec passed in isolation (3passed/4opt-in skipped). No assertion or timeout was changed and the failed full run is retained; do not call the final full run green. Independent review found no remaining critical/important diagnostic-diff issue and judged deployment blocked. The package is preparation-only, not a deployable or accepted release.
