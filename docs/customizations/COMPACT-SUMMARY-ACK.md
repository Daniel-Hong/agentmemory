# Compact summary state acknowledgement

The personal file-backed server requires the native engine's `state::set_ack` function before acquiring its writer lease or admitting capture. Its engine handler delegates to the existing `state::set` implementation, returns `true` on success, and forwards failures/deferred/no-result outcomes. Existing `state::set`, validation, triggers, disk format and SDK message limits remain unchanged.

`StateKV` enables this only for summary writes in the file-backed server. Its compatibility default and other namespaces keep the existing state API. The summary request is pinned to a JSON snapshot, a non-true ACK is an uncertain mutation, and the acknowledged snapshot updates the existing metadata/wire-byte overlay. No echoed old value is fabricated. Existing SDK completion and shutdown checks still apply; an ACK is not an fsync guarantee.

The failure mechanism is old+new response amplification. An installed COW engine and real SDK0.25 replay of a33556506-byte value produces67113039 response bytes, exceeding the SDK64MiB message cap. The write applies, the response disconnects the SDK, and the request times out. This is why neither a longer deadline nor treating a timeout as an unapplied write is safe.

Validation uses synthetic data only. The fixed native release engine and actual `StateKV` code must pass large overwrite, exact JSON content readback, SDK completion, no reconnect, retained bulk-response refusal, clean engine exit and cold readback. Ordinary set responses and adapter/size errors must retain their old contracts. The compiled CLI must pass capability discovery, normal shutdown receipt checks and a second fresh startup.

This requires a coupled app/engine deployment. Never enable the new app on an old engine or apply either old published bundle again. The .63 cold-boot helper is pinned to the old release and engine: migrate its dependency and bindings as part of the same reviewed cold transaction. If the current worker already latched mutation uncertainty, use the preserved uncertain transition with a fresh PID/time-bound stop receipt, current-data backup/readback, old lifecycle preservation and no data rewind. Do not turn old unknown writes into successful history.

A single input or get response must still fit the unchanged64MiB SDK message limit. This patch removes duplicated values from the summary write response; it does not introduce a new storage schema or solve arbitrary oversized records. Replace the custom native handler when upstream provides an equivalent acknowledged-write contract with the same validation, trigger, failure, reconnect, shutdown and preservation tests.

Implementation and actual deployment must be recorded separately. Workspace evidence is in `work/storage-timeout63/REPORT.md`; long-term memory recording remains pending manual review.

A related interrupted-pause recovery case can retain manual, memory and storage-error holds together. After sustained memory recovery, only the memory hold may be automatically released under a fresh predicate and successful storage confirmation. Manual and storage holds remain, and explicit checkpoint-verified resume is still required. Failed storage confirmation retains all holds and the existing automatic retry limit. This avoids clearing protection by editing the saved control record.
