# Ubuntu deployment-only Compose supervisor

Not installed. No production process or state touched.

`start.py CONFIG.json` runs the pinned package CLI, then publishes the actual Compose daemon PID for systemd Type=forking. Unlike Type=oneshot, systemd monitors that PID after the startup CLI exits. Unlike a foreground bootstrap, this reuses tested packaged CLI config/readiness/State artifact handling rather than duplicating it.

Config fields: absolute canonical `cli`, `engine` and their `cliSha256`, `engineSha256`; `node`; `dataDir`; `metadata` (candidate CLI engine-state.json); `namespace`; canonical `composeFile`; `pidFile` within the service RuntimeDirectory. Parent deployment must root-publish reviewed launcher/config and verified package closure. Environment comes from reviewed service configuration; no new env file parsing here.

Verification: exact Compose argv, executable, same uid/cgroup as launcher, fresh process start, matching metadata namespace/config/executable; recheck process and metadata before exclusive atomic PIDFile publication. Existing lifecycle/PIDFile fails closed; launcher never kills or adopts an existing daemon. Failure exit78 must retain metadata and prevent restart loops. A startup failure can leave candidate children alive for inspection; do not blindly retry.

Template fragment requires real immutable paths and separate replacement of old ExecStartPre and old coldboot dependency. Preserve existing User/Group, home/config, timeout660, KillMode=process, SendSIGKILL=no. Do not leave old .68 guard/coldboot active for v4 Compose. Type=forking main PID is daemon, not worker; Compose owns child-worker restart policy.

Isolated proof (2026-11-13): 4 Python tests passed, including 5 wrong process identity variants and 4 wrong metadata variants. Actual user-systemd transient Type=forking synthetic executable service became active/running MainPID1008555 equal published PIDFile; stopping unit reached inactive/MainPID0/success. Separate synthetic crash service MainPID1008957 killed by unit-scoped signal; systemd observed failed/Result=signal/ExecMainStatus9. Both synthetic processes exited and transient states cleaned. No live service affected. This proves Linux systemd PID handoff and failure observation, NOT a production system-unit deployment. A subsequent exact .69 packaged CLI smoke is recorded below.

Restart=on-failure detects daemon death. It does not guarantee unattended recovery from an uncertain writer epoch: retained metadata causes exit78 and deliberate operator inspection. That is existing storage safety, not oneshot's false-active status. A clean stop must clear lifecycle metadata; RuntimeDirectory/PIDFile are managed by systemd. Never remove production metadata merely to satisfy this wrapper.

## Exact .69 package integration smoke

Tar SHA256 `a54be01bc6d5c2fa9b0f3142fa8de840afbd9e196b9f65e5de18c04615a5529b`, version `0.9.33-daniel.69`. Fresh synthetic HOME/data, copied verified local engine/State/HTTP, loopback ports, env scrubbed. Candidate node_modules were reused; this is not a fresh dependency-install test. Real user-systemd Type=forking launch and clean v4 restart both reached active/running with MainPID equal PIDFile. Authenticated health/status returned200, inner health healthy, mutationFailures0. Top-level degraded accurately reflected runtime SDK-only durability, not startup failure. Both stops produced completed/verified disk-seal receipts with syncedtrue.

Important observed upstream stop race: first unit stop Resultsuccess; second ExecStop CLI exited0 and all processes stopped but Compose main exited1. Compose log `ENGINE_EXITED: managed engine exited with 0` confirms CLI stop terminates engine child before signaling daemon. systemd consequently reports Resultexit-code. No SuccessExitStatus1 override added: it would hide real daemon failure. Deployment must distinguish verified seal+all captured processes gone from this stop-status artifact; never equate arbitrary exit1 with success.

### Final corrected package validation

The stop-order issue above was reproduced by a failing regression, then corrected: after `compose::down`, revalidate and SIGTERM the daemon first without escalation; only then retire captured Linux residual child PID/start identities. Native compatibility remains separate. Final tar SHA256 `ce993e2111e5be3660cc4eaa444cebf163199caa25a010d52a68c21b339dde6a` passed two actual user-systemd lifecycle cycles with independently installed production dependencies: both start active/running with matching MainPID, authenticated health200/innerhealthy, stop exit0, inactive/MainPID0/Resultsuccess/ExecMainStatus0. Both receipts completed/verified with disk seal syncedtrue, zero mutation failures, distinct State instances, absent lifecycle metadata and exited app. This supersedes the stop-status limitation of the prior tar; no broad exit-status override was used. Production system-unit activation remains a separate authorized deployment step.
