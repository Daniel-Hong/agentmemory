# Implementation sequence

1. Freeze baseline and inspect current operating metadata (read-only). Completed: .32 paused/manual, autoOFF, dead114/legacy1, active0.
2. Add RED tests against StateKV default and SDK shutdown truthfulness. Implement sdk-completion tracker and public result predicate; keep strict disk-fence test entrypoints.
3. Wire ordinary pause/embedding/index/shutdown and separate completed/verified metadata; retain original-removal and quarantine proof gates. Explicitly block unsupported actions rather than fabricating durable proof.
4. Test preserved originals, recovery control/history/budgets, SDK failures and old receipts. Independent code review; fix actual defects without relaxing assertions.
5. Focused single-worker regressions/build/generated helpers/docs. Report tested scope, untested runtime, exact server-only candidate/rollout boundary; do not register/apply or alter operating state.

## Capture compatibility follow-up

- Reject global503 as end-to-end normalization.
- RED/GREEN explicit SDK acknowledgement and local original retention, including mixed-policy head-of-line behavior.
- Wire ordinary shared client, DSH, stock capture hooks and new Codex compatibility observation rows; preserve historical receipt-required paths.
- Test real module capture/API/client wiring and serialized synthetic KV recreation, plus filesystem fault boundaries and bounded retention.
- Preserve review findings and evidence. Do not equate this synthetic restart with actual engine/crash durability.
- Build and package only after focused regressions/review. Full npm test was rejected before execution as beyond small-test approval; do not retry indirectly or commit contrary to repository pre-commit requirement.
