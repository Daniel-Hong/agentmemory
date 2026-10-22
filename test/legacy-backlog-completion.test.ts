import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerApiTriggers } from '../src/triggers/api.js';
import { registerObserveFunction } from '../src/functions/observe.js';
import { registerCaptureFunctions } from '../src/functions/capture.js';
import { createFeatureLifecycle, FEATURE_NAMESPACE } from '../src/ops/feature-lifecycle.mjs';
import { createStateDurabilityFence } from '../src/ops/state-durability.mjs';
import { operationalState } from '../src/ops/context.js';
import { withKeyedLock } from '../src/state/keyed-mutex.js';
import { KV } from '../src/state/schema.js';
import { mockSdk } from './helpers/mocks.js';

vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const initialTime = Date.parse('2026-10-22T01:00:00.000Z');
let root: string;
const cleanups: Array<() => Promise<unknown>> = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'am-legacy-completion-'));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(initialTime);
  vi.stubEnv('AGENTMEMORY_HOME', root);
  vi.stubEnv('AGENTMEMORY_SECRET', 'synthetic-secret');
  vi.stubEnv('AGENTMEMORY_URL', 'http://127.0.0.1:45679');
  vi.stubEnv('AGENTMEMORY_CAPTURE_SPOOL_DIR', join(root, 'managed'));
  vi.stubEnv('AGENTMEMORY_CAPTURE_DRAIN_CHILD', '1');
  operationalState.featureLifecycle = undefined;
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  operationalState.featureLifecycle = undefined;
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(features = true, callerBudgetMs = 120) {
  const sessionId = 'synthetic-backlog-session';
  const rows = new Map<string, Map<string, any>>();
  const storePath = join(root, 'state'); await mkdir(storePath);
  const calls: string[] = [], receiptStates: unknown[] = [], inflight = new Set<Promise<unknown>>();
  let delayed: { stage: string; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  let mismatchObservationDisk = false;
  let offlineObserveOnce = false;
  async function pause(stage: string) {
    if (delayed?.stage === stage) {
      const selected = delayed; delayed = undefined;
      selected.entered.resolve(); await selected.release.promise;
    }
  }
  const diskPath = (scope: string) => join(storePath, encodeURIComponent(scope) + '.bin');
  async function persist(scope: string) {
    const value = Object.fromEntries(rows.get(scope) ?? []);
    await writeFile(diskPath(scope), JSON.stringify(mismatchObservationDisk && scope === KV.observations(sessionId) ? {} : value));
  }
  const kv = {
    async get(scope: string, key: string) {
      if (scope === KV.sessions) await pause('session_read');
      return structuredClone(rows.get(scope)?.get(key) ?? null);
    },
    async set(scope: string, key: string, value: unknown) {
      if (!rows.has(scope)) rows.set(scope, new Map());
      // Match the real SDK JSON boundary, including omission of undefined fields.
      rows.get(scope)!.set(key, JSON.parse(JSON.stringify(value))); await persist(scope); return value;
    },
    async update(scope: string, key: string, ops: Array<{ type: string; path: string; value?: unknown }>) {
      if (scope === KV.sessions) await pause('session_write');
      const value = rows.get(scope)!.get(key);
      for (const op of ops) { if (op.type === 'remove') delete value[op.path]; else value[op.path] = op.value; }
      await persist(scope);
    },
    async delete(scope: string, key: string) { rows.get(scope)?.delete(key); await persist(scope); },
    async list(scope: string) {
      if (scope === KV.observations(sessionId)) await pause('feature_observations_read');
      return [...(rows.get(scope)?.values() ?? [])].map(value => structuredClone(value));
    },
    durability: createStateDurabilityFence({ storePath, timeoutMs: 500, pollIntervalMs: 2, clock: () => performance.now() }),
  };
  await kv.set(KV.sessions, sessionId, { id: sessionId, project: 'synthetic-project', status: 'active', observationCount: 0 });
  const sdk = mockSdk({ looseTrigger: true });
  registerObserveFunction(sdk as never, kv as never);
  const capture = registerCaptureFunctions(sdk as never, kv as never);
  const lifecycle = features ? createFeatureLifecycle({ kv, KV, withKeyedLock, provider: null, schedule: false, isSlotsEnabled: () => true }) : undefined;
  operationalState.featureLifecycle = lifecycle;
  registerApiTriggers(sdk as never, kv as never, 'synthetic-secret');

  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, options: RequestInit = {}) => {
    const url = new URL(String(input)); calls.push(`${options.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/agentmemory/observe' && offlineObserveOnce) {
      offlineObserveOnce = false;
      return Promise.reject(new Error('synthetic transport outage'));
    }
    const id = url.pathname === '/agentmemory/session/end' ? 'api::session::end'
      : url.pathname === '/agentmemory/observe' ? 'api::observe'
      : url.pathname === '/agentmemory/capture/receipts' ? 'api::capture-receipts' : undefined;
    if (!id) throw Error('Unexpected synthetic route; network forbidden');
    const handler = sdk.fns.get(id)!;
    const request = Promise.resolve().then(() => handler({
      body: options.body ? JSON.parse(String(options.body)) : undefined,
      query_params: Object.fromEntries(url.searchParams), headers: { authorization: 'Bearer synthetic-secret' },
    })).then((result: any) => {
      if (id === 'api::capture-receipts') receiptStates.push(result.body);
      return new Response(JSON.stringify(result.body), { status: result.status_code });
    });
    inflight.add(request); request.then(() => inflight.delete(request), () => inflight.delete(request));
    // A disconnected HTTP caller does not cancel already running backend work.
    return new Promise<Response>((resolve, reject) => {
      const signal = options.signal;
      const abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      request.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
      if (signal?.aborted) abort();
    });
  }));
  const clientDir = join(root, 'client'); await mkdir(clientDir);
  for (const name of ['_capture.mjs', 'long-session-hook-client.mjs']) {
    const source = await readFile(new URL('../plugin/scripts/codex-compat/' + name, import.meta.url), 'utf8');
    await writeFile(join(clientDir, name), source.replace(/^\/\/# sourceMappingURL=.*$/gm, ''));
  }
  const { HookClient } = await import(pathToFileURL(join(clientDir, 'long-session-hook-client.mjs')).href);
  const outbox = join(root, 'outbox');
  const client = new HookClient({ dir: outbox, url: 'http://127.0.0.1:45679', secret: 'synthetic-secret', timeoutMs: callerBudgetMs });
  const pending = async () => Promise.all((await readdir(outbox)).filter(name => name.endsWith('.json')).sort().map(async name => JSON.parse(await readFile(join(outbox, name), 'utf8'))));
  const endBody = { sessionId, hookEventName: 'SessionEnd', eventId: 'synthetic-end-event' };
  const settle = async () => { while (inflight.size) await Promise.allSettled([...inflight]); };
  cleanups.push(async () => { capture.stop(); await settle(); await lifecycle?.stop(); await kv.durability.drain(); });
  return {
    client, kv, rows, sessionId, calls, receiptStates, pending, endBody, settle,
    delay(stage: string) {
      const gate = { stage, entered: deferred(), release: deferred() }; delayed = gate;
      cleanups.push(async () => gate.release.resolve()); return gate;
    },
    async repairDisk() { mismatchObservationDisk = false; await persist(KV.observations(sessionId)); },
    breakObservationDisk() { mismatchObservationDisk = true; },
    observeOfflineOnce() { offlineObserveOnce = true; },
    async drainManaged() { const capture = await import(pathToFileURL(join(clientDir, '_capture.mjs')).href); return capture.runDrainChild(); },
    advanceRetry(record: any) { vi.setSystemTime(record.nextAttemptAt + 1); },
  };
}

describe('legacy backlog completion through the actual client and REST functions', () => {
  it('documents local managed ownership allowing session-end before a late observation, without silently refreshing feature evidence', async () => {
    const f = await fixture(true, 1200); f.observeOfflineOnce();
    const body = { sessionId: f.sessionId, project: 'synthetic-project', eventId: 'synthetic-small-event', hookType: 'post_tool_use', cwd: '/synthetic', timestamp: new Date().toISOString(), data: { tool_output: 'small synthetic observation' } };
    await f.client.enqueue('/agentmemory/observe', body);
    await f.client.enqueue('/agentmemory/session/end', f.endBody);
    expect(await f.client.flush()).toBe(true); expect(await f.pending()).toEqual([]);
    expect(await f.kv.list(KV.observations(f.sessionId))).toHaveLength(0);
    expect(await f.kv.get(KV.sessions, f.sessionId)).toMatchObject({ status: 'completed' });
    const before = await f.kv.get(FEATURE_NAMESPACE, f.sessionId);
    expect(before).toMatchObject({ status: 'queued' });
    expect(await f.drainManaged()).toMatchObject({ delivered: 1, remaining: 0 });
    expect(await f.kv.list(KV.observations(f.sessionId))).toHaveLength(1);
    expect(await f.kv.get(KV.sessions, f.sessionId)).toMatchObject({ status: 'completed', observationCount: 1 });
    expect(await f.kv.get(FEATURE_NAMESPACE, f.sessionId)).toEqual(before);
  });
  it.each(['session_read', 'session_write', 'feature_observations_read'])('retains the session-end original while %s exceeds the caller budget, then acknowledges its retry', async stage => {
    const f = await fixture(); await f.client.enqueue('/agentmemory/session/end', f.endBody);
    const gate = f.delay(stage), flushing = f.client.flush();
    await gate.entered.promise;
    expect(await flushing).toBe(false);
    const retained = await f.pending(); expect(retained).toHaveLength(1); expect(retained[0].body).toEqual(f.endBody);
    gate.release.resolve(); await f.settle();
    expect(await f.kv.get(KV.sessions, f.sessionId)).toMatchObject({ status: 'completed' });
    f.advanceRetry(retained[0]);
    expect(await f.client.flush(), JSON.stringify(f.receiptStates)).toBe(true); expect(await f.pending()).toEqual([]);
  });

  it.each([false, true])('acknowledges a repeated ended session without changing its original completion time (features=%s)', async features => {
    const f = await fixture(features); await f.client.enqueue('/agentmemory/session/end', f.endBody);
    expect(await f.client.flush()).toBe(true);
    const completed = await f.kv.get(KV.sessions, f.sessionId);
    vi.setSystemTime(initialTime + 2000);
    await f.client.enqueue('/agentmemory/session/end', f.endBody);
    expect(await f.client.flush()).toBe(true); expect(await f.pending()).toEqual([]);
    expect(await f.kv.get(KV.sessions, f.sessionId)).toEqual(completed);
    if (features) expect(await f.kv.list(FEATURE_NAMESPACE)).toHaveLength(1);
  });

  it('keeps observation before session-end across a failed real capture fence and retries only its receipt', async () => {
    const f = await fixture(true, 1200); f.breakObservationDisk();
    const body = { sessionId: f.sessionId, project: 'synthetic-project', eventId: 'synthetic-observe-event', hookType: 'post_tool_use', cwd: '/synthetic', timestamp: new Date().toISOString(), data: { tool_output: 'synthetic '.repeat(32_000) } };
    await f.client.enqueue('/agentmemory/observe', body);
    await f.client.enqueue('/agentmemory/session/end', f.endBody);
    expect(await f.client.flush()).toBe(false);
    const retained = await f.pending(); expect(retained.map(row => row.body)).toEqual([body, f.endBody]);
    expect(f.calls).not.toContain('POST /agentmemory/session/end');
    expect(await f.kv.get(KV.sessions, f.sessionId)).toMatchObject({ status: 'active', observationCount: 1 });
    expect((await f.kv.list(KV.observations(f.sessionId)))).toHaveLength(1);
    await f.repairDisk(); f.advanceRetry(retained[0]);
    const complete = await f.client.flush();
    expect(complete, JSON.stringify({ receipts: f.receiptStates, fence: f.kv.durability.snapshot().lastVerification })).toBe(true); expect(await f.pending()).toEqual([]);
    expect(f.calls.filter(call => call === 'POST /agentmemory/observe')).toHaveLength(1);
    expect(f.calls.at(-1)).toBe('POST /agentmemory/session/end');
    expect(await f.kv.get(KV.sessions, f.sessionId)).toMatchObject({ status: 'completed', observationCount: 1 });
    expect(await f.kv.list(KV.observations(f.sessionId))).toHaveLength(1);
  });
});
