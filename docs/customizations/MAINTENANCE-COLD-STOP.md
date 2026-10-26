# Explicit maintenance cold stop (development candidate)

## Why this is separate

A historical SDK mutation failure is sticky in the worker. Normal background resume, verified shutdown and release preflight still require mutationFailures=0. This tool does not weaken those guards or declare the failed mutation recovered. It preserves the known uncertainty and current bytes, requests only graceful termination of the bound processes, and produces a preliminary cold-start verification checkpoint. It never starts a writer, deploys code, clears holds/counters or retries capture.

Existing committed snapshots remain useful historical partial exports. They are not regenerated, restored or used to replace current state by this procedure. No NAS, credential loader, network backup, service setting, privilege grant or OS reboot is involved. The helper refuses root execution and uses existing same-UID process rights. Administrator authentication is needed only for the existing systemctl stop/start commands.

## Boundaries and evidence

- A private 0600 plan pins the current host/boot/UID/namespaces, worker/engine PID+start, writer epoch/store, executable and entrypoint hashes, holds and known historical counters. Sources are the native state-store directory and optionally the current client outbox. Output must be a new private local directory outside both roots.
- At most two roots, 16GiB and10000 entries/files, depth64 and relative-name512-byte hard ceilings. One 1MiB stream at a time; no compression, LLM or whole-store JSON loading. These are ceilings, not a claim the current dataset has been copied or is safe.
- Source paths and files reject symlink traversal. Copy files are fsynced and hashed; the live acquisition is explicitly non-atomic. It is never replaced or called a consistent backup.
- The managed-service mode requires an exact agentmemory.service cgroup component and its MainPID equal to the pinned worker at admission. During stop observation a different nonzero MainPID rejects. It must observe a real deactivating stop job; the helper does not send SIGTERM to the managed worker. A request missed between observations is unknown and blocks.
- Only after the unit is inactive/failed, MainPID0, with no queued job of any type, and the bound worker absent, may the helper send pidfd SIGTERM to the still-matching old engine. Already-absent engine identities receive no signal. No SIGKILL or PID-only kill is used.
- After both exact identities are absent, the existing writer flock is acquired. A new stable copy is created without overwriting any original or partial copy. Source files/directories and copied files/directories are synced; full inventory/signatures and hashes are rechecked across both source roots. Original live preservation is reverified, including on resume.
- The stable-copy label means byte preservation under a cooperative writer lock. It is not proof of an old intended mutation, semantic integrity of every archive, absence of an uncooperative writer, or permission to start/release work. External concurrent service starts cannot be excluded forever; unit state is rechecked, and fresh normal startup guards remain mandatory.
- Checkpoints are atomic/fsynced, capped at4MiB, private and contain identifiers/hashes only locally. Interrupted temporary evidence and partial copies are not deleted. Console output is aggregate phase/booleans/safe codes. Old failure counters and quarantine observations remain explicit; a new process's zero counter is a different epoch, not recovery.

## Exact staged operating steps (NOT executed or approved by development)

The assistant first prepares/reviews a fresh private PLAN.json from approved metadata and freezes this helper hash. There is no operating plan in the repository or a user code-review/name-entry step. Do not substitute a synthetic test plan.

After the separate concrete operating approval, in terminal A run:

```
python3 -I /home/daniel/Documents/Codex/2026-10-21/task/agentmemory-auto-recovery/scripts/personal-release/maintenance-cold-stop.py --maintenance-cold-stop <PRIVATE_PLAN.json> --output <NEW_PRIVATE_ACQUISITION_DIRECTORY> --require-service
```

The acquisition finishes first. Only while that same invocation remains in awaiting_service_stop with service-stop-ready and the same identities still verified, in terminal B request the existing standard stop:

```
sudo systemctl stop --no-block agentmemory.service
```

This is an approved maintenance stop intent, not a fabricated clean shutdown. The old normal stop may report unverified and leave the engine alive; the helper then handles only that pinned engine after the supervisor is actually stopped. If stop intent, policy or identities change or cannot be observed, do not repeat the command or bypass a refusal. Keep the private checkpoint and inspect actual state.

Success is phase stable_copy_verified, readyForColdStartVerification=true, historicalWriteRecovered=false, writerStarted=false. It does not authorize a start by itself. After preservation and stopped identities are genuinely checked, a separately approved ordinary `sudo systemctl start agentmemory.service` can create the new engine/worker epoch. Keep deployment/storage_error holds, auto setting, all proof budgets/circuit/history unchanged and check cold writer evidence plus actual full current durability. No held work may resume until its separately approved normal guards pass. No startup is performed by this tool.

The no-signal verification-only resume is:

```
python3 -I /home/daniel/Documents/Codex/2026-10-21/task/agentmemory-auto-recovery/scripts/personal-release/maintenance-cold-stop.py --maintenance-cold-stop <SAME_PRIVATE_PLAN.json> --output <SAME_PRIVATE_ACQUISITION_DIRECTORY> --require-service --verify-stopped-only
```

It requires the original plan fingerprint, retained live files matching their manifest, both old identities absent and durable observed supervisor stop evidence with no new jobs. It cannot finish a still-live engine stop. It never overwrites partial stable copies. Unknown outcomes require inspection, not blind reruns.

## Approval, failure and validation limits

A single concrete operating approval must cover internal byte-reading/local preservation of the current native store (last metadata approximately2.18GB) and small outbox, the standard service stop, any remaining pinned engine's graceful SIGTERM, stable-copy/source fsync checks and (only if requested and prerequisites pass) ordinary held cold start/status checks. No external transfer, old snapshot restore, new deployment, background resume, quarantine replay, budget reset, forced termination or security/configuration change is included.

Same-NVMe local preservation protects against software reversal/inspection mistakes; it is not independent hardware-failure backup. Expect multiple reads and two copies, several GiB of local I/O. Prior NVMe cause is unresolved. New I/O errors, source changes, process uncertainty, evidence failure, active jobs or mismatches stop the sequence; no original is deleted or normalized. Downtime is not guaranteed: existing worker shutdown can take minutes and fail; process wait and filesystem calls can stall. A service/engine may remain held or stopped after failure. Report that state instead of restarting it speculatively.

Focused validation uses tiny real files, owned synthetic children and a simulated systemd boundary; the installed native engine is also tested in a distinct temporary home/store/loopback port with one tiny SDK state and a real rejected SDK mutation. Native integration is not production-scale nor an actual operating systemd stop. Full/browser/load suites and operating execution are excluded by the low-load scope. This candidate is a source maintenance tool, not a registered .29 server package. Existing .29 artifacts do not include the later shutdown timeline or this helper.
