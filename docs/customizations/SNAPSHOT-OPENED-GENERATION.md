# Snapshot observation generation read

Scope: .34 observed one read_observations / STATE_NAMESPACE_CHANGED failure. The producing writer and exact namespace remain unknown. No operating changes or extra observation are included.

The existing engine0.22.1 source investigation documents complete temporary namespace file write followed by rename. A reader with an open fd can finish that immutable published generation even after its pathname is replaced. Current namespace reader demands that the pathname still refers to that fd at completion, so normal replacement is reproducibly rejected. Snapshot export is already a partial application export collected across multiple calls; it is not a cross-namespace atomic snapshot or a disk-commit receipt.

Minimum change: snapshot observation calls explicitly opt into opened-generation consistency, through StateKV and existing observation overlay. Default reads and all durability certificates retain current-path consistency. Opened-generation reads require unchanged dev/inode/size/mtime. ctime changes are accepted only for an opened linked inode becoming unlinked; other ctime changes remain errors. Actual in-place content changes, invalid JSON/UTF-8, duplicate keys, cancellation, and size limits continue to fail. No retries/deadlines are increased. Existing overlay still includes current SDK values; do not call the result an exact single-generation transaction.

No writer coordination, new storage format, migration, engine change, runtime guard or boot change. Snapshot atomic publication/fsync/Git behavior and prior snapshot preservation remain unchanged. Remaining later serializer size and memory limits are not fixed by this patch.

Validation: first capture real small temp-file rename/unlink failures; then verify narrow opt-in success and unchanged strict refusal, in-place errors, corrupt/incomplete input, pending overlay/new/deleted keys, routing, snapshot publication failure preservation and cancellation/descriptor closure. Tests use synthetic data only. Existing production generation/throughput remains unverified.

## Actual validation and remaining limits

Focused synthetic/adjacent checks: 90 passed. Final build, skills generation/check, docs sync/check passed; full `npm test -- --maxWorkers=2` passed 5386 tests with13 existing conditional skips. An earlier source revision full run failed the unchanged compression-first-certification disk test (2000.280183ms, state_namespace_not_committed); its log is retained. The same class was already deterministically reproduced on baseline. Final green does not resolve that separate disk-certificate race, and its exact occurrence in that full run is not traced. No assertion, test selection or product timeout was weakened.

Whole-repo TypeScript checking still reports existing diagnostics. The newly exposed optional-argument declaration error was fixed; the three diagnostics in touched TS source refer to baseline unused imports and an existing generic cast. Full typecheck is not reported as passing.

Deployment: none. Operating .34 remains manually paused with automatic recovery OFF, quarantine114 and legacy1 preserved. A future server-only candidate/restart and a single bounded scheduler snapshot observation are still required. Writer identity for the operating failure and later serialization/memory capacity are unverified. No engine/runtime guard/client changes are part of this patch.

Upstream replacement: remove this local file-read path when upstream exposes a bounded complete namespace read with a documented stable generation and compatible overlay/deletion semantics. SDK acknowledgement alone does not prove disk durability.
