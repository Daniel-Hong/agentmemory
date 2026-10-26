# SDK capture window

## Problem and scope

An operating diagnostic release observed one startup backfill certificate attempt
for 100 source/intent keys expire in its SDK capture stage after 48 keys. It had
not started disk readback. This differs from the earlier readback failures and
does not establish their common cause. Individual operating SDK latency and
server CPU/queue attribution remain unknown.

The existing capture loop waited for every lookup in a quartet before starting
the next quartet. A slow lookup prevented completed slots from being reused.

## Minimal choice

Use four rolling capture workers. Each completed lookup admits the next selected
key. Keep the existing concurrency ceiling, deadline, pinned-value comparison,
scope/key mapping, revision freshness, full disk read, signature checks and fsync.
On failure or expiry, close admission; late SDK results must not restart capture.
Grouped certificates retain their existing shared four-call admission mechanism.

Increasing concurrency or timeouts was rejected because it changes resource or
proof limits. Skipping old intent certification was rejected because it changes
the existing enqueue handoff contract. Neither is part of this patch.

## Evidence and limits

- A regression held the first lookup and finished its peers. Old code started
  only four of eight selected keys; the candidate filled the free slots and
  eventually verified every selected value, with at most four SDK calls active.
- Failure, original-deadline expiry, late completion and pinned-value rejection
  have explicit regression coverage. A late sibling timer also cannot replace the
  recorded cause/time of an earlier capture failure.
- Two alternating synthetic runs with 50 slow source lookups and 50 fast intent
  lookups certified in 321–336 ms before and 175–178 ms after, at the same scaled
  400 ms test deadline. The 15-second production deadline is unchanged.
- At a tighter scaled 150 ms deadline both versions still failed: 46 keys were
  captured before and 91 after. There is no promise that the operating 100-key
  batch now fits its deadline, nor that prior readback failures are fixed.
- Synthetic delays model heterogeneous responses, not the actual engine's
  transport or workload. No operating content is part of the fixture.

Operating diagnosis artifacts remain private outside this repository. No live
deployment, restart, hold release, replay or budget reset is included. A future
rollout requires a separate reviewed server package and operating approval.

## Replacement criterion

Retire this customization if upstream provides a bounded work-conserving capture
implementation passing the same failure, deadline, freshness and durable-proof
tests. Do not replace it with weaker certification or larger timeout defaults.
