# Normalization verification and publication boundaries

The personal .55 application integrates upstream0.9.32, original-preserving native capture, SDK read bounds, provider opt-in compatibility and prior AsyncLocalStorage lifetime fixes. The operating .55 source is commit4605974f337a50ed7e0ef74e3bb635b6e5d5a805; later publication-only changes below do not imply another operating deployment. The engine remains the separately modified0.22.1 build; its exact source patch is in `patches/iii/0.22.1-cow-safe1/`.

## Validation

The application source passed6300 tests with13 conditional exclusions and its build/docs/skills checks before deployment. The unchanged SDK component also passed a separately approved bounded test; this is not an original12GiB-profile pass. TypeScript retains30 baseline diagnostics, so a full typecheck pass is not claimed. Final publication validation is recorded in the commit message after the tests run.

An isolated representative native test used the installed hook code, actual HTTP route, SDK0.25.1 and the same modified engine with a temporary store and synthetic300KiB image. It verified receipt semantics, exact image content, a single observation after repeated event delivery, and retained client originals. The1GiB/swap0/one-core test unit peaked below120MiB and exited successfully; no operating capture was injected. SDK completion is not crash-durable flush proof. Host hook eligibility/trust and representative transport verification are separate from a particular already-open desktop thread's dispatch.

Normal deployment verified the predecessor SDK shutdown receipt, original process identities, pidfd exit, stopped service, released listeners and an exclusive same-inode writer lease before the stable backup and stage. Data and historical uncertain outcomes were retained. New-process failure counters do not resolve older unknown writes. The original failed enrollment remains preserved; its reviewed replacement is an envelope revision with identical application and engine payloads.

## Portable corrective examples

`scripts/personal-release/examples/` preserves the successor exclusion and bounded read-only observation logic with synthetic endpoint/model selectors. It is not an operating kit. A real kit must bind reviewed IDs, paths, hashes, ownership and profile in its administrator-authenticated closure. No baseline, live environment, credential, captured payload or operational receipt is published.

The closed wrapper must accept its required eight files plus the hashed `review-evidence.json` added by the reviewed enrollment bootstrap. Unknown files, missing required files and changed evidence are still rejected. Real bootstrap fixtures exercise that boundary. An immutable registered candidate is never overwritten to repair this error.

Compatibility generation can add JavaScript files after the SDK manifest was generated. The builder now reruns the unchanged audit when a server manifest exists, so the final inventory matches all generated runtime files; audit rejection remains fatal. This publication-only tooling correction prevents recurrence without changing the deployed runtime.

## Remaining diagnostics and limits

The deployed full capture status calculation reads the inbox and then checks SDK completion history per record, four calls at a time. The outer status reporter stops waiting after five seconds but does not cancel that calculation. A synthetic479-record/45ms-history-read experiment reproduced timeout survival and duplicate work from overlapping callers. The assumed latency is not a measured operating latency or a production contribution estimate. This diagnostic can remain unavailable while actual capture succeeds; it must not be shown as an empty queue or as proof of loss. A follow-up should bound or share this read-only work while preserving fresh evidence and error semantics.

An oversized legacy audit log is intentionally retained outside monthly queries. Historical spool reconciliation gaps and flush uncertainties remain explicit. No deletion, bulk replay, budget reset or protection weakening is used to clear notices. A complete global integrity scan and automatic recovery of every large or damaged payload are not claimed.

Publication excludes host configuration, runtime data, backups, deployment archives and live proof records. Unrelated modifications in another checkout remain untouched.

## Prepared status admission correction

The source-only follow-up admits one inbox calculation per controller and holds admission until all already-started reads settle, even if a sibling fails. An overlapping caller receives `inbox:null`; aggregate status retains the unavailable notice. No result cache, retry, deadline increase, write or proof relaxation is introduced. The operating package is unchanged until a separately verified deployment.

An attempted values-only history batch was rejected in review: embedded record keys cannot establish the physical KV key that the existing completion proof uses. Per-key checks and four-read concurrency therefore remain. The 479-record synthetic45ms-read scenario still exceeds the outer five-second wait, but overlapping requests no longer multiply its reads. This assumption is not an operating latency measurement. A genuinely keyed batch or cancellable/paged status contract remains a separate design task.

## Prepared bounded proof pages

Routine status and authenticated capture queries explicitly request at most32 physical-key SDK proof checks. The complete controller query remains available and unchanged by default. The existing capture HTTP route accepts `proofOffset` and `proofGeneration`; no new endpoint, credential or hook permission is introduced. See `CAPTURE-STATUS-PROOF-PAGES.md` for the precise read-only contract. The active operating .55 package has not been replaced by this source change.
