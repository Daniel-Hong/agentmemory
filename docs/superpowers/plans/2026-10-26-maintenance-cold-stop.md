# Maintenance cold stop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Inline implementation, then independent review.

**Goal:** Preserve uncertainty and bytes while producing bounded, explicit cold-stop evidence without weakening normal guards.
**Architecture:** One same-user Linux Python CLI/core using standard-library pidfds, flock, private atomic checkpoints and streaming local copies. No app/API or privileged runner changes.
**Tech Stack:** Python3 standard library, unittest; existing JS regression tests.
**Spec:** docs/superpowers/specs/2026-10-26-maintenance-cold-stop-design.md

## Global Constraints

No operating execution, root, credentials, ports, reset, force kill, writer startup, deployment, hold release or network transfer. One worker; tiny synthetic files. Preserve normal sticky policy.

## Review Focus

PID reuse and uncertain disappearance; incomplete or changing copies; checkpoint failures before a signal; interruption/rerun boundaries; confusing live/stable copies or fresh counters with historical recovery.

### Task 1: core and executable boundary

Files: scripts/personal-release/maintenance-cold-stop.py; scripts/personal-release/test_maintenance_cold_stop.py.
Interface: run(plan, output, verify_stopped=False), plan has exact epoch/process code pins, two local sources and limits; output private evidence, sanitized CLI summary only.
- [x] Write tiny-file and synthetic-process failure tests, watch RED.
- [x] Implement validated plan, bounded copy and checkpoint, pidfd stop and stable-copy gate.
- [x] GREEN: explicit-mode refusal, success, timeout, PID reuse, partial copy, symlink/path/limit rejection, checkpoint failure, remaining processes, verify-only resume and rerun refusal. Preserve originals and unresolved history.
- [x] Independent review, address findings with tests. Run focused JS guards and required build/skills/docs checks at low concurrency. Commit/push personal only; no production package or activation.

Ruling: user already opted out of repetitive design/approval ceremonies; the delegated exact design scope is the approval. Use the existing isolated personal checkout. Full/browser/load suites remain excluded by explicit low-load instruction.

Ruling: actual Restart=on-failure requires a supervisor stop-intent barrier. Existing systemctl stop is reused; no service setting/root runner change. --require-service rejects unmanaged targets. Review found MainPID and queued-job gaps; regressions demonstrate rejection before engine signals.

Completion evidence: Python23/23, focused existing JS56/56, build/skills/docs passed. Actual installed engine tiny isolated SDK rejection -> cold-stop/stable-copy passed; both child exits0 and listener closed. Supervisor control plane is simulated in tests, production service stop not performed. Review fixes: revalidate live acquisition on resume; bind MainPID and exact unit; reject all queued unit jobs. Ruling: full/browser/load suites excluded by explicit low-load scope; unknown historical write is retained, not recovered.
