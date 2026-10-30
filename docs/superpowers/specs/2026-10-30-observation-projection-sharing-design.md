# Observation projection sharing

Intent: reduce redundant observation parsing competing with migration/Viewer on the same worker, without omitting integrity checks or claiming this is the sole operating bottleneck. Parent explicitly authorizes minimum implementation/test/review inline after reproduction; no further design approval pause.

Approaches: rejected journal parallelism regressed native small-SDK latency. Removing all checks is rejected. Periodic health events only reuse successful unexpired evidence and otherwise report unknown; explicit status and initial Viewer requests still run the full diagnostic. Automatic discovery frequency is reduced, with no change to mandatory write/index reconciliation. Selected: share ID/eligibility projection work for one scope/file revision, retaining only bounded small results. Full body list/snapshot remains separate and is a known residual.

Keep existing IDs (including legacy nonstrings), eligibility, SDK pending overlays, current-path generation checks/retry, corruption/oversize errors. File or mutation changes invalidate reuse. Bound completed cache to8scopes,4096rows/1MiB per scope; oversized projections remain usable but uncached. Do not retain sourceRaw/full records. Caller mutations must not poison reused results. No new SDK calls, endpoints or format. Timeout responses remain unknown until the existing shared scan really finishes; no success fabrication.

Normal update must preserve saved migration cursor/job under held boot, verify old data with existing guard, then explicitly resume SAME job. Do not weaken preservation or restart operating work during development.
