# Native SDK recovery review candidate

Production reference: 0.9.32-daniel.55, Git commit `4605974f337a50ed7e0ef74e3bb635b6e5d5a805`. The .57 held-start changes are sourced from the separately preserved `3148e1d0a3df0241b69b2166085b10ed5979b99f` candidate. The .55 reference in this tree retains its original Git ancestry.

The November 6 incident reproduced unbounded retries of stale lifecycle evidence after reboot, eight concurrent SDK bucket read timeouts, and recurring whole-inbox reads from the automatic Viewer health event. The fixes separate lifecycle reconciliation from transient startup failures, serialize SDK bucket reads with early failure, and keep automatic Viewer reporting off the full inbox path. Explicit inbox inspection remains available.

The running .55 later held both memory and storage. Memory recovery in the candidate can release the memory hold after its existing stability period and a fresh check after the storage wait. The storage hold continues to block background work. Both holds remain in the crash record until a subsequent verified transition, so another cold boot must observe stable memory again. An administrator's storage recovery is a separate operation.

On recovery from a storage hold, retained vector intent needs a durable resolution. A known SDK response and an intact backup are insufficient to confirm that the corresponding vector checkpoint reached disk. The candidate refuses explicit SDK recovery when it cannot establish an empty pending set. Disk-confirmed recovery and ordinary successful SDK operation retain their established contracts.

Acceptance requires a release-specific execution closure, retention of the actual storage and memory holds on non-clean startup, and preservation of original vector intent. SDK completion does not establish disk persistence. The existing .55 guard, cold-copy manifest and TypeScript baseline are separate checks. The new version is a review candidate; applying a package directly to the installation is outside this procedure. See the project incident report for the verified operational epoch and test results.
