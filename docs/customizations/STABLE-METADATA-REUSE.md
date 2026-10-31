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

Final ordered build/skills-generation/docs-sync/skills-check/full-suite validation
passed:5,776 tests passed,13 existing conditional skips,zero failures, including
the large SDK test. Full-suite wall360.595s; lowest sampled host available memory
11,574,620,160B. Cumulative validation child maxRSS2,262,656KiB includes build and
is not the operating worker's memory. Existing30 type diagnostics match the
baseline; no changed-file/new diagnosis. Package/activation validation is pending.
Operating .48 remains RUNNING with its same graph job. No temporary automatic
pause or test-resource pause is part of development or deployment planning.
