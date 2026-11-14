# Scoped storage-hold recovery candidate (.57)

This is an unissued candidate based on a preserved .55 source snapshot imported into a new local Git root; the import commit is not the original upstream or installed source commit. It does not authorize deployment.

The candidate suppresses automatic Viewer inbox scanning, protects held vector startup, guards foreground vector writes, exposes storage hold and pending transitions, and rejects an unsafe compound partial release. It includes read-only uncertain capture inspection. It does not automatically release compound holds or reconcile uncertain originals. SDK acknowledgments are not disk-flush proof.

Five focused files passed 73 tests in this isolated worktree using an empty temporary HOME and a 768 MiB cgroup. The full suite and actual worker integration have not been established. The current non-clean administrative recovery runtime and root execution closure remain unavailable; no deployment or enrollment has happened. Existing .56 enrollment was denied before execution with no local reason and has not been retried. Replace these personal changes only after equivalent upstream behavior, held-start preservation and recovery tests are established.
