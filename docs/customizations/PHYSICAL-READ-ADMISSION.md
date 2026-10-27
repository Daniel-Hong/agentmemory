# Physical-job admission and late joins

Development only, based on the upstream0.9.31 personal integration. No operating activation, data migration, hook installation or retry-policy change.

## Boundary

The previous complete-certificate critical lease counted five callers sharing one physical read as five grants. With bulk queued, a sixth compatible caller could not reach the shared-reader join path; after the first scan finished it started another scan and exhausted its original deadline. This was reproduced with actual parser/fence/list/fsync and real clock on a6MiB synthetic file with a fixed9second pacing delay. The delay isolates scheduling; it is not a measurement of production disk or parser speed.

The critical lease now belongs to an owned shared-reader job, covering classification/admission/physical work and cleanup. A compatible late waiter joins before requesting another critical lease. New jobs still use the existing queue/burst fairness and regular/small slot limits; no unbounded parallel scanning is added. Bulk chunk callbacks continue to exclude physical certificate work. SDK expectation capture and each consumer's comparison/fsync/final signature checks do not hold that physical lease.

Each caller retains its original absolute deadline including SDK capture, job queueing, reading, retries, fsync and freshness. Its own expected values remain independent even when bytes are shared. A shared read result is not a receipt or ACK. Projection/key/waiter limits and private-overflow behavior are unchanged.

Shared jobs have a fixed15second lifetime from creation, never refreshed by joins. The job cap is independent of a caller's shortened budget; one caller expiry/cancellation removes only that waiter. The last waiter aborts queued or active work. An aborted physical job retains exclusion and its slot until real settlement/close; the cap does not claim to preempt an unresponsive native I/O operation. Standalone shared-reader users retain their previous unlimited default unless they explicitly supply maxJobMs; the durability fence always supplies the fixed cap.

Logical certificate promises are tracked separately from physical exclusion. drain still waits capture, fsync, comparison cleanup and mutations as well as physical tails. A drain or nested proof requested from its own active certificate fails reentrantly instead of deadlocking. Frozen writes, sticky mutation failures, dirty revisions, originals, receipt verification and recovery budgets are unchanged.

## Validation

The committed regression requires five initial matching proofs plus a late sixth to share one physical scan, with the small independent proof settling while the main paced scan is still active. Before the fix it failed at15seconds with two reads and about8seconds of small-proof delay. After the fix the same fixture has one scan and successful matching proofs; raw final values and test logs live in the workspace evidence dossier.

Focused development verification:35files274tests passed, no failures/skips, including the real-time fixture, job cancellation/lifetime/fairness/cleanup, distinct-file capacity counterexample, independent expectations/deadlines, inode replacement, directory-fsync failure, dirty-key retention, proof-drain/self-drain, grouped capture, receipts/recovery, protection and shutdown. This is not the full suite. Independent review found the remaining old admission-stage test; its intended boundary assertions were corrected while retaining dirty keys, mutation failure counts, original deadline and later successful proof. Generic drain coverage received additional author-identified RED→GREEN regressions rather than weakening its old contract.

Full suite, browser/load/model tests, production293MiB performance and official engine0.25/Compose remain unverified. Six distinct scans needing more total service than their deadlines, ongoing publication replacement and an intrinsically slow scan are not solved by better joining. Successful controlled late joining is not operational normalization.

## Upstream replacement

Remove this customization only when an official implementation provides equivalent job-level joining, bounded lifetime/cancellation/cleanup and independent consumer proof semantics, and these same preservation/deadline/fairness tests pass. SDK success or a save-interval retention window is not a substitute for the existing disk proof.

Build verification used all39unchanged tsdown entry configurations in fresh sequential processes, retaining declarations/plugins/targets/clean flags and the standard asset poststeps. Standard parallel compilation exceeded the launcher's384MiB and1GiB heap ceilings; same-process sequential compilation retained memory and stopped after15entries. Fresh-process entries all completed at1GiB without raising the ceiling. This temporary execution harness is not committed as a product build system. Generated compatibility artifacts and original skills/docs sync/check passed. Full default-parallel build under an unrestricted heap was not rerun.
