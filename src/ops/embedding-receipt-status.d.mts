export type EmbeddingReceiptStatus = 'pending' | 'committed_metadata' | 'publication_verified_observed' | 'projection_mismatch' | 'index_missing' | 'index_pending' | 'canonical_missing' | 'not_found' | 'unavailable';
export interface EmbeddingReceiptEvidence {
 id: string;
 status: EmbeddingReceiptStatus;
 retryPhase: 'queued' | 'embedded' | 'unknown' | null;
 attempts: number | null;
 retryAt: number | null;
 committedAt: string | null;
 diskVerified: false;
 completionConfirmed: false;
 durablePublicationObserved: boolean;
 verifiedAt: string | null;
 evidenceScope: 'metadata_only' | 'this_process_observation';
}
export interface EmbeddingReceiptQueryResult { version: 1; evidence: 'metadata_only'; items: EmbeddingReceiptEvidence[]; }
export function createEmbeddingReceiptStatus(options: {
 kv: {
   get(scope: string, key: string): Promise<unknown>;
   observationReader?: {tracksMutations(scope: string): boolean; mutationRevision(scope: string): number; pendingMutations(scope: string): number} | null;
 };
 KV: {memories: string; observations(sessionId: string): string; vectorPendingLog: string};
 index?: {has(id: string): boolean} | null;
 observedPublication?: (id: string) => {verifiedAt: number | string; fingerprint: string} | null | undefined;
 timeoutMs?: number;
}): (input: {ids: string[]}) => Promise<EmbeddingReceiptQueryResult>;
