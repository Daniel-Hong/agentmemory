# Shared SDK read safety — preparation

Based on installed .51 source65ffc37; enginecc4ff876 unchanged. No new hooks, spool policy, credentials, external endpoints or persistent access.

Synthetic same-engine replay demonstrated that an oversized state::list response can disconnect the shared SDK connection and make a concurrent applied write appear TIMEOUT. The specific caller in the historical event is unproved. New process counters do not resolve old unknowns or verify application flush.

The application 15MiB payload budget remains unchanged; it is distinct from the SDK64MiB message cap. Large bulk summary reads refuse explicitly before dispatch. Complete metadata selection uses the local existing reader and selected per-key SDK gets. Metadata still parses individual source records; its8MiB retained projection cap is not a heap-peak guarantee. New metadata reads cap each serialized record at64MiB before joining/parsing; no record is skipped on refusal.

Summary read/write namespace serialization keeps queued writes visible to the shutdown fence. Failure is latched before the gate releases. Other namespaces are not paused. No completed body cache is added.

Targeted development tests and an actual SDK/engine synthetic guard/recovery replay passed; final release regression/build/SDK results are recorded separately. Preparation is not operating deployment or normalization.

Upstream replacement requires the same SDK size/refusal, shared-connection, pending overlay, file generation, identity, ordering, shutdown and old-unknown preservation tests. All historical failures and stable copies are preserved.
