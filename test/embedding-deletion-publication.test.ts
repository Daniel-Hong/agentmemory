import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockKV } from './helpers/mocks.js';
import { KV } from '../src/state/schema.js';
import { VectorIndex } from '../src/state/vector-index.js';
import { withKeyedLock } from '../src/state/keyed-mutex.js';
import { registerEmbeddingRecovery, EMBEDDING_RETRY_NAMESPACE as RETRY, EMBEDDING_COMMITTED_NAMESPACE as COMMITTED } from '../src/ops/embedding-recovery.mjs';

const controllers: ReturnType<typeof registerEmbeddingRecovery>[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function fixture(embed = vi.fn(async () => new Float32Array([1, 0]))) {
  const kv = mockKV(), index = new VectorIndex();
  const persistIndex = vi.fn(async () => {});
  const recovery = registerEmbeddingRecovery({ kv, KV, index, provider: { dimensions: 2, embed }, withKeyedLock, schedule: false, persistIndex });
  controllers.push(recovery);
  return { kv, index, persistIndex, recovery };
}
afterEach(async () => {
  for (const recovery of controllers.splice(0)) { recovery.stop(); await recovery.drain(); }
});

describe('embedding publication respects canonical deletion', () => {
  it('removes a vector resurrected by a canonical read that overlapped deletion', async () => {
    const f = fixture();
    await f.kv.set(KV.observations('s'), 'o', { id: 'o', title: 'canonical' });
    const get = f.kv.get;
    const reached = deferred<void>(), release = deferred<void>();
    let reads = 0;
    f.kv.get = async <T>(scope: string, key: string): Promise<T | null> => {
      const row = await get<T>(scope, key);
      if (scope === KV.observations('s') && key === 'o' && ++reads === 2) {
        reached.resolve(); await release.promise;
      }
      return row;
    };
    const pending = f.recovery.add({ id: 'o', sessionId: 's', kind: 'synthetic' });
    await reached.promise;
    await f.kv.delete(KV.observations('s'), 'o');
    f.index.remove('o');
    release.resolve();
    await pending; await f.recovery.drain();
    expect(await f.kv.get(KV.observations('s'), 'o')).toBeNull();
    expect(f.index.has('o')).toBe(false);
    expect(await f.kv.get(RETRY, 'o')).toBeNull();
    expect(await f.kv.get(COMMITTED, 'o')).toBeNull();
    expect(f.persistIndex).toHaveBeenCalled();
  });

  it('keeps an enqueue accepted while an older missing-record read is in flight', async () => {
    const f = fixture();
    const get = f.kv.get;
    const reached = deferred<void>(), release = deferred<void>();
    let held = false;
    f.kv.get = async <T>(scope: string, key: string): Promise<T | null> => {
      const row = await get<T>(scope, key);
      if (scope === KV.observations('s') && key === 'o' && !held) {
        held = true; reached.resolve(); await release.promise;
      }
      return row;
    };
    await f.recovery.enqueue({ id: 'o', sessionId: 's', kind: 'synthetic' });
    const pending = f.recovery.pump();
    await reached.promise;
    await f.kv.set(KV.observations('s'), 'o', { id: 'o', title: 'restored' });
    await f.recovery.enqueue({ id: 'o', sessionId: 's', kind: 'synthetic' });
    release.resolve();
    await pending; await f.recovery.drain();
    expect(await f.kv.get(RETRY, 'o')).toMatchObject({ id: 'o' });
    await f.recovery.pump(); await f.recovery.drain();
    expect(f.index.has('o')).toBe(true);
    expect(await f.kv.get(RETRY, 'o')).toBeNull();
    expect(await f.kv.get(COMMITTED, 'o')).toBeTruthy();
  });

  it('cleans an older vector and committed fingerprint when the record disappears during inference', async () => {
    const gate = deferred<Float32Array>(), entered = deferred<void>();
    const f = fixture(vi.fn(async () => { entered.resolve(); return gate.promise; }));
    await f.kv.set(KV.observations('s'), 'o', { id: 'o', title: 'canonical' });
    await f.kv.set(COMMITTED, 'o', { id: 'o', fingerprint: 'previous' });
    f.index.add('o', 's', new Float32Array([0, 1]));
    const pending = f.recovery.add({ id: 'o', sessionId: 's', kind: 'synthetic' });
    await entered.promise;
    await f.kv.delete(KV.observations('s'), 'o');
    gate.resolve(new Float32Array([1, 0]));
    await pending; await f.recovery.drain();
    expect(f.index.has('o')).toBe(false);
    expect(await f.kv.get(RETRY, 'o')).toBeNull();
    expect(await f.kv.get(COMMITTED, 'o')).toBeNull();
    expect(f.persistIndex).toHaveBeenCalled();
  });
});
