import { isDeepStrictEqual } from 'node:util';
import type { IIIClient } from 'iii-sdk';
import type { StateKV } from '../state/kv.js';
import { KV } from '../state/schema.js';
import { withKeyedLock } from '../state/keyed-mutex.js';
import type { CompressedObservation } from '../types.js';
import { captureEventScope, isCaptureKey, type CompletedEvent } from './event-record.js';
import { captureSourceDigest } from './receipt-digest.js';

export function registerCaptureReceipts(sdk: IIIClient, kv: StateKV): void {
  let active = 0;
  sdk.registerFunction('mem::capture-receipt', async (input: {key: string; digest?: string; budgetMs?: number}) => {
    const {key, digest, budgetMs = 15_000} = input;
    if (!isCaptureKey(key) || digest !== undefined && !/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 15_000) throw Error('INVALID_RECEIPT_QUERY');
    const receipt = (state: string, durable = false) => ({key, state, durable});
    if (active >= 2) return receipt('busy');
    active++;
    const deadline = Date.now() + budgetMs;
    const outstanding = new Set<Promise<unknown>>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    async function bounded<T>(promise: Promise<T>): Promise<T> {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error('receipt_deadline');
      let timer: ReturnType<typeof setTimeout>;
      try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('receipt_deadline')), remaining);
          timers.add(timer);
        })]);
      } finally { if (timer!) { clearTimeout(timer); timers.delete(timer); } }
    }
    function get<T>(scope: string, itemKey: string): Promise<T | null> {
      if (Date.now() >= deadline) return Promise.reject(Error('receipt_deadline'));
      const request = kv.get<T>(scope, itemKey);
      outstanding.add(request);
      request.then(() => outstanding.delete(request), () => outstanding.delete(request));
      return bounded(request);
    }
    const work = withKeyedLock(`capture:${key}`, async () => {
      const done = await get<CompletedEvent>(captureEventScope(key), key);
      if (!done) {
        const queued = await get<{status?: string}>(KV.captureInbox, key);
        return receipt(['pending', 'retrying', 'dead'].includes(queued?.status ?? '') ? queued!.status! : 'unknown');
      }
      if (done.key !== key) return receipt('unverifiable');
      if (done.state === 'deleted') return receipt('deleted');
      if (!digest) return receipt('completed');
      if (!kv.durability || !done.observationId) return receipt('unavailable');
      const scope = KV.observations(done.sessionId);
      const obs = await get<CompressedObservation>(scope, done.observationId), raw = obs?.sourceRaw;
      if (!obs || obs.id !== done.observationId || obs.sessionId !== done.sessionId || obs.captureKey !== key || raw?.captureKey !== key || raw.eventId !== done.eventId || raw.sessionId !== done.sessionId) return receipt('unverifiable');
      if (captureSourceDigest(raw.hookType, raw.timestamp, raw.raw) !== digest) return receipt('mismatch');
      const result = await kv.durability.waitForKeys({get} as StateKV, [{scope: captureEventScope(key), key}, {scope, key: done.observationId}], {deadline, expectedValues: [done, obs]});
      if (!result.synced || Date.now() >= deadline) return receipt('unavailable');
      const [afterDone, afterObs] = await Promise.all([get(captureEventScope(key), key), get(scope, done.observationId)]);
      if (!isDeepStrictEqual(done, afterDone) || !isDeepStrictEqual(obs, afterObs) || Date.now() >= deadline) return receipt('changed');
      return receipt('completed', true);
    }).catch(() => receipt('unavailable'));
    // Timed-out SDK calls cannot be cancelled; retain their slot until they settle.
    void work.finally(() => Promise.allSettled([...outstanding]).then(() => { active--; }));
    try { return await bounded(work); }
    catch { return receipt('unavailable'); }
    finally { for (const timer of timers) clearTimeout(timer); }
  });
  sdk.registerFunction('mem::capture-receipt-page', async (input: {shard: string; offset: number; limit: number}) => {
    const {shard, offset, limit} = input;
    if (!/^[a-f0-9]{2}$/.test(shard) || !Number.isSafeInteger(offset) || offset < 0 || offset > 2000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw Error('INVALID_RECEIPT_QUERY');
    if (!kv.captureReceiptPage) throw Error('CAPTURE_RECEIPT_PAGE_UNAVAILABLE');
    return kv.captureReceiptPage({shard, offset, limit});
  });
}
