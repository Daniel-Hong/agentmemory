import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createStateDurabilityFence } from '../ops/state-durability.mjs';
import { verifyVectorCheckpointFiles, verifyRemainingVectorPending, verifyVectorRetentionReceipts } from '../ops/vector-checkpoint-proof.mjs';
import type { VectorRetentionReceipt } from '../types.js';
import type { StateKV } from './kv.js';
import { KV } from './schema.js';

export type RetentionReceipt = VectorRetentionReceipt;
export type RecoveryUpsert = { id: string; q: number; s: string; e: string; k?: 'memory' | 'observation' };
export type RecoverySelection = {
  pendingRows: RecoveryUpsert[];
  meta: Record<string, unknown> | null;
  buckets: Array<{ bucket: number; ids: string[] }>;
};

export function recoveryUpserts(values: unknown, dimensions: number): RecoveryUpsert[] {
  if (!Array.isArray(values) || values.length > 16) throw Error('vector_recovery_selection_invalid');
  const ids = new Set<string>(), sequences = new Set<number>();
  for (const row of values) {
    if (!row || typeof row !== 'object' || Object.keys(row).some(key => !['id', 'q', 's', 'e', 'k'].includes(key)) ||
        !Number.isSafeInteger(row.q) || row.q <= 0 || row.q === Number.MAX_SAFE_INTEGER || sequences.has(row.q) ||
        typeof row.id !== 'string' || !row.id || row.id === '~clear' || row.id.length > 512 || ids.has(row.id) ||
        typeof row.s !== 'string' || !row.s || row.s.length > 512 ||
        (row.k !== undefined && row.k !== (row.id.startsWith('mem_') ? 'memory' : 'observation')) ||
        !Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 8192 ||
        typeof row.e !== 'string' || row.e.length !== 4 * Math.ceil(dimensions * 4 / 3))
      throw Error('vector_recovery_selection_invalid');
    const bytes = Buffer.from(row.e, 'base64');
    if (bytes.length !== dimensions * 4 || bytes.toString('base64') !== row.e) throw Error('vector_recovery_embedding_invalid');
    for (let offset = 0; offset < bytes.length; offset += 4) {
      if (!Number.isFinite(bytes.readFloatLE(offset))) throw Error('vector_recovery_embedding_invalid');
    }
    ids.add(row.id);
    sequences.add(row.q);
  }
  return [...values].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export const bucketScope = (bucket: number) => KV.bm25Index + ':vec:' + String(bucket).padStart(4, '0');
export const RETAINED_SCOPE = KV.vectorRetentionReceipts;

export function receiptFor(row: RecoveryUpsert, bucket: number): RetentionReceipt {
  const digest = createHash('sha256').update(JSON.stringify([row.id, row.q, row.s, row.e, row.k ?? null, bucket])).digest('hex');
  return { v: 1, id: row.id, q: row.q, bucket, digest };
}

export async function readRetention(kv: StateKV, storePath: string, admitted: () => boolean): Promise<RetentionReceipt[]> {
  const values = await kv.list<RetentionReceipt>(RETAINED_SCOPE);
  if (!Array.isArray(values) || values.length > 16 || values.some(row => !row || typeof row.digest !== 'string'))
    throw Error('vector_retention_receipts_invalid');
  const receipts = Object.fromEntries(values.map(row => [row.digest, row]));
  if (Object.keys(receipts).length !== values.length) throw Error('vector_retention_receipts_invalid');
  await verifyVectorRetentionReceipts({ storePath, receipts, admitted });
  return values;
}

export async function reconcileCheckpoint(
  kv: StateKV, storePath: string, selection: RecoverySelection, existing: RetentionReceipt[],
  authorize: boolean, admitted: () => boolean,
): Promise<RetentionReceipt[]> {
  const { pendingRows, buckets, meta } = selection;
  function check() {
    if (!admitted()) throw Error('vector_recovery_epoch_changed');
  }
  async function confirmPending() {
    check();
    const current = await kv.list<RecoveryUpsert>(KV.vectorPendingLog);
    if (!Array.isArray(current) || current.length !== pendingRows.length ||
        !pendingRows.every(row => current.some(value => isDeepStrictEqual(value, row)))) throw Error('vector_recovery_pending_changed');
    check();
  }

  await confirmPending();
  if (!pendingRows.length) {
    if (existing.length) throw Error('vector_retention_original_missing');
    await verifyRemainingVectorPending({ storePath, pendingRows, admitted });
    return [];
  }
  if (!meta || !isDeepStrictEqual(await kv.get(KV.bm25Index, 'vectors:meta'), meta)) throw Error('vector_recovery_meta_changed');
  const expected: RetentionReceipt[] = [];
  for (const {bucket, ids} of buckets) {
    for (const id of ids) {
      check();
      const row = pendingRows.find(item => item.id === id);
      if (!row || !isDeepStrictEqual(await kv.get(KV.vectorPendingLog, id), row) ||
          !isDeepStrictEqual(await kv.get(bucketScope(bucket), id), {id, s: row.s, e: row.e}))
        throw Error('vector_recovery_checkpoint_changed');
      expected.push(receiptFor(row, bucket));
    }
  }
  if (existing.some(stamp => !expected.some(wanted => isDeepStrictEqual(stamp, wanted))))
    throw Error('vector_retention_original_changed');
  const missing = expected.filter(wanted => !existing.some(stamp => isDeepStrictEqual(stamp, wanted)));
  if (missing.length && !authorize) throw Error('vector_retention_manual_verification_required');
  const recheck = await verifyVectorCheckpointFiles({storePath, pendingRows, meta, buckets, admitted});
  await recheck();

  // iii has no conditional delete. Preserve the entire WAL. Immutable receipt keys make
  // an interrupted batch retryable without replaying or rewriting even one vector.
  for (const stamp of missing) {
    check();
    await kv.set(RETAINED_SCOPE, stamp.digest, stamp);
  }
  if (missing.length) {
    const disk = createStateDurabilityFence({storePath, completion: 'disk'});
    const keys = missing.map(stamp => ({scope: RETAINED_SCOPE, key: stamp.digest}));
    const result = await disk.waitForKeys(kv, keys, {expectedValues: missing});
    if (result.synced !== true || result.keys !== keys.length || result.scopes !== 1 || result.mutationFailures !== 0)
      throw Error('vector_retention_disk_sync_unconfirmed');
  }
  const saved = await readRetention(kv, storePath, admitted);
  if (saved.length !== expected.length || !expected.every(stamp => saved.some(actual => isDeepStrictEqual(stamp, actual))))
    throw Error('vector_retention_receipts_changed');
  await confirmPending();
  await recheck();
  return saved;
}
