# Fixed Ubuntu administrator trust transition — development only

This tool prepares the missing administrator-code update path for the exact running .15 and already enrolled .16/.17 kits. Synthetic feature/recovery verification is separate from actual-host installation readiness. No operating administrator installation, trust edit, restart or retry has been performed by this development task.

## Fixed scope and provenance

`scripts/personal-release/admin-trust-transition.py` pins the three original candidate IDs, package/source/kit hashes and old administrator executable hashes. The command has no CLI path, candidate, environment or hash overrides. Library-only temporary fixture injection is not exposed by its CLI.

The transition changes only:

- Existing request/runner/enrollment executables in `/usr/local/libexec`.
- Three previously reviewed runtime library files in `/usr/local/lib/agentmemory-candidate-enrollment` when their bytes differ.
- Exact .15/.16/.17 baseline, manifest and added `admin-transition.json` in existing public/vault/incoming kit copies; the private catalog's matching kit digests.
- Current .15 activation code-hash/preservation metadata and one new deterministic code archive. Original archives remain intact.
- Existing enrollment `policy.json` and `installation.json` hash bindings. Candidate runtime admission remains pinned; current-release inspection permits the exact old/new runtime triplets only.

It does not change units, sudoers, API authorization, model configuration, client payloads, memories, outbox, pause settings or schedules. No new service start or collector stop is built into the trust transition. Its bounded health check verifies the existing .15 service, rather than starting inference.

The original .16 package, source and runtime bytes remain identical. The original failed job, log and transaction are snapshotted and hash-bound to the reviewed new kit metadata through a committed transition receipt. A new kit digest alone is insufficient. Original registration/approval records remain historical evidence, not silently rewritten approvals.

## Review and installation sequence — after separate operating approval

These are preparation instructions, not authorization to execute them now. The agents must complete technical source review of the full executable closure and exact hashes, rather than infer safety from a filename or test summary. The SSH administrator supplies execution authority, not a claim that they personally reviewed code. There is no web candidate-registration path or new passwordless installation permission.

1. Agents freeze and technically review the entire three-file closure at the exact source revision: `admin-trust-transition.py`, `dashboard-updates.py`, `candidate-enrollment.py`. Check the current .15 service/baseline, three enrolled kit identities, original failure and collector status. Active/uncertain update jobs block this procedure.
2. Install **only those three reviewed files** into a new root-owned, non-writable `/usr/local/lib/agentmemory-admin-trust-transition` directory. This staging step does not replace the operating entrypoints. Check the installed bytes against the reviewed SHA256 values. Do not use the general updater installer.
3. Create root-owned `source-review.json` there with `executionClosureReviewed: true`, a nonempty `reviewedBy`, and `files` mapping exactly those three names to their reviewed SHA256 values. Attribute the code review to its actual reviewer, including an AI reviewer when that is who performed it; keep the user execution authorization separate. Never claim a human source review that did not occur. The CLI rechecks all three installed files against this approval before every action.
4. Run the fixed root tool with `--prepare`. It checks original fixed hashes and existing guards, creates `/var/lib/agentmemory-updates/private/admin-trust-transition`, and stages before/after blobs, original kits/failure proof and a plan. It does not change operating targets. **An existing preparation is refused**; inspect it rather than deleting history or blindly preparing again.
5. Review `plan.json`'s exact target list, before/after hashes, owner/mode, observed dependencies, lineage, archive, service identity and original failure proof. Review the staged code and derived metadata. Set the copied `review-template.json` to `review.json`, preserving its exact `format`/`planSha256`, affirming `executionClosureReviewed` and identifying the reviewer only after this review. Files must remain root-owned and non-writable by the service user.
6. Run `--check`, then `--apply`. Both use existing enrollment/bootstrap/dispatch locks and reject administrative processes, active jobs or changed service/dependencies. Apply journals before replacement, swaps entrypoints first and refuses an old still-running entrypoint before changing trust records. No service restart is performed by this command. Success requires readback of all targets, standard current/candidate guards, next-baseline equivalence, and durable committed evidence.
7. Inspect the final receipt/journal and service health. **Do not execute a .16 retry until commit is confirmed**. The existing root-only `agentmemory-update-runner --retry-preflight-failure FAILED_JOB_UUID NEW_REQUEST_UUID` is then eligible only if collector-idle, current health/memory/guards and original one-use-failure requirements all pass. The original failed UUID is `86ecf1cd-e714-4def-ad80-73b5e0b57141`; choose a fresh request UUID only at the separately authorized retry step. Never requeue with a second UUID to escape a consumed claim.
8. Actual .16 application owns its established shutdown/staging/start path and temporarily interrupts the API/background work. Required collector maintenance needs its own approved scope. Keep .17 available for the existing certified-stopped compatible-recovery path. Confirm real version, health, data/hold state and later live acceptance separately.

Exact administrator command forms once installed and separately approved:

```sh
sudo python3 -I /usr/local/lib/agentmemory-admin-trust-transition/admin-trust-transition.py --prepare
sudo python3 -I /usr/local/lib/agentmemory-admin-trust-transition/admin-trust-transition.py --check
sudo python3 -I /usr/local/lib/agentmemory-admin-trust-transition/admin-trust-transition.py --apply
```

The middle plan review is mandatory; the commands are not a three-command unattended installer. Current private root policy hashes and actual host readiness remain unverified until authenticated preparation. A mismatch is a blocker, not permission to rewrite baseline values.

## Failure and recovery boundaries

Ordinary exceptions after the durable journal attempt known-state restoration under the same locks. Only exact staged old/new bytes, owner/mode and an unchanged service/update/enrollment closure are eligible. Unknown target bytes, new jobs/registrations, active administrator processes or changed service identity require inspection. No state or source records are rewound.

For an interrupted **uncommitted** transition, inspect the journal, receipt, targets and process state first. The separately authorized recovery command is the same fixed tool with `--restore`. It revalidates the reviewed plan and restores only known old/new states. Preserve the full preparation/evidence directory; do not delete it to force a new attempt. Hard process termination inside an atomic write can leave an unreferenced `.admin-trust-*` temporary file; this precise crash point is not fault-injected by the tests. Closed-kit guards can refuse it. An administrator must inspect ownership/path/content against the plan and handle that leftover explicitly; the tool never deletes unknown files automatically.

If receipt fsync confirmation is uncertain, no retry is permitted. Inspect first; a duplicate `--apply` can confirm only an entirely matching completed target state and current guards. It cannot blindly reapply changed operating state. A committed transition is never restored by `--restore`, even before .16; this avoids revoking the trust lineage supporting later queued work. Following .16 advancement use the reviewed .17 compatible recovery with the **new administrator trust state retained**. Never directly downgrade to .15/.11 or restore old data to undo code.

Full service downtime is not measured by synthetic fixtures. The transition itself requests no downtime, but updating trust is briefly multi-file and concurrent administrative operations are excluded. A stopped/crashed transition can temporarily block updates until known-state restoration or manual inspection; the existing service is left running. Unrecoverable unknown state needs manual administrator repair, not a generic bypass.

## Verification limits

Temporary fixtures exercise real kit/runner/enrollment code with synthetic service/API adapters. They cover exact .15→trust transition→.16 admission/application/next baseline; .16 post-start failure→.17 recovery; every target-prefix failure, fresh-process partial restore, duplicate/concurrent execution, baseline/evidence changes, receipt/write uncertainty, executable pre-import rejection and stale enrollment policy epochs. Hold reasons/recovery budget and synthetic data remain intact.

These results do not prove actual-host installation, real memory preservation, spool normalization, Windows compatibility, inference performance or a successful production retry. Actual root-only metadata and current service/collector conditions still need separately approved checks. No new external dependency is required; Python standard library, existing systemd/kit tools and SSH administrator authentication suffice.

## Existing-staging preparation continuation

`prepare-trust-transition.py` now continues the exact unapproved staging left by the prior wrapper. Human source-review prompts were an unnecessary wrapper restriction, not a core requirement. Technical code review remains the agents' responsibility; the existing user authorization covers staging and `--prepare` only. No repeat approval ceremony is introduced.

Run once from the user's SSH session:

```sh
sudo python3 -I /home/daniel/Documents/Codex/2026-10-21/task/agentmemory-diagnostics/scripts/personal-release/prepare-trust-transition.py
```

The wrapper verifies host-root ownership, safe directory/file permissions and the three unchanged frozen hashes. Under a local staging lock it requires the exact previous false/empty-reviewer record with matching hashes and AI evidence. Any other or already approved record, existing preparation, symlink, permission mismatch or active continuation stops without replacing the record. It neither recreates nor removes the staging directory.

For that one known pending state, the wrapper preserves the original record and digest inside the new root-protected record. `reviewedBy` names the actual Codex AI independent reviewer, with its actual scope, historical findings/correction, tests and exact source-file hashes bound in the evidence digest. The existing user's staging/prepare authorization is recorded separately; `userCodeReviewClaimed` and `operatingTransitionApproved` are false. It does not pretend the user reviewed the source and does not silently reinterpret Enter as approval. Existing core fields/schema and root ownership checks remain unchanged.

Only `--prepare` is then invoked. No plan approval, `--check`, `--apply`, restore, restart or retry is included. Output includes `stagingVerified:true`, `reviewAttributedToAI:true`, `userCodeReviewClaimed:false`, then the core tool's bounded result. Successful preparation ends with `PREPARE_COMPLETED`, `serviceControlled:false`, `retryStarted:false`. No private configuration or plan body is displayed.

`REVIEW_STATE_NOT_PENDING`, `PREPARATION_EXISTS_INSPECT_STATE`, `STAGED_HASH_MISMATCH` or permission failure means stop and inspect; do not change flags, delete records or repeat blindly. After interruption following child launch, `PREPARE_INTERRUPTED_INSPECT_RESULT_NO_RETRY` means preparation may have written original snapshots or a plan. Even if no child launched, an uncertain attestation write may have consumed the pending state; preserve it for inspection. Failure never grants another attempt automatically.

The old dossier's “NOT yet authorized” heading described creation time. Staging/preparation were subsequently authorized; actual trust transition/restart/retry remain separate and unperformed. The wrapper's normal SSH sudo requirement is unchanged.

## Read-only user hash correction — development, not installed

The first operating preparation returned `PATH_REFUSED`. The first matching public-baseline path is `/home/daniel/.agentmemory/bin/iii`: its actual parent is service-owned `0775`. The exact historical failure point remains unknown because no path/phase was recorded and the private preparation directory was inaccessible to the agent. Do not treat the matching condition as a recovered stack trace.

The old fixture stripped group-write from every directory and missed this deployment layout. The corrected fixture keeps explicit service-home `0775` paths, strict root-managed paths and a `0750` home. Whole preparation, .16 admission/application, .17 recovery, every target-prefix rollback and stale preparation preservation are exercised with that layout. UID/GID rejection branches are metadata-mocked; actual kernel root-to-service UID transition was not executed in this restricted development environment.

Only `/home/daniel` file hash observations use the original .15 kit's already reviewed `run_as_user` helper. Its module is verified against the pinned original kit before loading; the function is cached, never hash results. The child must run as the exact service UID/GID and returns only digest/mode/UID/GID. Root code/module, policy, staging, target-write and trust checks remain strict. No operating chmod is performed.

The service hash reader uses descriptor-relative no-follow traversal, allows group-write only for service-UID/service-GID-owned nodes, rejects world-write/other owners/symlinks/hardlinks, and bounds regular files to 512 MiB. It compares file descriptor/named-file identity, size, times, ownership/mode before/after reading and reopens the directory chain to detect replacement. Expected hashes remain mandatory. Reading under the service UID adds fork/helper overhead per user artifact; real-host preparation cost is unmeasured. File bodies never return to the parent through this hash path.

Frozen core transition SHA256 changes from `0ba0062120a38dfd642f173b14eb0557bd05901ef077b232c99ba0163d3dc4fe` to `d5e77e0d6254c4e26bcdd8c0ea5b3d5b07b578c015f444d4c91dbf490d483a39`. Runner and enrollment executable hashes are unchanged. The installed staging and root source-review remain untouched. The fixed preparation wrapper below checks that exact old staging before replacing only the corrected core. It is not an operating transition or deployment retry command.

Before installation, determine the actual preparation residue with the new **read-only** diagnostic (prepared command; not executed by the agent):

```sh
sudo python3 -I /home/daniel/Documents/Codex/2026-10-21/task/agentmemory-diagnostics/scripts/personal-release/diagnose-trust-preparation.py
```

It performs no lock creation, import/execution of kits, preparation, repair, file replacement, chmod, restart or retry. Output is limited to pinned staging checks, review booleans, preparation file/directory existence/counts, bounded journal/receipt status enums, current public-baseline protected-file/archive path conflicts, new-reader metadata incompatibility counts/first candidate and private policy-parent conflict counts. The metadata predictor requires the same directory read+execute bits as descriptor opening and accounts for expected UID/GID, type/link/size and write permissions. It does not prove ACL or actual kernel access. It never reads a plan or original snapshot body. `actualFailurePathKnown` and `resumeAuthorized` remain false. An empty-shell classification is evidence for further analysis, not permission to delete or reuse it. Wrong types/symlinks/unsafe ownership are refused; errors include a controlled diagnostic phase, not private content.

## Exact empty-shell continuation — prepared, not executed

The administrator's read-only diagnostic confirmed the expected old staging and genuine AI review, with only four empty preparation directories and no plan, journal, receipt or unknown entries. It reported 1,667 old-guard conflicts and zero new-reader metadata conflicts across 3,441 public paths. These are metadata predictions; the historical first failure and actual service-UID access remain unproven.

No new script is needed. After authorization for the following bounded staging refresh, use the existing fixed command once:

```sh
sudo python3 -I /home/daniel/Documents/Codex/2026-10-21/task/agentmemory-diagnostics/scripts/personal-release/prepare-trust-transition.py
```

Under its existing lock, it requires exact old three-file hashes, canonical previous AI review, root ownership/permissions and exactly the known empty shell. It refuses changed review, nonempty preparation, symlinks, concurrent execution, wrong source hash or an existing refresh archive. Only the core hash may change; the other two staged files stay identical. The corrected source is read once and its pinned bytes are installed, avoiding a second source-file read after validation.

It creates the root-private sibling `/var/lib/agentmemory-updates/private/admin-trust-transition-before-user-hash-fix` with old core/review snapshots and a bounded hash/identity audit. It moves the empty shell into `failed-shell` there, preserving its directory identities. It then atomically replaces only the staged core and `source-review.json`, attributing the actual AI review of correction commit `7c125e9fb5358525edcede805d1304834e627088` and preserving the previous review's digest/location. User source review is never claimed and no reviewer-name prompt is added. Existing user preparation authority remains separate from technical review and operating-transition approval.

Finally it invokes only `--prepare`, creating fresh original snapshots and a plan under the original work path. Operating runner/helper, enrolled kits/catalog, activation/baseline, service, data and failed deployment history are not changed by this command. There is no plan approval, check/apply/restore or deployment retry.

Success prints `stagedCoreUpdated`, `failedPreparationPreserved`, `reviewAttributedToAI` and `preparationOnly` as true, `userCodeReviewClaimed`, `serviceControlled` and `retryStarted` as false; the core reports `prepared:true`, followed by `PREPARE_COMPLETED`. Private plan/configuration bodies are not printed. Any failure or interruption requires inspection, not repetition: the archive deliberately blocks automatic redispatch. A failure between core/review replacements can leave inconsistent staging, which fails closed and requires bounded manual repair; the running service remains unchanged. No automatic rollback or general recovery manager is added.

Validation: 221 Python tests passed, including 17 wrapper cases, failure injection after each refresh phase, duplicate/concurrent/mismatched-state refusal and complete corrected preparation with realistic service-owned 0775 paths. The old committed wrapper's canonical review bytes were independently compared with this wrapper's expected record. The application suite passed 3,282 tests with four existing skips; build, skills and docs checks passed. Independent review found no remaining important issue. All transition/application/recovery tests use synthetic temporary fixtures, not production state; actual root staging refresh and service-identity execution remain unperformed.

## Baseline-selection failure after staging refresh — diagnosis only

The administrator reported successful staged-core replacement and failed-shell preservation, then `CURRENT_BASELINE_UNVERIFIED`. Do not repeat preparation or refresh: preserve both preparation directories and review history. Source tracing locates this code in the original enrollment helper's current-baseline selection. Preparation checks current guard, policy assets, installed post-file hashes and preservation archive hashes before this selection; reaching it differs from a direct installed-file hash mismatch.

The installed readable helper matches pinned original `00e343569903003f0af2f7e06c60b17f4549ee410c85b6c7012f4d14066c672c`. It admits catalog candidates only when their runtime triplet equals policy.runtimeHashes, and constructs the candidate using the policy library runtime. Public .15 runtime hash differs from .16/.17. The prior synthetic fixture used the newly modified enrollment helper plus a library/policy matching .15; it did not model the original single-epoch policy beside an older active release. A synthetic intact .15 now reproduces the same rejection when admission permits only .16, with unchanged receipt/data. This demonstrates a selection failure mode, not the actual private policy or proof of current production drift. No core correction is installed or made speculatively.

A fixed read-only diagnostic is prepared for the root-only comparisons:

```sh
sudo python3 -I /home/daniel/Documents/Codex/2026-10-21/task/agentmemory-diagnostics/scripts/personal-release/diagnose-baseline-selection.py
```

It reads only the fixed policy/catalog/library code, catalog kit manifests, registered .16/.17 baseline metadata, current root drop-in and fixed .15 activation receipt. Output consists of fixed field names, booleans, mismatch field names and counts: legacy drop-in selection; each fixed role's catalog manifest/runtime admission; library-policy consistency; receipt applied/candidate/source/installed-map differences; drop-in identity; preservation archive parent/name/hash format; registered baseline agreement; and preparation existence. Arbitrary catalog IDs, filesystem map keys, hashes, private policy/receipt values and body text are not printed. Descriptor-relative no-follow traversal and named-file signature checks prevent receipt-parent swaps from redirecting privileged reads. It imports/executes no kit and creates no lock, plan, review, file or service action.

This is not full baseline verification: archive contents and protected-file bodies are not reread, nor does current metadata reconstruct a historical stack trace. Root-only policy/library content was inaccessible to the agent; it was not retried with escalated access. The exact observed operating comparison still requires this body-free result. Only after distinguishing policy observation defects from genuine drift can a minimal correction be justified. No baseline reset, trust regeneration, staging change or operating retry is authorized by this diagnostic.

## Verified original-release derivation — developed, not installed

The administrator's diagnostic confirmed that the old policy admits none of the fixed .15/.16/.17 runtime triplets, although all three catalog manifests match and the installed library matches its existing policy. Current activation identity, installed-map entries and root drop-in match the original registered baseline; .16/.17 originals are identical. Archive name/parent/hash format match. The diagnostic explicitly did not validate protected-file or archive contents. This confirms an incompatible current-baseline selector, not a missing permission to weaken it or proof of damaged deployed code.

Preparation still loads the pinned original enrollment executable and validates its complete root policy/assets/installation marker. It derives the current baseline through the independently pinned, reviewed .15 runtime instead of asking the old selector to discover a current release it excludes. The fixed current catalog/kit/package/source identities remain mandatory. Before reading a preservation archive, fixed receipt identity and archive path/name/hash format are checked. Full current.guard, every protected-file observation, original archive checks, current archive content/member verification and receipt-byte stability remain required. The derived complete baseline must equal both original registered .16/.17 baselines. No mismatched runtime is admitted into the old policy and no baseline is rewritten to make this check pass. Later planned trust migration and apply/recovery verification remain unchanged.

The receipt bytes that passed validation are reused for new receipt/old-archive derivation and prior-receipt digest. They must still match on reread and target-before capture; a changed receipt cannot produce a valid plan. A newly planned archive must remain absent at target capture. Live state can still advance after preparation; the existing apply guards then refuse stale plans.

Tests now install the exact historical helper `00e34356…` and historical runtime-library epoch `9b33a051…`, not a new helper or a .15-matching policy. Their source/provenance is recorded in fixtures/README.md. The historical runtime triplet corresponds to the unique public five-candidate group; this is inference from administrator/public metadata, not direct readback of the private library bytes. Synthetic candidates, packages and data remain synthetic. Tests include an admitted older-runtime candidate that fails the current drop-in identity, full .15 transition then .16 apply and .17 compatible recovery, every target-prefix restoration, changed activation/receipt capture races, full archive-member corruption, wrong baseline and preserved preparation boundaries.

The fixed wrapper supports only the next known state: staged core `d5e77e0d6254c4e26bcdd8c0ea5b3d5b07b578c015f444d4c91dbf490d483a39`, exact previous AI review/history and a second empty failed shell. It also verifies the first archive's exact old code/review/audit and preserved directory identities. The original first archive remains unchanged. It preserves the second shell and old staged code/review under `/var/lib/agentmemory-updates/private/admin-trust-transition-before-baseline-selection-fix`, replaces only staged core and review evidence, and invokes only --prepare. The new core pin is `03006669023307afcb702d5dbdb034ba0e3a2e4682e8202da604a097cf7813ae`; dashboard/enrollment staged pins are unchanged. Previous root review bytes were compared against the committed writer's output and match exactly. No human code-review/name entry is required.

A nonempty/changed preparation, stale code/review, changed original evidence, an existing second refresh archive or concurrent invocation is refused. Partial refresh never grants automatic repeat, erase or repair. Both old failed shells and their review/code snapshots survive. This continuation is prepared for separate approval of its exact staging/history changes; it has not run. Its command remains the fixed prepare-trust-transition.py command above, with no arguments. It does not approve/apply the new plan, install operating runner/helper, change trust/catalog/baseline, retry .16, restart or touch memories.

Complete-path review also checked subsequent code reads/write-target parents: readable operating metadata shows installed code parents are not group-writable and the code archive/current receipt/release roots are 0700. Service-owned 0775 read-only hashes keep the existing privilege-drop path. Current private failed-job/log/transaction proof and live process/service state are not re-read by the agent; the unchanged original guards must validate these under root at preparation/execution time. No additional root read is needed to establish the selector defect, but this is not a guarantee that mutable operational preconditions remain unchanged.

Validation: full Python suite 240 passed, plus 21 wrapper cases rerun after exact prior-audit validation. Independent review identified a receipt reread race; two RED/GREEN regressions verify its correction, and final review found no important issue. Build/skills/application/docs verification is recorded in the accompanying evidence dossier. Actual root refresh, preparation, trust migration, restart and deployment remain unperformed.

## Actual prepared-plan review access

The administrator completed preparation with plan SHA256 `dcac8099a293abe1f4ebc72ff3284bcb45ffd9f63042b529d5e273b5c196a442`, intent SHA256 `bb8c3711a3ac16ef96c166871a35e0e240210e1c0138d77e2eefda1282016437` and 36 targets. The agent's direct O_RDONLY/O_NOFOLLOW read of that fixed root-private plan was denied by OS permissions. No sudo/root retry or permission change was attempted. Source review and synthetic tests alone do not complete review of the actual plan.

The minimum read-only evidence command is:

```sh
sudo python3 -I /home/daniel/Documents/Codex/2026-10-21/task/agentmemory-diagnostics/scripts/personal-release/export-trust-plan-review.py
```

It pins the exact plan/intent/count and three root-staged code digests. It reconstructs the proposed metadata from hash-bound original snapshots using the reviewed transition rules, compares all staged target bytes, validates the new code archive's complete member set/hashes, checks original failure snapshots, role-specific safe modes, current target ownership/mode metadata and the entire exact entrypoint-first ordering. Only fixed target aliases, modes, booleans and the already supplied plan/intent/count are printed. It does not export policy/receipt/record bodies, private map values or user identities. It executes only the pinned core's definitions/read helpers; no kit imports, locks, subprocesses, review recording, trust writes, service control or deployment retry occur. Snapshot verification is bounded by existing read limits. Live state must still pass the existing check/apply guards.

After receiving this actual output, the agents must assess it and state the genuine AI review result. Only after operating authorization may that result be recorded atomically in root-owned review.json, bound to this exact plan SHA and attributed to the actual AI reviewer. This is not a request for the user to certify source review or enter a reviewer name. The existing fixed --check then --apply path follows; neither this exporter nor preparation grants operating approval. A review-recording command must be based on the completed actual review, not invented in advance. Actual .16 retry remains separate after a verified committed transition.
