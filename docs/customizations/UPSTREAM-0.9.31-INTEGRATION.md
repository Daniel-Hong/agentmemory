# Upstream v0.9.31 development integration

Official source: https://github.com/rohitg00/agentmemory.git, main c5b8ebfb32eb6a08fe301d3bb75840f3597b66c8. Personal return point: 5d41a60f91adc48c58905eb4fcbac7c353231d6e. Integration work is isolated on integration/upstream-0.9.31-20261027. This is not a production release or approval to update an installed client.

## Reused upstream implementation

Provider response-body deadlines/cancellation replace custom eager buffering. Indexed bounded graph queries replace whole-graph transfer and repeated adjacency construction; the local file reader and generation isolation remain. Worker SSE replaces the obsolete WebSocket relay while retaining first-frame bounds, serialization isolation, original exclusion and refresh OFF behavior. Unpublished durable topic registrations are removed while direct lifecycle functions remain.

Custom expected-value readback, fsync/signature checks, writer leases, verified shutdown, pause/drain, original retention, recovery budgets/history and default OFF are retained. No whole personal commit was reverted solely because a title or text looked similar.

## Summary contract integration

Small fresh sessions use the official summary/watermark/recovery implementation when the complete compressed and retained-source prompt fits the configured input budget. The original source is included as data in the prompt. Output can be XML or validated JSON content; session identity, counts and coverage fingerprints are always computed locally, never accepted from model output.

Existing personal progress, revision, processed IDs, offsets, or even a pin-only checkpoint keep the incremental JSON route. Large inputs or recognized binary carriers (explicit imageData/data-URI markers) also keep that route. The admission walk stops at a size/depth bound before serializing large source inputs, and actual provider prompts are checked again. Existing summaries are included in the reduce budget. This does not make every fingerprint computation bounded: the coverage fingerprint still serializes its source values.

Coverage includes retained source and compression revision/status. Old fingerprints are conservatively recomputed rather than promoted to current proof. Publication rechecks the session, input fingerprint and prior summary under the observation lock. Legacy personal summaries without verifiable coverage remain retained/held; this integration does not declare them recovered or reset their budget.

The incremental provider remains serialized by the shared provider adapter. Removing a duplicate summary-wide preparation lock permits bounded coordinator preparation across sessions without concurrent model execution. Existing same-session coalescing is preserved. A combined handle drains both official and incremental requests before stop completes. The official response deadline does not guarantee remote provider cancellation or bound every preceding KV/lock wait. Native Ollama retains the existing five-field JSON grammar and output cap for both summary consumers. Internal fractional clock deadlines are floored; one start sample preserves the external budget without relaxing its integer validation.

## Hooks and receipt compatibility

Stock hooks and codex-compat wrappers are built separately. Run `npm run build:codex-compat` after the official build. Existing host-event identity remains. The API honors an explicit final boolean and otherwise accepts the retained SessionEnd hook name; stock hooks use the official final flag and the compatibility wrapper keeps its existing name argument. A legacy outbox observation is removed only after verified receipt or fsynced managed-spool handoff. Receipt-required records are preserved on rejection and are not expired merely by age.

Structured redaction and legacy payload-digest canonicalization have edge cases still requiring a version-compatibility matrix. Never accept a mismatched digest to drain a queue. Installing the new capture helper or manifest requires a separately reviewed operational scope; no installation is performed by this document or its build commands.

## Validation and remaining limits

Focused run: files=69, passed=799, failed=0, pending=0. This includes all 26 official summary recovery/watermark cases with their completion, retry and original-preservation assertions retained. The recovery fixture uses the personal JSON response protocol and deferred compression worker; its missing-source setup removes both retained source representations. The official watermark file is unchanged.

Build, explicit compatibility-hook generation, skills generation/lint and documentation sync/check pass. Full suite, browser/load tests, real model calls and real SDK/engine 0.25 lifecycle integration were not run under the low-load development scope.

The SDK 0.25 state API returns state values, not a demonstrated disk commit receipt. Client shutdown closes connections and telemetry; it does not certify the independently supervised state worker's disk state or process exit. Worker Compose ownership, physical format and writer epoch compatibility require isolated real-runtime validation before deployment. The previous whole-file readback latency problem is not established as solved by upstream or by these summary tests.

## Receipt normalization follow-up (development only)

Two synthetic defects were reproduced after the integration checkpoint: collision-suffixed redacted keys and private tags spanning separate values. The sender hashed a serialized whole-object redaction while observe used per-key/value structured redaction. The small fix extracts the unchanged observe JSON roundtrip + `scrubKeys: true` contract into `normalizeCaptureData` and uses it in the sender digest. This is a delegated implementation choice within the approved correction scope. Accepting legacy digest mismatches would weaken proof; rewriting old records would change preserved source. Both alternatives are excluded.

`captureSourceDigest`, receipt expected values, disk readback/fsync/signature and post-proof rechecks are unchanged. Existing receipts are not rehashed or migrated. Existing mismatched stored sources remain retained. Old helpers can still mismatch new structured source and require an explicitly scoped client update; no installed helper is changed here. Existing auto-recovery checkpoints with a differing digest are blocked as SOURCE_MISMATCH without budget/history reset or silent checkpoint replacement, including across restart.

Regression plan: first require matching receipts for 8 wire-JSON fixtures by direct and spool paths (three cases fail before the fix); then verify generated compat collector + actual file fence, old source retention, recovery checkpoint retention, privacy and capture guards with a temporary HOME and one fork worker. No actual engine/socket test is included in this validation; its separate execution permission is still blocked. Large readback performance, full suite/browser/load and actual engine0.25 remain unverified. Do not deploy or install hooks based on these focused tests. Upstream replacement criterion: the official sender computes exactly the same structured-normalized source contract and these privacy/retention/receipt regressions pass without relaxing guards.

Receipt follow-up validation: 11 focused files / 174 tests passed with no failures or skips, including the generated helper through a real loopback server and the actual local file fence. Independent source/evidence review found no new blocking defect. A separate tiny probe used installed SDK0.25.1 + engine0.22.1, not official engine0.25/Compose: two synthetic rows survived normal restart, selected readback/fsync and receipts matched, wrong digest was rejected, and writer admission was false/false/true for initial/worker-only/new-engine boundaries. This is application admission, not engine-enforced write exclusion or a power-loss guarantee. Own processes and test ports were closed. No operating data, installed hooks or services were changed. Full suite, browser/load/model calls, official engine0.25 and the large-file timeout problem remain unverified.
