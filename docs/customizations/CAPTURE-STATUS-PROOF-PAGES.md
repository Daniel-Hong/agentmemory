# Bounded capture status proof pages

Prepared read-only source change; not an operating deployment.

The ordinary status reporter and existing authenticated `GET /agentmemory/capture` check at most32 archived SDK records with the original physical-key completion function and at most four concurrent reads. Failure remains unavailable, not success. A blocked SDK call can still exceed the caller deadline; its admission remains occupied until actual settlement. No timeout or storage guard is increased or removed.

`inbox.sdkRetained` is a retained-source count. `sdkProofPage.completed` counts only the current page. `sdkCompleted` is omitted unless this request checked the entire source set from offset0. A missing field never means zero. The UI separates these values and does not infer that an empty ordinary queue proves every retained SDK source complete.

## Continuation

The first request needs no new parameters. Its `capture.inbox.sdkProofPage` contains `offset`, `checked`, `completed`, `total`, `nextOffset`, `generation` and `checkedAt` (proof calculation completion time). Request the next page on the same authenticated route with `proofOffset=<nextOffset>&proofGeneration=<generation>`. Page size is fixed at32 for HTTP calls. No automatic traversal, retry, write, replay or deletion is started.

Offsets must be safe nonnegative integers within the current source set. A returned offset remains usable above10000 retained originals. If the original inbox snapshot changes, the server returns409 `CAPTURE_PROOF_GENERATION_CHANGED` with `restartFrom:0`. Restart explicitly; do not accumulate an old page as current proof. Invalid page input returns400. A busy or failed scan returns an unchecked inbox and retains its unavailable notice.

The generation is a local SHA-256 over per-record SHA-256 digests ordered by inbox key. Each digest covers the complete record, including its original payload. It is not a credential, flush receipt or history generation. Each page reads current history by physical KV key; history can change between or during pages. Matching source generations therefore do not make histories atomic and page counts must not be summed into a whole-inbox durability certificate. No historical unknown write is resolved by these counts.

## Cost and remaining limits

The network proof count is bounded; total memory, CPU and latency are not independent of inbox size. Every page still lists the inbox, hashes each original record during projection, and sorts metadata and digests. The file-backed list projects rows without retaining the full payloads in the returned array. It does not read an additional whole history namespace, cache proof results or bypass the writer. Very large inboxes or stalled SDK calls can still be unavailable. A genuinely keyed engine batch/index would be a separate compatible change.

With the same synthetic479-record, 8,006,855-byte dataset and assumed45ms per history read, complete verification made479 reads in about5.45s, while one page made32 reads in about0.40s. The shared test process peaked around142MiB RSS; this is not a before/after memory comparison or an operating latency guarantee. Data creation was outside the timed section. Tests use synthetic fixtures and temporary HOME only.

## Operating application boundary

Combine this server/UI change with the already-published single-calculation admission fix in one reviewed server candidate. Keep the existing engine binary, Ollama endpoint/models, native55 hooks, global hooks, originals, preserved lifecycle evidence and historical unknowns. No hook trust update is required by these optional query parameters.

Before any new application: bind the exact current .55 package/source receipt and new candidate hash, verify supported hold/drain and normal shutdown receipt, old worker/engine absence and writer lease exclusion, then make/readback a current stable copy and stage the exact candidate. If shutdown or storage evidence is uncertain, stop; do not silently fall back to a crash admission or repeat a request. New writes preclude promising an automatic old-version/data rollback.

A new candidate needs its own formal enrollment and administrator authentication under existing trust rules. Prior candidate/grant identities are not reusable. No stop, enrollment, policy change, budget reset or application is performed by these documentation or test steps. After an explicitly authorized application, verify fresh Health/SDK/memory, one representative bounded API page and an unchanged-generation continuation, real UI labels, and natural work with the same graph ready. Retain backup and unknown evidence.
