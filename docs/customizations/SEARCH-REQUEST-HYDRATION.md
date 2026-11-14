# Request-local search hydration reuse

Sparse project filtering may expand hybrid search through 100, 200, 400, 800,
and 1,000 candidates. Earlier rounds previously fetched the same State records
again. A request-local positive hydration cache avoids those repeated RPCs.

## Safety and lifetime

- Reuse requires both State mutation-key observers and the existing pinned State
  read-admission predicate. Other backends/clients retain the uncached path.
- Each reused result checks the exact current State/engine identity predicate
  before and after its asynchronous continuation. No identity TTL, RPC fence,
  writer-lease condition, or mutation protection is removed.
- Index publication and observation/memory key mutation invalidate entries and
  associated request-local project/session filtering caches. An invalidation
  during hydration cannot publish that obsolete result.
- Failed/missing reads are not retained, including memory fallback after a
  failed observation read. There is no cross-request cache or transactional
  snapshot promise; concurrent mutations retain read-time search semantics.
- At most 1,000 hydrated entries each observe two State keys. All request
  observers are released in `finally`, including authorization errors.

## Evidence and limits

A deterministic sparse-project fixture keeps identical result order and
100→200→400→800→1,000 expansion. Total State reads drop from 6,000 to 3,000:
observation hydration 2,500→1,000, memory hydration/filter reads 3,500→2,000.
Identity checks still run on cache hits and may dominate native filesystem cost.
This is an RPC-count improvement, not a measured production latency guarantee.
No production search was repeated to benchmark this change.

Regression cases include deletion, mutation before index publication, publication
revision changes, mutation during hydration, writer loss before/after an async
cache continuation, failed reads, concurrent requests, absent admission support,
and observer cleanup. Remove this customization when upstream supplies equivalent
request reuse with mutation freshness, pinned admission, and bounded cleanup.
