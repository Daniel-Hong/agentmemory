# Upstream and native hook integration55

## Scope and provenance

Development integration joins personal .54 source27874d65939142ed0647840722714bcf919d693b and .53 source7a5fe05b8b94d287aa9717369c00132cdb20fc75, then official0.9.32 sourcea78401f3de29ada76c614aa624f85071e7b50009. Keep the running custom engine unchanged. This source is preparation, not deployment or whole historical integrity certification.

Retain personal SDK mutation epoch/latch, bounded summary readers, source generation validation, identity-bound native startup/shutdown, writer lease and held boot. Upstream orphan cleanup is disabled for SDK-only completion. Certified embedding fingerprints deliberately keep their old canonical text to avoid silently invalidating historical receipts; newer direct/bulk concept text is a separate policy, not a migration.

## Native capture and transport

The explicit local-sdk-v2 package retains all six native events and their context/session roles. Only prompt/tool/Stop capture selects C. It keeps the approved8MiB input,256MiB originals and5MiB references policy, original-first verification, no automatic original deletion, payload conflict and uncertain-send holds. Same endpoint and capture scope remain. Large guarded restore remains unsupported rather than bypassing the server limit.

Native context/session requests, bridge requests and shared legacy post/receipt/restore routes refuse Fetch redirects. Initial URL checks alone do not constrain307/308 destinations. Synthetic side-request tests verify actual request options; existing real redirect tests ensure no second destination receives the observation and preserve uncertainty after the first POST.

Installed global9 event registrations/13 compatibility files remain a separate preserved artifact. The baseline long-session compatibility client has direct fetches not universally covered by native guards. Do not claim all global transport hardened. Keep its old files in the app overlay and review native C separately before host activation.

## Release helper changes

Archive checks use one pinned regular-file descriptor, exact compressed hash/member set and streamed member hashes. Preserve the exact environment file in place after no-output baseline/identity validation; do not back it up or restore it. Other files and evidence remain preserved. Version032 support retains candidate/package/source identity and rejects malformed or unrelated versions. The new archive regression test belongs in the source checkpoint.

## Actual verification and remaining gates

Final ordinary non-integration regression:6,300 passed/13 conditional skips/0 failures; build, compatibility build, docs check and17 skill checks passed. Release helper suite:397 passed after the four service-provider adapter tests. TypeScript retains30 identical baseline diagnostics after source-root/line normalization; no full typecheck pass is claimed. The earlier four integration failures remain in development evidence: stale compat generation, historical fixture recalculated with newer privacy behavior, stale endpoint docs and obsolete refused-transport drop expectation. Fixed historical fixtures use independent old values and preserve mismatch refusal.

The fresh large SDK fixture passed on product source`dbbdb790` on2026-11-05 under the newly user-approved bounded11GiB profile, preserving all functional/cleanup assertions. Whole-test limits were2GiB/swap0/onecore, original child heap/RSS/CPU and8GiB host-stop protections stayed unchanged. Original12GiB profile is not claimed passed. The new one-shot execution is consumed. Do not obtain resources by stopping operating work or weakening protections. Later service-adapter-only changes reuse this evidence only after verifying identical product and SDK fixture bytes.

Before deployment, verify explicit LLM/cloud embedding selector compatibility under upstream032 opt-in, exact current host trust linkage and final package/source hashes. Do not silently disable summaries or enable a new external destination. Normal drain, verified shutdown, current stable backup and protected acceptance remain required. No restart, SDK/budget reset, old unknown rewrite, data rollback or automatic old-version fallback is authorized by this source preparation.

## Upstream replacement criteria

Retire personal guards only when an upstream implementation passes the same SDK-only completion, epoch/source race, identity/shutdown, original-first preservation, malformed input, redirect and failure-retry tests. Historical unknown writes and flush uncertainty are never resolved merely by fresh counters or this regression suite.

## Prepared service provider selection adapter

Current operating metadata identifies OpenAI LLM and OpenAI2560dim embeddings. Narrow configuration checks found EMBEDDING_PROVIDER=openai in the existing environment file and no AGENTMEMORY_LLM_PROVIDER there or in the unit's explicit Environment property. Upstream032 must not silently disable working summaries.

The smallest prepared transition is optional reviewed release metadata`serviceProviderSelection: {"llm":"openai"}`. It emits exactly one fixed nonsecret line into the already managed`/etc/systemd/system/agentmemory.service.d/90-personal.conf`:

```ini
Environment="AGENTMEMORY_LLM_PROVIDER=openai"
```

No `.env` read/write expansion, key/model/endpoint change, new credential, sudoers, access policy or root-owned executable path is added by this adapter. The managed drop-in hash remains protected; absent metadata preserves old bytes. Reject every other provider, extra field, null or environment injection. New runtime acceptance requires`config/flags.provider == "llm"` when selected; this is configured-provider evidence, not a connectivity or completed-model-call certificate. Existing verified stop, original/stable backup, identity, held boot and rollback restrictions remain.

Four synthetic regressions cover exact generated bytes/unchanged environment, protected drop-in tampering, invalid/injected metadata and blocked acceptance when LLM selection is inactive. Independent read-only review found no Critical/Important issue in this adapter. Full release-helper suite397 passed. No operating setting, service, hook trust or enrollment was changed while preparing it. Actual setting activation and hook trust are excluded from the latest read/test approval and require their exact action-time scope.
