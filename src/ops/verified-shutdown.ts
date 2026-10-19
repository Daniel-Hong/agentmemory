import { writeShutdownReceipt } from "./background-lifecycle.mjs";

const SHUTDOWN_STAGES = ['work', 'boot_gate', 'lifecycle', 'ingress', 'control', 'index_save', 'durability_drain', 'disk_fence', 'restart_guard', 'freeze', 'final_disk_fence', 'worker_stop', 'worker_drain'] as const;
export type ShutdownProgress = {
  stage: (typeof SHUTDOWN_STAGES)[number];
  event?: 'start' | 'done' | 'failed';
  workerIndex?: number;
  elapsedMs?: number;
};

export async function verifiedShutdown({ work, engineAlive, receiptDir, onProgress, timeoutMs = 600000, pollMs = 250 }: {
  work: (progress: (update: ShutdownProgress) => void) => Promise<unknown>;
  onProgress?: (progress: ShutdownProgress) => unknown;
  engineAlive: () => boolean | null;
  receiptDir: string;
  timeoutMs?: number;
  pollMs?: number;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined;
  let durability: unknown = null, errorCode: string | null = null;
  const startedAt = Date.now(), pending = new Map<string, ShutdownProgress>();
  let collecting = true, lastStage: ShutdownProgress = { stage: 'work', elapsedMs: 0 };
  const progress = (update: ShutdownProgress) => {
    if (!collecting || !SHUTDOWN_STAGES.includes(update?.stage)) return;
    const clean: ShutdownProgress = { stage: update.stage, elapsedMs: Math.max(0, Date.now() - startedAt) };
    if (update.stage === 'worker_stop' || update.stage === 'worker_drain') {
      if (!Number.isSafeInteger(update.workerIndex) || update.workerIndex! < 0 || !['start', 'done', 'failed'].includes(update.event!)) return;
      clean.workerIndex = update.workerIndex; clean.event = update.event;
      const key = clean.stage + ':' + clean.workerIndex;
      if (clean.event === 'start') pending.set(key, { ...clean });
      else pending.delete(key);
    }
    lastStage = clean;
    try { Promise.resolve(onProgress?.({ ...clean })).catch(() => {}); } catch {}
  };
  try {
    durability = await Promise.race([
      Promise.resolve().then(() => work(progress)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(Error("shutdown_timeout"), { code: "SHUTDOWN_TIMEOUT" })), timeoutMs);
        poll = setInterval(() => {
          try {
            if (engineAlive() === false) reject(Object.assign(Error("engine_lost"), { code: "ENGINE_LOST" }));
          } catch {
            reject(Object.assign(Error("engine_check_failed"), { code: "ENGINE_CHECK_FAILED" }));
          }
        }, pollMs);
      }),
    ]);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    errorCode = typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "SHUTDOWN_STORAGE_FAILED";
  } finally {
    collecting = false;
    clearTimeout(timer); clearInterval(poll);
  }
  let verified = !errorCode && !!durability
    && (durability as { synced?: boolean }).synced === true
    && (durability as { mutationFailures?: number }).mutationFailures === 0;
  if (!verified && !errorCode) errorCode = "SHUTDOWN_NOT_VERIFIED";
  const diagnostics = { lastStage, pendingWorkers: [...pending.values()] };
  const receipt = { pid: process.pid, at: new Date().toISOString(), verified, durability, errorCode, ...diagnostics };
  try {
    await writeShutdownReceipt(receipt, receiptDir);
  } catch {
    verified = false; errorCode = "SHUTDOWN_RECEIPT_FAILED";
    // A post-rename sync failure may have published a success receipt.
    await writeShutdownReceipt({ ...receipt, verified, errorCode }, receiptDir).catch(() => {});
  }
  return { verified, durability, errorCode, ...diagnostics };
}
