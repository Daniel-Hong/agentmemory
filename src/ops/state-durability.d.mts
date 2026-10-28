export type DirtyKey = { scope: string; key: string; revision?: number; lastTouched?: number };
type Reader = { get(scope: string, key: string): Promise<unknown> };
export type FenceResult = { keys: number; scopes: number; synced: boolean; waitMs: number; mutationFailures: number; completion?: 'disk' | 'sdk'; completed?: boolean };
export function namespaceJson(buffer: Uint8Array): Record<string, unknown>;
export function createStateDurabilityFence(options: { storePath: string; timeoutMs?: number; pollIntervalMs?: number; clock?: () => number; completion?: 'disk' | 'sdk' }): {
 readonly completion: 'disk' | 'sdk';
 mutate<T>(scope: string, key: string, fn: () => Promise<T>): Promise<T>;
 keys(): DirtyKey[];
 keysFor(keys: DirtyKey[]): DirtyKey[];
 forgetKeys(keys: DirtyKey[]): void;
 stableKeys(options?: { minAgeMs?: number; limit?: number }): DirtyKey[];
 wait(kv: Reader): Promise<FenceResult>;
 waitForKeys(kv: Reader, keys: DirtyKey[], options?: { deadline?: number; expectedValues?: unknown[] }): Promise<FenceResult>;
 waitForKeyGroups(kv: Reader, groups: DirtyKey[][], options?: {deadline?:number}): Promise<PromiseSettledResult<FenceResult>[]>;
 flushStable(kv: Reader, options?: { minAgeMs?: number; limit?: number }): Promise<unknown>;
 freeze(): void;
 drain(): Promise<void>;
 snapshot(): { completion: 'disk'|'sdk'; sdkCompletion: unknown; frozen: boolean; activeMutations: number; touchedScopes: number; mutationFailures: number; pruning: boolean; lastVerification: unknown; measurements: unknown; readSharing: unknown };
};
