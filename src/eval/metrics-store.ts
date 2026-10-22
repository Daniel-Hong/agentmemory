import type { FunctionMetrics } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { KV } from "../state/schema.js";

const RECENT_BUCKET_MS = 60_000;
const RECENT_BUCKETS = 15;
const RECENT_FUNCTIONS = 512;
type AttemptBucket = { minute: number; attempts: number; failures: number };

function recentClock(): number | undefined {
  try {
    const now = Date.now();
    return Number.isFinite(now) && Math.abs(now) <= 8.64e15 ? now : undefined;
  } catch { return undefined; }
}

export class MetricsStore {
  private cache = new Map<string, FunctionMetrics>();
  private observedSince = recentClock();
  private latestObservationAt = this.observedSince;
  private recent = new Map<string, AttemptBucket[]>();

  constructor(private kv: StateKV) {}

  private observationTime(): number | undefined {
    const now = recentClock();
    if (now === undefined || this.observedSince === undefined) {
      this.observedSince = undefined;
      return undefined;
    }
    this.latestObservationAt = Math.max(this.latestObservationAt ?? this.observedSince, now);
    return this.latestObservationAt;
  }

  private recentBuckets(functionId: string, now: number, create = true): AttemptBucket[] | undefined {
    let buckets = this.recent.get(functionId);
    if (!buckets) {
      if (this.recent.size >= RECENT_FUNCTIONS) return undefined;
      buckets = [];
      if (create) this.recent.set(functionId, buckets);
    }
    const earliest = Math.floor(now / RECENT_BUCKET_MS) - RECENT_BUCKETS + 1;
    while (buckets.length && buckets[0]!.minute < earliest) buckets.shift();
    return buckets;
  }

  private recentSnapshot(functionId: string, now: number | undefined): FunctionMetrics['recent'] {
    if (now === undefined || this.observedSince === undefined) return undefined;
    try {
    const buckets = this.recentBuckets(functionId, now, false);
    if (!buckets) return undefined;
    const start = Math.max(this.observedSince, (Math.floor(now / RECENT_BUCKET_MS) - RECENT_BUCKETS + 1) * RECENT_BUCKET_MS);
    return {
      observedSince: new Date(this.observedSince).toISOString(),
      windowStartAt: new Date(start).toISOString(),
      windowEndAt: new Date(now).toISOString(),
      windowMs: now - start,
      attemptCount: buckets.reduce((sum, bucket) => sum + bucket.attempts, 0),
      failureCount: buckets.reduce((sum, bucket) => sum + bucket.failures, 0),
    };
    } catch {
      this.observedSince = undefined;
      return undefined;
    }
  }

  async record(
    functionId: string,
    latencyMs: number,
    success: boolean,
    qualityScore?: number,
  ): Promise<void> {
    const now = this.observationTime(), buckets = now === undefined ? undefined : this.recentBuckets(functionId, now);
    if (buckets && now !== undefined) {
      const minute = Math.floor(now / RECENT_BUCKET_MS);
      let bucket = buckets.at(-1);
      if (!bucket || bucket.minute !== minute) {
        bucket = { minute, attempts: 0, failures: 0 };
        buckets.push(bucket);
      }
      bucket.attempts++;
      if (!success) bucket.failures++;
    }
    return withKeyedLock(`metrics:${functionId}`, async () => {
    let m = this.cache.get(functionId);
    if (!m) {
      m = (await this.kv.get<FunctionMetrics>(KV.metrics, functionId)) ?? {
        functionId,
        totalCalls: 0,
        successCount: 0,
        failureCount: 0,
        avgLatencyMs: 0,
        avgQualityScore: 0,
      };
    }

    m=structuredClone(m);
    const prev = m.totalCalls;
    m.totalCalls += 1;
    m.avgLatencyMs = (m.avgLatencyMs * prev + latencyMs) / m.totalCalls;
    if (success) {
      m.successCount += 1;
    } else {
      m.failureCount += 1;
    }
    if (typeof qualityScore === 'number' && Number.isFinite(qualityScore)) {
      if (!Number.isSafeInteger(m.qualitySampleCount) || (m.qualitySampleCount ?? -1) < 0) {
        if (prev > 0 && m.legacyAvgQualityScore === undefined) m.legacyAvgQualityScore = m.avgQualityScore;
        m.qualitySampleCount = 0; m.qualityEpochAt = Date.now();
      }
      const count = m.qualitySampleCount!;
      m.avgQualityScore = count > 0 ? (m.avgQualityScore * count + qualityScore) / (count + 1) : qualityScore;
      m.qualitySampleCount = count + 1;
    }

    await this.kv.set(KV.metrics, functionId, m);
    this.cache.set(functionId, m);
    });
  }

  async get(functionId: string): Promise<FunctionMetrics | null> {
    const metric = (
      this.cache.get(functionId) ??
      (await this.kv.get<FunctionMetrics>(KV.metrics, functionId))
    );
    return metric ? { ...metric, recent: this.recentSnapshot(functionId, this.observationTime()) } : null;
  }

  async getAll(): Promise<FunctionMetrics[]> {
    const kvMetrics = await this.kv
      .list<FunctionMetrics>(KV.metrics)
      .catch(() => []);
    const merged = new Map<string, FunctionMetrics>();
    for (const m of kvMetrics) merged.set(m.functionId, m);
    for (const [id, m] of this.cache) merged.set(id, m);
    const now = this.observationTime();
    return Array.from(merged.values(), metric => ({ ...metric, recent: this.recentSnapshot(metric.functionId, now) }));
  }
}
