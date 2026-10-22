import type { StateKV } from "../state/kv.js";
import type { EmbeddingIntent, EmbeddingProvider } from "../types.js";
import type { VectorIndex } from "../state/vector-index.js";
import type { VectorPublication } from "../state/index-persistence.js";
import type { OllamaReadiness } from "./provider-readiness.mjs";
export const EMBEDDING_RETRY_NAMESPACE: "mem:embedding-retry:v1";
export const EMBEDDING_COMMITTED_NAMESPACE: "mem:embedding-committed:v1";
export interface EmbeddingRecovery {
 add(item: EmbeddingIntent): Promise<boolean>;
 enqueue(item: EmbeddingIntent): Promise<boolean>;
 prepareEnqueue(item: EmbeddingIntent): Promise<() => Promise<boolean>>;
 enqueueBatch(items: EmbeddingIntent[]): Promise<void>;
 initialize(): Promise<void>;
 pump(): Promise<void>;
 reconcile(): Promise<void>;
 start(): void;
 stop(): void;
 drain(): Promise<void>;
 observedPublication(id:string): {verifiedAt:number;fingerprint:string}|null;
 defer(item: EmbeddingIntent, error: unknown, attempted?: boolean): Promise<unknown>;
 snapshot(): {pendingCount: number; completedCount: number; counterEpoch: string; initialized: boolean; lastError: string | null; lastSuccessAt: string | null; publicationEvidence?: {scope: "this_process_observation"; limit: number; retained: number; observed: number; evicted: number; available: boolean; unavailable: number}};
}
export function registerEmbeddingRecovery(options: {
 kv: StateKV; KV: typeof import("../state/schema.js").KV;
 index: VectorIndex; provider: EmbeddingProvider; readiness?: OllamaReadiness | null;
 withKeyedLock?: typeof import("../state/keyed-mutex.js").withKeyedLock;
 logger?: Pick<typeof import("../logger.js").logger, "warn">;
 clock?: () => number; schedule?: boolean; onIndexChanged?: () => void;
 persistIndex?: (publication?: VectorPublication) => Promise<void>;
}): EmbeddingRecovery;
