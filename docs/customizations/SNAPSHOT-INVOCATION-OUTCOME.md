# Snapshot admission and actual completion

2026-10-28 development follow-up to operating .37 / ace9bc2d; server-only .38 release preparation. No operating action.

## Confirmed boundary

The worker sets SDK invocationTimeoutMs=180000. The operating creation request returned HTTPError after180.008seconds, while its real owner continued and committed at327.938seconds. The exact raw HTTP error code was not captured. REST/MCP previously mapped every invocation exception to "Snapshots not enabled". Scheduler tick could record the invocation exception as a snapshot failure even while its real owner was still running or already finished.

## Minimal contract change

The original mem::snapshot-create remains synchronous for direct legacy callers. New mem::snapshot-request uses the same creation closure and recovery owner; it acknowledges only after the existing admission metadata has been saved. It returns accepted:true, completed:false and attemptAt. The existing owner continues to track actual export/publication/Git completion and pause/stop/drain waits for it. No generic queue, operation deadline increase or new storage backend is introduced.

POST /agentmemory/snapshot/create now requests admission and normally returns202, not the old201 completion response. GET /agentmemory/snapshot/status is an authenticated, no-store, small read-only status query. A transport exception returns an unconfirmed response with retryable:false; it is not proof of failure, feature disablement or successful completion. The caller must inspect state rather than blindly submitting again. Genuine admission failure is not acknowledged as accepted.

MCP memory_snapshot_create likewise requests admission. New memory_snapshot_status is a separate read-only tool: reusing a statusOnly flag on a mutating tool would be unsafe against an older server that ignores that flag. Older servers may reject the new tool/function, but that lookup cannot fall back to creation. New clients expecting immediate SnapshotMeta must be updated for admission/status semantics. The service's client hooks/outbox/receipt protocol is unaffected.

mem::snapshot-request invocation metrics count admission calls, not successful exports. Legacy mem::snapshot-create metrics keep their old meaning. Actual asynchronous export results come from snapshotRecovery's attempt fields, not request metrics or HTTP202.

## Actual owner and history

The scheduler waits an already active owner rather than issuing a competing RPC. A safe process-local owner token distinguishes an owner started/finished during a late RPC response; that transport error cannot overwrite the real outcome. The most recent invocation error is separate bounded in-memory code/time metadata. Unknown dispatch before any handler admission retains the existing backoff policy; cross-process exactly-once delivery is not newly guaranteed.

Optional lastFinishedAttemptAt/lastFinishedErrorCode fields bind the latest outcome to an attempt. A new admission clears only these latest per-attempt fields, not existing failure counters, earlier error/history, last success or Git records. Successful or failed owner completion records its own reference. Reopening metadata during an interrupted retry reports unknown rather than borrowing an earlier failure. Legacy metadata is readable without rewriting or inventing a completed-attempt proof. Older code ignores/preserves the extra fields; a later old-code attempt may make the new proof stale, which is shown as unknown.

The Viewer shows attempt start/status separately from the last known success. Admission, a running worker, elapsed time, a process restart, HTTP202 and SDK completion alone do not prove snapshot success. A completed export is still a partial application export; whole-archive heap/per-record limits, global namespace atomicity, partial restore semantics and abrupt-power-loss limits are unchanged.

## Compression diagnostic gap

The one operating compression failure's real cause is unknown. Its retained-warning safe diagnostics were empty, and a narrow journal neighborhood did not recover a cause. safeFailureDetails only copies attached error.diagnostics; bare local compression_timeout and other ordinary exceptions therefore produced {}.

Compression-local timeout errors now carry fixed COMPRESSION_TIMEOUT diagnostics. Otherwise-empty safe details receive COMPRESSION_UNCLASSIFIED, not an invented provider/storage cause. The retained warning has finite phase and nonnegative elapsedMs; raw error messages/stacks/prompt/response text and observation/session identifiers are not added. The global sanitizer,60-second deadline, retry cap, revision checks, source retention, metrics and deferral semantics remain unchanged. Preparation before the existing outer catch and intentionally swallowed index errors keep their existing behavior.

## Verification and limits

Synthetic RED cases reproduced response/completion coupling, incorrect disabled mapping, scheduler errors before/during/after real ownership and retry restart misclassification. Small synthetic tests cover persisted admission, admission save failure, single-flight/pause/drain, legacy metadata, authenticated read-only status, safe older-server failure, and compression diagnostic redaction. Test evidence and final check results are recorded under the task's snapshot-outcome-diagnostics-development dossier.

A subsequent small isolated test using installed SDK0.25.0/native engine0.22.1 verified prompt admission, owner continuation beyond a synthetic2-second invocation budget, attempt-bound success/failure, actual archive/Git success, prior snapshot preservation on failure and drain waiting for the owner. It used temporary HOME/config/state/spool and a loopback port; both processes exited normally and temporary data/port cleanup was verified. Evidence: snapshot-outcome-sdk-integration-verified2/REPORT.md in the task workspace. No operating snapshot/retry/resume/model call, restart, installation, candidate registration or deployment was executed. That component test does not reproduce production180-second calls, large exports, whole-service scheduler/control assembly or real REST/MCP/Viewer end-to-end. The release preparation must review the changed public response contract and freeze a server-only package before any separate operating approval.

Replace these customizations when upstream provides equivalent request/actual-completion semantics, read-only tracking and privacy-safe compression diagnostics with the same failure/source-preservation regressions.
