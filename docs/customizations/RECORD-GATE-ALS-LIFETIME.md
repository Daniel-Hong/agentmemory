# Record recovery async-context lifetime

## Problem and boundary

A fresh entry in createRecordRecoveryGate used to allocate and enable a new AsyncLocalStorage for each normal mutation. Deleting an idle map entry did not disable its ALS. Node22's enabled storage list therefore retained instances; future async-resource initialization traversed the accumulated list and copied their symbols, including undefined stores. The actual installed .50 bundle has the same code. This was reproduced independently of SDK and source-file size. The synthetic native setup profile placed58.6% of self samples in async-context propagation/init; this is not an operating CPU contribution measurement.

The Node22 API contract requires disabling an unused instance before collection and exits all contexts belonging to that instance. See https://nodejs.org/download/release/v22.21.1/docs/api/async_context.html#asynclocalstoragedisable . Consequently callback-parent completion alone is insufficient to retire an entry.

## Minimal ownership rule

Every running, queued and reentrant record use increments the same entry reference count before acquiring its gate. Gate callbacks synchronously expire their active token and release reader/writer state before the awaiting use() finally runs. Only the final reference disposes the inner gate, requiring no reader, writer or queued callback; the map deletion also checks entry identity. Independent entries, outer selected-record context and other ALS instances are not disabled. Standalone gate behavior and every storage/unknown/durability check remain unchanged.

A detached async descendant is not an active owner after its callback settles. Its expired token cannot authorize a new owner's entry, including via explicitly bound callbacks. A caller observing timeout/abort does not settle the actual SDK callback: the gate remains held until that callback actually settles. An SDK invocation timeout is different: the local promise settles while a remote write can remain unknown. The fix does not add remote cancellation or mark that write successful; failure count and mutationOutcomeUncertain remain set after late readback.

## Validation

Evidence directory: ../observation-work-selection-development/als-lifetime-validation (relative to repository parent).

- TDD regression: original source has3 expected lifetime failures; fixed focused suite12/12 passes. Includes concurrent references, queued writer, nested and unselected keys, actual escaped Promise descendant, bound context, callback failure, caller timeout/abort and independent trace preservation.
- Full default-fork suite: 5800pass/13existing conditional skips/0fail, including summary-sdk-boundary's existing12GiB-gated transport test. Build, skills generation/check and docs sync passed.
- Real SDK0.25.0, installed engine0.22.1 SHA60858a8d8663bc2696078602a8d2f9f5f61ee2ab75d76c35ffe24a01c5576b81. Independent temp HOME/config/state/spool and loopback port per arm; fixed initial17keys+5canonical nodes. Payload preparation and sealed-manifest setup are outside measured graph work. Both main comparison arms are uninstrumented, with identical2ms CPU profiling. N is requested normal writes; initial22 writes and previous graph writes also contribute, so total state-set counts are recorded.

| Requested writes N | Actual set count before reads | Old100SDK gets | Fixed100SDK gets | Old5-node graph | Fixed5-node graph |
|---|---:|---:|---:|---:|---:|
|0|22|15.069ms|15.722ms|286.322ms|166.362ms|
|1000|1310|121.472ms|10.921ms|2062.289ms|182.866ms|
|2000|2597|299.479ms|8.800ms|5231.767ms|163.454ms|

Each graph phase generates and applies actual journals of37/55/55/55/55writes, with canonical reads, control and committed cursor; it is not a precomputed journal-only replay. Per-arm cumulative state sets end2886 after caller-boundary checks; no requested work or metadata is skipped. Phase wall includes its drain/tick. sdkAwaitMs is a sum of potentially overlapping RPC waits, not CPU or a wall-time fraction.

- Separate instrumented fixed run:20000normal writes in batches of8; per-record ALS created20024/disabled20024/end0/max8. No strong retained Set of instances is used; main old/new performance arms have no prototype instrumentation. At20000writes,100SDK gets9.866ms; RPCs, active mutations and record entries end0, SDK failures0, final values and graph originals match.
- Separate explicit remote timeout boundary, both old/new: caller timeout/abort does not release an in-flight request's ownership. A synthetic25ms SDK invocation timeout permits exactly one late actual engine write, then keeps failurecount1 and unknown=true. No duplicate request, failure reset or false success. This limit applies only to synthetic requests; no product timeout was changed.
- Test workers, registered descendants, engine and ports exit normally; temporary fixtures are removed only after absence/port checks. No forced kill, production data, provider/model calls or operating service mutation.

## Deployment and replacement

Not deployed. Existing .50 remains operating; original data, graph job/build, histories and backups are untouched. Existing runtime contexts cannot be safely removed externally by this source-only change. Candidate admission, normal stop/drain and any required administrator enrollment must be separately validated before update. Operating acceptance must include enough natural writes to exceed the prior recurrence workload, warm UI/API, fresh Health and committed progress of the same graph job, not only startup200.

Keep the change until upstream has equivalent per-record context lifetime and the same owner/late-completion regressions pass. No cache or Graph UI changes are bundled here.
