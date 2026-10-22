import { afterEach, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  elapsed: 0, measureError: false, readFailures: 0, permanentReadFailure: false,
  fsyncFailure: false, verifyFailure: false, cryptoFailure: false,
  reads: 0, opens: 0, syncs: 0, stats: 0, closes: 0,
}));
const signature = { dev: 1n, ino: 2n, size: 100n, mtimeNs: 3n, ctimeNs: 4n };
vi.mock('node:perf_hooks', () => ({ performance: { now: () => {
  if (hooks.measureError) throw Error('PRIVATE_MEASUREMENT_ERROR');
  return hooks.elapsed;
} } }));
vi.mock('node:crypto', async original => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, createHmac: (...args: Parameters<typeof actual.createHmac>) => {
    if (hooks.cryptoFailure) throw Error('PRIVATE_CRYPTO_ERROR');
    return actual.createHmac(...args);
  } };
});
vi.mock('../src/ops/namespace-reader.mjs', () => ({ readNamespaceEntries: async (_path: string, options: any) => {
  hooks.reads++; hooks.elapsed += 7;
  const failed = hooks.permanentReadFailure || hooks.readFailures-- > 0;
  options.onRead?.({ fileBytes: 100, bytesRead: failed ? 40 : 80, entries: failed ? 0 : 1, complete: !failed });
  if (failed) throw Object.assign(Error('state_namespace_changed'), { code: 'state_namespace_changed' });
  return { values: new Map([...options.keys].map((key: string) => [key, { privateValue: 'PRIVATE_DATA' }])), signature: '1:2:100:3:4' };
} }));
vi.mock('node:fs/promises', () => ({
  open: async () => {
    hooks.opens++;
    return { stat: async () => signature, sync: async () => {
      hooks.syncs++; hooks.elapsed += 3;
      if (hooks.fsyncFailure) throw Error('PRIVATE_IO_ACCOUNT_1234');
    }, close: async () => { hooks.closes++; hooks.elapsed++; } };
  },
  stat: async () => {
    hooks.stats++; hooks.elapsed += 2;
    return hooks.verifyFailure ? { ...signature, ino: 99n } : signature;
  },
}));
import { createStateDurabilityFence } from '../src/ops/state-durability.mjs';
import { createDurabilityMeasurements } from '../src/ops/durability-measurement.mjs';

afterEach(() => {
  Object.assign(hooks, { elapsed: 0, measureError: false, readFailures: 0, permanentReadFailure: false,
    fsyncFailure: false, verifyFailure: false, cryptoFailure: false, reads: 0, opens: 0, syncs: 0, stats: 0, closes: 0 });
});
const scope = 'mem:obs:PRIVATE_SESSION';
const selected = [{ scope, key: 'PRIVATE_KEY' }];
const kv = { get: async () => { hooks.elapsed += 4; return { privateValue: 'PRIVATE_DATA' }; } };
function fixture() {
  return createStateDurabilityFence({ storePath: '/synthetic/PRIVATE_PATH', timeoutMs: 60, pollIntervalMs: 1, clock: () => hooks.elapsed });
}
function samples(fence: ReturnType<typeof fixture>): any[] {
  return (fence.snapshot() as any).measurements.recent;
}

it('measures disjoint phases with the original IO counts and unchanged certification result', async () => {
  const fence = fixture();
  expect(await fence.waitForKeys(kv, selected)).toEqual({ keys: 1, scopes: 1, synced: true, waitMs: 19, mutationFailures: 0 });
  expect(samples(fence)).toHaveLength(1);
  const sample = samples(fence)[0];
  expect(sample).toMatchObject({ outcome: 'verified', checkAttempts: 1, rechecks: 0, retryCount: 0, elapsedMs: 21,
    phases: { captureMs: 4, readbackMs: 7, fsyncMs: 6, verifyMs: 2, cleanupMs: 2, retryWaitMs: 0 } });
  expect(sample.namespaces[0]).toMatchObject({ kind: 'observations', fileBytes: 100, scanBytes: 80, scans: 1, completeScans: 1 });
  expect({ reads: hooks.reads, opens: hooks.opens, syncs: hooks.syncs, stats: hooks.stats, closes: hooks.closes })
    .toEqual({ reads: 1, opens: 2, syncs: 2, stats: 1, closes: 2 });
});

it('distinguishes transient namespace replacement from a final storage failure', async () => {
  const fence = fixture(); hooks.readFailures = 1;
  await expect(fence.waitForKeys(kv, selected)).resolves.toMatchObject({ synced: true });
  expect(samples(fence)[0]).toMatchObject({ outcome: 'verified', checkAttempts: 2, rechecks: 1, retryCount: 1,
    retryReasons: { namespace_changed: 1 }, namespaces: [{ scans: 2, completeScans: 1, scanBytes: 120 }] });
});

it.each(['readback', 'fsync', 'verify'] as const)('retains dirty keys and identifies failed %s without arbitrary error text', async stage => {
  const fence = fixture();
  await fence.mutate(scope, 'PRIVATE_KEY', async () => {});
  hooks.permanentReadFailure = stage === 'readback'; hooks.fsyncFailure = stage === 'fsync'; hooks.verifyFailure = stage === 'verify';
  await expect(fence.waitForKeys(kv, selected)).rejects.toMatchObject({ code: 'STATE_DURABILITY_TIMEOUT' });
  expect(fence.keys()).toHaveLength(1);
  expect(samples(fence)[0]).toMatchObject({ outcome: 'failed', failedStage: stage });
  expect(samples(fence)[0].retryCount).toBeGreaterThan(0);
  expect(JSON.stringify((fence.snapshot() as any).measurements)).not.toContain('PRIVATE');
});

it('records capture timeout once and ignores later completion of the outstanding get', async () => {
  const fence = createStateDurabilityFence({ storePath: '/synthetic', timeoutMs: 5, pollIntervalMs: 1 });
  let resolve!: (value: unknown) => void;
  const pending = new Promise(r => { resolve = r; });
  await expect(fence.waitForKeys({ get: () => pending }, selected)).rejects.toMatchObject({ code: 'STATE_DURABILITY_TIMEOUT', diagnostics: { stage: 'capture' } });
  const before = JSON.stringify(samples(fence));
  expect(samples(fence)[0]).toMatchObject({ outcome: 'failed', failedStage: 'capture', checkAttempts: 0 });
  resolve({ privateValue: 'PRIVATE_DATA' }); await pending; await Promise.resolve();
  expect(JSON.stringify(samples(fence))).toBe(before);
});

it('uses stable scope tokens within one fence, different tokens across fences, and no identifiers', async () => {
  const a = fixture(), b = fixture();
  await a.waitForKeys(kv, selected); await a.waitForKeys(kv, selected); await b.waitForKeys(kv, selected);
  const token = samples(a)[0].namespaces[0].token;
  expect(token).toMatch(/^[0-9a-f]{16}$/);
  expect(samples(a)[1].namespaces[0].token).toBe(token);
  expect(samples(b)[0].namespaces[0].token).not.toBe(token);
  expect(JSON.stringify((a.snapshot() as any).measurements)).not.toMatch(/PRIVATE|mem:obs|synthetic/);
});

it('bounds history and namespace detail, reports overflow and protects stored samples from callers', async () => {
  const fence = createStateDurabilityFence({ storePath: '/synthetic', timeoutMs: 100000, clock: () => hooks.elapsed });
  const keys = Array.from({ length: 12 }, (_, i) => ({ scope: 'unknown:PRIVATE_' + i, key: 'PRIVATE_KEY' }));
  for (let i = 0; i < 12; i++) await fence.waitForKeys(kv, keys);
  const measurements = (fence.snapshot() as any).measurements;
  expect(measurements.recent).toHaveLength(8); expect(measurements.evicted).toBe(4);
  expect(measurements.recent[0]).toMatchObject({ namespaceCount: 12, omittedNamespaces: 4 });
  expect(measurements.recent[0].namespaces).toHaveLength(8);
  expect(measurements.recent[0].namespaces.every((x: any) => x.kind === 'other')).toBe(true);
  measurements.recent[0].outcome = 'PRIVATE_MUTATION';
  expect(JSON.stringify(samples(fence))).not.toContain('PRIVATE');
  expect(Buffer.byteLength(JSON.stringify((fence.snapshot() as any).measurements))).toBeLessThan(24000);
});

it.each(['measureError', 'cryptoFailure'] as const)('does not change storage outcomes when %s prevents measurement', async failure => {
  hooks[failure] = true;
  const fence = fixture();
  await expect(fence.waitForKeys(kv, selected)).resolves.toMatchObject({ synced: true });
  hooks.permanentReadFailure = true;
  await expect(fence.waitForKeys(kv, selected)).rejects.toMatchObject({ code: 'STATE_DURABILITY_TIMEOUT' });
});

it('keeps retry waiting separate from scan work and drops incomplete telemetry after clock failure', () => {
  const measurements = createDurabilityMeasurements();
  const sample = measurements.begin([scope], 1)!;
  hooks.elapsed = 4; sample.enter('readback'); hooks.elapsed = 11;
  sample.retry('state_namespace_not_committed', 'readback'); sample.enter('retryWait');
  hooks.elapsed = 31; sample.enter('readback'); sample.check(); hooks.elapsed = 38;
  sample.finish('verified', null, 'verify');
  expect(measurements.snapshot()!.recent[0]).toMatchObject({ elapsedMs: 38,
    phases: { captureMs: 4, readbackMs: 14, retryWaitMs: 20 }, retryReasons: { not_committed: 1 } });
  const broken = measurements.begin([scope], 1)!;
  hooks.measureError = true; broken.enter('readback'); hooks.measureError = false;
  broken.finish('verified', null, 'verify');
  expect(measurements.snapshot()).toMatchObject({ unavailable: 1 });
  expect(measurements.snapshot()!.recent).toHaveLength(1);
});

it('treats prototype-like names and unrecognized reasons as fixed other categories', () => {
  const measurements = createDurabilityMeasurements();
  const sample = measurements.begin(['constructor', '__proto__'], 2)!;
  sample.enter('readback');
  sample.retry('constructor', 'capture'); sample.finish('failed', '__proto__', 'capture');
  expect(measurements.snapshot()!.recent[0]).toMatchObject({ retryReasons: { other: 1 }, failureReason: 'other' });
  expect(measurements.snapshot()!.recent[0].namespaces.every((x: any) => x.kind === 'other')).toBe(true);
});

it.each(['reject', 'timeout'] as const)('identifies revision recapture %s as capture failure, not disk IO', async mode => {
  const fence = mode === 'timeout'
    ? createStateDurabilityFence({ storePath: '/synthetic', timeoutMs: 8, pollIntervalMs: 1 })
    : fixture();
  await fence.mutate(scope, 'PRIVATE_KEY', async () => {});
  let calls = 0;
  const recapturing = { get: async () => {
    if (++calls === 1) {
      await fence.mutate(scope, 'PRIVATE_KEY', async () => {});
      return { privateValue: 'PRIVATE_DATA' };
    }
    if (mode === 'timeout') return new Promise(() => {});
    hooks.elapsed += 100;
    throw Error('PRIVATE_CAPTURE_ERROR');
  } };
  await expect(fence.waitForKeys(recapturing, selected)).rejects.toMatchObject({ code: 'STATE_DURABILITY_TIMEOUT' });
  expect(fence.keys()).toHaveLength(1);
  const expected = mode === 'timeout' ? 'capture_timeout' : 'capture_error';
  expect(samples(fence)[0]).toMatchObject({ outcome: 'failed', failedStage: 'capture', failureReason: expected,
    retryReasons: { [expected]: 1 }, checkAttempts: 0 });
  expect(hooks.reads).toBe(0); expect(hooks.syncs).toBe(0);
});

it('keeps concurrent certifications independent when capture completes out of order', async () => {
  const fence = fixture(); let release!: (value: unknown) => void;
  const delayed = fence.waitForKeys({ get: () => new Promise(r => { release = r; }) }, selected);
  await fence.waitForKeys(kv, [{ scope: 'mem:audit', key: 'PRIVATE_OTHER' }]);
  release({ privateValue: 'PRIVATE_DATA' }); await delayed;
  expect(samples(fence).map(x => x.id)).toEqual([2, 1]);
  expect(samples(fence).map(x => x.namespaces[0].kind)).toEqual(['audit', 'observations']);
});

it.each([['mem:index:bm25', 'index'], ['mem:audit:2026-10', 'audit'], ['mem:memories', 'memories']])('classifies the existing %s namespace without exposing it', (scope, expected) => {
  const measurements = createDurabilityMeasurements(); const sample = measurements.begin([scope], 1)!;
  sample.finish('verified', null, 'verify');
  expect(measurements.snapshot()!.recent[0].namespaces[0].kind).toBe(expected);
});

it.each(['verified', 'failed'] as const)('counts final measurement construction failure once while storage remains %s', async outcome => {
  const fence = fixture(); hooks.permanentReadFailure = outcome === 'failed';
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw Error('PRIVATE_TIMESTAMP_FAILURE'); });
  try {
    if (outcome === 'verified') await expect(fence.waitForKeys(kv, selected)).resolves.toMatchObject({ synced: true });
    else {
      await fence.mutate(scope, 'PRIVATE_KEY', async () => {});
      await expect(fence.waitForKeys(kv, selected)).rejects.toMatchObject({ code: 'STATE_DURABILITY_TIMEOUT' });
      expect(fence.keys()).toHaveLength(1);
    }
    expect((fence.snapshot() as any).measurements).toMatchObject({ unavailable: 1, recent: [] });
  } finally { clock.mockRestore(); }
  hooks.permanentReadFailure = false; hooks.elapsed = 0;
  await expect(fence.waitForKeys(kv, selected)).resolves.toMatchObject({ synced: true });
  expect((fence.snapshot() as any).measurements).toMatchObject({ unavailable: 1, recent: [{ outcome: 'verified' }] });
});

it('counts a finalized sample construction failure only once and remains usable', () => {
  const measurements = createDurabilityMeasurements(); const sample = measurements.begin([scope], 1)!;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw Error('PRIVATE_TIMESTAMP_FAILURE'); });
  try { expect(() => sample.finish('verified', null, 'verify')).not.toThrow(); sample.finish('failed', 'STATE_SYNC_FAILED', 'fsync'); }
  finally { clock.mockRestore(); }
  expect(measurements.snapshot()).toMatchObject({ unavailable: 1, recent: [] });
  measurements.begin([scope], 1)!.finish('verified', null, 'verify');
  expect(measurements.snapshot()).toMatchObject({ unavailable: 1, recent: [{ id: 2, outcome: 'verified' }] });
});

it('keeps previous bounded history and eviction count intact when final construction fails', () => {
  const measurements = createDurabilityMeasurements();
  for (let i = 0; i < 8; i++) measurements.begin([scope], 1)!.finish('verified', null, 'verify');
  const before = measurements.snapshot()!.recent;
  const sample = measurements.begin([scope], 1)!;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw Error('PRIVATE_TIMESTAMP_FAILURE'); });
  try { sample.finish('verified', null, 'verify'); } finally { clock.mockRestore(); }
  expect(measurements.snapshot()).toMatchObject({ unavailable: 1, evicted: 0, recent: before });
  measurements.begin([scope], 1)!.finish('verified', null, 'verify');
  expect(measurements.snapshot()).toMatchObject({ unavailable: 1, evicted: 1 });
  expect(measurements.snapshot()!.recent).toHaveLength(8);
});

it('keeps previous history atomic and counts loss if bounded history preparation throws', () => {
  const measurements = createDurabilityMeasurements();
  for (let i = 0; i < 8; i++) measurements.begin([scope], 1)!.finish('verified', null, 'verify');
  const before = measurements.snapshot()!.recent; const sample = measurements.begin([scope], 1)!;
  const original = Array.prototype.slice;
  Array.prototype.slice = function(this: any[], start?: number, end?: number) {
    if (this.length === 9 && this[8]?.id === 9 && this[8]?.namespaceCount === 1) throw Error('PRIVATE_HISTORY_FAILURE');
    return Reflect.apply(original, this, [start, end]);
  };
  try { sample.finish('verified', null, 'verify'); } finally { Array.prototype.slice = original; }
  expect(measurements.snapshot()).toMatchObject({ unavailable: 1, evicted: 0, recent: before });
  measurements.begin([scope], 1)!.finish('verified', null, 'verify');
  expect(measurements.snapshot()).toMatchObject({ unavailable: 1, evicted: 1 });
});

it('keeps exact completed outcomes when the recent-eight samples are evicted', async () => {
  const fence = fixture();
  for (let index = 0; index < 12; index++) await fence.waitForKeys(kv, selected);
  hooks.permanentReadFailure = true;
  await expect(fence.waitForKeys(kv, selected)).rejects.toMatchObject({ code: 'STATE_DURABILITY_TIMEOUT' });
  const view = (fence.snapshot() as any).measurements;
  expect(view.recent).toHaveLength(8);
  expect(view.totals).toMatchObject({ completed: 13, verified: 12, failed: 1,
    failedStages: { readback: 1 }, failureReasons: { namespace_changed: 1 } });
  expect(JSON.stringify(view.totals)).not.toMatch(/PRIVATE|mem:obs|synthetic/);
});

it('counts actual fence outcomes even when detailed measurement cannot start', async () => {
  hooks.measureError = true;
  const fence = fixture();
  await expect(fence.waitForKeys(kv, selected)).resolves.toMatchObject({ synced: true });
  expect((fence.snapshot() as any).measurements.totals).toMatchObject({ completed: 1, verified: 1, failed: 0 });
});
