import { afterEach, expect, it, vi } from 'vitest';
import { mockKV, mockSdk } from './helpers/mocks.js';
import { KV } from '../src/state/schema.js';
import { VectorIndex } from '../src/state/vector-index.js';
import { withKeyedLock } from '../src/state/keyed-mutex.js';
import { registerCaptureFunctions } from '../src/functions/capture.js';
import { registerObserveFunction } from '../src/functions/observe.js';
import { registerEmbeddingRecovery, EMBEDDING_RETRY_NAMESPACE as RETRY, EMBEDDING_COMMITTED_NAMESPACE as COMMITTED } from '../src/ops/embedding-recovery.mjs';
vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const workers: Array<{ stop(): void; drain(): Promise<void> }> = [];
afterEach(async () => { for (const worker of workers.splice(0)) { worker.stop(); await worker.drain(); } });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const payload = { sessionId: 'counter-session', project: 'synthetic', cwd: '/tmp/counter', hookType: 'post_tool_use', timestamp: '2026-10-20T00:00:00Z', data: { tool_name: 'synthetic', tool_output: 'synthetic original' } };
function captureFixture(kv = mockKV()) {
 const sdk = mockSdk({ looseTrigger: true }); registerObserveFunction(sdk as never, kv as never);
 const controller = registerCaptureFunctions(sdk as never, kv as never, { durableAfterMs: 0 }); workers.push(controller);
 return { kv, sdk, controller, capture: (eventId: string) => sdk.trigger('mem::capture', { payload, eventId }) };
}
function embeddingFixture(kv = mockKV()) {
 const index = new VectorIndex(), embed = vi.fn(async () => new Float32Array([1, 0])), persistIndex = vi.fn(async () => {}); let now = 0;
 const worker = registerEmbeddingRecovery({ kv: kv as never, KV, index, provider: { name: 'synthetic', dimensions: 2, embed }, withKeyedLock, persistIndex, schedule: false, clock: () => now }); workers.push(worker);
 return { kv, worker, embed, persistIndex, advance: () => { now += 60000; } };
}
const item = { id: 'counter-observation', sessionId: 's', kind: 'synthetic' as const };
it('reports capture completions without counting duplicate delivery, with a fresh restart epoch', async () => {
 const f = captureFixture(), initial = f.controller.progress();
 expect(initial).toMatchObject({ completedCount: 0, counterEpoch: expect.stringMatching(uuid) });
 expect(await f.capture('counter-first')).toMatchObject({ state: 'completed' });
 expect(await f.capture('counter-first')).toMatchObject({ status: 'duplicate' });
 expect(f.controller.progress()).toMatchObject({ completedCount: 1, counterEpoch: initial.counterEpoch });
 expect(await f.capture('counter-second')).toMatchObject({ state: 'completed' });
 expect(f.controller.progress().completedCount).toBe(2);
 const restarted = captureFixture(f.kv); expect(restarted.controller.progress().completedCount).toBe(0);
 expect(restarted.controller.progress().counterEpoch).not.toBe(initial.counterEpoch);
});
it('does not report failed capture processing as completed', async () => {
 const f = captureFixture(); f.sdk.registerFunction('mem::observe', async () => { throw Error('synthetic capture failure'); });
 expect(await f.capture('counter-failed')).toMatchObject({ state: 'retrying' });
 expect(f.controller.progress().completedCount).toBe(0);
});
it('counts an embedding only after publication certification and counts its duplicate intent once', async () => {
 const f = embeddingFixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
 f.persistIndex.mockImplementationOnce(async () => gate);
 await f.kv.set(KV.observations('s'), item.id, { id: item.id, title: 'canonical' });
 const initial = f.worker.snapshot(); expect(initial).toMatchObject({ completedCount: 0, counterEpoch: expect.stringMatching(uuid) });
 await f.worker.add(item); await vi.waitFor(() => expect(f.persistIndex).toHaveBeenCalledOnce());
 try {
  expect(f.embed).toHaveBeenCalledOnce(); expect(f.worker.snapshot().completedCount).toBe(0);
  await f.worker.enqueue(item); expect(f.worker.snapshot().completedCount).toBe(0);
 } finally { release(); await f.worker.drain(); }
 expect(f.worker.snapshot()).toMatchObject({ completedCount: 1, pendingCount: 0, counterEpoch: initial.counterEpoch });
 await f.worker.pump(); await f.worker.drain(); expect(f.worker.snapshot().completedCount).toBe(1);
 const restarted = embeddingFixture(f.kv); await restarted.worker.initialize();
 expect(restarted.worker.snapshot().completedCount).toBe(0); expect(restarted.worker.snapshot().counterEpoch).not.toBe(initial.counterEpoch);
});
it.each(['publication', 'marker'])('does not count %s failures, then counts one successful retry', async failure => {
 const f = embeddingFixture(); await f.kv.set(KV.observations('s'), item.id, { id: item.id, title: 'canonical' });
 if (failure === 'publication') f.persistIndex.mockRejectedValueOnce(Error('synthetic publication failure'));
 else {
  let failed = false;
  Object.assign(f.kv, { backend: 'file', durability: { waitForKeys: async (_kv: unknown, keys: Array<{ scope: string }>) => { if (!failed && keys.some(key => key.scope === COMMITTED)) { failed = true; throw Error('synthetic marker failure'); } } } });
 }
 await f.worker.add(item); await f.worker.drain();
 expect(await f.kv.get(RETRY, item.id)).toBeTruthy(); expect(f.worker.snapshot().completedCount).toBe(0);
 f.advance(); await f.worker.pump(); await f.worker.drain();
 expect(f.worker.snapshot()).toMatchObject({ completedCount: 1, pendingCount: 0 }); expect(f.embed).toHaveBeenCalledOnce();
});
it('does not count deleted canonical rows as successful embeddings', async () => {
 const f = embeddingFixture(); await f.worker.enqueue(item); await f.worker.pump(); await f.worker.drain();
 expect(f.worker.snapshot()).toMatchObject({ completedCount: 0, pendingCount: 0 }); expect(f.embed).not.toHaveBeenCalled();
});
it('counts provider failures only after a later successful publication', async () => {
 const f = embeddingFixture(); await f.kv.set(KV.observations('s'), item.id, { id: item.id, title: 'canonical' });
 f.embed.mockRejectedValueOnce(Error('synthetic provider failure'));
 await f.worker.add(item); await f.worker.drain(); expect(f.worker.snapshot().completedCount).toBe(0);
 f.advance(); await f.worker.pump(); await f.worker.drain();
 expect(f.worker.snapshot()).toMatchObject({ completedCount: 1, pendingCount: 0 });
});
it('does not count an obsolete projection changed during its committed marker write', async () => {
 const f = embeddingFixture(); await f.kv.set(KV.observations('s'), item.id, { id: item.id, title: 'before' });
 const set = f.kv.set; let changed = false;
 f.kv.set = async (scope, key, value) => { const result = await set(scope, key, value); if (scope === COMMITTED && !changed) { changed = true; await set(KV.observations('s'), item.id, { id: item.id, title: 'after' }); } return result; };
 await f.worker.add(item); await f.worker.drain();
 expect(f.worker.snapshot()).toMatchObject({ completedCount: 0, pendingCount: 1 });
 await f.worker.pump(); await f.worker.drain();
 expect(f.worker.snapshot()).toMatchObject({ completedCount: 1, pendingCount: 0 });
 expect(f.embed).toHaveBeenCalledWith('after ');
});
