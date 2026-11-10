import {recoveryUpserts, type RecoveryUpsert, type RecoverySelection} from './vector-checkpoint-reconciliation.js';
import { VectorIndex, base64ToFloat32, float32ToBase64, type VectorEntry } from "./vector-index.js";
import type { StateKV } from "./kv.js";
import { KV } from "./schema.js";
import { logger } from "../logger.js";
import { safeAudit } from "../functions/audit.js";
import { getIndexSaveIntervalMs, getVectorBucketSize } from "../config.js";
import { isDeepStrictEqual } from "node:util";

const FAILURE_LOG_THROTTLE_MS = 60_000;
const INDEX_PERSISTENCE_FUNCTION_ID = "mem::index-persistence";
const LEGACY_BM25_KEY = "data";
const LEGACY_BM25_MANIFEST_KEY = "data:manifest";
const LEGACY_VECTOR_KEY = "vectors";
const LEGACY_VECTOR_MANIFEST_KEY = "vectors:manifest";
const VECTOR_META_KEY = "vectors:meta";
const VECTOR_BUCKET_SCOPE_PREFIX = `${KV.bm25Index}:vec:`;
const WRITE_CONCURRENCY = 32;
const LOAD_CONCURRENCY = 8;
const DISK_FENCE_BATCH_KEYS = 200;
const FIRST_CHECKPOINT_DELAY_MS = 5_000;
const PENDING_CLEAR_KEY = "~clear";
const PENDING_LOG_SAVE_THRESHOLD = 500;
const EARLY_SAVE_MIN_GAP_MS = 5_000;
const BACKFILL_MARKER_KEY = "vectors:backfill";
const MEMORY_ID_PREFIX = "mem_";
const LEGACY_SHARD_SCOPE_PREFIXES = [`${KV.bm25Index}:bm25:`, `${KV.bm25Index}:vectors:`];
const LEGACY_SHARD_KEY = "data";
const LEGACY_SHARD_SUFFIX = /^((?:[0-9a-z]+-[0-9a-f]{32})|(?:idx_[0-9a-z]+_[0-9a-f]{12})):\d{5}$/;
const ORPHAN_SWEEP_KEY = "legacy:sweep";

function auditIndexPersistEnabled(): boolean {
  const raw = process.env.AGENTMEMORY_AUDIT_INDEX_PERSIST;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

type IndexShardManifest = {
  v: 1;
  generation?: string;
  shards: Array<{ scope: string; key: string; chars: number }>;
  chars: number;
};

type VectorMeta = {
  v: 3;
  bucketCount: number;
  savedAt: string;
  count: number;
  backfillSince?: string | null;
};

type PersistedVector = {
  id: string;
  s: string;
  e: string;
};

type PendingVectorRow = {
  q: number;
  id?: string;
  s?: string;
  k?: "memory" | "observation";
  e?: string;
  t?: 1;
  c?: 1;
};

type BackfillMarker = {
  v: 1 | 2;
  since: string | null;
};

export interface PendingReplayResult {
  entries: number;
  added: number;
  removed: number;
  cleared: boolean;
  skipped: number;
}

export type VectorPublication = { id: string; entry: VectorEntry | null };

type IndexPersistenceOptions = {
  saveIntervalMs?: number;
  bucketSize?: number;
  now?: () => number;
  requireRecoveryPlan?: boolean;
  isStorageHeld?: () => boolean;
  storageGeneration?: () => number;
};

export interface IndexLegStatus {
  lastSavedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  dirtySince: string | null;
}

export interface VectorCountShortfall {
  expected: number;
  loaded: number;
}

export interface IndexPersistenceStatus {
  saveIntervalMs: number;
  firstCheckpointPending?: boolean;
  nextSaveAt?: string | null;
  saving: boolean;
  buckets: number;
  pendingChanges: number;
  vector: IndexLegStatus | null;
  vectorCountShortfall: VectorCountShortfall | null;
  pendingLog?: number;
  pendingLogKnown?: boolean;
  retainedCheckpointRows?: number;
  pendingLogAcknowledged?: number;
  pendingLogError?: string | null;
}

export type VectorLoadState = "buckets" | "migrated" | "none" | "unavailable";

export interface VectorLoadResult {
  vector: VectorIndex | null;
  state: VectorLoadState;
  savedAt: string | null;
  expectedCount?: number;
  checkpointMeta?: VectorMeta;
  backfillSince?: string | null;
}

export function vectorBucketScope(bucket: number): string {
  return `${VECTOR_BUCKET_SCOPE_PREFIX}${String(bucket).padStart(4, "0")}`;
}

function statePath(scope: string, key: string): string {
  return `${scope}/${key}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function earliestBackfillSince(...cutoffs: Array<string | null | undefined>): string | null | undefined {
  let earliest: string | undefined;
  for (const cutoff of cutoffs) {
    if (cutoff === null) return null;
    if (cutoff !== undefined && (earliest === undefined || Date.parse(cutoff) < Date.parse(earliest))) earliest = cutoff;
  }
  return earliest;
}

function generationTime(generation: string | undefined): string | null {
  const stamp = generation?.split("_")[1];
  if (!stamp) return null;
  const ms = parseInt(stamp, 36);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function isValidShardDescriptor(
  shard: unknown,
): shard is IndexShardManifest["shards"][number] {
  if (!shard || typeof shard !== "object") return false;
  const candidate = shard as { scope?: unknown; key?: unknown; chars?: unknown };
  return (
    typeof candidate.scope === "string" &&
    candidate.scope.length > 0 &&
    typeof candidate.key === "string" &&
    candidate.key.length > 0 &&
    Number.isInteger(candidate.chars) &&
    (candidate.chars as number) >= 0
  );
}

function legacyShardGeneration(scope: string): string | null | undefined {
  const prefix = LEGACY_SHARD_SCOPE_PREFIXES.find((candidate) => scope.startsWith(candidate));
  if (!prefix) return undefined;
  return LEGACY_SHARD_SUFFIX.exec(scope.slice(prefix.length))?.[1] ?? null;
}

function isPersistedVector(row: unknown): row is PersistedVector {
  if (!row || typeof row !== "object") return false;
  const candidate = row as Partial<PersistedVector>;
  return typeof candidate.id === "string" && typeof candidate.s === "string" && typeof candidate.e === "string";
}

async function inBatches<T>(
  items: T[],
  size: number,
  run: (item: T) => Promise<void>,
  stopOnFailure = false,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    const results = await Promise.allSettled(items.slice(offset, offset + size).map(run));
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    if (stopOnFailure && failures.length > 0) break;
  }
  return failures;
}

function isPendingVectorRow(row: unknown): row is PendingVectorRow {
  if (!row || typeof row !== "object") return false;
  const candidate = row as PendingVectorRow;
  if (typeof candidate.q !== "number" || !Number.isFinite(candidate.q)) return false;
  if (candidate.c === 1) return true;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return false;
  return candidate.t === 1 || typeof candidate.e === "string";
}

function emptyLegStatus(): IndexLegStatus {
  return { lastSavedAt: null, lastError: null, lastErrorAt: null, dirtySince: null };
}

export class IndexPersistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFailureLogAt = 0;
  private running: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  private stopped = false;
  private lastSaveAt: number;
  private dirtyEpoch = 0;
  private markedDuringRunAt: number | null = null;
  private hasVectorCheckpoint = false;
  private firstVectorSaveAttempted = false;
  private nextSaveAt: number | null = null;
  private leg: IndexLegStatus = emptyLegStatus();
  private readonly saveIntervalMs: number;
  private readonly bucketSize: number;
  private readonly now: () => number;
  private readonly isStorageHeld: () => boolean;
  private readonly storageGeneration: () => number;
  private bootStorageGeneration: number;
  private storageBlocked = false;
  private storageResume: Promise<boolean> | null = null;
  private storageRecovering = false;
  private bucketOfId: Map<string, number> = new Map();
  private bucketCounts: Map<number, number> = new Map();
  // Retain the original address until the deletion is certified on disk.
  private removedBuckets: Map<string, number> = new Map();
  private highestBucket = 0;
  private hasOpenBucket = false;
  private vectorCountShortfall: VectorCountShortfall | null = null;
  private seq = 0;
  private retainedRows = new Map<string, RecoveryUpsert>();
  private retentionReady = true;
  private pendingLog: Map<string, number> = new Map();
  private acknowledgedLog: Map<string, number> = new Map();
  private logChains: Map<string, Promise<void>> = new Map();
  private logSuppressed = false;
  private pendingLogUnknown = false;
  private pendingLogInspected = false;
  private pendingLogError: string | null = null;
  private earlySaveQueued = false;
  private backfillQueue: Promise<void> = Promise.resolve();
  private recoveryError: string | null = null;
  private backfillRevision = 0;
  private recoveryReady: boolean;
  private backfillSince: string | null | undefined;
  private checkpointBackfillSince: string | null | undefined;
  private completingBackfill = false;

  constructor(
    private kv: StateKV,
    private vector: VectorIndex | null,
    options: IndexPersistenceOptions = {},
  ) {
    this.recoveryReady = !options.requireRecoveryPlan || !vector;
    this.pendingLogInspected = !options.requireRecoveryPlan || !vector;
    this.isStorageHeld = options.isStorageHeld ?? (() => false);
    this.storageGeneration = options.storageGeneration ?? (() => 0);
    this.bootStorageGeneration = this.storageGeneration();
    this.vector?.setChangeListener((id, entry) => this.logChange(id, entry));
    this.retentionReady = !this.hasRetentionStore() ||
      (!options.requireRecoveryPlan && this.kv.canUseUnloadedDiskIndex?.() === true);
    this.vector?.setMutationGuard(id => {
      if (!this.retentionReady || (id === null ? this.retainedRows.size > 0 : this.retainedRows.has(id)) ||
          (!this.logSuppressed && (this.isStorageHeld() || this.storageBlocked || this.storageRecovering ||
            this.storageGeneration() !== this.bootStorageGeneration))) {
        throw Object.assign(new Error('VECTOR_RECOVERY_PAUSED'), {code: 'VECTOR_RECOVERY_PAUSED'});
      }
    });
    this.now = options.now ?? Date.now;
    const interval = options.saveIntervalMs;
    this.saveIntervalMs =
      typeof interval === "number" && Number.isFinite(interval) && interval > 0
        ? interval
        : getIndexSaveIntervalMs();
    const bucketSize = options.bucketSize;
    this.bucketSize =
      typeof bucketSize === "number" && Number.isInteger(bucketSize) && bucketSize > 0
        ? bucketSize
        : getVectorBucketSize();
    this.lastSaveAt = this.now();
  }

  scheduleSave(): void {
    if (this.stopped || !this.recoveryReady || this.recoveryError || !this.vector?.pendingChanges) return;
    const now = this.now();
    this.dirtyEpoch++;
    if (this.running && this.markedDuringRunAt === null) this.markedDuringRunAt = now;
    if (this.leg.dirtySince === null) this.leg.dirtySince = new Date(now).toISOString();
    this.queueSave();
  }

  save(): Promise<void> {
    this.clearTimer();
    if (this.queued) return this.queued;
    if (this.running) {
      const queued = this.running.then(() => {
        this.queued = null;
        return this.startRun();
      });
      this.queued = queued;
      return queued;
    }
    return this.startRun();
  }

  async saveVerified(publication?: VectorPublication): Promise<void> {
    const bucketBefore = publication
      ? this.bucketOfId.get(publication.id) ?? this.removedBuckets.get(publication.id)
      : undefined;
    const expected = publication?.entry ? {
      id: publication.id, s: publication.entry.sessionId, e: float32ToBase64(publication.entry.embedding),
    } : null;
    await this.save();
    const unverified = () => Object.assign(new Error('vector_publication_unverified'), { code: 'VECTOR_PUBLICATION_UNVERIFIED' });
    if (!publication) {
      const status = this.status();
      if (status.vector?.lastError || status.pendingLogError || status.pendingChanges > 0) throw unverified();
      return;
    }
    try {
      if (this.leg.lastError || !this.vector || (this.kv.backend === 'file' && !this.kv.durability)) throw unverified();
      const { id } = publication;
      const bucket = this.bucketOfId.get(id) ?? bucketBefore ?? this.removedBuckets.get(id);
      const keys: Array<{scope:string;key:string}> = [
        { scope: KV.vectorPendingLog, key: id },
        { scope: KV.vectorPendingLog, key: PENDING_CLEAR_KEY },
        { scope: KV.bm25Index, key: VECTOR_META_KEY },
      ];
      if (bucket !== undefined) keys.push({ scope: vectorBucketScope(bucket), key: id });
      const check = async () => {
        const [row, pending, clear, meta] = await Promise.all([
          bucket === undefined ? null : this.kv.get<PersistedVector>(vectorBucketScope(bucket), id),
          this.kv.get(KV.vectorPendingLog, id),
          this.kv.get(KV.vectorPendingLog, PENDING_CLEAR_KEY),
          this.kv.get<VectorMeta>(KV.bm25Index, VECTOR_META_KEY),
        ]);
        const validMeta = meta === null ? expected === null && bucket === undefined :
          meta.v === 3 && Number.isInteger(meta.count) && meta.count >= (expected ? 1 : 0) &&
          Number.isInteger(meta.bucketCount) && meta.bucketCount >= 0 && (bucket === undefined || bucket < meta.bucketCount);
        if (!isDeepStrictEqual(row, expected) || clear !== null || !validMeta ||
            ((pending !== null || this.retainedRows.has(id)) && !await this.verifyRetainedVectorPublication(publication))) throw unverified();
      };
      await Promise.all([this.logChains.get(id), this.logChains.get(PENDING_CLEAR_KEY)]);
      await check();
      await this.waitForVectorPublication(keys);
      await check();
    } catch { throw unverified(); }
  }

  status(): IndexPersistenceStatus {
    return {
      saveIntervalMs: this.saveIntervalMs,
      firstCheckpointPending: Boolean(this.vector && !this.hasVectorCheckpoint && (this.vector.pendingChanges > 0 || this.running)),
      nextSaveAt: this.nextSaveAt === null ? null : new Date(this.nextSaveAt).toISOString(),
      saving: this.running !== null,
      buckets: this.bucketCountInUse(),
      pendingChanges: this.vector?.pendingChanges ?? 0,
      vector: this.vector ? { ...this.leg } : null,
      vectorCountShortfall: this.vectorCountShortfall,
      pendingLog: this.pendingLogInspected && !this.pendingLogUnknown ? this.pendingLog.size + this.retainedRows.size : undefined,
      retainedCheckpointRows: this.retainedRows.size,
      pendingLogKnown: this.pendingLogInspected && !this.pendingLogUnknown,
      pendingLogAcknowledged: this.pendingLogInspected && !this.pendingLogUnknown ? this.acknowledgedLog.size : undefined,
      pendingLogError: this.pendingLogError,
    };
  }

  async replayPendingLog(expectedDimensions = 0): Promise<PendingReplayResult> {
    const result: PendingReplayResult = { entries: 0, added: 0, removed: 0, cleared: false, skipped: 0 };
    const vector = this.vector;
    if (!vector || !this.retentionReady || this.blockIfStorageHeld() || this.recoveryError) return result;
    let rows: unknown[];
    try {
      rows = await this.kv.list<unknown>(KV.vectorPendingLog);
    } catch (err) {
      this.pendingLogUnknown = true;
      this.pendingLogError = errorMessage(err);
      this.pauseRecovery(new Error("Pending vector log read failed"));
      logger.warn("index persistence: could not read the pending vector log", { message: this.pendingLogError });
      return result;
    }
    if (this.blockIfStorageHeld()) return result;
    this.pendingLogInspected = true;
    if (!Array.isArray(rows) || rows.some(row => !isPendingVectorRow(row))) {
      this.pendingLogUnknown = true;
      this.pauseRecovery(new Error('Pending vector log contains invalid records'));
      return result;
    }
    if (this.retainedRows.size) {
      if (rows.length !== this.retainedRows.size ||
          ![...this.retainedRows.values()].every(original => rows.some(row => isDeepStrictEqual(row, original)))) {
        this.storageBlocked = true;
        this.pendingLogUnknown = true;
        this.pauseRecovery(new Error('Retained vector log changed'));
      }
      return result;
    }
    const valid = (Array.isArray(rows) ? rows : []).filter(isPendingVectorRow).sort((a, b) => a.q - b.q);
    for (const row of valid) {
      if (row.c === 1 || row.t === 1) continue;
      try {
        const decoded = base64ToFloat32(row.e!);
        if (Buffer.from(row.e!, 'base64').toString('base64') !== row.e || !decoded.length || (expectedDimensions > 0 && decoded.length !== expectedDimensions) || decoded.some(value => !Number.isFinite(value))) throw new Error('invalid vector');
      } catch {
        this.pendingLogUnknown = true;
        this.pauseRecovery(new Error('Pending vector log contains invalid embeddings'));
        return result;
      }
    }
    this.logSuppressed = true;
    try {
      for (const row of valid) {
        result.entries++;
        const key = row.c === 1 ? PENDING_CLEAR_KEY : row.id!;
        if ((this.pendingLog.get(key) ?? -Infinity) < row.q) this.pendingLog.set(key, row.q);
        if (this.pendingLog.get(key) === row.q) this.acknowledgedLog.set(key, row.q);
        if (row.q > this.seq) this.seq = row.q;
        if (row.c === 1) {
          vector.clear();
          result.cleared = true;
          continue;
        }
        const id = row.id!;
        if (row.t === 1) {
          if (vector.has(id)) {
            vector.remove(id);
            result.removed++;
          }
          continue;
        }
        let embedding: Float32Array;
        try {
          embedding = base64ToFloat32(row.e!);
        } catch {
          result.skipped++;
          continue;
        }
        if (embedding.length === 0 || (expectedDimensions > 0 && embedding.length !== expectedDimensions)) {
          result.skipped++;
          continue;
        }
        vector.add(id, typeof row.s === "string" ? row.s : "", embedding);
        result.added++;
      }
    } finally {
      this.logSuppressed = false;
    }
    if (result.skipped > 0) {
      try { await this.markBackfillSince(null); } catch (err) { this.pauseRecovery(err); }
    }
    if (result.added + result.removed > 0 || result.cleared) this.scheduleSave();
    return result;
  }

  async readBackfillMarker(): Promise<string | null | undefined> {
    if (!this.vector) return undefined;
    const marker = await this.kv.get<BackfillMarker>(KV.bm25Index, BACKFILL_MARKER_KEY);
    if (!marker) return undefined;
    if (marker.v === 2 && marker.since === null) return null;
    if ((marker.v === 1 || marker.v === 2) && typeof marker.since === "string" && Number.isFinite(Date.parse(marker.since))) return marker.since;
    throw new Error("Invalid persisted vector backfill marker");
  }

  markBackfillSince(since: string | null): Promise<void> {
    this.backfillRevision++;
    return this.queueBackfillChange(async () => {
      if (!this.vector || this.blockIfStorageHeld() || (since !== null && !Number.isFinite(Date.parse(since)))) return;
      const current = await this.readBackfillMarker();
      if (this.blockIfStorageHeld()) throw new Error('Storage hold prevents vector recovery');
      const next = earliestBackfillSince(current, this.backfillSince, since)!;
      if (current !== next) await this.kv.set<BackfillMarker>(KV.bm25Index, BACKFILL_MARKER_KEY, { v: 2, since: next });
      this.backfillSince = next;
    });
  }

  private queueBackfillChange(change: () => Promise<void>): Promise<void> {
    const run = this.backfillQueue.then(change);
    this.backfillQueue = run.catch(() => {});
    return run;
  }

  isRecoveryPaused(): boolean {
    return this.recoveryError !== null || !this.recoveryReady;
  }

  private pauseRecovery(error: unknown): void {
    this.recoveryReady = false;
    this.recoveryError = `Vector recovery paused until restart: ${errorMessage(error)}`;
    this.leg.lastError = this.recoveryError;
    this.leg.lastErrorAt = new Date(this.now()).toISOString();
    this.clearTimer();
    logger.warn(this.recoveryError);
  }

  private blockIfStorageHeld(): boolean {
    if (!this.isStorageHeld() && this.storageGeneration() === this.bootStorageGeneration) return false;
    this.storageBlocked = true;
    if (!this.recoveryError) this.pauseRecovery(new Error('Storage hold prevents vector recovery'));
    return true;
  }

  recoveryCutoff(): string | null | undefined { return this.backfillSince; }

  resumeStorageRecovery(expectedDimensions = 0, manualReconcile = false): Promise<boolean> {
    if (this.storageResume) return this.storageResume;
    this.storageRecovering = true;
    const work = this.resumeStorageRecoveryOnce(expectedDimensions,manualReconcile).finally(() => { this.storageRecovering = false; this.storageResume = null; });
    this.storageResume = work;
    return work;
  }

  private hasRetentionStore(): boolean {
    return this.kv.backend === 'file' && typeof this.kv.readVectorRetention === 'function';
  }

  private checkpointSelection(loaded: VectorLoadResult, rows: RecoveryUpsert[]): RecoverySelection {
    if (rows.length && (!loaded.vector || !loaded.checkpointMeta || loaded.vector.size !== loaded.expectedCount)) {
      throw Error('vector_recovery_checkpoint_incomplete');
    }
    const buckets = new Map<number, string[]>();
    for (const row of rows) {
      const entry = loaded.vector?.get(row.id), bucket = this.bucketOfId.get(row.id);
      if (bucket === undefined || !entry || entry.sessionId !== row.s || float32ToBase64(entry.embedding) !== row.e)
        throw Error('vector_recovery_checkpoint_mismatch');
      const ids = buckets.get(bucket) ?? [];
      ids.push(row.id);
      buckets.set(bucket, ids);
    }
    return {pendingRows: rows, meta: loaded.checkpointMeta ?? null, buckets: [...buckets].map(([bucket, ids]) => ({bucket, ids}))};
  }

  /** Revalidate existing WAL evidence for one explicitly selected capture, without creating receipts. */
  async verifyCaptureVectorPending(id: string, sessionId: string, pending: unknown): Promise<boolean> {
    if (!this.retentionReady || this.storageRecovering || this.storageBlocked || this.isRecoveryPaused()) return false;
    const row = this.retainedRows.get(id);
    if (!row) return pending == null;
    if (!this.vector || row.s !== sessionId || !isDeepStrictEqual(row, pending)) return false;
    const revision = this.kv.vectorCheckpointRevision;
    const current = () => !this.stopped && !this.isStorageHeld() && this.storageGeneration() === this.bootStorageGeneration &&
      !this.storageBlocked && !this.storageRecovering && !this.isRecoveryPaused() &&
      !this.pendingLog.size && !this.logChains.size && !this.vector?.pendingChanges;
    try {
      if (!current()) return false;
      const meta = await this.kv.get<VectorMeta>(KV.bm25Index, VECTOR_META_KEY);
      if (meta?.v !== 3) return false;
      const rows = [...this.retainedRows.values()];
      const selected = this.checkpointSelection({state: 'buckets', vector: this.vector, savedAt: meta.savedAt,
        checkpointMeta: meta, expectedCount: meta.count}, rows);
      await this.kv.reconcileVectorCheckpoint(selected, current, revision, false, true);
      return current();
    } catch { return false; }
  }

  async verifyRetainedVectorPublication(publication: VectorPublication): Promise<boolean> {
    const retained = this.retainedRows.get(publication.id), entry = publication.entry;
    if (this.kv.durability?.completion !== 'sdk' || !retained || !entry || !(entry.embedding instanceof Float32Array)) return false;
    const matches = () => {
      const loaded = this.vector?.get(publication.id);
      return entry.sessionId === retained.s && float32ToBase64(entry.embedding) === retained.e &&
        loaded?.sessionId === retained.s && float32ToBase64(loaded.embedding) === retained.e;
    };
    try {
      if (!matches()) return false;
      const pending = await this.kv.get(KV.vectorPendingLog, publication.id);
      return await this.verifyCaptureVectorPending(publication.id, entry.sessionId, pending) && matches();
    } catch { return false; }
  }

  private rememberRetained(rows: RecoveryUpsert[]): void {
    this.retainedRows = new Map(rows.map(row => [row.id, row]));
    for (const row of rows) this.seq = Math.max(this.seq, row.q);
    this.retentionReady = true;
  }

  private async requireEmptySdkPendingLog(): Promise<void> {
    const rows = await this.kv.list<unknown>(KV.vectorPendingLog);
    if (!Array.isArray(rows) || rows.length > 0 || this.pendingLog.size > 0 || this.logChains.size > 0) {
      throw new Error('Pending vector records require durable reconciliation before SDK recovery');
    }
  }

  private async resumeStorageRecoveryOnce(expectedDimensions: number, manualReconcile:boolean): Promise<boolean> {
    if (this.stopped || this.isStorageHeld()) return false;
    const generation = this.storageGeneration();
    const sdkRecovery = this.kv.durability?.completion === 'sdk' &&
      (this.storageBlocked || generation !== this.bootStorageGeneration);
    if (!sdkRecovery && !this.vector) return true;
    if (!sdkRecovery && !this.storageBlocked) return !this.isRecoveryPaused();
    try {
      let selected:RecoveryUpsert[] | undefined;
      const checkpointRevision=this.kv.vectorCheckpointRevision;
      const current=()=>!this.stopped && !this.isStorageHeld() && generation===this.storageGeneration() &&
        this.pendingLog.size===0 && this.logChains.size===0 && this.storageRecovering;
      if (sdkRecovery && manualReconcile) {
        if(!current())throw Error('vector_recovery_busy');
        selected=recoveryUpserts(await this.kv.list(KV.vectorPendingLog),expectedDimensions);
      } else if (sdkRecovery) await this.requireEmptySdkPendingLog();
      if (this.isStorageHeld() || generation !== this.storageGeneration()) throw new Error('Storage hold changed during vector recovery');
      this.bootStorageGeneration = generation;
      this.storageBlocked = false;
      this.recoveryError = null;
      if (!this.vector) {
        if(selected?.length)throw Error('vector_recovery_index_unavailable');
        if(selected)await this.kv.reconcileVectorCheckpoint({pendingRows:[],buckets:[],meta:null},current,checkpointRevision,true);
        return true;
      }
      const loaded = await this.load(Boolean(selected?.length), selected !== undefined);
      if (this.blockIfStorageHeld() || !loaded || loaded.state === 'unavailable') throw new Error('Persisted vector checkpoint is unavailable');
      if (loaded.vector && expectedDimensions > 0 && loaded.vector.validateDimensions(expectedDimensions).mismatches.length) throw new Error('Persisted vector dimensions mismatch');
      // SDK checkpoint reads may span minutes. Recheck before the first backfill write.
      if (sdkRecovery) {
        if (selected) {
          await this.kv.reconcileVectorCheckpoint(this.checkpointSelection(loaded, selected), current, checkpointRevision, true);
          if (!current()) throw Error('vector_recovery_epoch_changed');
          this.rememberRetained(selected);
        } else await this.requireEmptySdkPendingLog();
        this.pendingLogInspected = true;
        this.pendingLogUnknown = false;
      }
      await this.prepareBackfill(loaded);
      if (this.blockIfStorageHeld() || this.isRecoveryPaused()) { this.storageBlocked = true; return false; }
      if (loaded.vector && loaded.vector.size > 0) this.vector.restoreFrom(loaded.vector);
      if (!sdkRecovery) await this.replayPendingLog(expectedDimensions);
      if (this.blockIfStorageHeld() || this.isRecoveryPaused()) { this.storageBlocked = true; return false; }
      this.pendingLogError = null;
      this.leg.lastError = null; this.leg.lastErrorAt = null;
      return true;
    } catch (error) {
      this.storageBlocked = true;
      if (sdkRecovery || !this.recoveryError) this.pauseRecovery(error);
      return false;
    }
  }

  async prepareBackfill(loaded: VectorLoadResult | null, forceFull = false): Promise<string | null | undefined> {
    if (!this.vector || this.blockIfStorageHeld() || this.recoveryError) return undefined;
    if (!loaded || loaded.state === "unavailable") {
      this.pauseRecovery(new Error("Persisted vector checkpoint is unavailable"));
      return undefined;
    }
    const shortfall = loaded.expectedCount !== undefined && (loaded.vector?.size ?? 0) < loaded.expectedCount;
    const since = forceFull || loaded.state === "none" || shortfall || !Number.isFinite(Date.parse(loaded.savedAt ?? "")) ? null : loaded.savedAt;
    try {
      const fallback = loaded.backfillSince;
      if (fallback !== undefined && fallback !== null && (typeof fallback !== "string" || !Number.isFinite(Date.parse(fallback)))) {
        throw new Error("Invalid persisted vector recovery cutoff");
      }
      await this.markBackfillSince(earliestBackfillSince(since, fallback)!);
      if (this.blockIfStorageHeld() || this.recoveryError) return undefined;
      const marker = await this.readBackfillMarker();
      if (this.blockIfStorageHeld() || this.recoveryError) return undefined;
      this.recoveryReady = true;
      this.scheduleSave();
      return marker;
    } catch (err) {
      this.pauseRecovery(err);
      return undefined;
    }
  }

  async beginBackfill(): Promise<boolean> {
    if (this.isRecoveryPaused()) return false;
    try {
      await this.markBackfillSince(null);
      return true;
    } catch (err) {
      this.pauseRecovery(err);
      return false;
    }
  }

  private checkpointRecoveryCutoff(): string | null | undefined {
    return this.completingBackfill ? null : this.backfillSince;
  }

  private needsRecoveryCheckpoint(): boolean {
    const cutoff = this.checkpointRecoveryCutoff();
    return cutoff !== undefined && cutoff !== this.checkpointBackfillSince;
  }

  async completeBackfill(isCovered: () => boolean = () => true): Promise<boolean> {
    if (this.isRecoveryPaused()) return false;
    const revision = this.backfillRevision;
    const since = this.backfillSince;
    this.completingBackfill = since !== undefined;
    await this.save();
    if (this.leg.lastError || this.vector?.pendingChanges || !isCovered()) return false;
    let cleared = false;
    try {
      await this.queueBackfillChange(async () => {
        if (this.recoveryError || this.backfillRevision !== revision || !isCovered()) return;
        await this.kv.delete(KV.bm25Index, BACKFILL_MARKER_KEY);
        cleared = true;
      });
      if (!cleared) return false;
      if (this.backfillRevision !== revision || !isCovered()) {
        if (since !== undefined) await this.markBackfillSince(since);
        return false;
      }
      // The checkpoint retains the cutoff through the delete/crash window. A later
      // ordinary checkpoint can remove it once this recovery has completed.
      this.backfillSince = undefined;
      this.completingBackfill = false;
      return true;
    } catch (err) {
      this.pauseRecovery(err);
      return false;
    }
  }

  clearBackfillMarker(): Promise<void> {
    return this.queueBackfillChange(async () => {
      if (this.vector) await this.kv.delete(KV.bm25Index, BACKFILL_MARKER_KEY);
    });
  }

  async flushPendingLog(): Promise<void> {
    await Promise.all([...this.logChains.values()]);
  }

  private nextSeq(): number {
    this.seq = Math.max(this.seq + 1, this.now() * 1000);
    return this.seq;
  }

  private logChange(id: string | null, entry: VectorEntry | null): void {
    if (this.logSuppressed || this.blockIfStorageHeld() || !this.recoveryReady || this.recoveryError) return;
    const key = id ?? PENDING_CLEAR_KEY;
    const q = this.nextSeq();
    let row: PendingVectorRow;
    if (id === null) {
      row = { q, c: 1 };
    } else if (entry) {
      row = {
        q,
        id,
        s: entry.sessionId,
        k: id.startsWith(MEMORY_ID_PREFIX) ? "memory" : "observation",
        e: float32ToBase64(entry.embedding),
      };
    } else {
      row = { q, id, t: 1 };
    }
    this.pendingLog.set(key, q);
    this.acknowledgedLog.delete(key);
    this.enqueueLog(key, async () => {
      if (this.blockIfStorageHeld()) throw new Error('Storage hold prevents vector log write');
      await this.kv.set<PendingVectorRow>(KV.vectorPendingLog, key, row);
      if (this.pendingLog.get(key) === q) this.acknowledgedLog.set(key, q);
    }).then(
      () => {
        this.pendingLogError = null;
      },
      (err) => {
        this.pendingLogError = errorMessage(err);
        this.logFailure(err);
      },
    );
    this.maybeEarlySave();
  }

  private enqueueLog(key: string, op: () => Promise<void>): Promise<void> {
    const run = (this.logChains.get(key) ?? Promise.resolve()).then(op);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.logChains.set(key, tail);
    void tail.then(() => {
      if (this.logChains.get(key) === tail) this.logChains.delete(key);
    });
    return run;
  }

  private maybeEarlySave(): void {
    if (this.stopped || !this.recoveryReady || this.recoveryError || this.running || this.earlySaveQueued) return;
    if (this.pendingLog.size < PENDING_LOG_SAVE_THRESHOLD) return;
    if (this.now() - this.lastSaveAt < EARLY_SAVE_MIN_GAP_MS) return;
    this.earlySaveQueued = true;
    setTimeout(() => {
      this.earlySaveQueued = false;
      this.save().catch((err) => this.logFailure(err));
    }, 0);
  }

  private deletePendingKey(key: string, q: number | undefined): Promise<void> {
    return this.enqueueLog(key, async () => {
      if (this.retainedRows.has(key) || (key === PENDING_CLEAR_KEY && this.retainedRows.size)) throw Error('vector_retention_original_protected');
      if (this.pendingLog.get(key) !== q) return;
      if (this.blockIfStorageHeld()) throw new Error('Storage hold prevents vector log deletion');
      await this.kv.delete(KV.vectorPendingLog, key);
      if (this.pendingLog.get(key) === q) {
        this.pendingLog.delete(key);
        this.acknowledgedLog.delete(key);
      }
    });
  }

  private async clearCoveredPendingLog(coveredSeq: number): Promise<void> {
    const clearSeq = this.pendingLog.get(PENDING_CLEAR_KEY);
    if (clearSeq !== undefined ? clearSeq <= coveredSeq : this.pendingLogUnknown) {
      await this.deletePendingKey(PENDING_CLEAR_KEY, clearSeq);
    }
    const covered = [...this.pendingLog].filter(([key, q]) => key !== PENDING_CLEAR_KEY && q <= coveredSeq);
    const failures = await inBatches(covered, WRITE_CONCURRENCY, ([key, q]) => this.deletePendingKey(key, q));
    if (failures.length > 0) {
      throw new Error(`${failures.length} of ${covered.length} pending vector log deletes failed: ${errorMessage(failures[0])}`);
    }
    this.pendingLogUnknown = false;
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  async load(strictCheckpoint = false, operatorWillVerify = false): Promise<VectorLoadResult> {
    const unavailable: VectorLoadResult = {vector: null, state: 'unavailable', savedAt: null};
    if (this.blockIfStorageHeld()) return { vector: null, state: 'unavailable', savedAt: null };
    const revision = this.kv.vectorCheckpointRevision, generation = this.storageGeneration();
    let hasReceipts = false;
    if (this.hasRetentionStore()) {
      this.retentionReady = false;
      try { hasReceipts = (await this.kv.readVectorRetention()).length > 0; }
      catch (error) { this.storageBlocked = true; this.pauseRecovery(error); return unavailable; }
      this.retentionReady = !hasReceipts && !operatorWillVerify;
      strictCheckpoint ||= hasReceipts;
    }
    if (!this.vector) {
      if (hasReceipts) { this.storageBlocked = true; this.pauseRecovery(Error('vector_retention_index_unavailable')); return unavailable; }
      await this.finishLegacyCleanup();
      return { vector: null, state: "none", savedAt: null };
    }

    let meta: VectorMeta | null;
    try {
      meta = await this.kv.get<VectorMeta>(KV.bm25Index, VECTOR_META_KEY);
    } catch (err) {
      logger.warn("index persistence: vector metadata read failed", { message: errorMessage(err) });
      return { vector: null, state: "unavailable", savedAt: null };
    }

    if (this.blockIfStorageHeld()) return { vector: null, state: 'unavailable', savedAt: null };

    if (meta && meta.v === 3 && Number.isInteger(meta.bucketCount) && meta.bucketCount >= 0) {
      const loaded = await this.loadBuckets(meta.bucketCount,strictCheckpoint);
      if (this.blockIfStorageHeld()) return { vector: null, state: 'unavailable', savedAt: null };
      if (!loaded) return { vector: null, state: "unavailable", savedAt: null };
      this.hasVectorCheckpoint = loaded.size > 0;
      this.checkpointBackfillSince = meta.backfillSince;
      const replacementVerified = await this.removeLegacyVectorSnapshotIfPresent(loaded, meta);
      if (replacementVerified) await this.finishLegacyCleanup();
      const expectedCount = Number.isInteger(meta.count) ? meta.count : undefined;
      this.vectorCountShortfall =
        expectedCount !== undefined && loaded.size < expectedCount
          ? { expected: expectedCount, loaded: loaded.size }
          : null;
      if (this.vectorCountShortfall) {
        logger.warn("index persistence: loaded fewer vectors than the last save recorded", {
          ...this.vectorCountShortfall,
        });
      }
      const result: VectorLoadResult = { vector: loaded, state: replacementVerified ? "buckets" : "unavailable", savedAt: meta.savedAt ?? null,
        expectedCount, ...(strictCheckpoint ? {checkpointMeta:meta} : {}), backfillSince: meta.backfillSince };
      if (hasReceipts && !operatorWillVerify) {
        try {
          if (!replacementVerified) throw Error('vector_retention_checkpoint_unavailable');
          const raw = await this.kv.list<RecoveryUpsert>(KV.vectorPendingLog);
          const first = raw?.[0]?.id;
          const dimensions = typeof first === 'string' ? loaded.get(first)?.embedding.length ?? 0 : 0;
          const rows = recoveryUpserts(raw, dimensions);
          const current = () => !this.stopped && !this.isStorageHeld() && this.storageGeneration() === generation &&
            !this.pendingLog.size && !this.logChains.size;
          await this.kv.reconcileVectorCheckpoint(this.checkpointSelection(result, rows), current, revision, false);
          if (!current()) throw Error('vector_retention_epoch_changed');
          this.rememberRetained(rows);
        } catch (error) { this.storageBlocked = true; this.pauseRecovery(error); return unavailable; }
      }
      return result;
    }
    if (hasReceipts) { this.storageBlocked = true; this.pauseRecovery(Error('vector_retention_checkpoint_missing')); return unavailable; }

    return this.migrateLegacy();
  }

  private bucketCountInUse(): number {
    return this.hasOpenBucket ? this.highestBucket + 1 : 0;
  }

  private assignBucket(id: string): number {
    const existing = this.bucketOfId.get(id);
    if (existing !== undefined) { this.removedBuckets.delete(id); return existing; }
    const removed = this.removedBuckets.get(id);
    if (removed !== undefined) {
      this.removedBuckets.delete(id);
      this.bucketOfId.set(id, removed);
      this.bucketCounts.set(removed, (this.bucketCounts.get(removed) ?? 0) + 1);
      return removed;
    }
    if (!this.hasOpenBucket) {
      this.hasOpenBucket = true;
      this.highestBucket = 0;
    } else if ((this.bucketCounts.get(this.highestBucket) ?? 0) >= this.bucketSize) {
      this.highestBucket++;
    }
    this.bucketOfId.set(id, this.highestBucket);
    this.bucketCounts.set(this.highestBucket, (this.bucketCounts.get(this.highestBucket) ?? 0) + 1);
    return this.highestBucket;
  }

  private releaseBucket(id: string): void {
    const bucket = this.bucketOfId.get(id);
    if (bucket === undefined) return;
    this.bucketOfId.delete(id);
    const remaining = (this.bucketCounts.get(bucket) ?? 1) - 1;
    if (remaining > 0) this.bucketCounts.set(bucket, remaining);
    else this.bucketCounts.delete(bucket);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextSaveAt = null;
  }

  private queueSave(): void {
    if (this.stopped || !this.recoveryReady || this.recoveryError || this.timer || !this.vector?.pendingChanges) return;
    const now = this.now();
    const remaining = Math.max(0, this.lastSaveAt + this.saveIntervalMs - now);
    const delay = !this.hasVectorCheckpoint && !this.firstVectorSaveAttempted
      ? Math.min(FIRST_CHECKPOINT_DELAY_MS, remaining)
      : remaining;
    this.nextSaveAt = now + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextSaveAt = null;
      this.save().catch((err) => this.logFailure(err));
    }, delay);
  }

  private startRun(): Promise<void> {
    const run = this.runSave().finally(() => {
      if (this.running === run) this.running = null;
      if (!this.queued) this.queueSave();
    });
    this.running = run;
    return run;
  }

  private async runSave(): Promise<void> {
    const vector = this.vector;
    if (!vector || !this.retentionReady || this.blockIfStorageHeld() || this.isRecoveryPaused()) return;
    if (!vector.pendingChanges && !this.needsRecoveryCheckpoint()) return;
    const hasVectorChanges = vector.pendingChanges > 0;
    const epoch = this.dirtyEpoch;
    this.markedDuringRunAt = null;
    if (hasVectorChanges) {
      this.lastSaveAt = this.now();
      this.firstVectorSaveAttempted = true;
    }
    const coveredSeq = this.seq;
    try {
      await this.writeChanges(vector);
      if (this.blockIfStorageHeld()) return;
      await this.clearCoveredPendingLog(coveredSeq).catch((err) => {
        this.pendingLogError = errorMessage(err);
        this.logFailure(err);
      });
      this.leg.lastSavedAt = new Date(this.now()).toISOString();
      this.leg.lastError = null;
      this.leg.lastErrorAt = null;
      if (this.dirtyEpoch === epoch || vector.pendingChanges === 0) {
        this.leg.dirtySince = null;
      } else if (this.markedDuringRunAt !== null) {
        this.leg.dirtySince = new Date(this.markedDuringRunAt).toISOString();
      }
    } catch (err) {
      this.leg.lastError = errorMessage(err);
      this.leg.lastErrorAt = new Date(this.now()).toISOString();
      if (this.leg.dirtySince === null) this.leg.dirtySince = this.leg.lastErrorAt;
      if (hasVectorChanges) this.lastSaveAt = this.now();
      this.clearTimer();
      this.logFailure(err);
    }
  }

  private async writeChanges(vector: VectorIndex): Promise<void> {
    const changes = vector.takeChanges();
    if (changes.size === 0 && !this.needsRecoveryCheckpoint()) return;
    const keys: Array<{ scope: string; key: string }> = [{ scope: KV.bm25Index, key: VECTOR_META_KEY }];
    const failed = new Map<string, boolean>();
    const failures = await inBatches([...changes], WRITE_CONCURRENCY, async ([id, present]) => {
      const entry = present ? vector.get(id) : undefined;
      try {
        if (entry) {
          const bucket = this.assignBucket(id);
          await this.kv.set<PersistedVector>(vectorBucketScope(bucket), id, {
            id,
            s: entry.sessionId,
            e: float32ToBase64(entry.embedding),
          });
          keys.push({ scope: vectorBucketScope(bucket), key: id });
        } else {
          const bucket = this.bucketOfId.get(id) ?? this.removedBuckets.get(id);
          if (bucket !== undefined) {
            this.removedBuckets.set(id, bucket);
            await this.kv.delete(vectorBucketScope(bucket), id);
            keys.push({ scope: vectorBucketScope(bucket), key: id });
            this.releaseBucket(id);
          }
        }
      } catch (err) {
        failed.set(id, present);
        throw err;
      }
    });
    if (failures.length > 0) {
      vector.returnChanges(failed);
      throw new Error(
        `${failures.length} of ${changes.size} vector writes failed: ${errorMessage(failures[0])}`,
      );
    }
    const backfillSince = this.checkpointRecoveryCutoff();
    try {
      await this.kv.set<VectorMeta>(KV.bm25Index, VECTOR_META_KEY, {
        v: 3,
        bucketCount: this.bucketCountInUse(),
        savedAt: new Date(this.now()).toISOString(),
        count: [...this.bucketCounts.values()].reduce((total, count) => total + count, 0),
        ...(backfillSince !== undefined ? { backfillSince } : {}),
      });
      await this.waitForVectorPublication(keys);
      this.checkpointBackfillSince = backfillSince;
    } catch (err) {
      vector.returnChanges(changes);
      throw err;
    }
    for (const [id, present] of changes) if (!present) this.removedBuckets.delete(id);
    this.hasVectorCheckpoint = this.bucketOfId.size > 0;
    if (!this.hasVectorCheckpoint) this.firstVectorSaveAttempted = false;
  }

  private async loadBuckets(bucketCount: number, strictCheckpoint = false): Promise<VectorIndex | null> {
    const loaded = new VectorIndex();
    const bucketOfId = new Map<string, number>();
    const bucketCounts = new Map<number, number>();
    const bucketIds = Array.from({ length: bucketCount }, (_, bucket) => bucket);
    // SDK bucket lists share the worker connection. Stop issuing reads once the checkpoint is unavailable.
    const sdkReads = this.kv.durability?.completion === "sdk";
    const failures = await inBatches(bucketIds, sdkReads ? 1 : LOAD_CONCURRENCY, async (bucket) => {
      const rows = await this.kv.list<unknown>(vectorBucketScope(bucket));
      let count = 0;
      for (const row of rows) {
        if (!isPersistedVector(row)) {
          if(strictCheckpoint)throw Error('vector_recovery_bucket_invalid');
          continue;
        }
        if(strictCheckpoint && bucketOfId.has(row.id))throw Error('vector_recovery_duplicate_id');
        try {
          loaded.loadPersisted(row.id, row.s, base64ToFloat32(row.e));
        } catch {
          if(strictCheckpoint)throw Error('vector_recovery_bucket_invalid');
          continue;
        }
        bucketOfId.set(row.id, bucket);
        count++;
      }
      if (count > 0) bucketCounts.set(bucket, count);
    }, sdkReads);
    if (failures.length > 0) {
      logger.warn("index persistence: vector bucket read failed", {
        failed: failures.length,
        message: errorMessage(failures[0]),
      });
      return null;
    }
    this.bucketOfId = bucketOfId;
    this.bucketCounts = bucketCounts;
    this.highestBucket = bucketCount > 0 ? bucketCount - 1 : 0;
    this.hasOpenBucket = bucketCount > 0;
    return loaded;
  }

  private async waitForVectorPublication(keys: Array<{ scope: string; key: string }>): Promise<void> {
    const durability = this.kv.durability;
    if (!durability) return;
    const dataKeys = keys.filter(({ scope, key }) => scope !== KV.bm25Index || key !== VECTOR_META_KEY);
    // Each fence has a bounded SDK capture budget; certify metadata after verifying data.
    for (let offset = 0; offset < dataKeys.length; offset += DISK_FENCE_BATCH_KEYS) {
      await durability.waitForKeys(this.kv, dataKeys.slice(offset, offset + DISK_FENCE_BATCH_KEYS));
    }
    await durability.waitForKeys(this.kv, [{ scope: KV.bm25Index, key: VECTOR_META_KEY }]);
  }

  private async migrateLegacy(): Promise<VectorLoadResult> {
    const manifest = await this.readIndexValue<IndexShardManifest>(
      KV.bm25Index,
      LEGACY_VECTOR_MANIFEST_KEY,
      "vector",
      "manifest",
    );
    const legacyKey = await this.readIndexValue<string>(KV.bm25Index, LEGACY_VECTOR_KEY, "vector", "legacy");
    if (!manifest.ok || !legacyKey.ok) return { vector: null, state: "unavailable", savedAt: null };
    const legacyPresent = manifest.value != null || (typeof legacyKey.value === "string" && legacyKey.value.length > 0);
    if (!legacyPresent) {
      await this.finishLegacyCleanup();
      return { vector: null, state: "none", savedAt: null };
    }

    const data = await this.loadShardedData(LEGACY_VECTOR_KEY, LEGACY_VECTOR_MANIFEST_KEY, "vector");
    if (typeof data !== "string") {
      logger.warn("index persistence: legacy vector snapshot is unreadable; keeping it and skipping migration");
      return { vector: null, state: "unavailable", savedAt: null };
    }
    const legacy = VectorIndex.deserialize(data);
    const savedAt =
      (manifest.value && typeof manifest.value === "object" ? generationTime(manifest.value.generation) : null) ??
      new Date(this.now()).toISOString();

    if(this.kv.durability?.completion==='sdk')return {vector:legacy,state:'unavailable',savedAt};

    const staging = new VectorIndex();
    for (const [id, entry] of legacy.entries()) staging.add(id, entry.sessionId, entry.embedding);
    try {
      await this.markBackfillSince(savedAt);
      await this.writeChanges(staging);
      const meta = await this.kv.get<VectorMeta>(KV.bm25Index, VECTOR_META_KEY);
      if (!meta) throw new Error("vector_migration_metadata_missing");
      await this.verifyVectorReplacement(legacy, meta);
    } catch (err) {
      logger.warn("index persistence: migrating the legacy vector snapshot failed; it stays in place and the next save retries", {
        message: errorMessage(err),
      });
      legacy.markAllChanged();
      return { vector: legacy, state: "unavailable", savedAt };
    }

    await this.removeLegacyVectorSnapshot(manifest.value);
    await this.finishLegacyCleanup();
    await this.auditIndexPersistence("migrate", [statePath(KV.bm25Index, VECTOR_META_KEY)], {
      vectors: legacy.size,
      buckets: this.bucketCountInUse(),
    });
    logger.info("index persistence: migrated the vector index to bucketed storage", {
      vectors: legacy.size,
      buckets: this.bucketCountInUse(),
    });
    const migrated = new VectorIndex();
    for (const [id, entry] of legacy.entries()) migrated.loadPersisted(id, entry.sessionId, entry.embedding);
    return { vector: migrated, state: "migrated", savedAt };
  }

  private async removeLegacyVectorSnapshot(manifest: IndexShardManifest | null): Promise<void> {
    if(this.kv.durability?.completion==='sdk')return;
    if (manifest && Array.isArray(manifest.shards)) {
      await this.deleteShards(manifest.shards.filter(isValidShardDescriptor), "legacy_vector_cleanup");
    }
    await this.deleteKey(KV.bm25Index, LEGACY_VECTOR_MANIFEST_KEY, "legacy_vector_cleanup");
    await this.deleteKey(KV.bm25Index, LEGACY_VECTOR_KEY, "legacy_vector_cleanup");
  }

  private async verifyVectorReplacement(legacy: VectorIndex, meta: VectorMeta): Promise<void> {
    if(this.kv.durability?.completion==='sdk')throw new Error('SDK_COMPLETION_ONLY');
    if (meta.count < legacy.size) throw new Error("vector_migration_count_mismatch");
    const keys: Array<{ scope: string; key: string }> = [{ scope: KV.bm25Index, key: VECTOR_META_KEY }];
    if (!isDeepStrictEqual(await this.kv.get(KV.bm25Index, VECTOR_META_KEY), meta)) throw new Error("vector_migration_metadata_mismatch");
    const loaded = await this.loadBuckets(meta.bucketCount);
    if (!loaded || loaded.size !== meta.count) throw new Error("vector_migration_bucket_count_mismatch");
    for (const [id, entry] of legacy.entries()) {
      const actual = loaded.get(id);
      if (!actual || actual.sessionId !== entry.sessionId || !isDeepStrictEqual(actual.embedding, entry.embedding)) throw new Error("vector_migration_readback_mismatch");
    }
    for (const [id] of loaded.entries()) keys.push({ scope: vectorBucketScope(this.bucketOfId.get(id)!), key: id });
    if (this.kv.backend === "file" && !this.kv.durability) throw new Error("vector_disk_fence_unavailable");
    await this.waitForVectorPublication(keys);
    const verified = await this.loadBuckets(meta.bucketCount);
    if (!verified || verified.size !== loaded.size) throw new Error("vector_migration_bucket_count_mismatch");
    for (const [id, entry] of loaded.entries()) {
      const actual = verified.get(id);
      if (!actual || actual.sessionId !== entry.sessionId || !isDeepStrictEqual(actual.embedding, entry.embedding)) throw new Error("vector_migration_readback_mismatch");
    }
    if (!isDeepStrictEqual(await this.kv.get(KV.bm25Index, VECTOR_META_KEY), meta)) throw new Error("vector_migration_metadata_mismatch");
  }

  private async removeLegacyVectorSnapshotIfPresent(loaded: VectorIndex, meta: VectorMeta): Promise<boolean> {
    const manifest = await this.readIndexValue<IndexShardManifest>(KV.bm25Index, LEGACY_VECTOR_MANIFEST_KEY, "vector", "manifest");
    const legacy = await this.readIndexValue<string>(KV.bm25Index, LEGACY_VECTOR_KEY, "vector", "legacy");
    if (!manifest.ok || !legacy.ok) return false;
    if (manifest.value == null && legacy.value == null) return true;
    let source: VectorIndex | null = null;
    try {
      const data = await this.loadShardedData(LEGACY_VECTOR_KEY, LEGACY_VECTOR_MANIFEST_KEY, "vector");
      if (typeof data !== "string") throw new Error("vector_migration_legacy_unreadable");
      source = VectorIndex.deserialize(data);
      if (loaded.size < source.size) throw new Error("vector_migration_count_mismatch");
      await this.verifyVectorReplacement(source, meta);
    } catch (err) {
      logger.warn("index persistence: kept legacy vector snapshot because replacement durability was not verified", { message: errorMessage(err) });
      if (source) {
        // Preserve newer bucket values while restoring the missing legacy vectors for retry.
        for (const [id, entry] of source.entries()) {
          if (!loaded.has(id)) loaded.loadPersisted(id, entry.sessionId, entry.embedding);
        }
        if(this.kv.durability?.completion!=='sdk')loaded.markAllChanged();
      }
      return false;
    }
    await this.removeLegacyVectorSnapshot(manifest.value ?? null);
    return true;
  }

  private async removeLegacyBm25Snapshot(): Promise<void> {
    if(this.kv.durability?.completion==='sdk')return;
    const manifestRead = await this.readIndexValue<IndexShardManifest>(KV.bm25Index, LEGACY_BM25_MANIFEST_KEY, "bm25", "manifest");
    const legacyRead = await this.readIndexValue<string>(KV.bm25Index, LEGACY_BM25_KEY, "bm25", "legacy");
    if (!manifestRead.ok || !legacyRead.ok) return;
    const manifest = manifestRead.value ?? null;
    const legacy = legacyRead.value ?? null;
    if (manifest == null && legacy == null) return;
    if (manifest && Array.isArray(manifest.shards)) {
      await this.deleteShards(manifest.shards.filter(isValidShardDescriptor), "legacy_bm25_cleanup");
    }
    if (manifest != null) await this.deleteKey(KV.bm25Index, LEGACY_BM25_MANIFEST_KEY, "legacy_bm25_cleanup");
    if (legacy != null) await this.deleteKey(KV.bm25Index, LEGACY_BM25_KEY, "legacy_bm25_cleanup");
  }

  private async finishLegacyCleanup(): Promise<void> {
    await this.removeLegacyBm25Snapshot();
    await this.sweepOrphanedGenerations();
  }

  private async sweepOrphanedGenerations(): Promise<void> {
    if(this.kv.durability?.completion==='sdk')return;
    try {
      if ((await this.kv.get(KV.bm25Index, ORPHAN_SWEEP_KEY)) != null) return;
      const candidates = new Map<string, string>();
      for (const scope of await this.kv.listGroups()) {
        const generation = legacyShardGeneration(scope);
        if (generation === undefined) continue;
        if (generation === null) {
          logger.warn("index persistence: orphan sweep skipped, unrecognized legacy shard scope", { scope });
          return;
        }
        candidates.set(scope, generation);
      }
      const named = await this.namedLegacyGenerations();
      if (!named) return;
      const orphans = [...candidates].filter(([, generation]) => !named.has(generation));
      const failures = await inBatches(orphans, WRITE_CONCURRENCY, async ([scope]) => {
        if (!(await this.deleteKey(scope, LEGACY_SHARD_KEY, "orphan_generation_sweep"))) throw new Error(scope);
      });
      const summary = {
        generations: new Set(orphans.map(([, generation]) => generation)).size,
        shards: orphans.length,
        failed: failures.length,
      };
      if (failures.length > 0) {
        logger.warn("index persistence: orphan sweep left shards behind; the next boot retries", summary);
        return;
      }
      if (candidates.size > orphans.length) {
        if (orphans.length > 0) logger.info("index persistence: swept orphaned legacy index generations", summary);
        return;
      }
      await this.kv.set(KV.bm25Index, ORPHAN_SWEEP_KEY, { v: 1, at: new Date(this.now()).toISOString(), ...summary });
      await this.auditIndexPersistence("sweep", [statePath(KV.bm25Index, ORPHAN_SWEEP_KEY)], summary);
      logger.info("index persistence: swept orphaned legacy index generations", summary);
    } catch (err) {
      logger.warn("index persistence: orphan sweep failed; the next boot retries", { message: errorMessage(err) });
    }
  }

  private async namedLegacyGenerations(): Promise<Set<string> | null> {
    const named = new Set<string>();
    for (const [key, label] of [[LEGACY_BM25_MANIFEST_KEY, "bm25"], [LEGACY_VECTOR_MANIFEST_KEY, "vector"]] as const) {
      const read = await this.readIndexValue<IndexShardManifest>(KV.bm25Index, key, label, "manifest");
      if (!read.ok) return null;
      const manifest = read.value;
      if (manifest == null) continue;
      const generations = typeof manifest === "object" && Array.isArray(manifest.shards)
        ? manifest.shards
            .filter((shard) => typeof shard?.scope === "string" && shard.scope.length > 0)
            .map((shard) => legacyShardGeneration(shard.scope))
        : [];
      if (typeof manifest === "object" && typeof manifest.generation === "string") generations.push(manifest.generation);
      const usable = generations.filter((generation): generation is string => !!generation);
      for (const generation of usable) named.add(generation);
      if (usable.length === 0) {
        logger.warn("index persistence: orphan sweep skipped, a legacy manifest names no generation", { key });
        return null;
      }
    }
    return named;
  }

  private logFailure(err: unknown): void {
    const now = this.now();
    if (now - this.lastFailureLogAt < FAILURE_LOG_THROTTLE_MS) return;
    this.lastFailureLogAt = now;
    const code = (err as { code?: string })?.code;
    logger.warn("index persistence: failed to save the vector index", {
      code,
      message: errorMessage(err),
      hint:
        code === "TIMEOUT"
          ? "iii-engine state::set timed out; unsaved vectors stay in memory and retry on the next save"
          : undefined,
    });
  }

  private async auditIndexPersistence(
    action: string,
    targetIds: string[],
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!auditIndexPersistEnabled()) return;
    await safeAudit(this.kv, "index_persist", INDEX_PERSISTENCE_FUNCTION_ID, targetIds, {
      action,
      ...details,
    });
  }

  private async deleteKey(scope: string, key: string, reason: string): Promise<boolean> {
    let result = "deleted";
    let error: string | undefined;
    try {
      await this.kv.delete(scope, key);
    } catch (err) {
      result = "failed";
      error = errorMessage(err);
    }
    await this.auditIndexPersistence("delete", [statePath(scope, key)], {
      scope,
      key,
      reason,
      result,
      error,
    });
    return error === undefined;
  }

  private async deleteShards(shards: IndexShardManifest["shards"], reason: string): Promise<void> {
    await inBatches(shards, WRITE_CONCURRENCY, async (shard) => {
      await this.deleteKey(shard.scope, shard.key, reason);
    });
  }

  private async loadShardedData(legacyKey: string, manifestKey: string, label: string): Promise<string | null> {
    const manifest = await this.readIndexValue<IndexShardManifest>(KV.bm25Index, manifestKey, label, "manifest");
    if (!manifest.ok) return null;
    if (manifest.value != null && typeof manifest.value === "object") {
      return this.loadManifestData(manifest.value, label);
    }
    const legacy = await this.readIndexValue<string>(KV.bm25Index, legacyKey, label, "legacy");
    if (!legacy.ok) return null;
    if (legacy.value && typeof legacy.value === "string") return legacy.value;
    return null;
  }

  private async readIndexValue<T>(
    scope: string,
    key: string,
    label: string,
    source: "manifest" | "legacy",
  ): Promise<{ ok: true; value: T | null } | { ok: false }> {
    try {
      return { ok: true, value: await this.kv.get<T>(scope, key) };
    } catch (err) {
      logger.warn(`index persistence: ${label} ${source} read failed`, {
        scope,
        key,
        message: errorMessage(err),
      });
      return { ok: false };
    }
  }

  private async loadManifestData(manifest: IndexShardManifest, label: string): Promise<string | null> {
    if (
      manifest.v !== 1 ||
      !Array.isArray(manifest.shards) ||
      manifest.shards.length === 0 ||
      !Number.isInteger(manifest.chars) ||
      manifest.chars < 0
    ) {
      logger.warn(`index persistence: ${label} shard manifest invalid`);
      return null;
    }
    for (const shard of manifest.shards) {
      if (!isValidShardDescriptor(shard)) {
        logger.warn(`index persistence: ${label} shard manifest invalid`);
        return null;
      }
    }
    const loadedShards = await Promise.all(
      manifest.shards.map(async (shard) => ({
        shard,
        chunk: await this.kv.get<string>(shard.scope, shard.key).catch(() => null),
      })),
    );
    const chunks: string[] = [];
    let chars = 0;
    for (const { shard, chunk } of loadedShards) {
      if (typeof chunk !== "string") {
        logger.warn(`index persistence: ${label} shard missing`, { scope: shard.scope, key: shard.key });
        return null;
      }
      if (chunk.length !== shard.chars) {
        logger.warn(`index persistence: ${label} shard length mismatch`, {
          scope: shard.scope,
          key: shard.key,
          expected: shard.chars,
          actual: chunk.length,
        });
        return null;
      }
      chunks.push(chunk);
      chars += chunk.length;
    }
    if (chars !== manifest.chars) {
      logger.warn(`index persistence: ${label} total length mismatch`, { expected: manifest.chars, actual: chars });
      return null;
    }
    return chunks.join("");
  }
}
