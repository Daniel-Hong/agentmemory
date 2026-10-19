export interface OllamaReadiness {
 ensureReady(): Promise<boolean>;
 markUnavailable(error: unknown, delay?: number): void;
 start(): void;
 stop(): Promise<void>;
 drain(): Promise<void>;
 snapshot(): {status: string; errorCode: string | null; [key: string]: unknown};
 noteResponse(metadata: Record<string, unknown>): void;
}
export function createOllamaReadiness(options: {baseUrl: string; models?: string[]; fetchFn?: typeof fetch; clock?: () => number; probeTimeoutMs?: number; readyTtlMs?: number; maxDelayMs?: number; onStateChange?: (state: unknown) => void}): OllamaReadiness;
export function providerDeferredError(readiness?: OllamaReadiness | null, error?: unknown): Error & {providerUnavailable: true; diagnostics: Record<string, unknown>};
export function readOllamaContent(data: unknown, readiness?: OllamaReadiness | null, requestKind?: string): string;
export function networkErrorCode(error: unknown): string;
export function safeFailureDetails(error: unknown): Record<string, string | number>;
