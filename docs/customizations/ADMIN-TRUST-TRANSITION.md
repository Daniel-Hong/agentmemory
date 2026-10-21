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

These are preparation instructions, not authorization to execute them now. An SSH administrator must review the full source closure and exact hashes, not merely a filename or successful test summary. There is no web candidate-registration path or new passwordless installation permission.

1. Freeze the reviewed source revision and inspect the entire three-file closure: `admin-trust-transition.py`, `dashboard-updates.py`, `candidate-enrollment.py`. Check the current .15 service/baseline, three enrolled kit identities, original failure and collector status. Active/uncertain update jobs block this procedure.
2. Install **only those three reviewed files** into a new root-owned, non-writable `/usr/local/lib/agentmemory-admin-trust-transition` directory. This staging step does not replace the operating entrypoints. Check the installed bytes against the reviewed SHA256 values. Do not use the general updater installer.
3. Create root-owned `source-review.json` there with `executionClosureReviewed: true`, a nonempty `reviewedBy`, and `files` mapping exactly those three names to their reviewed SHA256 values. Do not generate an affirmative approval from unreviewed source. The CLI rechecks all three installed files against this approval before every action.
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

## Interactive preparation-only wrapper

`prepare-trust-transition.py` simplifies the separately approved staging/prepare phase. It pins the same unchanged three executable hashes, refuses an existing bundle, verifies every input before root staging, and installs an initially **unapproved** `source-review.json`. It does not change the core transition or its trust model.

From an interactive SSH terminal, after reviewing this wrapper:

```sh
sudo python3 -I /home/daniel/Documents/Codex/2026-10-21/task/agentmemory-diagnostics/scripts/personal-release/prepare-trust-transition.py
```

The screen identifies the actual Codex AI independent reviewer, exact historical test results and limitations separately from the human source-review attestation. It displays the frozen hashes and code inspection paths. AI evidence does not establish that the operator reviewed the code. An actual reviewer may provide their own identity and the exact `SOURCE REVIEW COMPLETE; PREPARE ONLY` confirmation **only after inspecting the full installed source closure**. This creates the root-owned source review and invokes only `--prepare`. No automatic plan approval, `--check`, `--apply`, restore, service operation or retry is included.

If source review is incomplete, press Enter: the wrapper returns `STAGED_REVIEW_REQUIRED`, leaves approval false and never starts preparation. This is a valid stopping point. Review cannot be replaced by a convenient confirmation phrase. To finish later, inspect the existing bundle and complete the manual source-review/prepare steps; do not rerun the new-bundle installer or remove an existing directory to bypass its refusal.

Success shows the core tool's bounded `prepared:true` result followed by `PREPARE_COMPLETED` with `serviceControlled:false` and `retryStarted:false`. Hash mismatch, existing bundle or staged mutation refuses execution. Before launch, interruption reports `REVIEW_INTERRUPTED_NO_PREPARE`; after launch it reports `PREPARE_INTERRUPTED_INSPECT_RESULT_NO_RETRY` because original snapshots/plan may already exist. Preserve evidence and inspect state before another action. Private configuration, plan contents and records are never displayed by the wrapper.

The original SSH dossier's “NOT yet authorized” title described its creation time. Staging and preparation were subsequently authorized in the conversation; operating trust transition/restart/retry remain separate and unperformed. Actual administrator authentication and honest source-review attestation are still required.
