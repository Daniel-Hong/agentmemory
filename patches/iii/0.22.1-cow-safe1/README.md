# Reviewed iii0.22.1 KV snapshot/save-loop patch

Apply `kv.patch` to iii-hq/iii source commit `e7de3820d1e558f3762edf95e4440552444d48d3`. It contains the exact deployed `engine/src/builtins/kv.rs` change, including synthetic regression tests. Resulting source SHA-256: `1de0af8b6547f4c4c2d36121e26ee3c4107a10e06f8e353f0f46d534def28f17`. The validated Linux release binary SHA-256 is `cc4ff876e7e5dcd4ea9313404542b6f0105b6544f2708259743f4beaf0c07f01`; source hashes do not promise identical binaries across toolchains. This is a personal modified engine, not the official0.22.1 binary.

The patch reduces deep snapshot copies while preserving serialized save publication, generation ordering and retry ownership. It also fixes old/new save-loop overlap, shared temporary-file publication and stale failed-operation reinsertion. The same KV file format is retained. Regression, file compatibility and real SDK comparisons were run in isolated stores; library tests are not a full workspace integration claim. Small synthetic memory improvements do not promise proportional production savings or remove the cost of keeping live KV values resident.

No binary, live namespace, credential, operational receipt, backup or captured payload is included. Production lifecycle/unknown writes require separate evidence; applying this patch does not resolve historical uncertain writes.
