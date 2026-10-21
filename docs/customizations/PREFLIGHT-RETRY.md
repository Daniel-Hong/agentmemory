# Limited administrator preflight retry — development only

The dashboard rejects any candidate with a failed/interrupted job. Recovery acknowledgement only changes interrupted to failed; it never authorizes that same candidate again. Client-transition preparation omitted a legitimate path for an idle-client preflight collision. This patch adds a narrowly scoped administrator command without changing the web API, sudoers, units, enrolled kits, service or data.

## Rules

After separate administrator review/installation, the root-only runner accepts:

```text
agentmemory-update-runner --retry-preflight-failure FAILED_JOB_UUID NEW_REQUEST_UUID
```

This is not an instruction to execute the uninstalled feature. The no-password `agentmemory-update-request UUID` helper never accepts these arguments. The web API continues to reject failed candidates.

Only one original failed job for the exact candidate is eligible: PROGRAM_FAILED, not interrupted or an earlier retry. Its root-owned bounded private transaction must show constructed/not_needed, no certified shutdown, rollback, rewind or inspection requirement. Its private log must contain exactly `PHASE: failed` and CLIENT_PROCESS_ACTIVE/no-rewind JSON, without prior phases. Transaction time must lie within the original job interval. Unknown/partial failure is refused.

The new request binds original job/transaction/log hashes, reviewed kit/package/baseline hashes and candidate ID. The original public job and private job log remain unchanged. The candidate-level transaction receipt is hash-bound at authorization and execution; normal apply overwrites that shared receipt during later phases, so the fixed trust transition separately preserves its original bytes before later execution. Without a transition the original retry behavior remains hash-bound to its admission-time receipt. A private durable one-use claim precedes queue creation. If IO fails between writes, the claim is consumed and inspection required; another UUID is not an escape. The same UUID returns its saved job without redispatch. Ordinary/helper requests cannot redispatch a queued administrator retry. A retry chain is refused.

A nonblocking global flock covers validation/claim/queue creation. Queued/running/interrupted work blocks admission. Admission and execution recheck the reviewed vault runtime, client-idle check, complete existing baseline/archive/root-asset guards, dependency reuse, release absence, service PID/user/group, healthy state, no storage mutation failures, normal memory pressure and non-error background control. These checks are read-only. Normal apply repeats its existing checks and owns pause/stop/backup/stage/start. A client starting between checks still causes refusal and consumes the retry. This command never stops collectors automatically or weakens guards.

A dispatch error is unconfirmed, not success or permission to retry. Preserve queued job/claim and inspect its unit/job without blindly redispatching. Success remains applied_pending_acceptance, never invented acceptance or a data-preservation claim.

## Coordinated installation boundary

The fixed development transition now addresses the pinned root-asset blocker; see [ADMIN-TRUST-TRANSITION.md](ADMIN-TRUST-TRANSITION.md). It preserves original immutable packages and failed-job evidence and supplies a separate administrator-approved old/new trust lineage. Replacing the runner alone, using the general installer, deleting failure history or renaming a candidate remains unsafe and unsupported.

Operating installation, transition and retry have not been performed. The transition requires separate SSH administrator review and approval; the no-password web request authority is unchanged.

## Synthetic verification

Temporary fixtures cover original evidence, changed bindings, partial/unknown/interrupted refusal, one-use/duplicates, successful execution once, current guards, ordinary-helper redispatch refusal, real flock contention, symlink logs and conservative IO/dispatch failure. No production memories, administrative installation, restarts, Windows, models or capture replay are exercised.
