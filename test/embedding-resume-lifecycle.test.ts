import { afterEach, expect, it, vi } from 'vitest';
import { mockKV } from './helpers/mocks.js';
import { KV } from '../src/state/schema.js';
import { VectorIndex } from '../src/state/vector-index.js';
import { withKeyedLock } from '../src/state/keyed-mutex.js';
import { installBackgroundControl } from '../src/ops/background-control.mjs';
import { registerEmbeddingRecovery, EMBEDDING_RETRY_NAMESPACE as RETRY, EMBEDDING_COMMITTED_NAMESPACE as COMMITTED } from '../src/ops/embedding-recovery.mjs';
import * as search from '../src/functions/search.js';
const workers: ReturnType<typeof registerEmbeddingRecovery>[] = [];
afterEach(async () => { installBackgroundControl(null); for (const worker of workers.splice(0)) { worker.stop(); await worker.drain(); } search.setEmbeddingRecovery(null); search.setEmbeddingProvider(null); search.setVectorIndex(null); vi.useRealTimers(); });
function fixture() {
 const kv = mockKV(), index = new VectorIndex(), embed = vi.fn(async () => new Float32Array([1, 0]));
 const provider = { name: 'fixture', dimensions: 2, embed };
 const worker = registerEmbeddingRecovery({ kv: kv as never, KV, index, provider, withKeyedLock, schedule: false, persistIndex: async () => {} });
 workers.push(worker); return { kv, index, embed, provider, worker };
}
it('loads durable queue while paused without waiting for committed canonical scans', async () => {
 const f = fixture();
 for (let n = 0; n < 8; n++) await f.kv.set(RETRY, String(n), { id: String(n), sessionId: 's', kind: 'synthetic' });
 await f.kv.set(COMMITTED, 'prior', { id: 'prior', sessionId: 's', kind: 'synthetic' });
 let canonicalReads = 0; const get = f.kv.get;
 f.kv.get = async (scope, key) => { if (scope === KV.observations('s')) canonicalReads++; return get(scope, key); };
 installBackgroundControl({ isPaused: () => true, run: async () => ({ deferred: true }) } as never);
 await f.worker.pump();
 expect(f.worker.snapshot().pendingCount).toBe(8);
 expect(canonicalReads).toBe(0); expect(f.embed).not.toHaveBeenCalled();
});
it('hands the entire paused backlog to durable recovery and resumes on the timer', async () => {
 vi.useFakeTimers(); const f = fixture(); let paused = true;
 installBackgroundControl({ isPaused: () => paused, run: async (fn: () => unknown) => paused ? { deferred: true } : fn() } as never);
 search.setVectorIndex(f.index); search.setEmbeddingProvider(f.provider); search.setEmbeddingRecovery(f.worker);
 const jobs = Array.from({ length: 12 }, (_, n) => ({ id: String(n), sessionId: 's', text: 'stale boot text', context: { kind: 'synthetic' as const, logId: String(n) } }));
 for (const job of jobs) await f.kv.set(KV.observations('s'), job.id, { id: job.id, title: 'latest ' + job.id });
 const result = await search.backfillVectorBacklog(jobs, { batchSize: 5, pauseMs: 0 });
 expect(result).toMatchObject({ complete: false, remaining: 12 });
 expect(await f.kv.list(RETRY)).toHaveLength(12); expect(f.embed).not.toHaveBeenCalled();
 f.worker.start(); paused = false;
 await vi.advanceTimersByTimeAsync(45000); await f.worker.drain();
 expect(f.index.size).toBe(12); expect(await f.kv.list(RETRY)).toHaveLength(0);
 expect(f.embed).toHaveBeenCalledTimes(12); expect(f.embed).toHaveBeenCalledWith('latest 11 ');
});
it('does not lose new intents admitted during startup queue loading', async () => {
 const f = fixture(); const existing = { id: 'old', sessionId: 's', kind: 'synthetic' };
 await f.kv.set(RETRY, existing.id, existing);
 const list = f.kv.list; let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
 f.kv.list = async scope => { const rows = await list(scope); if (scope === RETRY) await held; return rows; };
 const initialized = f.worker.initialize(); const queued = f.worker.enqueue({ ...existing, id: 'new' });
 release(); await Promise.all([initialized, queued]);
 expect(f.worker.snapshot()).toMatchObject({ pendingCount: 2, initialized: true });
 expect(await list(RETRY)).toHaveLength(2);
});
it('processes queued work before the entire committed scan finishes', async () => {
 const f = fixture();
 for (let n = 0; n < 200; n++) {
  const id = 'prior-' + n; const text = id + ' ';
  await f.kv.set(KV.observations('s'), id, { id, title: id });
  const { createHash } = await import('node:crypto');
  await f.kv.set(COMMITTED, id, { id, sessionId: 's', kind: 'synthetic', fingerprint: createHash('sha256').update(text).digest('hex') });
  f.index.add(id, 's', new Float32Array([1, 0]));
 }
 const get = f.kv.get; let reads = 0;
 f.kv.get = async (scope, key) => { if (scope === KV.observations('s')) reads++; return get(scope, key); };
 await f.kv.set(KV.observations('s'), 'urgent', { id: 'urgent', title: 'urgent' });
 await f.worker.enqueue({ id: 'urgent', sessionId: 's', kind: 'synthetic' });
 await f.worker.pump(); await f.worker.drain();
 expect(f.index.has('urgent')).toBe(true); expect(reads).toBeLessThan(70);
});
it('keeps all other durable backlog intents when one file fence fails', async () => {
 const f = fixture(); search.setVectorIndex(f.index); search.setEmbeddingProvider(f.provider); search.setEmbeddingRecovery(f.worker);
 const jobs = Array.from({ length: 12 }, (_, n) => ({ id: String(n), sessionId: 's', text: 'boot', context: { kind: 'synthetic' as const, logId: String(n) } }));
 Object.assign(f.kv, { backend: 'file', durability: { waitForKeys: async (_kv: unknown, keys: { key: string }[]) => { if (keys.some(key => key.key === '1')) throw Error('fixture_fence_failed'); } } });
 await expect(search.backfillVectorBacklog(jobs)).rejects.toThrow('fixture_fence_failed');
 expect(await f.kv.list(RETRY)).toHaveLength(12); expect(f.embed).not.toHaveBeenCalled();
});
it('resumes all durable backlog intents after restart using current content and deletions', async () => {
 const f = fixture(); search.setVectorIndex(f.index); search.setEmbeddingProvider(f.provider); search.setEmbeddingRecovery(f.worker);
 const jobs = ['changed', 'deleted', 'unchanged'].map(id => ({ id, sessionId: 's', text: 'boot', context: { kind: 'synthetic' as const, logId: id } }));
 for (const job of jobs) await f.kv.set(KV.observations('s'), job.id, { id: job.id, title: job.id });
 await search.backfillVectorBacklog(jobs); f.worker.stop(); await f.worker.drain();
 await f.kv.set(KV.observations('s'), 'changed', { id: 'changed', title: 'current content' }); await f.kv.delete(KV.observations('s'), 'deleted');
 const restarted = registerEmbeddingRecovery({ kv: f.kv as never, KV, index: f.index, provider: f.provider, withKeyedLock, schedule: false, persistIndex: async () => {} }); workers.push(restarted);
 await restarted.initialize(); expect(restarted.snapshot().pendingCount).toBe(3);
 await restarted.pump(); await restarted.drain();
 expect(await f.kv.list(RETRY)).toHaveLength(0); expect(f.index.has('deleted')).toBe(false);
 expect(f.embed).toHaveBeenCalledTimes(2); expect(f.embed).toHaveBeenCalledWith('current content ');
 await restarted.pump(); await restarted.drain(); expect(f.embed).toHaveBeenCalledTimes(2);
});
