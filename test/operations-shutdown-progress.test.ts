import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedShutdown } from '../src/ops/verified-shutdown.js';
import { createBackgroundLifecycle } from '../src/ops/background-lifecycle.mjs';

const directories: string[] = [];
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'shutdown-progress-')); directories.push(dir); return dir; }
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const receipt = async (dir: string) => JSON.parse(await readFile(join(dir, 'shutdown-receipt.json'), 'utf8'));

it('keeps an unfinished worker visible when another worker completes before the shutdown timeout', async () => {
  const dir = await directory();
  const lifecycle = createBackgroundLifecycle(() => {});
  lifecycle.track({ stop: () => new Promise(() => {}) });
  lifecycle.track({ stop: async () => {} });
  const result = await verifiedShutdown({ receiptDir: dir, engineAlive: () => true, timeoutMs: 20, pollMs: 5,
    work: async (progress: any) => { progress({ stage: 'lifecycle' }); await lifecycle.shutdown(async () => {}, progress); return { synced: true, mutationFailures: 0 }; },
  });
  expect(result).toMatchObject({ verified: false, durability: null, errorCode: 'SHUTDOWN_TIMEOUT', lastStage: { stage: 'worker_stop', workerIndex: 1, event: 'done' }, pendingWorkers: [{ stage: 'worker_stop', workerIndex: 0 }] });
  expect(await receipt(dir)).toMatchObject({ verified: false, errorCode: 'SHUTDOWN_TIMEOUT', pendingWorkers: [{ stage: 'worker_stop', workerIndex: 0 }] });
});

it('filters diagnostic fields and ignores progress callback failures without certifying diagnostics as durability', async () => {
  const dir = await directory();
  const result = await verifiedShutdown({ receiptDir: dir, engineAlive: () => true, timeoutMs: 100, pollMs: 5,
    onProgress: () => { throw Error('diagnostic callback failure'); },
    work: async (progress: any) => {
      progress({ stage: 'boot_gate', raw: 'private payload' });
      progress({ stage: 'unsafe/path/private payload', workerIndex: -1 });
      return { synced: true, mutationFailures: 1 };
    },
  } as any);
  expect(result).toMatchObject({ verified: false, errorCode: 'SHUTDOWN_NOT_VERIFIED', lastStage: { stage: 'boot_gate' } });
  const disk = await receipt(dir);
  expect(JSON.stringify(disk)).not.toContain('private payload');
  expect(JSON.stringify(disk)).not.toContain('diagnostic callback failure');
});

it('preserves the work failure when an asynchronous diagnostic callback rejects', async () => {
  const dir = await directory();
  const result = await verifiedShutdown({ receiptDir: dir, engineAlive: () => true, timeoutMs: 100, pollMs: 5,
    onProgress: async () => { throw Error('diagnostic failure'); },
    work: async (progress: any) => { progress({ stage: 'disk_fence' }); throw Object.assign(Error('storage failure'), { code: 'SYNTHETIC_WORK_FAILED' }); },
  } as any);
  expect(result).toMatchObject({ verified: false, errorCode: 'SYNTHETIC_WORK_FAILED', lastStage: { stage: 'disk_fence' } });
});

it('reports each lifecycle stop and drain completion without hiding worker errors or skipping flush', async () => {
  const events: unknown[] = [];
  const lifecycle = createBackgroundLifecycle(() => {});
  lifecycle.track({ stop: async () => { throw Error('private worker failure'); }, drain: async () => {} });
  lifecycle.track({ stop: async () => {}, drain: async () => { throw Error('private drain failure'); } });
  const flush = vi.fn(async ({ drained }) => { expect(drained).toBe(false); });
  const progress = (event: unknown) => { events.push(event); throw Error('diagnostic failure'); };
  await expect(lifecycle.shutdown(flush, progress)).rejects.toThrow('background drain failed');
  expect(flush).toHaveBeenCalledTimes(1);
  expect(events).toEqual(expect.arrayContaining([
    { stage: 'worker_stop', workerIndex: 0, event: 'start' }, { stage: 'worker_stop', workerIndex: 0, event: 'failed' },
    { stage: 'worker_stop', workerIndex: 1, event: 'done' }, { stage: 'worker_drain', workerIndex: 0, event: 'done' },
    { stage: 'worker_drain', workerIndex: 1, event: 'start' }, { stage: 'worker_drain', workerIndex: 1, event: 'failed' },
  ]));
  expect(JSON.stringify(events)).not.toContain('private');
});

it('keeps the timeout receipt immutable when the timed-out work later reports more progress', async () => {
  const dir = await directory();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let finished!: () => void;
  const done = new Promise<void>(r => { finished = r; });
  const result = await verifiedShutdown({ receiptDir: dir, engineAlive: () => true, timeoutMs: 15, pollMs: 5,
    work: async progress => {
      progress({ stage: 'boot_gate' }); await gate;
      progress({ stage: 'disk_fence' }); finished();
      return { synced: true, mutationFailures: 0 };
    },
  });
  release(); await done;
  expect(result).toMatchObject({ verified: false, errorCode: 'SHUTDOWN_TIMEOUT', lastStage: { stage: 'boot_gate' } });
  expect(await receipt(dir)).toMatchObject({ verified: false, errorCode: 'SHUTDOWN_TIMEOUT', lastStage: { stage: 'boot_gate' } });
});

it('can still certify completed storage when the diagnostic observer fails', async () => {
  const dir = await directory();
  const result = await verifiedShutdown({ receiptDir: dir, engineAlive: () => true, timeoutMs: 100, pollMs: 5,
    onProgress: async () => { throw Error('diagnostic failure'); },
    work: async progress => { progress({ stage: 'index_save' }); return { synced: true, mutationFailures: 0 }; },
  });
  expect(result).toMatchObject({ verified: true, errorCode: null, lastStage: { stage: 'index_save' }, pendingWorkers: [] });
});
