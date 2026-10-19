export function ensurePrivateSnapshotDir(dir: any): Promise<void>;
export function publishSnapshotFile(dir: any, name: any, content: any): Promise<void>;
export function createSnapshotRecovery({ dir, intervalMs, gitExec, create, isPaused, now, setTimer, clearTimer }: {
    dir: any;
    intervalMs: any;
    gitExec: any;
    create: any;
    isPaused?: (() => boolean) | undefined;
    now?: (() => number) | undefined;
    setTimer?: typeof setTimeout | undefined;
    clearTimer?: typeof clearTimeout | undefined;
}): {
    init: () => Promise<any>;
    runCreate: (fn: any) => Promise<any>;
    start(): void;
    drain(): Promise<void>;
    stop(): Promise<void>;
    snapshot(): {
        status: string;
        lastSuccessAt: null;
        lastCommitHash: null;
        lastAttemptAt: null;
        lastErrorCode: any;
        failures: number;
        nextAttemptAt: string | null;
        nextCheckAt: any;
        intervalMs: any;
        format: string;
    };
};
