# daniel.65 — retained embedding publication and memory calibration

Base: operating .64 source `152fa918a8449b3b3eff22d5020f3d1ad6001329`. Status: isolated source implementation, not yet deployed. The wrapper workspace's `work/forced-shutdown-recovery-2026-11-10/` records actual validation and later activation.

The operator approved recovery of four embedding retries and capture backlog following a forced-poweroff boot failure, then explicitly selected18% memory pause/22% recovery on2026-11-10. The separate root-owned .64 self-service crash tool has already been installed and used; it is not bundled as a silently compatible .65 tool. The next deployment must version-match its coldboot and self-service helpers.

## Retained vectors

The original recovery intentionally retains WAL rows and forbids mutation of their IDs. Ordinary embedding retries previously called index.add and could never finish those IDs. The worker now compares a freshly source-derived Float32Array with both retained and loaded vector bytes and session. It reuses the existing current native checkpoint/retention receipt verifier without authorizing or writing new coverage. Only exact success skips index.add. Source projection and intent generation are checked again after verification.

Publication requires the same proof again before and after the existing SDK fence. An ID known as retained cannot fall back to ordinary publication if its WAL disappears. Add/remove/clear remain protected. There is no approximate similarity, original WAL deletion, new API, storage timeout extension or mutation-guard exception.

The SDK committed marker preserves one bounded previous intent/commit snapshot with original attempts, error, generation and fingerprint metadata. It includes completion=sdk/verified=false/synced=false. Existing metadata is history, not source/vector provenance. Physical WAL/bucket bytes and receipts remain untouched.

The existing embedding receipts view may still show index_pending because retained WAL remains present. Completion requires the worker's pending result and current committed/source/index proofs; WAL0 is not a target. A nondeterministic or different provider result remains pending.

## Memory

The pause boundary changes from max(2GiB,total×20%) to max(2GiB,total×18%). Recovery changes from max(3GiB,total×25%) to max(3GiB,total×22%) and still requires strict greater-than for120continuous seconds, fresh post-fence samples, bounded attempts and unchanged hold ownership. Critical remains max(512MiB,total×5%). Existing manual/storage/deployment holds are not waived.

## Verification and operation

The new four-item publication regression failed before implementation and passed after it. Refusals cover byte mismatch including negative zero, wrong owner, stale/missing receipt, changed checkpoint, source/generation races, paused admission, and loss of receipt or WAL during publication. Tests use synthetic namespace archives and the real StateKV/proof code; they are not a real native-engine process replay or operating repair.

Focused embedding204tests and memory56tests passed before the independent review's final WAL-loss regression; the additional regression's RED/GREEN proof and combined72tests are in the wrapper logs. All39 build configurations, copied assets and SDK bundle audit passed. The built default-fork suite passed6547tests in561files, with13conditional skips in4files, inside isolated user/network/mount namespaces with temporary HOME and masked operating paths. Integration and the unchanged12GiB summary boundary fixture were excluded. Typecheck exited2 with the same30 normalized baseline diagnostics and no added diagnostics. Package/native acceptance and deployment remain pending at this source-note stage. Do not claim all backlog completion from these tests.

The real patched a44eba0c native engine and SDK passed an additional isolated acceptance: four synthetic retained retries completed after one conservative publication retry (seven deterministic synthetic inference calls), with byte-identical original WAL, vector bucket and source files. All four receipts remained; mutation guards still rejected add/remove/clear. Two identity-checked SIGTERM stops exited0, and a fresh native process read back all four committed markers, absent retry rows and unchanged originals. Current epoch evidence used actual processes/sockets; the fixture's prior different-boot marker and provider were synthetic. This does not certify a fresh post-restart writer lease, packaged CLI or operating completion. Evidence: workspace `native-proof/result-am65-native-_ii31xyl.json`.

Deployment must preserve patched a44eba0c engine, original client13files, all operational source/cursors/attempts/Lesson/metrics/retained WAL, and issued prior kits. Normal update admission must genuinely satisfy its storage guard. No historical write is made verified by a new SDK-only completion. Long-term memory is pending separate manual review.
