import type { ShutdownProgress } from './verified-shutdown.js';
type Worker = { stop?: () => unknown; drain?: () => unknown };
type Progress = (update: ShutdownProgress) => unknown;
export function createBackgroundLifecycle(closeAdmission: () => void): {
 track<T extends Worker>(worker: T): T;
 drain(): Promise<void>;
 shutdown(flush: (state: { drained: boolean }) => Promise<unknown>, onProgress?: Progress): Promise<void>;
};
export function registerBackgroundInterval(lifecycle: ReturnType<typeof createBackgroundLifecycle>, callback: () => unknown, ms: number, pauseable?: boolean): ReturnType<typeof setInterval>;
export function writeShutdownReceipt(value: unknown, directory?: string): Promise<void>;
export function readShutdownReceipt(directory?: string): Promise<unknown>;
