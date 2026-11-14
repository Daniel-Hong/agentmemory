# Additive memory-pressure recovery

Status: released as `0.9.33-daniel.75` after isolated tests and installed-package
verification. Existing data and capture originals are not migrated by this policy.
No host pressure experiment was performed. Earlier release artifacts are unchanged.

## Why

Available-memory percentages alone can pause work even when measured stall pressure
is low. The additional path permits bounded nonzero stalls without claiming that
past host observations predict future concurrent-pipeline allocation bursts.

## Policy

Retain the original critical threshold `max(0.5 GiB, total * 5%)` and all critical
API refusal behavior. With valid Linux PSI only, permit an additional recovery
path after 120 seconds of fresh samples above
`max(3 GiB, critical + 2 GiB)`. Strictly greater is required at the floor.

The proposed operational stall budget is some <=1%, full <=0.1%, about 1400/146
 times the observed whole-window ratios. These are candidate budgets, not proven
universal safety limits. Use counter deltas / actual monotonic elapsed time, plus
current avg10 and avg60 within the same budgets. Microstalls do not reset a window.
A large/sustained pressure reading or floor violation resets only the added
pressure window. The original policy remains authoritative: available >=18%
(or its existing reserve floor) is normal regardless of PSI, and available >22%
(or its existing recovery floor) permits recovery after 120 fresh seconds even
when PSI is high. PSI is an additional recovery opportunity below the original
reserve, never a veto on either legacy path. Once qualified, healthy pressure
prevents repeated pauses solely at 18%.

The .74 deployed candidate incorrectly added such a veto. A read-only trace
showed 10.51–11.00 decimal GB available with full stall 0.4615% over 120 seconds,
blocking legacy recovery. The .75 candidate removes the veto without increasing
the PSI budgets or bypassing critical, freshness, attempts or storage protection.
The original recovery timer and the PSI window are independent: a 119-second
quiet interval below the old recovery threshold plus one second above it with
high PSI cannot combine into an approved 120-second recovery. Either complete
path must independently qualify again during activation.

Missing/malformed PSI, unsafe or regressing counters, non-monotonic elapsed time,
and sampling gaps over 10 seconds disable the added path; use the original 18/22%
policy and rebuild the pressure window. Swap usage is not a zero-swap gate.
Sample counters are validated individually: full delta can microscopically exceed
some delta because kernel reads are not a simultaneous snapshot.

Existing wall-clock freshness checks, 120-second stable interval, three attempts,
backoff, activation-time rechecks, persisted manual/deployment/storage holds,
durability fences, and failed-activation restoration of the paused control state
are retained. This is not automatic software rollback: operational code rollback
requires separate approval, and data is never rewound. Recovery does not clear
other holds.

## Limits and replacement

A 5-second sampling cadence cannot prevent an allocation burst between samples.
No PSI threshold guarantees safe simultaneous pipeline startup. Final activation
checks reject pressure/floor changes before reopening admission, but post-start
burst behavior needs separately authorized operational observation. Upstream can
replace this customization only after equivalent fresh-window, critical protection,
hold preservation, and failed-activation control-state restoration tests pass
without losing data or retry history.

## Verification

Deterministic synthetic samples only, with injected monotonic time; no real memory
pressure induced. The focused budget tests cover boundaries, microstalls, missing
PSI, rollover, stale gaps, clock regression, current spikes, actual elapsed time,
compound holds, and post-fence pressure return. Existing protection/durability,
boot, build-profile, and fallback artifact suites are included. The full repository suite and exact-package start/save/search/normal-shutdown
checks also passed before deployment. Actual deployment retained existing capture
records; detailed operational evidence stays outside the public source tree.
Ongoing workload behavior and future allocation bursts still require observation.
