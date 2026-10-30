# Snapshot input lifetime and selected index evidence

Development-only changes; installed services, hooks, engines and runtime settings are not changed by building this checkout.

## Snapshot

The legacy root JSON fields and record serializer stay compatible. Observation sessions are loaded, validated and emitted one at a time. The prior array reference is cleared before the next awaited read; only the observation count is retained for statistics. The existing graph-generation view, opened-file observation generation, atomic file publisher and fsync sequence remain.

This does not bound total process memory to the output buffer. A single session array, one record's serialization, sessions/memories/graph/access metadata, SDK caches and allocator behavior can still dominate. No record cap, dropped data, new format or increased product timeout/heap was introduced.

Regression coverage observes real temporary output and prior-array WeakRef reachability in a small isolated child. Format, restore and late failure/cancellation preservation are tested. A small synthetic baseline/current comparison is too noisy to establish an MB saving or operating OOM cause; no operational performance guarantee follows from it.

## Selected index evidence

`GET /agentmemory/capture/index-evidence?keys=...` uses existing authentication and strict capture-key selection. At most ten distinct keys are accepted. The iii handler reads selected review/canonical/session records sequentially and returns only identity/text-presence booleans and hashed references, current-process BM25 has/session and vector ownership observations.

There is no namespace list, repair, inference, state write, index mutation or counter reset. Canonical `kv.get` can internally read a complete selected record; the response contains no original payload, title/narrative content, path, credential or raw exception. `canonicalRecordRead` distinguishes a known result from an unresolved/timed-out read.

The helper has a bounded observation budget, leaves at most one keyed read outstanding after timeout and remains busy until that work settles. It reports rebuilding/epoch/selected-value changes and malformed metadata as unavailable. These are non-atomic observations and do not exclude ABA or establish disk durability, completed business work or repair authorization. Existing membership response semantics remain unchanged.

## Replacement criteria and deployment boundary

Prefer equivalent upstream session-streaming input and selected read-only evidence once compatible behavior/failure tests pass. No new storage migration is required. Server activation requires normal reviewed packaging/registration/restart; development tests do not prove the current operating BM25 `has` result or actual Viewer rendering. No automatic index repair or general resume accompanies this feature.
