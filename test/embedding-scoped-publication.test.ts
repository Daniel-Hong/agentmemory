import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockKV } from './helpers/mocks.js';
import { KV } from '../src/state/schema.js';
import { VectorIndex } from '../src/state/vector-index.js';
import { IndexPersistence, vectorBucketScope } from '../src/state/index-persistence.js';
import { withKeyedLock } from '../src/state/keyed-mutex.js';
import { createStateDurabilityFence } from '../src/ops/state-durability.mjs';
import { registerEmbeddingRecovery, EMBEDDING_RETRY_NAMESPACE as RETRY, EMBEDDING_COMMITTED_NAMESPACE as COMMITTED } from '../src/ops/embedding-recovery.mjs';

vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const fixtures: ReturnType<typeof fixture>[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scoped-vector-publication-'));
  const kv = mockKV(), index = new VectorIndex();
  const blocked = new Set<string>();
  let changed: ((scope: string, key: string) => void) | undefined;
  const flush = (scope: string) => {
    if (!blocked.has(scope)) writeFileSync(join(directory, encodeURIComponent(scope) + '.bin'), JSON.stringify(Object.fromEntries(kv.store.get(scope) ?? [])));
  };
  const set = kv.set, remove = kv.delete;
  kv.set = async (scope, key, value) => { const result = await set(scope, key, value); flush(scope); changed?.(scope, key); return result; };
  kv.delete = async (scope, key) => { await remove(scope, key); flush(scope); changed?.(scope, key); };
  Object.assign(kv, { backend: 'file', durability: createStateDurabilityFence({ storePath: directory, timeoutMs: 80, pollIntervalMs: 5 }) });
  const persistence = new IndexPersistence(kv as never, index); persistence.stop();
  let clock = 0;
  const provider = { dimensions: 2, embed: vi.fn(async () => new Float32Array([1, 0])) };
  const recovery = registerEmbeddingRecovery({ kv, KV, index, provider, withKeyedLock, schedule: false, clock: () => clock, persistIndex: publication => persistence.saveVerified(publication) });
  const value = { kv, index, provider, recovery, persistence, blocked, flush,
    advance: () => { clock += 60000; }, onMutation: (fn: typeof changed) => { changed = fn; },
    disk: (scope: string) => JSON.parse(readFileSync(join(directory, encodeURIComponent(scope) + '.bin'), 'utf8')),
    restartedKV: () => {
      const restarted = mockKV();
      for (const filename of readdirSync(directory)) restarted.store.set(decodeURIComponent(filename.slice(0, -4)), new Map(Object.entries(JSON.parse(readFileSync(join(directory, filename), 'utf8')))));
      return restarted;
    },
    close: async () => { recovery.stop(); await recovery.drain(); persistence.stop(); rmSync(directory, { recursive: true, force: true }); },
  };
  fixtures.push(value); return value;
}
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });

const item = { id: 'requested', sessionId: 's', kind: 'synthetic' };
describe('embedding item publication against real synthetic files', () => {
  it('completes one intent without repeating inference when an unrelated vector arrives during its write', async () => {
    const f = fixture();
    await f.kv.set(KV.observations('s'), item.id, { id: item.id, title: 'canonical' });
    f.onMutation((scope, key) => {
      if (scope === vectorBucketScope(0) && key === item.id) { f.onMutation(undefined); f.index.add('later', 's', new Float32Array([0, 1])); }
    });
    await f.recovery.add(item); await f.recovery.drain();
    expect(await f.kv.get(RETRY, item.id)).toBeNull();
    expect(await f.kv.get(COMMITTED, item.id)).toBeTruthy();
    expect(f.provider.embed).toHaveBeenCalledTimes(1);
    expect(f.index.pendingChanges).toBe(1);
    expect(f.disk(KV.bm25Index)['vectors:meta'].count).toBe(1);
    const restarted = new IndexPersistence(f.restartedKV() as never, new VectorIndex());
    try {
      const loaded = await restarted.load();
      expect(loaded.expectedCount).toBe(1);
      expect(loaded.vector?.has(item.id)).toBe(true);
      expect(loaded.vector?.has('later')).toBe(false);
    } finally { restarted.stop(); }
  });

  it('retains an intent on a real disk mismatch, then republishes without inference and certifies deletion', async () => {
    const f = fixture();
    await f.kv.set(KV.observations('s'), item.id, { id: item.id, title: 'canonical' });
    f.blocked.add(vectorBucketScope(0));
    await f.recovery.add(item); await f.recovery.drain();
    expect(await f.kv.get(RETRY, item.id)).toMatchObject({ attempts: 1, errorCode: 'VECTOR_PUBLICATION_UNVERIFIED' });
    expect(await f.kv.get(COMMITTED, item.id)).toBeNull();
    f.blocked.clear(); f.advance();
    await f.recovery.pump(); await f.recovery.drain();
    expect(await f.kv.get(RETRY, item.id)).toBeNull();
    expect(f.provider.embed).toHaveBeenCalledTimes(1);
    expect(f.disk(vectorBucketScope(0))[item.id]).toBeTruthy();
    await f.kv.delete(KV.observations('s'), item.id); f.index.remove(item.id);
    await f.recovery.enqueue(item); await f.recovery.pump(); await f.recovery.drain();
    expect(f.disk(vectorBucketScope(0))[item.id]).toBeUndefined();
    expect(f.disk(KV.bm25Index)['vectors:meta'].count).toBe(0);
    expect(await f.kv.get(RETRY, item.id)).toBeNull();
    expect(await f.kv.get(COMMITTED, item.id)).toBeNull();
  });

  it('keeps the intent when a stale pending-log row remains on disk after the vector was saved', async () => {
    const f = fixture();
    await f.kv.set(KV.observations('s'), item.id, { id: item.id, title: 'canonical' });
    let held = false;
    f.onMutation((scope, key) => {
      if (!held && scope === KV.vectorPendingLog && key === item.id) { held = true; f.blocked.add(KV.vectorPendingLog); }
    });
    await f.recovery.add(item); await f.recovery.drain();
    expect(await f.kv.get(RETRY, item.id)).toMatchObject({ attempts: 1 });
    expect(await f.kv.get(COMMITTED, item.id)).toBeNull();
    expect(f.disk(KV.vectorPendingLog)[item.id]).toBeTruthy();
    f.onMutation(undefined); f.blocked.clear(); f.flush(KV.vectorPendingLog); f.advance();
    await f.recovery.pump(); await f.recovery.drain();
    expect(await f.kv.get(RETRY, item.id)).toBeNull();
    expect(f.provider.embed).toHaveBeenCalledTimes(1);
  });
});

it('refuses capture intent ACK when the real synthetic retry namespace is missing on disk',async()=>{
 const f=fixture();await f.kv.set(KV.observations('s'),item.id,{id:item.id,title:'canonical',sourceRaw:{toolOutput:'preserved raw'}});
 f.blocked.add(RETRY);
 await expect(f.recovery.enqueue(item)).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT'});
 expect(await f.kv.get(RETRY,item.id)).toBeTruthy();expect(f.provider.embed).not.toHaveBeenCalled();
 f.blocked.clear();f.flush(RETRY);await f.recovery.enqueue(item);
 expect(await f.restartedKV().get(RETRY,item.id)).toBeTruthy();
 expect(await f.restartedKV().get(KV.observations('s'),item.id)).toMatchObject({sourceRaw:{toolOutput:'preserved raw'}});
});
it('keeps retry until the committed fingerprint is on disk and retries publication without another inference',async()=>{
 const f=fixture();await f.kv.set(KV.observations('s'),item.id,{id:item.id,title:'canonical'});f.blocked.add(COMMITTED);
 await f.recovery.add(item);await f.recovery.drain();expect(await f.kv.get(RETRY,item.id)).toBeTruthy();
 f.blocked.clear();f.advance();await f.recovery.pump();await f.recovery.drain();
 expect(f.disk(COMMITTED)[item.id]).toBeTruthy();expect(f.disk(RETRY)[item.id]).toBeUndefined();expect(f.provider.embed).toHaveBeenCalledOnce();
});
