# Bounded physical certification reads

Development candidate only. Production remains .23; no rollout, settings,
collector, quarantine, retry policy or timeout changes were performed here.

## Reproduction and interpretation

The matched natural .23 compression failure fetched SDK values in43ms, detected
an observations-file signature change after1.15s and exhausted its15s deadline
while rereading a271MB file. It had no retained value/generation mismatch or
fsync phase. This proves invalidation and unfinished reread for that failure,
not the responsible writer, a durable engine journal, or all compression failures.

A standalone synthetic probe uses exactly271,150,476bytes,43ms SDK-get responses,
independent keys arriving25ms apart, and an atomic replacement at1.1s. The next
file is216bytes larger, matching the measured size delta. It is a file-publication
model, not the engine itself. No production bodies or models are used.
Two text shapes bracket sensitivity without claiming the live content matches.
Plain x payloads scan in0.83s alone; escaped quotes/backslashes and UTF-8 payloads
in3.28s. Four escaped-file scans take13.45s, eight time out at15s. With replacement,
eight again time out. CPU consumption is approximately one core for that wall
interval; measured physical read_bytes is0(page cache), and event-loop max delay
is32ms or less. Thus this experiment establishes CPU amplification by multiple
independent full parsings, rather than a13-second event-loop stall or cold disk.
Operating CPU versus disk contribution remains unmeasured.

After caller timeout, all physical readers drained in under1ms in these failure
runs. No stuck reader was reproduced. The original plain one-reader replacement
probe waited for its already scheduled publisher after the reader had completed;
its317ms terminal wait must not be described as reader drain. The corrected
probe separately timestamps physical drain before waiting for the publisher.

## Minimum change

The existing shared reader can union keys only before a physical scan starts;
late incompatible requests formerly started additional scans immediately.
A fence now admits one physical scan, letting waiting compatible requests union
keys for the next scan. No arbitrary batch timer or completed-result cache exists.
FIFO applies to admission order, not strict wall-clock request arrival: shared
requests first collect their same-turn key union in a microtask. A later direct
request in that same tick can enter admission before that shared group.

All direct, max-sharing-capacity and oversized-projection fallbacks use the same
physical gate. The reusable reader default is eight physical slots, while the
state durability fence selects one. At most64 additional admission entries wait;
full admission fails with state_namespace_admission_limit, never success. Existing
fence retries and the original absolute deadline remain in force. Each entry
owns only existing request metadata; per-scan selected-byte/key/waiter limits
remain unchanged. No source values are cached between scans.

Queued cancellation removes the admission and never starts a reader. A slot
remains held until the physical reader settles even if all its callers abort.
An additional signal check immediately before the work microtask closes the
admitted-then-aborted race found by independent review. drain waits for both
pending admissions and actual readers. Different expected values, generation
checks, freshness/signatures and fsync retain their existing per-request rules.
The admission queue does not change SDK or globally serialized LLM execution.

## Effect and limits

On the same escaped-file eight-request replacement fixture, the isolated
prototype completed8/8 in7.63s instead of0/8 within15s. The actual candidate
repeated this in7.55s, with8/8 completed and no timeout. Single-request replacement
cost was4.46s before versus4.48s in the candidate. Stable eight-request completion
was6.54s instead of all eight timing out. These are certification throughput and
first-request outcomes, not full compression/embedding throughput or live gains.

The probe covers warm cached files, only one programmed publication and no
real SDK worker, persistent memory pressure or unrelated feature workload.
Continuous file replacement can still prevent any valid stable certification;
a deadline still fails safely. A single expensive request can delay smaller
namespaces within the same fence, including foreground callers with five-second
HTTP budgets. Their shorter budget is not extended; successful legacy-outbox
delivery under that combined workload has not been established by this probe. Queue exhaustion is explicit, not discarded
work. Existing pending/dirty records survive for normal recovery. Compatibility
and readback correctness still require operating verification.

## Quarantine15

The current inbox.dead statistic counts retained dead-state records, distinct
from active retrying records and historical error attempts. The .23 activation
snapshot had13; the later snapshot had15, a net increase of2, not proof that only
2new records entered(all transitions were not individually observed). Records
are retained in the existing KV inbox. A non-throwing rejected mem::observe result
is treated as permanent, or a transient exception reaches the cycle attempt
limit(default5; actual override was not queried here). Automatic sweep excludes
dead records. Existing manual retry resets the cycle while retaining total
attempts/history and checking storage before completion. It may fail again;
individual recoverability is unknown without permitted per-item classification.
No replay, deletion or change to that policy was performed.

## Rollout and replacement criterion

If separately authorized, use the existing server-only candidate/recovery route;
no collector replacement, permissions, migration or stored-format change is
needed. Observe natural certification first failures, admission queue pressure,
completed receipts, backlog and quarantine separately. A queue delay or higher
single-request failure is a regression, not hidden by aggregate throughput.
Keep acceptance pending until a comparable operating workload confirms benefit.
Rollback is code-only through the compatible existing route; retain latest data.
Replace this custom coordinator when upstream supplies equivalently bounded
whole-namespace sharing/admission with the same deadline/durability tests.

## Serial arrival follow-up

With the same escaped271MB fixture and replacement, eight distinct requests
arriving every2seconds(representing serialized model completions, not actual
model calls) had4/8 first-certification failures before and0/8 after. Arrival-to-
last-completion window was26.21s before and20.39s after; completed-certificate
counts were4 and8 respectively. Each request retained its own15s deadline,
so the20-second cohort window is not a deadline extension. This is one paired
trial, not a steady-state rate or a real-engine/full-feature workload.

The direct-admission code, together with real-file fence tests, passed122
focused regressions. Independent review found an admitted-then-aborted race;
a failing test reproduced it before the execution-time signal check fixed it.
The original canceled/readers drain finding was not reproduced. Operating
quarantine remains unchanged and its per-item recovery status is unknown.

Final development validation passed: build, skills generation/check, docs
synchronization/check and3,531 application tests(10skipped) using the default
fork pool with a temporary HOME. Independent review reported no remaining
important issue after the admitted-cancellation correction. These checks do
not prove production improvement or quarantine recovery.
