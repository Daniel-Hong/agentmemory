import { afterEach, expect, test } from 'vitest';
import { registerEnrichmentWorker, ENRICHMENT_NAMESPACE, ENRICHMENT_REVISION } from '../src/ops/background-enrichment.mjs';
import { installBackgroundControl } from '../src/ops/background-control.mjs';

const KV = { sessions: 'sessions', observations: (id: string) => 'obs:' + id };
afterEach(() => installBackgroundControl(null));
function fixture() {
  const db = new Map<string, Map<string, any>>();
  let revision = 0, reads = 0, now = 100000, graph = true, compress = false;
  const calls: any[] = [];
  const kv = {
    observationReader: { async revision() { return revision; } },
    async get(ns: string, id: string) { return structuredClone(db.get(ns)?.get(id) ?? null); },
    async list(ns: string) { if (ns.startsWith('obs:')) reads++; return structuredClone([...(db.get(ns)?.values() ?? [])]); },
    async set(ns: string, id: string, value: any) { if (!db.has(ns)) db.set(ns, new Map()); db.get(ns)!.set(id, structuredClone(value)); if (ns.startsWith('obs:')) revision++; },
    async delete(ns: string, id: string) { db.get(ns)?.delete(id); if (ns.startsWith('obs:')) revision++; },
    async update(ns: string, id: string, updates: any[]) { const value = await this.get(ns, id); for (const op of updates) value[op.path] = op.value; await this.set(ns, id, value); },
  };
  let onCall = async (_id: string, _payload: any) => {};
  const sdk = { async trigger({ function_id, payload }: any) {
    calls.push({ function_id, payload: structuredClone(payload) });
    await onCall(function_id, payload);
    if (function_id === 'mem::compress') {
      const row = await kv.get(KV.observations(payload.sessionId), payload.observationId);
      await kv.set(KV.observations(payload.sessionId), row.id, { ...row, llmCompressionRevision: ENRICHMENT_REVISION });
    }
    return { success: true, llm: true };
  } };
  const worker = () => registerEnrichmentWorker({ kv, sdk, KV, withKeyedLock: async (_key: string, fn: any) => fn(), isGraphEnabled: () => graph, isCompressEnabled: () => compress, logger: { info() {}, warn() {} }, clock: () => ++now, schedule: false, batchSize: () => 2, inputChars: () => 3200 });
  const seed = async (id = 's', count = 2) => {
    await kv.set(KV.sessions, id, { id, summary: { sourceOffsets: { kept: 9 }, segments: [{ narrative: 'synthetic-summary' }] } });
    for (let i = 0; i < count; i++) await kv.set(KV.observations(id), 'o' + i, { id: 'o' + i, type: 'decision', title: 'Synthetic source ' + i, narrative: 'synthetic', timestamp: String(i), sourceRaw: { text: 'synthetic-original-' + i } });
  };
  return { kv, calls, worker, seed, reads: () => reads, flags: (c: boolean, g: boolean) => { compress = c; graph = g; }, onCall: (fn: typeof onCall) => { onCall = fn; } };
}

test('unchanged completed sessions skip observation scans but same-count content changes invalidate completion', async () => {
  const f = fixture(); await f.seed(); const w = f.worker();
  await w.pump(); const reads = f.reads(); const calls = f.calls.length;
  await w.pump(); await w.pump();
  expect(f.reads()).toBe(reads); expect(f.calls.length).toBe(calls);
  const row = await f.kv.get(KV.observations('s'), 'o0');
  await f.kv.set(KV.observations('s'), 'o0', { ...row, title: 'Changed same-count source' });
  await w.pump();
  expect(f.reads()).toBe(reads + 1); expect(f.calls.length).toBe(calls + 1);
  expect((await f.kv.get(KV.sessions, 's')).summary.sourceOffsets).toEqual({ kept: 9 });
});

test('enabling compression invalidates completed graph-only sessions', async () => {
  const f = fixture(); await f.seed(); const w = f.worker(); await w.pump();
  f.flags(true, true); await w.pump();
  expect(f.calls.filter(c => c.function_id === 'mem::compress')).toHaveLength(2);
  expect((await f.kv.get(KV.sessions, 's')).enrichmentProgress.compress.processedCount).toBe(2);
});

test('each compression commit publishes progress before the next model call and graph checkpoint', async () => {
  const f = fixture(); f.flags(true, true); await f.seed(); const original = await f.kv.get(KV.observations('s'), 'o0');
  const checkpoints: any[] = [];
  f.onCall(async () => { checkpoints.push((await f.kv.get(KV.sessions, 's')).enrichmentProgress); });
  await f.worker().pump();
  expect(checkpoints[1]?.compress.processedCount).toBe(1);
  expect(checkpoints[1]?.compress.pendingCount).toBe(1);
  expect(checkpoints[2]?.compress.processedCount).toBe(2);
  expect(checkpoints[2]?.graph.pendingCount).toBe(2);
  expect((await f.kv.get(KV.sessions, 's')).enrichmentProgress.graph.processedCount).toBe(2);
  expect((await f.kv.get(KV.observations('s'), 'o0')).sourceRaw).toEqual(original.sourceRaw);
  expect(f.reads()).toBe(2);
});

test('a revision change during graph work cannot freeze a stale completion snapshot', async () => {
  const f = fixture(); await f.seed('s', 1); let changed = false;
  f.onCall(async () => {
    if (changed) return; changed = true;
    const row = await f.kv.get(KV.observations('s'), 'o0');
    await f.kv.set(KV.observations('s'), 'o0', { ...row, narrative: 'concurrent synthetic change' });
  });
  const w = f.worker(); await w.pump(); await w.pump();
  expect(f.calls).toHaveLength(2);
  const reads = f.reads(); await w.pump(); expect(f.reads()).toBe(reads);
});

test('missing revision support scans safely and blocked records remain pending across rounds', async () => {
  const f = fixture(); await f.seed(); f.kv.observationReader.revision = async () => null as any;
  const w = f.worker(); await w.pump(); const reads = f.reads(); await w.pump(); expect(f.reads()).toBe(reads + 1);
  await f.kv.set(ENRICHMENT_NAMESPACE, 's', { graphDone: {}, graphFailures: { o0: { status: 'blocked', attempts: 8, history: [{ errorCode: 'synthetic-kept' }] } }, compressFailures: {} });
  await w.pump();
  const state = await f.kv.get(ENRICHMENT_NAMESPACE, 's');
  expect(state.graphFailures.o0.history).toEqual([{ errorCode: 'synthetic-kept' }]);
  expect((await f.kv.get(KV.sessions, 's')).enrichmentProgress.graph.quarantinedCount).toBe(1);
});


test('graph refreshes a concurrently removed non-target row after compression commits', async () => {
  const f = fixture(); f.flags(true, true); await f.seed();
  const row = await f.kv.get(KV.observations('s'), 'o1');
  await f.kv.set(KV.observations('s'), 'o1', { ...row, llmCompressionRevision: ENRICHMENT_REVISION });
  f.onCall(async id => { if (id === 'mem::compress') await f.kv.delete(KV.observations('s'), 'o1'); });
  await f.worker().pump();
  expect(f.calls.find(c => c.function_id === 'mem::graph-extract').payload.observations.map((row: any) => row.id)).toEqual(['o0']);
  expect((await f.kv.get(KV.sessions, 's')).enrichmentProgress.compress.processedCount).toBe(1);
});


test('stop and drain wait for the admitted commit and retain pending work without another call', async () => {
  const f = fixture(); f.flags(true, true); await f.seed();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let admitted!: () => void; const started = new Promise<void>(resolve => { admitted = resolve; });
  f.onCall(async () => { admitted(); await gate; });
  const w = f.worker(); const pumping = w.pump(); await started;
  let drained = false; const drain = w.drain().then(() => { drained = true; }); const stop = w.stop();
  await Promise.resolve(); expect(drained).toBe(false);
  release(); await Promise.all([pumping, drain, stop]);
  expect(f.calls).toHaveLength(1);
  const session = await f.kv.get(KV.sessions, 's');
  expect(session.enrichmentProgress.compress.processedCount).toBe(1);
  expect(session.enrichmentProgress.compress.pendingCount).toBe(1);
  expect(session.summary.sourceOffsets).toEqual({ kept: 9 });
});

test('completed sessions do not consume scans while a later session keeps its bounded turns', async () => {
  const f = fixture(); await f.seed('complete', 1); await f.seed('pending', 3);
  const w = f.worker(); await w.pump(); expect(f.reads()).toBe(2);
  await w.pump(); expect(f.reads()).toBe(3);
  await w.pump(); expect(f.reads()).toBe(3);
  expect(f.calls.map(c => c.payload.observations.length)).toEqual([1, 2, 1]);
  expect((await f.kv.get(KV.sessions, 'pending')).enrichmentProgress.graph.pendingCount).toBe(0);
});

test('graph enablement invalidates a completed compression-only checkpoint', async () => {
  const f = fixture(); f.flags(true, false); await f.seed(); const w = f.worker();
  await w.pump(); await w.pump(); const reads = f.reads(); await w.pump(); expect(f.reads()).toBe(reads);
  f.flags(true, true); await w.pump();
  expect(f.calls.filter(c => c.function_id === 'mem::graph-extract')).toHaveLength(1);
  expect((await f.kv.get(KV.sessions, 's')).enrichmentProgress.graph.pendingCount).toBe(0);
});
