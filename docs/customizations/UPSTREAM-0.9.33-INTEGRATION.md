# Official v0.9.33 — integration and retained-custom acceptance

> The initial staging sections below are the historical PR #3 snapshot, not the final candidate status. The dated continuation sections supersede its engine/SDK and unexecuted-test statements. The latest functional-integration section supersedes the initial selective scope and its deferred feature list; historical evidence below is not rewritten. No production deployment is claimed.

## Reproducible source pins

- Official v0.9.32 base: `0da38f1d5067a479a6e5c4653de342ba43ca22b2`.
- Personal original head: `658f3fdc3350a64670b28b50789defca0eef462a` (`0.9.32-daniel.55`).
- Official v0.9.33 tag: `28ffc538b81b265e2f649354ed9f88b0c12ae414` (2026-11-09).
- Staged review branch: `integration/v0.9.33-review`; upstream mirror branch: `sync/upstream-v0.9.33`.

Exactly **25** upstream v0.9.33 implementation/test files are imported as upstream Git blobs, but only after verifying that each file in the current `personal` tree is byte-for-byte the same blob as the upstream v0.9.32 base. This deliberately does **not** merge the entire v0.9.33 tree or replace any personalized code. The locally changed `test/cli-doctor-fixes.test.ts` is intentionally not overwritten; any missing upstream regression from that file requires a manual minimal port.

## Staged upstream source candidates — no parity certification yet

| Change | Imported source and relevant upstream regression | Remaining check |
| --- | --- | --- |
| #1350 / #1277 | Circuit-breaker success reset and content-filter errors not counted as provider outage | Ensure real HTTP 5xx still trip breaker. |
| #1696 | Hybrid search larger fusion pool, saved-memory diversification, refill after stale hits | Personal CJK/project isolation, large-store retrieval and old-memory ordering. |
| #1250 | CLIP text tower to produce comparable image/text embeddings | Same 512-dimension projections, no automatic re-embedding. |
| #1588 | Placeholder provider keys recognized consistently by config and doctor | Preserve explicit OpenAI selection and local plain-http exception. |
| #1703 | Claude `CLAUDE_CONFIG_DIR` path selection | Actual launch environment and native hook/MCP profile equivalence. |
| #1691 | MCP long-call timeout in source REST proxy/plugin bridge | Personal generated `.mjs` and CLI shim parity, no live timeout changes. |
| #1695 / #1701 | Redact before truncation and recognize compound secret names in core filter | Native/global bundled scripts and private capture path not yet updated/verified. |
| #1692 | Give core SessionEnd hook time to finish | Generated client bundles, source-first delivery and native retained originals. |

## Deferred / non-replaceable without a separate parity gate

Official iii/SDK 0.25.1, state scope paging, 64 MiB transport changes, engine auto-install and registry worker changes are **not** incorporated. The personal modified iii 0.22.1, SDK 0.25.1, exact KV save-loop patch, SDK write/flush certification, source-generation and writer identity rules stay unchanged. Official features with overlapping names are not proof of equivalent crash durability. The engine upgrade requires isolated real-engine + existing-format migration/rollback-read tests before any change to engine pin.

Retain personal sourceRaw and incremental summary/cursor, capture inbox/original/retry/quarantine/uncertainty, native six-event hooks and private source retention, embedding publication evidence, background durable holds, health/Viewer, update trust and feedback store unchanged. Official #1698 orphan facet heal, #1601 eviction cleanup, #1687 partial-vector repair, #1545/#1544 consolidation/reflection, #1527 session filters, #1693/#1220 hook pre-tool context, remaining generated hook security and large-store fixes remain **unported or partly covered**. No custom code is retired. `docs/customizations/catalog.json` retains `unverified` decisions.

## Mandatory review before promotion to personal or a deployment candidate

1. From this exact source tree, run `npm run build`, `npm run skills:gen`, `npm run docs:sync`, `npm run skills:check`, `npm run docs:check` and a diff check. Commit all generated artifacts only after inspecting them.
2. Use isolated temporary HOME and Vitest default fork pool for `npm test`; run eval typecheck, compare known baseline diagnostics. Tests copied from upstream have **not been executed** while staging this source; passing test names do not constitute proof.
3. Verify bundled native/global Claude/Codex scripts reflect the reviewed source changes; preserve actual client hooks, original-first image/spool, project scope, strict secret redaction and 500/190-second timeout semantics where applicable. Never infer deployed behavior from an unchanged generated bundle.
4. Require release gate, isolated SDK/real-engine/storage cold-start/read-back/incomplete-write tests and existing data-format compatibility for any engine or persistence changes. No production store, settings, service, hook trust or backlog should be touched during this code review.
5. Remove a custom feature only in an independent follow-up after its complete parity and no-data-loss regression matrix passes. Preserve recorded history, old-format readers and uncertainty markers; no automatic old-memory replacement.

Status: **prepared for source review only; build, tests, docs regeneration, generated-hook parity, live operating verification and deploy are not claimed.**


## 2026-11-13 reconciliation on the verified .68 source lineage

The historical .55 review above is preserved. The new isolated source candidate
combines `08bb147d1c5146ca23d6955418f69880a8a05c18` (.68 + personal
lineage reconciliation) with PR #3 head
`8ecd207a7fc88073f78140a167ec731f80ae68f5`. This is source preparation,
not PR promotion, an engine upgrade, or deployment. The .68 Graph schema 3,
summary compact ACK, SDK retention/recovery and current Health behavior remain.

- The only textual merge conflicts were the changelog and generated Codex manifest.
  Both changelog histories were retained; the manifest was regenerated from source.
- `skills:gen` fixes the previously failing config reference by discovering
  `AGENTMEMORY_CALL_TIMEOUT_MS` and `AGENTMEMORY_SESSION_END_WORKER`.
- The one missing official #1588 regression for placeholder OpenAI keys with a
  plain-http local endpoint was ported into the personal doctor test without
  replacing its additional custom tests.
- The imported SessionEnd regression exposed a missing official manifest change.
  Add its 10-second timeout only to the repository Claude hook manifest; no live
  client hook settings or Codex timeout policy are changed.
- No customization is certified as retired. The engine/worker gate remains
  separate: the official State Worker does not yet provide the required
  `state::set_ack` contract. Keep that guard and existing engine pin intact.
- Validation details and limitations are recorded in the adjacent workspace
  `upstream33-reconcile-20261113/REPORT.md`; tests are not operating evidence.

## SDK 0.25.1 isolated continuation

The candidate retains compact ACK and durability protections. Clean builds pin SDK/helpers 0.25.1 and the already verified OpenTelemetry dependency set; YAML/JSON5 match the bundle audit. No runtime audit has been disabled. The synthetic SDK boundary regression passes with a 3 GiB host preflight (its child is bounded to 1 GiB RSS and a 512 MiB V8 heap), retaining a 1 GiB host low-memory abort plus time/CPU limits. This replaces only the test's disproportional 12 GiB reserve, not operating memory admission. The minimal separate State worker ACK patch remains custom until upstream provides equivalent behavior; a compact ACK alone is not a disk receipt. No production activation or customization retirement is claimed.

## State-bound Compose candidate (isolated only)

The candidate uses an explicitly selected local patched State worker. Immutable boot identity and instance-qualified handlers are combined with the CLI-selected executable SHA-256, effective store path, process start/UID/namespaces and established sockets to the verified engine. Storage calls check the bound epoch before and after the response; replacement makes old aliases/binding unusable. The official engine metadata does not provide authenticated registration-to-OS-PID mapping, so this is a local lifecycle/cooperative-writer safety contract, not a hostile same-user security boundary. A same-user process able to modify the data or executable is outside that claim.

State-bound leases use v4; native leases remain v3. Existing v3 evidence is retained and is not silently upgraded into a State-bound proof. Registry workers without selected executable evidence fail closed. The bounded engine-evidence wait now finishes before lease creation, avoiding unsupported-marker creation after a slow metadata publication. Actual isolated State-only restart, fsync receipt, and real-binary CLI stop were verified; production migration and packaged registry/Docker deployment remain pending.

The patched file worker additionally acquires a separate lifetime advisory `.agentmemory-state.lock` before loading the store, retaining it through background flush work. This excludes cooperating patched workers on the same canonical store; software ignoring advisory locks remains outside the operating contract. Actual lock contention, abnormal-exit takeover and normal-exit takeover are separately tested. This does not authorize deleting historical application lease markers.

## Packaged local candidate and preserved native migration

The later candidate supersedes the earlier migration/shutdown limitations above. `deploy/state-worker/README.md` documents the pinned patched-State source builder and artifact manifest; `docs/customizations/NATIVE-V3-STATE-V4-MIGRATION.md` documents an explicit native prepare/finalize flow that retains exact original v3 bytes and appends a receipt. First v4 admission verifies that receipt and records provenance; unknown native layouts or changed evidence fail closed. No operating store or marker was migrated by this work.

The selected release worker now seals mutation admission, drains accepted mutations and flushes/fsyncs the namespace files and directory before issuing an instance-bound receipt. A real synthetic native .22.1→release-State migration preserved source/cursor/manual-hold/unknown fields, and subsequent app shutdown produced a verified disk receipt and clean marker, followed by successful restart/readback. The separate real 35,651,694-byte overwrite test retained the final digest and metadata after sealed flush and restart. These are isolated acceptance results, not claims of deployed client/server behavior.

Docker source-build/bootstrap wiring is present and its real local bootstrap was exercised. Native Docker image build/run is still unverified: the current account cannot access the root-owned daemon socket, and the rootless prerequisite check reports missing `newuidmap`/`newgidmap` (`uidmap`). No permission, system package or security setting was changed to bypass this limit.


## Functional integration continuation (2026-11-13)

The runtime feature gaps listed above are now implemented in this source candidate, rather than being inferred from the version tag:

- State scope paging uses bounded key/get batches and instance-qualified State RPCs, preserving file writer epoch and source read guards. The actual pinned release State read 405 synthetic records totaling 74,649,600 bytes through five pages, with no whole-scope `state::list` call. The application payload budget now follows the verified 64 MiB transport with 60 MiB headroom; this is a transport limit, not a host-RAM reserve. `collectAll` still materializes its results and is not claimed constant-memory.
- Consolidation uses official current-head selection, provenance/idempotence keys, successor-first publication and interrupted-publication recovery. Procedural recurrence counts source sessions and actual re-saves, not edit versions. Original records, retained source, cursors, retries and unknown extension fields remain intact.
- Official bounded reflection evidence, citation checks, insight response limits/HTTP status and query validation are integrated. The custom extractive lifecycle remains selected where configured: upstream generative synthesis is not equivalent to its no-inferred-facts and opt-out contracts. Original full evidence is retained for mutation revalidation, not replaced with prompt snippets.
- Orphan-facet diagnosis/repair and eviction index removal are integrated. A facet or unindexed observation that reappears during revalidation is preserved. Historical partial-vector gaps trigger full recovery under the existing opt-in/pause/publication gates; failed watch releases remain owned and prevent a false clean shutdown.
- Session time filters, native PreToolUse envelope/project scope/timeout, Cursor subagent metadata, action creator identity, and official engine download retries/checksums are integrated. Actual host startup/client activation is unchanged.
- Compose versions are .25.1 engine, .22.22 State source and .22.8 HTTP; this fork's file-backed State still requires the verified ACK/epoch/seal artifact rather than the unpatched registry State. Provider selectors, summary timeout and local-dispatch setting reach all deployment templates; multiline/C1 YAML values round-trip safely. Windows demo shutdown uses guarded Compose ownership.
- The official configurable summary deadline and call headroom apply to the stock small-summary path. Custom long sessions remain bounded-input/checkpointed work rather than being replaced by an unbounded monolithic request. Machine-relative CPU display is adopted while the existing cgroup-aware capacity metric and drained health publication remain.

No source-similarity comparison retires retained-source, writer lease, compact ACK, manual-review, graph-generation or recovery safety code. Official helpers replace duplicate behavior where equivalent; retained custom paths have explicit additional contracts. Supporting release checks and operational documentation are integrated, while upstream marketing pages are intentionally not copied as claims about this fork.

Final combined regression results and remaining platform/package gates are recorded in the continuation report. No production data/service/hooks, durable memories, remote branches or PR state were changed. The package keeps its internal candidate version until release approval; the installed operating version is not inferred from this checkout.

### Final Ubuntu acceptance

Final combined regression: 585 files passed, 5 skipped; 6,978 tests passed, 14 skipped; zero failures. Build, generated Codex artifacts, documentation synchronization and 17-skill checks passed. TypeScript reports 29 existing baseline diagnostics, with no new normalized diagnostic; this is not a clean typecheck claim.

The actual Ubuntu installed-tar gate passed installation/identity, bundled-hook capture and search, installed MCP save/search, verified stop/start data retention, and Viewer/status, using isolated homes/ports/store and the verified release State + HTTP 0.22.8 + iii 0.25.1. The local fixture provider was synthetic; no user's provider or operating data was used.

The user's latest scope explicitly excludes Docker and Windows environment validation. They are not blockers for this Ubuntu-only request, and no cross-platform support is certified here. Operating server activation and remote Git publication remain separate from these completed isolated checks.

### Authorized Ubuntu rollout candidate (.69)

The owner subsequently authorized Ubuntu operating deployment after a recoverable backup, followed by GitHub publication after normalization. Candidate identity is now `0.9.33-daniel.69`; approval is not deployment evidence. The live baseline remains native `.68` until the explicit rollout executes. Docker/Windows validation remains out of scope.

Deployment preparation preserves the original native migration proof and accepts only the same-epoch clean:false→true transition caused by a verified normal shutdown. Source bytes, cursors and uncertainty history are not reset. The systemd forking wrapper verifies the actual Compose executable, argv, cgroup, UID and process start before publishing its PIDFile; preexisting metadata requires inspection rather than adoption. Existing custom provider/summary/receipt environment keys are retained through the Compose filter.

Dependency audit reports the preexisting YAML 2.8.1 deeply nested document stack-overflow advisory GHSA-48c2-rrv3-qjmp. This rollout parses generated/local configuration, not an added remote YAML ingestion endpoint. No unrelated dependency auto-fix was applied; the finding is retained for follow-up rather than concealed.

Final .69 rollout preparation: 6,991 tests passed, 14 skipped (585 files passed, 5 skipped). A real installed-tar/systemd two-cycle test found and then eliminated a normal-stop ordering race: Compose now retires its own engine before verified residual-child cleanup, with no force-kill escalation. Both final cycles report inactive/Result=success/exit0, verified disk seals and retained-state restart. The final tar SHA256 is `ce993e2111e5be3660cc4eaa444cebf163199caa25a010d52a68c21b339dde6a`. These remain isolated proofs; the live deployment requires the explicit privileged runner.

## Ubuntu operating acceptance, 2026-11-13 UTC

The owner applied `.71` after a verified clean disk shutdown of `.70`, all prior processes exiting, and offline hash-verified backups. The service resumed through the supported deployment control. The 10,000 retained SDK originals matched their pre-upgrade hashes exactly (no missing or changed rows); all 431 sessions, including the pre-restart synthetic verification session, survived. Existing 38,032 observations and 61 memories were preserved. One synthetic observation was then accepted and returned by project-scoped search; an SDK-v1 duplicate request returned the same observation ID without a second observation. Health reported running/no holds, zero mutation/SDK failures, and vector backfill zero.

Completion remains explicitly **SDK**, not per-request disk durability. A legacy-format verification request received HTTP 503 `SDK_COMPLETION_ONLY` after acceptance; the actual hook SDK-v1 contract returned HTTP 200 `duplicate`, `completed:true`, `durable:false`. It was not blindly replayed as a new event. Verified disk shutdown and offline retention are separate evidence.

Final broad regression: 7,020 passed, 18 failed, 14 skipped. Failure investigation found a concurrent rebuild briefly removing CLI output (15), a process-load deadline case (1), a test which loaded the pre-fix lock implementation (1), and an obsolete SDK archive capacity expectation (1). Frozen final output reruns passed 93/93 tests; updated capacity/restore/reconciliation suites passed 86/86. This is combined regression evidence, not a claim that the initial full invocation was green. TypeScript has the same 29 pre-existing normalized diagnostics with no additions; docs/skills consistency checks pass.

Remaining limitations: the scoped search took about 48 seconds (a preceding 20-second request timed out); legacy audit history remains preserved outside monthly audit queries; explicit capture/index status checks can remain unavailable under load. Retained SDK archives have no new disk quota and are not represented as semantically resolved or safely deletable. Historical spool recovery is separate from new-event admission. Docker and Windows execution tests were expressly excluded by the owner. GitHub CI must be evaluated for the published commit, not inferred from these local results.

### Post-acceptance publication hold

A subsequent live health sample reported `mutationFailures:1` while SDK validation failures remained zero and the service still reported healthy/running. Publication was withheld before commit/push. The successful source-preservation/store/search/dedup evidence above remains valid, but full normalization is **not established**. Feature-lifecycle and observation-context warnings are not sufficient to identify the initiating error. Current diagnostics do not retain the first mutation exception, so its exact dispatch/outcome must not be inferred or erased by restarting. Investigation is continuing; no blind queue replay or clean shutdown claim is authorized by the earlier healthy sample alone.

### .72 socket-snapshot correction and recovery (2026-11-14 UTC)

Rotated .71 diagnostics subsequently identified `STATE_ENGINE_SOCKET_OWNER_UNVERIFIED` before and after dispatch. Independent isolated reproduction showed a concrete false-negative path: the engine accepts another legitimate connection after its FD enumeration but before TCP rows are read. The captured inode set omits that new engine socket, even while the original verified connection remains intact; the next stable observation succeeds. This proves the non-atomic observation defect, not the exact timing or semantic outcome of every historical live mutation.

The .72 fix makes at most three complete State observations for only missing-connection/socket-owner mismatch, keeping the same engine epoch and rechecking process/executable/UID/namespaces on each pass. Persistent foreign ownership, changed identity and ambiguous after-dispatch outcomes remain failures. Local before-dispatch admission rejections use process-local evidence rather than trusting a remotely supplied error code; they are not promoted to uncertain dispatched writes. Regression coverage includes `test/state-local-admission.test.ts`.

The owner applied .72 through the explicit sealed-not-clean recovery path. The .71 failure count of one and its uncertain outcome were preserved in the recovery receipt; no clean marker was fabricated and no original was removed. The original 10,000 retained hashes remain identical (10,001 total after the accepted synthetic event). Supported manual resume returned running with no holds. Final bounded acceptance: seven health samples from 02:01:30 to 02:04:46 UTC were healthy/running with no holds, mutation failures or SDK failures; first/latest mutation errors were null, while SDK completed work increased from 12 to 43. A new SDKv1 synthetic capture returned 201 stored, scoped search returned 200 with its exact ID in 48.993 seconds, and duplicate submission returned 200 with the same ID; independent disk inspection found exactly one record. This certifies the tested Ubuntu capture/search/dedup and bounded stability, not unlimited future stability or legacy-backlog resolution. The earlier .71 acceptance and subsequent publication hold above remain historical evidence, not overwritten success claims.

Final status HTTP 200 reported 38,034 observations (38,032 original plus two accepted synthetic probes), 61 memories and 431 sessions, missing observations 0, BM25 complete, vector backfill pending 0/idle. Remaining informational codes were `audit-legacy-frozen` and `capture-check-unavailable`; these are not silently treated as completed legacy cleanup.
