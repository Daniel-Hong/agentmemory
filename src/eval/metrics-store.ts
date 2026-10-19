import type { FunctionMetrics } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { KV } from "../state/schema.js";

export class MetricsStore {
  private cache = new Map<string, FunctionMetrics>();

  constructor(private kv: StateKV) {}

  async record(
    functionId: string,
    latencyMs: number,
    success: boolean,
    qualityScore?: number,
  ): Promise<void> {
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
    return (
      this.cache.get(functionId) ??
      (await this.kv.get<FunctionMetrics>(KV.metrics, functionId))
    );
  }

  async getAll(): Promise<FunctionMetrics[]> {
    const kvMetrics = await this.kv
      .list<FunctionMetrics>(KV.metrics)
      .catch(() => []);
    const merged = new Map<string, FunctionMetrics>();
    for (const m of kvMetrics) merged.set(m.functionId, m);
    for (const [id, m] of this.cache) merged.set(id, m);
    return Array.from(merged.values());
  }
}
