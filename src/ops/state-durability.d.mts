export type DirtyKey = { scope: string; key: string; revision?: number; lastTouched?: number };
type Reader = { get(scope: string, key: string): Promise<unknown> };
export type FenceResult = { keys: number; scopes: number; synced: boolean; waitMs: number; mutationFailures: number };
export function namespaceJson(buffer: Uint8Array): Record<string, unknown>;
export function createStateDurabilityFence(options: { storePath: string; timeoutMs?: number; pollIntervalMs?: number; clock?: () => number }): {
 mutate<T>(scope: string, key: string, fn: () => Promise<T>): Promise<T>;
 keys(): DirtyKey[];
 keysFor(keys: DirtyKey[]): DirtyKey[];
 forgetKeys(keys: DirtyKey[]): void;
 stableKeys(options?: { minAgeMs?: number; limit?: number }): DirtyKey[];
 wait(kv: Reader): Promise<FenceResult>;
 waitForKeys(kv: Reader, keys: DirtyKey[]): Promise<FenceResult>;
 flushStable(kv: Reader, options?: { minAgeMs?: number; limit?: number }): Promise<unknown>;
 freeze(): void;
 drain(): Promise<void>;
 snapshot(): { frozen: boolean; activeMutations: number; touchedScopes: number; mutationFailures: number; pruning: boolean; lastVerification: unknown };
};
