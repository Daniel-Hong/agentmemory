# Fixed administrator trust transition implementation plan

> **For agentic workers:** use superpowers:executing-plans to implement inline. The human explicitly approved the referenced bounded trust transition and development execution; operating actions remain excluded.

**Goal:** Prepare a reviewed, journaled transition of the fixed Ubuntu administrator binaries and .15/.16/.17 trust records, with original failure lineage intact.

**Architecture:** A root-only, fixed-scope tool prepares derived bytes without changing operating targets, requires a root-owned approval of the complete plan, then applies known old-to-new bytes under existing locks. Original snapshots and deterministic archives form an acyclic lineage. Retry admission recognizes revised kits only through a committed transition receipt binding the original failure.

**Tech Stack:** Python standard library, existing Runner/Runtime/enrollment guards, unittest temporary fixtures.

**Spec:** workspace `preflight-retry-evidence/TRUST-TRANSITION-SCOPE.md`, human approval of expanded single transition.

## Global constraints

- No actual operating root/trust writes, installation, restart or retry during development.
- Fixed .15/.16/.17 identities and package/source bytes; no alias candidate or failure deletion.
- No web/sudo/unit/auth/model/data changes. Preserve original archives/approvals/failed job.
- Fail closed for changed baselines, unknown partial state, concurrency and service advancement.
- No installation commands until complete success and recovery proof.

## Review focus

- Hash self-reference: old own archive precedes new current kit/archive.
- Old failure identity after trust revision: explicit root-committed old/new kit lineage.
- Partial writes/fsync uncertainty: per-file old/new verification and journaled restoration.
- User-owned activation/archive: exact reviewed bytes, fixed paths, no symlinks or permission expansion.
- Update/service advancement: prohibit restoration after activation or queued new work.

## Task 1: Fixed derivation

Create `scripts/personal-release/admin-trust-transition.py` and `test_admin_trust_transition.py`.

- [x] Tests first: unchanged package/source/clients; new .15 guard/archive, new .16/.17 before guards; policy/installation marker; reject unexpected original hashes.
- [x] `Transition.prepare()` derives a fixed plan, staged after bytes and original snapshots. No live target writes.
- [x] Validate plan deterministically against current originals and standard guards; no arbitrary path/table execution API.

## Task 2: Journaled commit/restore

- [x] Tests first: successful apply, failure after each target, atomic-write uncertainty, unknown bytes, lock contention and duplicate invocation.
- [x] `Transition.apply(review)` accepts root-owned exact plan approval, locks enrollment/kit-bootstrap/dispatch, checks fixed service identity and writes durable journal before changes.
- [x] `Transition.restore(review)` restores exact prior code/trust only when no service/update advancement, preserving original evidence and refusing unknown states.

## Task 3: Retry lineage

Modify `dashboard-updates.py`; extend synthetic tests.

- [x] A revised candidate without committed transition is refused.
- [x] An exact original failed job/log/kit/baseline -> reviewed new kit binding is accepted once; altered transition/candidate/proof is refused.
- [x] Existing non-transition retry remains unchanged.

## Task 4: Whole path

- [x] Synthetic active .15 -> administrative transition -> .16 retry/apply and next baseline derivation.
- [x] Inject .16 post-start failure -> certified stopped .17 compatible recovery, holds/data retained.
- [x] No real memory, inference, worker or operating service actions.

## Task 5: Review and preparation outcome

- [x] Independent code review and required build/generation/docs/full Python/JS verification.
- [x] Describe exact targets, SSH review/install stages, remaining actual-host prerequisites and rollback boundary.
- [ ] Push validated source only to personal; no upstream PR. Do not claim operating installation complete.

## Execution ledger

- Tasks 1–4: implemented; complete synthetic .16/.17 paths, each target-prefix failure/restore, original proof/hold/budget preservation verified.
- Final review: executable import-before-hash verification identified; marker-write reproductions failed first, then fixed with pre-import manifest/helper pinning and compile of the exact validated bytes. Independent reviewer reran 16 transition tests successfully; no remaining important finding.
- Verification: build/generation/docs/skills and JS 3282 passed (4 existing skipped); final full Python 182 passed, including proof-mutation rejection.
- Ruling: no generic installer or permission extension; fixed manual SSH staging and exact-plan review only. A hard-kill atomic temporary-file edge remains a documented manual-inspection boundary; do not auto-delete unknown files.
- Operating state: no root trust changes, installation, service action or retry executed. Actual private-policy hash and current host readiness are prerequisites for later authorized administrator preparation.
