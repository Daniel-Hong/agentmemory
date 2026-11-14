# Limited sealed-for-recovery stop (preparation only)

These tools do not deploy/start a candidate, resume background work, clear uncertainty, remove lifecycle markers, rewrite clean flags, or force-kill. They are not automatically run by the app.

## Review and staging

A user-reviewed config explicitly pins `service: agentmemory.service`, `user`, absolute `helper`, `rpcConfig`, fixed root result path `/var/lib/agentmemory-updates/recovery/sealed-for-recovery-COMPOSEPID-START.json`, and `processes` (`compose`, `engine`, `state`, `app`: each pid/start/exe). `reviewedFiles` must include exact hashes of the helper, RPC config and copied source import closure. Stage helper as `deploy/recovery/seal-current.mjs`, preserving relative source imports `src/ops/engine-epoch.mjs`, `state-epoch.mjs`, `state-dispatch-error.mjs`; include each in reviewedFiles. Source files are not included automatically in npm tarballs. The owner explicitly executes the reviewed runner with sudo after checking its published SHA. A separate root-owned source-tree installation is not required; files must be root/daniel-owned, not group/world writable, nonsymlink, with reviewed manifest hashes. RPC code runs as daniel (UID1000) with a minimal environment, not root. This targets accidental lifecycle changes, not a hostile same-user process with authority to modify the store.

RPC config explicitly supplies sdkPackageJson (for installed iii-sdk/dotenv resolution), namespace, engineUrl, metadata, enginePidFile, store, marker, markerSha256, healthUrl, receipt, and exactly one of secretFile or secretEnvFile. secretEnvFile parses only AGENTMEMORY_SECRET using dotenv; it does not hydrate other environment settings. Use an existing protected secret source, not a new unnecessary token copy. healthUrl must be HTTP 127.0.0.1 /agentmemory/health. Namespace and endpoint must match Compose metadata. No API secret is printed or saved in receipts.

Before invocation, create the user's receipt directory with restricted access; the runner creates only its fixed protected root result directory. The reviewed one-time command is `sudo /usr/bin/python3 -I -B REVIEWED_PATH/seal-stop.py --execute-reviewed-seal-stop REVIEWED_PATH/config.json`. This is a template, not authorization to run against production.

## Actions and boundaries

1. Verify review hashes, exact live process identities, systemd owner, unchanged dirty v4 marker, and absence of prior attempt/receipt.
2. Require pausedRequested, deployment hold, zero active operations and zero active mutations. Record exact original failure count/holds.
3. Verify SDK engine socket/process evidence, State immutable identity/alias and prior epoch; invoke only instance-pinned seal_flush. Recheck epoch and quiescence, preserve failure count/holds, exclusively write/fsync recovery receipt and its directory.
4. Root verifies marker/processes and receipt, requests only normal systemctl stop, records stop result and all-old-PID disappearance. It never claims clean even if stop returned0. Nonzero stop is retained, not hidden; remaining process stops advancement. No candidate start is included.

Seal is irreversible until State restarts. It certifies persistence of actual committed bytes, not that an uncertain requested operation succeeded. Existing dirty marker and semantic uncertainty remain. The result/receipt files prevent blind repeated execution after ambiguous failures; inspect first. A timeout may leave the State sealed or children alive, requiring inspection, not a retry or kill.

## Verification scope

12 isolated JS procedure tests: exact failure/hold preservation, pre-seal admission failures, post-seal identity/receipt/flush/history failures. 3 Python mocked root-runner tests: helper failure never stops, sealed stop preserves nonclean result, remaining PID never triggers force. Production not executed. Actual SDK wiring and root-owned staged closure still require an isolated integration smoke before deployment use.
