# Capture receipt budget and validated scanner optimization

Development only. The operating capture backlog has not been certified reconciled. This patch changes the server namespace scanner, not the compatibility client's five-second request budget, the server fence's fifteen-second maximum, the receipt API or ownership/deletion rules. No deployment or restart is performed by these tests.

## Demonstrated cause

The compatibility worker calls `handoffObservation` with 5000 ms. Oversized records first query a digest-bound durable receipt. The receipt handler uses the remaining caller deadline when checking both completion metadata and the full source observation on disk. If this scan exhausts the deadline, the client retains the original and may never reach POST. A healthy server, zero write-mutation failures and no new spool append drops do not prove this ownership handoff completed.

This is distinct from a regular background certification with a full 15000 ms budget. Both use the scanner, but the five-second caller path cannot be reported as a full fifteen-second failure. Live caller correlation was not instrumented; the following proves a synthetic mechanism rather than the identity of every operating failure.

## Minimum change and correctness

The existing state machines already locate strings and structural boundaries before native JSON.parse validates each complete value. Native regular-expression searches now skip runs without quotes or container delimiters while outside compound strings. The raw byte-prefix scanner uses the same optimization. No bytes are discarded from entry text or fatal UTF-8 decoding. Every selected and unselected entry is still parsed and validated; top-level duplicate keys, malformed JSON, trailer boundaries, replacement signatures, cancellation, fsync and final signature verification follow the existing path.

No completed-result cache, new retention format, index, global timeout or privileged release component is added.

## Reproduction

Freeze the pre-change reader from the personal fork commit, then run:

```sh
git show fb8da9638037df94c9b735a3994754a572cdc281:src/ops/namespace-reader.mjs > /tmp/agentmemory-reader-daniel16.mjs
node benchmark/capture-receipt-budget.mjs /tmp/agentmemory-reader-daniel16.mjs --assert-release
```

The benchmark refuses a baseline whose SHA256 differs from `c0d7f7e4ff1f8670e54664d4e38761d2ae1b3845b39279b93aa7533307c01d35`. It generates a roughly 220 MB namespace with numeric vectors, escaped/multibyte text and a roughly 5.6 MB synthetic source observation, plus an independent concurrent background namespace. It uses the packaged HookClient and capture adapter, real receipt handler, real streaming reader and real file/directory fsync. SDK gets and HTTP transport are in-process fixtures; the transport checks routes and honors AbortSignal. No real engine, network, model or private data is used.

Two alternating trials observed:

| Reader | Collector elapsed | Durable receipt | Original records remaining | POST requests |
|---|---:|---|---:|---:|
| Frozen baseline | 5.09–5.11 s | unavailable | 1 | 0 |
| Optimized | 3.91–3.99 s | completed, durable | 0 | 0 |

Both cases certified the independent background operation. Candidate source ownership was released only after matching raw-source digest, disk readback, fsync, final signatures and post-fence current-value checks passed. The baseline retained the exact original after the short proof deadline. This is a guarded performance reproduction, not a timing assertion in the normal CI suite.

Correctness tests also cover mismatched/missing/deleted source, changed payload, malformed unselected JSON, malformed disk JSON, HTTP rejection, post-fence deletion and retry ownership. A separate Node worker process reads a persisted pending record during future retry backoff and leaves its exact body intact; it does not prove a successful network retry after process restart.

## Validation

Build, skill generation/check, documentation synchronization/check and the full application suite passed: 3301 tests passed, 4 skipped. Tests used a temporary HOME and the default fork pool. The sandbox-only first run could not bind test sockets or run synchronous child processes; the permitted development validation passed without changing those tests or operating permissions. An independent review found no important issue and separately passed the nine collector/receipt preservation cases. Rebuilding compatibility artifacts left both the capture client and its manifest hashes unchanged.

Upstream replacement is appropriate when the upstream reader preserves these full-entry validation and durable-receipt regressions and demonstrates comparable bounded-budget behavior; do not drop the local correctness cases solely because a faster parser exists upstream.

## Limits and rollout

Two trials, synthetic data, page cache and in-process transport are insufficient to predict production reliability. Real engine scheduling, write churn, file layouts, provider latency, network overhead and larger/concurrent source projections can still exhaust either deadline. Logical scan bytes do not measure physical disk IO. This does not claim all fifteen-second failures or the operating warning are fixed.

After complete development validation, use the existing server release/SSH enrollment route with a primary and compatible recovery package based on the actual current server baseline. Do not reuse an older-baseline recovery candidate blindly. The production diff is server-only; no collector protocol or root runner/helper update is required by this change. Confirm the release's client compatibility hashes before deciding the exact rollout scope. Describe the candidates and obtain operating deployment/restart approval before applying. Preserve the latest outbox and data on rollback; rollback changes code only. Observe existing work after deployment and require actual receipt/ownership progress, not disappearance of a historical warning, before acceptance.
