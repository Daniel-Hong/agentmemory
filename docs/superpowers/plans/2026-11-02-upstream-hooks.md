# Upstream and hook compatibility implementation plan

> Execution: isolated development only. User approved implementation on 2026-11-02; operating activation, new security settings and remote publication are separate gates.

**Goal:** Merge the four official upstream commits after c5b8ebf into operating app source 65ffc37 without losing the personal ALS, storage, viewer and SDK capture contracts; prepare coherent hook artifacts and a non-mutating overlap diagnostic.

**Architecture:** Work only in `agentmemory-upstream-hooks-20261102`, branch `integration/upstream-hooks-20261102`. Preserve the existing .51 checkout, all dirty historical worktrees, operating engine and runtime. The official main target is c6c476d2905926727fa5848a134d7a3b38a7fa98. Full upstream merge is requested; selective replacement of unrelated personal code is not.

**Constraints:** No operating data in development tests; temporary real HOME, default Vitest fork pool; no threads. No installed hook/config/credential/trust changes, service control, replay, deletion or remote push. Existing pending/held/accepted event IDs must remain unchanged. Native and compat payload shapes differ, so identical IDs must not be imposed without an equivalent source contract. Do not expand captured fields or destinations. Checkpoint commits are deferred unless required for a reproducible candidate, and must use existing project identity and required checks.

## Task 1 — upstream merge

- Import verified official objects from the already-created isolated `/tmp/agentmemory-upstream-merge-review-20261102.git`; do not refetch all history or mutate operating refs.
- Start a no-commit merge of the fixed official SHA in the new worktree.
- Resolve README/translations by preserving upstream removal of obsolete badges and generating personal tool counts with `docs:sync`; do not copy upstream counts by hand.
- Resolve the single Viewer conflict by preserving both personal details/focus restoration and upstream engine-detail toggle state.
- Resolve the two website comparison changes using upstream data structure plus locally generated actual capability values.
- Validate auto-merged doctor protection and Cline path handling through their upstream behavioral tests. Preserve custom/private engine guards; tests must not install or stop an actual engine.
- Run affected Viewer layout, bootstrap, operations and worker-state tests with synthetic data. A clean textual merge is not behavioral evidence.

## Task 2 — hook source/artifacts

- First distinguish existing personal native source/artifacts (already SDK-aware) from the installed marketplace legacy artifact. Reuse verified behavior rather than reimplementing it.
- Add only the missing source-level static overlap/contract diagnostic and associated fixture tests if existing diagnostics do not expose both sources. Diagnostic output must omit credentials, source bodies and private command arguments.
- Validate SDK completion response identity, failure/timeout retention, legacy spool/receipt handling, child recursion prevention and independent event identity using existing real synthetic component paths.
- Do not automatically disable a source, change trust hashes, overwrite plugin caches, mutate old queued records, or declare duplicate dispatch without evidence.
- Rebuild supported native and compat artifacts from the same source and document a future exact activation diff. Actual hook activation on another originating host remains unverified until explicitly inspected there.

## Verification and review

- Run `build → skills:gen → docs:sync → skills:check → npm test` with temporary HOME and default fork pool. Record exact failures/skips rather than carrying old exceptions forward.
- Run relevant website metadata/build checks if tooling is already installed; no new installation without authorization.
- Test memory prerequisites honestly; never pause production to obtain memory.
- Independent review must check the final diff for preservation of ALS lifetime, storage/receipt/unknown semantics, private-engine auto-fix guards, truthful Viewer states, source-preserving hook completion and no operating side effects.
- Report final source/diff/tests/artifact hashes and exact deployment or activation prerequisites. No operating success claim follows from development tests alone.

## Current preparation evidence

- Source .51 is clean at 65ffc37ea48c67bb3e274d09a7769f816c6bf020.
- Official main was rechecked at c6c476d; merge-tree found 34 content-conflict files, mostly generated documentation.
- Installed global compat artifact 13 files already match personal .51; an old directory version label is not a reason to replace them.
- Native marketplace shared capture differs from the personal SDK-aware artifact; five event types overlap, but actual duplicate dispatch is not established.
- The unrelated bounded spool inspector has its own development directory and tests; it does not change product code or run a global scan.

## Final candidate preparation extension

Parent authorized isolated .52 version/package preparation and a global-companion
manifest: keep global nine events, exclude native overlapping five, preserve the
exact PreToolUse matcher/command, MCP/skills and existing payload/URL/credential
rules. Test a real ZIP first (missing flavor RED), then implement only an explicit
packaging flavor; do not change installed hooks or default flavor. Re-run final
build/generators/affected tests and full isolated regression after version changes.
Large SDK test still requires natural host available >=12GiB before starting and
its own existing guard during the run. No operating pause or resource reclamation
from other processes is allowed. Freeze final source/archive hashes without Git
publication or privileged enrollment.
