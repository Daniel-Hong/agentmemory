import type { IIIClient } from "iii-sdk";
import type { MemoryProvider } from "../types.js";
import type { StateKV } from "../state/kv.js";
import type { MetricsStore } from "../eval/metrics-store.js";

export interface SummaryWorker {
  pump(): Promise<{ progressed: boolean; more?: boolean }>;
  stop(): Promise<void>;
  drain(): Promise<void>;
  snapshot(): { stopped: boolean; running: number };
}

export function registerLongSessionSummarizer(
  sdk: IIIClient,
  kv: StateKV,
  provider: MemoryProvider,
  metricsStore: MetricsStore | undefined,
  deps: {
    KV: typeof import("../state/schema.js").KV;
    withKeyedLock: typeof import("../state/keyed-mutex.js").withKeyedLock;
    logger: typeof import("../logger.js").logger;
    safeAudit: typeof import("../functions/audit.js").safeAudit;
    scrubRecord: typeof import("../functions/privacy.js").scrubRecord;
    schedule?: boolean;
    onWorker?: (handle: SummaryWorker) => void;
  },
): SummaryWorker;

export function closeLongSessionInferenceAdmission(): void;

export const INCREMENTAL_SUMMARY_SYSTEM: string;
export const INCREMENTAL_SUMMARY_FORMAT: Record<string, unknown>;
