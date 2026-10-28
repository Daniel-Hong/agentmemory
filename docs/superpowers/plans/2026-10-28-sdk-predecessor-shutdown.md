# SDK predecessor shutdown implementation plan

> **For agentic workers:** Use executing-plans, native implementation with independent review. No operating action.

Goal: permit SDK shutdown only when the already installed predecessor and proposed candidate have matching explicit SDK contracts, without false disk claims.

Architecture: the existing hash-bound service drop-in identifies the exact preceding root-owned kit. Runtime binds that kit/release, activation identity, installed package profile, active service command and current version. Preflight and pre-stop proofs must match, including main/worker/engine start identities. Existing disk predecessor behavior remains strict. New candidate shutdown and stopped-only failure recovery remain unchanged.

Tech: existing Python reviewed-kit runtime and unittest synthetic filesystem/System fixtures.

Global constraints: no installed guard, service or data changes; no security/global policy expansion; preserve completed=true/verified=false/synced=false semantics; no forced kill or counter reset. Unknown/missing/mismatched contract refuses before service stop.

Review focus: contract tampering, wrong service/version/profile, PID reuse, receipt/process completion failure, disk/SDK cross-protocol transitions.

- [x] Add paired SDK predecessor fixtures and assertions for successful initial SDK stop, no false disk claim, and pre-stop refusal on missing/tampered contract or changed process identity. Run RED.
- [x] Keep the existing baseline format unchanged. Add bounded bound-metadata reads and SDK contract comparison to kit-runtime.py; recheck proof before signaling the service. Preserve all current receipt freshness/process-gone checks. Run focused GREEN.
- [x] Exercise existing bootstrap/release/disk/rollback suites; independently review the exact guard changes.
- [x] Keep unrelated baseline disk certificate race separately evidenced; do not weaken assertions or merge an unapproved product fix.
- [ ] Freeze a new package/draft identity only after checks, prepare the same SSH review/enrollment route without executing it, and document short normal resume plus one scheduler snapshot then normal pause. Paused exclusive snapshot execution is unsupported.
