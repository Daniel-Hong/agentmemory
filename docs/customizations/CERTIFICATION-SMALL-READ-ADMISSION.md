# Small certification reads and truthful recovery diagnostics

Development candidate after daniel.24, not deployed. No collector replacement,
permission change, timeout/retry/ACK policy change, migration or quarantine replay.

## Mechanism and safety

A retained .24 compression trace completed two observations scans in about
9.9 seconds, then never started its embedding-intent read before the 15-second
deadline. Tiny and large reads shared one physical slot.

Keep one regular slot and add one slot for files at most 1 MiB. One additional
path stat classifies each initial logical read; a growth fallback does not classify again. Opened-file size and finite stream
end enforce the bound despite growth/replacement. Growth before open falls back
to regular admission; growth during streaming fails signature validation and
retries normally. Both lanes share the existing 64-entry waiting limit, with
FIFO within a lane. There is no completed-result cache. Expected values,
revisions, caller deadlines, cancellation, fsync and final signatures remain.
Drain waits for actual readers and in-flight size classification even after the last consumer cancels. LLM serialization is unchanged.

Review reproduced queued key ownership aliasing and physical overfetch after
growth. Final singleton key selection now occurs at actual admission with a
separate Set; finite readers cap their stream end. A cancelled participant
cannot grant overflow ownership to its survivor. Sharing compatibility includes
caller file-size limits. Full queues fail closed through existing retry behavior.

A canonical observation stored before failed embedding-intent certification must
not be acknowledged by semantic dedup on retry. Existing durable IDs continue
through locked restoration and fresh certification. Foreign generation/source
checks are not suppressed. Normal pump preparation/publication can replace or
delete a retry generation during deferred certification; attribution of the
22 operating dead letters to that exact interleaving remains unproven. A bounded
ownership-coordination design is still a proposal, not implemented here.

Capture progress tracks pending/retrying keys separately from total inbox
capacity. Dead originals/history and quarantine warnings remain; startup,
sweep/status, retry, completion and deletion update active membership.

## Generated comparisons and limitations

275,187,888-byte escaped JSON, four competing large requests, 43 ms mock SDK
reads, real local file reading/fsync, existing deadlines, no production content,
engine publication or model inference. Two stable runs alternate execution order.

- Small requests: baseline 6/6 time out at 5 seconds; candidate 6/6 finish in
  67–75 ms. Compression: baseline 2/2 time out at 15 seconds; candidate both
  finish in 3.56–3.63 seconds. Compatible receipt-shaped certification can join
  the source read and finish in 3.51–3.58 seconds.
- An incompatible source-key receipt still times out at 5 seconds in both
  versions; candidate small requests finish in ~89 ms and compression in 3.70 s.
- Atomic replacement: compression still times out in both; candidate small
  requests finish in ~78 ms. Several large background requests still time out.
- CPU remains roughly one core; peak process RSS about 110–125 MB. These are
  overloaded warm-cache fixtures, not a guarantee of production throughput or
  legacy delivery. The change protects small work, not all large parse costs.

A collector/real receipt/file-fence test also demonstrates that oversized legacy
capture can exhaust its entire caller budget checking mismatched disk state
before any POST, while preserving the original. This is a possible branch,
not proof of the current head's request or error. The consumed one-time raw
head read grant was not reused.

## Six HEALTH issues and actual resolution criteria

| Issue | Candidate and remaining condition |
| --- | --- |
| Index check incomplete | Remove false session-timeout attribution; missing state remains unknown. Only a complete scan and, if needed, verified repair resolves it. No automatic rebuild. |
| Frozen legacy audit (reported 351 MiB) | Report excluded coverage even for full monthly pages. Original history remains. Including it needs separately reviewed compatible history access/migration; no migration or deletion here. |
| 22 capture dead letters | Exclude from active-stall count, keep warning and records. Durable retry must certify. Selected operational recovery still needs scope and receipt verification. |
| Accepted embedding_intent_changed retry | Preserve freshness checks and retry history. Subsequent certified completion, not warning disappearance, establishes recovery. |
| Legacy outbox | Verify handoff per removed item and complete/available scan. Count decline alone is not delivery; session events may have no capture receipt. |
| Historical 190 append failures | Preserve count/reason and unknown individual outcomes. Recent attempts warn; old/undated history stays visible as info. Aggregate counters cannot establish individual loss/recovery retroactively. |

The audit metadata fix never opens an unsafe frozen scope. Index wording does
not make its scan faster or complete. No automatic acknowledgement, counter
reset, original truncation, forced replay or quarantine release. Health alone
is not normalization acceptance.

## Verification and upstream replacement

TDD covers strict physical growth bounds, queued cancellation ownership, lane
isolation, shared/direct saturation, fallback cancellation, caller limits,
replacement/restart freshness, durable retry, live/dead progress and truthful
unknown/history diagnostics. Aggregate checks/review are recorded in the work
report. Replace custom admission when upstream offers equivalent bounded durable
commit receipts/scheduling with the same correctness and compatibility tests.
Any later rollout must measure capture latency, compression failure/recovery,
legacy receipt reconciliation, queue pressure and retained quarantine/history.

## Completed development validation

Build, skills generation/check, documentation sync/check and whitespace checks
pass. Final full suite uses the default fork pool, a real temporary HOME and
`--maxWorkers=2`: 3,556 passed, 10 skipped, 345 files passed and two skipped.
The unrestricted final run had one timeout in the existing 80 ms real-filesystem
embedding-scoped-publication fixture; that file passes all nine cases alone.
No product timeout was changed. Earlier expected RED tests and harness fixes
are retained in workspace validation logs. Independent review has no remaining
important findings after queued ownership, physical cap and classification-drain
fixes. This is development validation, not operating acceptance.
