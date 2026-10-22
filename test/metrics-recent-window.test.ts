import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsStore } from '../src/eval/metrics-store.js';
import type { StateKV } from '../src/state/kv.js';
import type { FunctionMetrics } from '../src/types.js';

const epoch = Date.parse('2026-10-22T00:00:30.000Z');
const historical = (functionId = 'mem::compress'): FunctionMetrics => ({
  functionId, totalCalls: 100, successCount: 80, failureCount: 20,
  avgLatencyMs: 10, avgQualityScore: 75,
});
function fixture(seed: FunctionMetrics[] = [historical()]) {
  const rows = new Map(seed.map(row => [row.functionId, structuredClone(row)]));
  const set = vi.fn(async (_scope: string, key: string, value: FunctionMetrics) => {
    rows.set(key, structuredClone(value));
  });
  const kv = {
    get: async (_scope: string, key: string) => structuredClone(rows.get(key) ?? null),
    set,
    list: async () => [...rows.values()].map(row => structuredClone(row)),
  } as unknown as StateKV;
  return { store: new MetricsStore(kv), kv, rows, set };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('recent function metric attempts', () => {
  it.each(['throw', 'nan', 'out-of-range', 'iso-throw'])('isolates optional recent clock failures from cumulative metrics: %s', async fault => {
    const now = vi.spyOn(Date, 'now');
    if (fault === 'throw') now.mockImplementation(() => { throw Error('synthetic clock'); });
    if (fault === 'nan') now.mockReturnValue(NaN);
    if (fault === 'out-of-range') now.mockReturnValue(9e15);
    if (fault === 'iso-throw') vi.spyOn(Date.prototype, 'toISOString').mockImplementation(() => { throw Error('synthetic ISO clock'); });
    const { store, rows } = fixture();
    await store.record('mem::compress', 10, false);
    expect(await store.get('mem::compress')).toMatchObject({ totalCalls: 101, failureCount: 21 });
    expect((await store.get('mem::compress'))?.recent).toBeUndefined();
    expect((await store.getAll())[0]).toMatchObject({ totalCalls: 101, failureCount: 21 });
    expect(rows.get('mem::compress')).toMatchObject({ totalCalls: 101, failureCount: 21 });
  });

  it('does not fabricate complete coverage after a clock failure skips an observed attempt', async () => {
    const { store } = fixture();
    const now = vi.spyOn(Date, 'now').mockImplementationOnce(() => { throw Error('synthetic clock'); });
    await store.record('mem::compress', 10, false); now.mockRestore();
    expect((await store.get('mem::compress'))?.recent).toBeUndefined();
    expect((await store.getAll())[0].totalCalls).toBe(101);
  });
  it('starts honest zero coverage at observation, independent of historical failures', async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const { store, set } = fixture();
    vi.setSystemTime(epoch + 10_000);
    expect((await store.get('mem::compress'))?.recent).toEqual({
      observedSince: new Date(epoch).toISOString(),
      windowStartAt: new Date(epoch).toISOString(),
      windowEndAt: new Date(epoch + 10_000).toISOString(),
      windowMs: 10_000, attemptCount: 0, failureCount: 0,
    });
    expect(set).not.toHaveBeenCalled();
  });

  it('aggregates every attempt beyond diagnostic sample eviction without persisting recent fields', async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const { store, rows, set } = fixture();
    await Promise.all(Array.from({ length: 25 }, (_, index) => store.record('mem::compress', 10, index >= 11)));
    const metric = (await store.getAll())[0];
    expect(metric).toMatchObject({ totalCalls: 125, failureCount: 31, successCount: 94, recent: { attemptCount: 25, failureCount: 11 } });
    expect(rows.get('mem::compress')).not.toHaveProperty('recent');
    expect(set).toHaveBeenCalledTimes(25);
    metric.recent!.attemptCount = 999;
    expect((await store.get('mem::compress'))?.recent?.attemptCount).toBe(25);
  });

  it('expires whole minute buckets and states the actual retained interval', async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const { store } = fixture();
    await store.record('mem::compress', 10, false);
    vi.setSystemTime(epoch + 14 * 60_000);
    await store.record('mem::compress', 10, true);
    vi.setSystemTime(epoch + 14 * 60_000 + 40_000);
    const metric = await store.get('mem::compress');
    expect(metric?.recent).toEqual({
      observedSince: new Date(epoch).toISOString(),
      windowStartAt: '2026-10-22T00:01:00.000Z',
      windowEndAt: '2026-10-22T00:15:10.000Z',
      windowMs: 850_000, attemptCount: 1, failureCount: 0,
    });
    vi.setSystemTime(epoch + 30 * 60_000);
    expect((await store.getAll())[0].recent).toMatchObject({ attemptCount: 0, failureCount: 0 });
  });

  it('starts a new observation epoch after restart while preserving all cumulative counters', async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const { store, kv } = fixture();
    await store.record('mem::compress', 10, false);
    vi.setSystemTime(epoch + 60_000);
    const restarted = new MetricsStore(kv);
    expect(await restarted.get('mem::compress')).toMatchObject({ totalCalls: 101, failureCount: 21, recent: {
      observedSince: new Date(epoch + 60_000).toISOString(), attemptCount: 0, failureCount: 0,
    } });
  });

  it('does not move coverage backward when the wall clock regresses', async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const { store } = fixture();
    vi.setSystemTime(epoch + 180_000);
    await store.record('mem::compress', 10, true);
    vi.setSystemTime(epoch - 60_000);
    await store.record('mem::compress', 10, false);
    expect((await store.get('mem::compress'))?.recent).toMatchObject({
      windowStartAt: new Date(epoch).toISOString(), windowEndAt: new Date(epoch + 180_000).toISOString(),
      windowMs: 180_000, attemptCount: 2, failureCount: 1,
    });
  });

  it('counts an observed failed attempt even if the existing historical write rejects', async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const { store, set, rows } = fixture();
    set.mockRejectedValueOnce(new Error('synthetic write failure'));
    await expect(store.record('mem::compress', 10, false)).rejects.toThrow('synthetic write failure');
    expect(await store.get('mem::compress')).toMatchObject({ totalCalls: 100, failureCount: 20, recent: { attemptCount: 1, failureCount: 1 } });
    expect(rows.get('mem::compress')).toEqual(historical());
  });

  it('keeps bounded function coverage without evicting earlier observations or inventing zero for overflow', async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const { store } = fixture([]);
    for (let index = 0; index <= 512; index++) await store.record(`synthetic::${index}`, 1, false);
    expect((await store.get('synthetic::0'))?.recent).toMatchObject({ attemptCount: 1, failureCount: 1 });
    expect((await store.get('synthetic::512'))?.recent).toBeUndefined();
    expect((await store.getAll()).filter(row => row.recent)).toHaveLength(512);
  });

  it('does not let reading inactive historical metrics consume active observation capacity', async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const { store } = fixture(Array.from({ length: 512 }, (_, index) => historical(`historical::${index}`)));
    const old = await store.getAll();
    expect(old).toHaveLength(512);
    expect(old.every(row => row.recent?.attemptCount === 0)).toBe(true);
    await store.record('synthetic::new-active-function', 1, false);
    expect((await store.get('synthetic::new-active-function'))?.recent).toMatchObject({ attemptCount: 1, failureCount: 1 });
  });
});
