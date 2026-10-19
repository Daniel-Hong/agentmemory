import { afterEach, expect, it, vi } from 'vitest';
import { mockKV } from './helpers/mocks.js';
import { KV } from '../src/state/schema.js';
import { VectorIndex } from '../src/state/vector-index.js';
import { withKeyedLock } from '../src/state/keyed-mutex.js';
import { registerEmbeddingRecovery, EMBEDDING_RETRY_NAMESPACE as RETRY } from '../src/ops/embedding-recovery.mjs';
import * as search from '../src/functions/search.js';
const workers: ReturnType<typeof registerEmbeddingRecovery>[] = [];
afterEach(async () => { for (const w of workers.splice(0)) { w.stop(); await w.drain(); } search.setEmbeddingRecovery(null); search.setVectorIndex(null); search.setEmbeddingProvider(null); });
function fixture(fence = vi.fn(async (_kv: unknown, _keys: {scope: string; key: string}[]) => {})) {
 const kv = mockKV(), index = new VectorIndex(), provider = { name: 'synthetic', dimensions: 2, embed: vi.fn(async () => new Float32Array([1, 0])) };
 Object.assign(kv, { backend: 'file', durability: { waitForKeys: fence } });
 const worker = registerEmbeddingRecovery({ kv: kv as never, KV, index, provider, withKeyedLock, schedule: false, persistIndex: async () => {} });
 workers.push(worker); search.setVectorIndex(index); search.setEmbeddingProvider(provider); search.setEmbeddingRecovery(worker);
 return { kv, worker, fence, provider };
}
const jobs = (count: number, sessionId = 's') => Array.from({length: count}, (_, n) => ({ id: `${sessionId}-${n}`, sessionId, text: 'bootstrap text', context: {kind: 'synthetic' as const, logId: String(n)} }));
it('certifies the same canonical namespace once for a bounded backlog batch', async () => {
 const f = fixture(), backlog = jobs(5);
 await search.backfillVectorBacklog(backlog);
 expect(f.fence).toHaveBeenCalledTimes(1);
 expect(new Set(f.fence.mock.calls[0]![1].map(k => k.scope))).toEqual(new Set([KV.observations('s'), RETRY]));
 for (const job of backlog) expect(f.fence.mock.calls[0]![1]).toContainEqual({scope: KV.observations('s'), key: job.id});
 expect(await f.kv.list(RETRY)).toHaveLength(5); expect(f.provider.embed).not.toHaveBeenCalled();
});
it('bounds each publication to fifty items and preserves existing retry evidence', async () => {
 const f = fixture(), old = {id: 's-0', sessionId: 's', kind: 'synthetic', attempts: 7, retryAt: 999999, phase: 'embedded', fingerprint: 'keep'};
 await f.kv.set(RETRY, old.id, old);
 await search.backfillVectorBacklog(jobs(105));
 expect(f.fence).toHaveBeenCalledTimes(3);
 expect(f.fence.mock.calls.map(call => call[1].length)).toEqual([100, 100, 10]);
 expect(await f.kv.get(RETRY, old.id)).toEqual(old); expect(await f.kv.list(RETRY)).toHaveLength(105);
});
it('does not combine unrelated canonical namespaces into a single scan budget', async () => {
 const f = fixture();
 await search.backfillVectorBacklog([...jobs(3, 'a'), ...jobs(3, 'b')]);
 expect(f.fence).toHaveBeenCalledTimes(2);
 for (const call of f.fence.mock.calls) expect(new Set(call[1].map(k => k.scope)).size).toBe(2);
});
it('retains later intents and reports failure when an earlier publication fails', async () => {
 let calls = 0;
 const f = fixture(vi.fn(async () => { if (++calls === 1) throw Error('synthetic fence failure'); }));
 await expect(search.backfillVectorBacklog(jobs(105))).rejects.toThrow('synthetic fence failure');
 expect(await f.kv.list(RETRY)).toHaveLength(105); expect(calls).toBe(3); expect(f.provider.embed).not.toHaveBeenCalled();
});
it('never acknowledges a foreground enqueue before its original pair fence finishes', async () => {
 let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
 const f = fixture(vi.fn(async () => gate));
 let acknowledged = false; const pending = f.worker.enqueue({id: 'foreground', sessionId: 's', kind: 'synthetic'}).then(() => { acknowledged = true; });
 await vi.waitFor(() => expect(f.fence).toHaveBeenCalledTimes(1));
 expect(acknowledged).toBe(false); expect(f.fence.mock.calls[0]![1]).toHaveLength(2);
 release(); await pending; expect(acknowledged).toBe(true);
});
it('does not turn a rejected publication with an empty reason into a successful handoff', async () => {
 const f = fixture(vi.fn(async () => { throw undefined; }));
 await expect(search.backfillVectorBacklog(jobs(2))).rejects.toBeUndefined();
 expect(await f.kv.list(RETRY)).toHaveLength(2);
});
it('waits for the complete batch certificate before acknowledging the handoff', async () => {
 let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
 const f = fixture(vi.fn(async () => gate)); let acknowledged = false;
 const pending = search.backfillVectorBacklog(jobs(5)).then(() => { acknowledged = true; });
 await vi.waitFor(() => expect(f.fence).toHaveBeenCalledTimes(1));
 expect(await f.kv.list(RETRY)).toHaveLength(5); expect(acknowledged).toBe(false);
 release(); await pending; expect(acknowledged).toBe(true);
});
it('stops before the next batch while retaining source rows for a later rebuild', async () => {
 let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
 const f = fixture(vi.fn(async () => gate)), backlog = jobs(105);
 for (const job of backlog) await f.kv.set(KV.observations('s'), job.id, { id: job.id, title: job.id });
 const pending = search.backfillVectorBacklog(backlog); const result = pending.then(() => 'resolved', () => 'rejected');
 await vi.waitFor(() => expect(f.fence).toHaveBeenCalledTimes(1));
 f.worker.stop(); release(); expect(await result).toBe('rejected');
 expect(await f.kv.list(RETRY)).toHaveLength(50); expect(await f.kv.list(KV.observations('s'))).toHaveLength(105);
});
