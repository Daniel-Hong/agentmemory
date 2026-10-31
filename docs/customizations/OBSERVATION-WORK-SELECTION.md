# Complete observation work selection

Development .48 is separate from frozen .47 and installed .46. It is not deployed.

## Contract

The reader-owned work view streams every file record into detached scalar metadata and merges the current successful SDK upsert/delete overlay. It never substitutes keyword/vector search indexes for a complete work list. File-generation/settings changes invalidate the base projection. Mutation/epoch changes during a read invalidate the view. Selected per-key SDK values must match the recorded full JSON hash; summary publication retains the existing selected-source, session identity and prior-summary checks. Unrelated arrivals remain pending.

Summary priority/ties, blocked/history/backoff, old source pins and offsets, wire selection and final remaining formula are unchanged. Selection hydrates one original at a time and keeps detached selected input/required grounding evidence; old partial source pins may still be large. Enrichment keeps exact bounded graph projections, fingerprints and array wire budgets, and reloads after changed source revision/settings. Pre-provider source invalidation does not consume provider retry attempts. Stop/drain semantics stay normal and do not force cancellation of in-flight models. Optional read cancellation rejects partial results.

Retained cache admission is8MiB/entry,16MiB aggregate and8entries. Cache overflow returns all metadata uncached, never truncates or marks an incomplete list current. These are serialized metadata admission limits, not total heap/RSS guarantees: transient metadata, parsing a single record, selected grounding fields and existing pins also use memory. Generic list, exports and initial XML-versus-incremental admission for sessions without checkpoints are unchanged. Continuous file publication can still require repeated metadata scans.

The new cached read path requires a current owned native writer epoch. `fileWriterReadCurrent` proves only current lease/process/SDK peer binding. It does not grant historical recovery admission, mark a writer clean or resolve unknown writes. Existing recovery/write gates and marker formats are unchanged. A fresh store can read while historical recovery remains unadmitted; lost peer/ownership or uncertain writes invalidate read reuse.

## Evidence and limits

New regression matrix covers generation replacement, SDK overlays/deletes, incomplete files, overflow, concurrent cache admission, cancellation during scan/overlay/hydration, final-stat races, current-epoch changes including during inference, fresh-store versus recovery admission, priority/ties, partial pins, deleted processed history, provider waiting/backoff, settings changes and compression/graph payload/progress equivalence.

A separate-process synthetic comparison uses5,332,993B/1024records and50productive registered summary batches alongside registered Viewer snapshots and graph reconciliation with scheduled fake SDK KV. All50model input hashes, processed/pending traces and normalized summary hashes match. Physical opens50→2(one work scan plus an existing independent unindexed-search projection scan), chunks4100→164, CPU3247.121→393.168ms, wall2234.539→312.948ms, observed sample-max heap62,289,336→43,703,496B, kernel process peakRSS179036→143732KiB. Additional hydration doubles per-key reads including publication250→500.

Viewer median2.248→2.205ms but maximum70.663→105.767ms; graph median3.803→2.686ms but maximum44.200→78.236ms; event-loop p9911.592→18.170ms. Initial admission/hash scan is costlier than plain body parsing. Both synthetic paths return200; this is not a reproduction or proof of operating504 recovery, production memory safety or graph throughput. No operating293MB body or actual model is used.

Installed SDK0.25/native engine0.22.1 small isolated test uses private HOME/XDG/cwd/config/store/spool and one non-operating loopback port. Twelve originals are checked before/after periodic file publication with SDK per-key hashes; actual registered summary calls complete12/12, synthetic graph inference leaves0pending, all12full original values remain equal, mutationFailures0/connected. Total6.768s, sampled combined RSS216,666,112B, disk614,035B; child engine/worker exit0, ports released and synthetic root removed, evidence outside cleanup. First native attempt correctly exposed the overly broad recovery-admission dependency and failed; its evidence remains preserved. The corrected read-specific proof was independently reviewed and tested without changing recovery admission.

Whole final build/docs/test result and source artifact identity are recorded in the external preparation dossier after execution. No prior conditional deployment exception or consumed one-shot grant is reused. No temporary auto-pause is introduced; no production service pause is used to obtain test memory.

## Replacement

Replace this local projection with an upstream complete generation-bound per-key work/metadata API only after identical semantic, invalidation, resource and operating checks. A search index cannot replace this contract.
