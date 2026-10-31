# Stable-generation metadata reuse

Development repair after installed .48. No operating activation or new candidate
has occurred for this change.

The operating worker reopened the same 293,552,856-byte namespace after it had
closed, including two concurrent streams. The inode/size/mtime remained equal.
The same 62,777,120-byte observations and 77,566,248-byte summaries files also
recurred. Session metadata shows nine pending summary sessions; the old shared
work cache retained eight views. Two actual sessions exceed the ID projection
cache's old 4,096-row cutoff (8,317 and 5,035 observations). These are recurring
read mechanisms; file-descriptor samples do not identify each caller's CPU share.

The installed CLI, server bundle and summarizer/enrichment bundle match the
frozen .48 package byte-for-byte. The selected-work branch is present. It does
not eliminate cold initialization, separate snapshot reads or every list call.

Changes stay in three existing readers:

- Work metadata: up to512 views with unchanged8MiB entry/16MiB aggregate encoded
  bounds, current file identity, writer-read context and SDK mutation checks.
- ID/eligibility metadata: up to512 scopes/32,768 aggregate rows/8MiB aggregate
  encoded bytes, at most4MiB per entry. Over-budget results remain complete and
  uncached. Cached results are not exposed as mutable caller data.
- Summary counts: at most16,384 keys/4MiB encoded key bytes by current file
  generation; concurrent reads share validation/publication. Apply latest SDK
  pending changes after copying the key set. Never return an old count after a
  failed current read; retain null-valued keys as present.

These are metadata admission bounds, not a total process-heap guarantee. No
completed observation-body cache, authoritative search-membership shortcut,
new storage format, timeout increase or writer/recovery admission change is
introduced. Original records, history, budgets and unknown writes are untouched.

TDD evidence reproduces a second-round work reread (36 chunks instead of18), a
long-session projection reread (31 instead of20 chunks), three duplicate count
scans and a late count caller escaping the shared validation flight. Regression
coverage includes generation replacement, overlay upserts/deletes, corrupt
publication, uncacheable complete outputs and aggregate pressure eviction.

In an isolated 5,866,334-byte/9-session/8,829-record comparison against exact
frozen1b6ae2f0 reader source, three rounds open68→28 files; warmed rounds20→0 each.
CPU1,250.329→603.736ms; wall952.022→431.985ms. Cold round358.601→367.127ms,
event-loop p9925.395→32.997ms and max32.522→37.945ms are worse. Sampled heap
47,996,496→51,906,016B increases; process maxRSS162,216→161,308KiB. Metadata and
selected model-input hashes match. The fixture has no actual SDK/model/browser
or operating data; it does not certify operating responsiveness or graph speed.

Independent static review found no concrete Critical/Important code defect and
identified missing boundary tests; those were added. The first combined SDK
run failed in the restricted environment; localhost bind independently returned
EPERM. With the same assertions and natural12GiB precondition, the separately
authorized isolated localhost SDK boundary test passed in2.35s. Original failed
logs remain preserved; this does not turn a failed combined run into a pass.

Developer-fix ordered build/skills-generation/docs-sync/skills-check/full-suite
validation (version48,commit6b964819) passed:5,776 tests passed,13 existing
conditional skips,zero failures, including
the large SDK test. Full-suite wall360.595s; lowest sampled host available memory
11,574,620,160B. Cumulative validation child maxRSS2,262,656KiB includes build and
is not the operating worker's memory. Existing30 type diagnostics match the
baseline; no changed-file/new diagnosis. Package/activation validation is pending.
Operating .48 remains RUNNING with its same graph job. No temporary automatic
pause or test-resource pause is part of development or deployment planning.

The later version49 candidate run completed5,775 passed/13 existing skips/1failed.
The large SDK test passed. The unchanged storage-unit-certification overlapping
publication test failed with index_publication/readback STATE_DURABILITY_TIMEOUT
(state_namespace_not_committed), matching an already retained version48 failure.
Its test/helper, disk-fence and index-publication source hashes match frozen48.
This establishes a pre-existing failure mode, not its exact cause or irrelevance.
The version49 run is not all-passing; no previous candidate's waiver is reused.
No test/timeout/assertion has been relaxed and no operating update has occurred.

## Concurrent disk certificate lifetime correction

A deterministic barrier-controlled reproduction on frozen48 and the first49
code demonstrates a local revision lifetime race: an old metadata capture is
held, revision2 is published and verified by a second certificate, which forgets
its dirty key, then the old capture resumes. It cannot see revision2 and waits
for obsolete revision1 until state_namespace_not_committed. SDK and disk both
contain2; the later receipt is already verified. This reproduces the retained
failure mechanism without claiming every historical timeout has that cause.

The minimal correction keeps revision-only observers for keys selected by active
disk certificates, updated by existing local mutation tracking and removed in
finally. Forgetting dirty work cannot erase an active certificate's generation
knowledge. Original readback, file/directory fsync, signature validation and
pinned exact-value refusal remain. SDK-mode certificates do not register observers.
No value cache, global mutation history, deadline increase, disk-success shortcut
or operating marker modification is introduced. TDD reproduces the failure, then
verifies current-value success, corrupt disk refusal and pinned-old-value refusal;
additional barriers cover a third mutation during recapture and capture failure.
Independent static review found no issues in this scoped correction.

Three additional alternating baseline/fixed synthetic pairs retain model-input
and result hashes. Baseline first rounds358.68–365.25ms and fixed355.29–359.23ms
overlap; the earlier single cold regression does not recur. Whole CPU remains
1238–1251→590–594ms and warm file opens20→0. Whole-run p99 remains26.57–28.31→
29.70–30.92ms and sampled heap47.7→55.7–56.8MB. Warm comparison-hash bookkeeping
alone costs12.5–16.2ms per round, so this harness includes synchronous work beyond
reader calls; it does not prove a production event-loop cause. No latency-tail
improvement or operating large-source safety is claimed.

The final verifier also exposed a pre-existing fixture order assumption in
shared-namespace-small-admission: asynchronous stat can admit requestB first,
but the fixture finished that physical read then awaited still-unfinishedA.
A deterministic reversed-stat diagnostic reproduces this wait with the real
reader. Finish the actual first read and await whichever caller completes, then
finish the second and awaitboth. Keep separate-read count/sharedRequests0 and
add exact[10,Infinity]limits. No product admission/timeout changes. Related31
tests and independent review verify this test-only correction.

SDK resource admission is evaluated by the unchanged test's own12GiB check.
A separate test-launcher sort can wait for natural13GiB before dispatching the
SDK filefirst, retaining original config/allfiles/defaultforks/oneworker. This
adds headroom afterbuild, not an operating monitor or a lower test criterion.
The final source's standalone SDK case passed after natural14032490496B
admission with no concurrent build. Earlier full-suite resource refusals and
fixture failures remain preserved; none is relabelled as an all-passing run.
