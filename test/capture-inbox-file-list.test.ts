import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StateKV, applyUpdateOps } from '../src/state/kv.js';
import { KV } from '../src/state/schema.js';
import { registerCaptureFunctions } from '../src/functions/capture.js';
import { listCaptureInboxMetadata, projectCaptureInbox } from '../src/capture/inbox-metadata.js';
import { mockSdk } from './helpers/mocks.js';
import { capturePayloadDigest } from '../src/capture/receipt-digest.js';
import { captureFailureHistoryDigest } from '../src/capture/sdk-resolution-record.js';
import { createStateDurabilityFence } from '../src/ops/state-durability.mjs';

vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const directories: string[] = [];
const controllers: Array<ReturnType<typeof registerCaptureFunctions>> = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'am-capture-list-'));
  directories.push(dir);
  vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH', dir);
  return join(dir, encodeURIComponent(KV.captureInbox) + '.bin');
}
function stateSdk(rows: Record<string, unknown> = {}) {
  const sdk = mockSdk();
  const store = new Map<string, Map<string, unknown>>([[KV.captureInbox, new Map(Object.entries(rows))]]);
  const list = vi.fn(async ({ scope }: { scope: string }) => {
    if (scope === KV.captureInbox) throw Error('SDK_LIST_EXCEEDS_64_MIB');
    return [...(store.get(scope)?.values() ?? [])];
  });
  sdk.registerFunction('state::list', list as never);
  sdk.registerFunction('state::get', async (input: any) => store.get(input.scope)?.get(input.key) ?? null);
  sdk.registerFunction('state::set', async (input: any) => {
    if (!store.has(input.scope)) store.set(input.scope, new Map());
    store.get(input.scope)!.set(input.key, input.value);
    return input.value;
  });
  sdk.registerFunction('state::update', async (input: any) => {
    const before = store.get(input.scope)?.get(input.key);
    const after = applyUpdateOps(before, input.ops);
    store.get(input.scope)?.set(input.key, after);
    return { old_value: before, new_value: after, errors: [] };
  });
  sdk.registerFunction('state::delete', async (input: any) => {
    const before = store.get(input.scope)?.get(input.key);
    store.get(input.scope)?.delete(input.key);
    return before ?? null;
  });
  return { sdk, list, store };
}
async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(path)) hash.update(block);
  return hash.digest('hex');
}

it('preserves capture admission and status with an intact inbox beyond a 64 MiB SDK list', async () => {
  const path = await fixture();
  const { sdk, list, store } = stateSdk();
  const largeText = 'x'.repeat(512 * 1024);
  const handle = await open(path, 'w');
  let sdkBytes = 2;
  try {
    await handle.write('{');
    for (let i = 0; i < 128; i++) {
      const key = 'retained-' + i;
      const row = {
        key, eventId: key, sessionId: 'old-session', project: 'fixture',
        status: 'dead', attempts: 1, updatedAt: '2026-11-01T00:00:00.000Z',
        payload: { data: { synthetic: largeText } },
      };
      store.get(KV.captureInbox)!.set(key, row);
      const value = JSON.stringify(row);
      sdkBytes += Buffer.byteLength(value) + Number(i > 0);
      await handle.write((i ? ',' : '') + JSON.stringify(key) + ':' + value);
    }
    await handle.write('}');
    await handle.write(Buffer.from([0, 0, 0, 0, 255, 255, 255, 255]));
  } finally {
    await handle.close();
  }
  expect(sdkBytes).toBeGreaterThan(64 * 1024 * 1024);
  const original = await digest(path);
  const kv = new StateKV(sdk as never);
  const localList = vi.spyOn(kv.graphFileList!, 'list');
  sdk.registerFunction('mem::observe', async (payload: any) => ({ observationId: payload.observationId }));
  sdk.registerFunction('fixture::health', async () => ({ connected: true }));
  const controller = registerCaptureFunctions(sdk as never, kv);
  controllers.push(controller);
  const result = await sdk.trigger('mem::capture', {
    eventId: 'evc_000000000099',
    payload: { hookType: 'post_tool_use', sessionId: 'new-session', project: 'fixture',
      cwd: '/synthetic', timestamp: '2026-11-07T00:00:00.000Z', data: { tool_name: 'Bash', tool_output: 'synthetic' } },
  });
  expect(result).toMatchObject({ status: 'accepted', state: 'sdk_completed' });
  const report = await controller.status();
  expect(report.inbox).toMatchObject({ dead: 128, pending: 0, sdkCompleted: 1 });
  expect(await sdk.trigger('fixture::health', {})).toEqual({ connected: true });
  expect(list.mock.calls.some(([input]) => input.scope === KV.captureInbox)).toBe(false);
  expect(localList.mock.calls.every(([, options]) => typeof options?.project === 'function')).toBe(true);
  expect(await digest(path)).toBe(original);
}, 30_000);

it('overlays acknowledged inbox set/update/delete before disk catches up', async () => {
  const path = await fixture();
  const rows = { original: { key: 'original', attempts: 0 }, removed: { key: 'removed' } };
  await writeFile(path, JSON.stringify(rows));
  const { sdk, list } = stateSdk(rows);
  const kv = new StateKV(sdk as never);
  await kv.update(KV.captureInbox, 'original', [{ type: 'set', path: 'attempts', value: 2 }]);
  await Promise.all([
    kv.set(KV.captureInbox, 'first', { key: 'first' }),
    kv.set(KV.captureInbox, 'second', { key: 'second' }),
  ]);
  await kv.delete(KV.captureInbox, 'removed');
  const expected = [{ key: 'original', attempts: 2 }, { key: 'first' }, { key: 'second' }];
  expect(await kv.list(KV.captureInbox)).toEqual(expected);
  await writeFile(path, JSON.stringify(Object.fromEntries(expected.map(row => [row.key, row]))));
  expect(await kv.list(KV.captureInbox)).toEqual(expected);
  expect(list).not.toHaveBeenCalled();
});

it('keeps an in-flight SDK mutation out of the overlay until acknowledged', async () => {
  await fixture();
  const { sdk } = stateSdk();
  let acknowledge!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  sdk.registerFunction('state::set', async () => {
    entered();
    return new Promise(resolve => { acknowledge = resolve; });
  });
  const kv = new StateKV(sdk as never);
  const write = kv.set(KV.captureInbox, 'new', { key: 'new' });
  await started;
  expect(await kv.list(KV.captureInbox)).toEqual([]);
  acknowledge({ key: 'new' });
  await write;
  expect(await kv.list(KV.captureInbox)).toEqual([{ key: 'new' }]);
});

it('does not let a capture retry mutate the acknowledged overlay before another SDK write', async () => {
  await fixture();
  const { sdk } = stateSdk();
  const kv = new StateKV(sdk as never);
  await kv.set(KV.captureInbox, 'new', { key: 'new', attempts: 1, payload: { data: { text: 'original' } } });
  const first = await kv.list<any>(KV.captureInbox);
  first[0].attempts++;
  first[0].payload.data.text = 'locally changed';
  expect(await kv.list(KV.captureInbox)).toEqual([
    { key: 'new', attempts: 1, payload: { data: { text: 'original' } } },
  ]);
});

it('retains an inbox deletion ACK when an absent checkpoint cannot prove the deletion generation', async () => {
  const path = await fixture();
  await writeFile(path, '{}');
  const { sdk } = stateSdk();
  const kv = new StateKV(sdk as never);
  const old = { key: 'old', attempts: 1 };
  await kv.set(KV.captureInbox, old.key, old);
  await kv.delete(KV.captureInbox, old.key);
  expect(await kv.list(KV.captureInbox)).toEqual([]);
  // An absent key alone does not identify which SDK mutation was checkpointed.
  await writeFile(path, JSON.stringify({ old }));
  expect(await kv.list(KV.captureInbox)).toEqual([]);
  await kv.set(KV.captureInbox, old.key, { ...old, attempts: 2 });
  expect(await kv.list(KV.captureInbox)).toEqual([{ key: 'old', attempts: 2 }]);
});

it('projects each inbox entry and retires the ACK overlay only after the matching checkpoint', async () => {
  const path = await fixture();
  await writeFile(path, '{"old":{"key":"old","attempts":0,"payload":{"data":"large original"}}}');
  const { sdk } = stateSdk();
  const kv = new StateKV(sdk as never);
  const project = (value: any) => ({ key: value.key, attempts: value.attempts });
  await kv.set(KV.captureInbox, 'old', { key: 'old', attempts: 1, payload: { data: 'uncheckpointed' } });
  expect(await kv.list(KV.captureInbox, { project })).toEqual([{ key: 'old', attempts: 1 }]);
  expect(await kv.list<any>(KV.captureInbox)).toEqual([
    { key: 'old', attempts: 1, payload: { data: 'uncheckpointed' } },
  ]);
  await writeFile(path, '{"old":{"key":"old","attempts":1,"payload":{"data":"uncheckpointed"}}}');
  await kv.list(KV.captureInbox, { project });
  await writeFile(path, '{"old":{"key":"old","attempts":2,"payload":{"data":"checkpoint advanced"}}}');
  expect(await kv.list(KV.captureInbox, { project })).toEqual([{ key: 'old', attempts: 2 }]);
});

it('retains the exact bounded list and review previews without payloads', async () => {
  const row = { key: 'preview', hookType: 'user_prompt_submit',
    payload: { hookType: 'post_tool_use', data: { tool_name: 'Bash', tool_input: 'x'.repeat(800) } } };
  const metadata = projectCaptureInbox(row);
  expect(metadata).not.toHaveProperty('payload');
  expect(metadata.preview).toBe(('Bash: ' + JSON.stringify(row.payload.data.tool_input)).slice(0, 160));
  expect(metadata.reviewPreview).toBe(('Bash: ' + JSON.stringify(row.payload.data.tool_input)).slice(0, 500));
  const message = projectCaptureInbox({ key: 'message', hookType: 'stop', payload: { hookType: 'stop', data: { message: 'done' } } });
  expect(message.preview).toBe('stop: {"message":"done"}');
  expect(message.reviewPreview).toBe('stop: "done"');
});

it('projects a recent ACK independently of callers and projector mutation', async () => {
  await fixture();
  const { sdk } = stateSdk();
  const kv = new StateKV(sdk as never);
  await kv.set(KV.captureInbox, 'new', { key: 'new', attempts: 1, payload: { data: 'original' } });
  const rows = await listCaptureInboxMetadata(kv);
  rows[0].attempts = 9;
  await kv.list(KV.captureInbox, { project: (row: any) => { row.payload.data = 'changed'; return row.key; } });
  expect(await kv.list(KV.captureInbox)).toEqual([{ key: 'new', attempts: 1, payload: { data: 'original' } }]);
});

it('refuses corrupt or uncertain inbox state without an SDK list fallback', async () => {
  const path = await fixture();
  const { sdk, list } = stateSdk();
  const kv = new StateKV(sdk as never);
  await writeFile(path, '{"old":broken}');
  await expect(kv.list(KV.captureInbox)).rejects.toThrow(/state_namespace/);
  await writeFile(path, '{"old":{"key":"old"}}');
  sdk.registerFunction('state::set', async () => { throw Error('SDK outcome unknown'); });
  await expect(kv.set(KV.captureInbox, 'new', { key: 'new' })).rejects.toThrow('SDK outcome unknown');
  await expect(kv.list(KV.captureInbox)).rejects.toThrow('graph_mutation_uncertain');
  expect(list).not.toHaveBeenCalled();
  expect(await readFile(path, 'utf8')).toBe('{"old":{"key":"old"}}');
});

it.each(['redis', 'no-local-path'] as const)('preserves SDK fallback for %s', async mode => {
  const { sdk, list } = stateSdk();
  if (mode === 'redis') await fixture();
  else vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH', '');
  list.mockImplementation(async () => [{ key: 'legacy' }]);
  const kv = new StateKV(sdk as never, mode === 'redis' ? { backend: 'redis' } : {});
  expect(await kv.list(KV.captureInbox)).toEqual([{ key: 'legacy' }]);
  expect(await kv.list(KV.captureInbox, { project: (row: any) => row.key })).toEqual(['legacy']);
  expect(list).toHaveBeenCalledWith({ scope: KV.captureInbox });
});

it('keeps unrelated capture namespaces on their SDK path', async () => {
  await fixture();
  const { sdk, list } = stateSdk();
  const kv = new StateKV(sdk as never);
  for (const scope of [KV.captureReview + ':other', KV.captureInbox + ':other', 'mem:capture:events:ab']) {
    expect(await kv.list(scope)).toEqual([]);
    expect(list).toHaveBeenCalledWith({ scope });
  }
});

function completedRow(key: string) {
  return { key, eventId: key, sessionId: 'synthetic-session', project: 'synthetic', hookType: 'post_tool_use',
    observationId: 'obs-' + key, status: 'pending', storageCompletion: 'sdk', attempts: 1,
    acceptedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    payload: { hookType: 'post_tool_use', sessionId: 'synthetic-session', project: 'synthetic',
      cwd: '/synthetic', timestamp: '2026-11-01T00:00:00.000Z', data: { synthetic: 'original' } } };
}

it('counts 5074 ordinary SDK completions with one keyed local review projection and no per-row history GET', async () => {
  const path = await fixture();
  const rows = Object.fromEntries(Array.from({ length: 5074 }, (_, i) => { const row = completedRow('sdk-' + i); return [row.key, row]; }));
  await writeFile(path, JSON.stringify(rows));
  const { sdk, list } = stateSdk(rows);
  const kv = new StateKV(sdk as never);
  const get = vi.spyOn(kv, 'get');
  const localList = vi.spyOn(kv.graphFileList!, 'list');
  const controller = registerCaptureFunctions(sdk as never, kv);controllers.push(controller);
  expect((await controller.status()).inbox).toMatchObject({ sdkCompleted: 5074, pending: 0 });
  expect(get.mock.calls.filter(([scope]) => scope === KV.captureReview)).toHaveLength(0);
  expect(localList.mock.calls.filter(([scope]) => scope === KV.captureReview)).toHaveLength(1);
  expect(list.mock.calls.some(([input]) => input.scope === KV.captureReview)).toBe(false);
});

it('passes actual review storage keys through disk and acknowledged projections and retains deletion tombstones', async () => {
  const path = await fixture();
  const reviewPath = join(dirname(path), encodeURIComponent(KV.captureReview) + '.bin');
  await writeFile(reviewPath, '{"disk-key":{"key":"value-alias"}}');
  const { sdk, list } = stateSdk();const kv = new StateKV(sdk as never);
  const project = (value: any, key?: string) => ({ key, embeddedKey: value.key });
  expect(await kv.list(KV.captureReview, { project })).toEqual([{ key: 'disk-key', embeddedKey: 'value-alias' }]);
  await kv.set(KV.captureReview, 'ack-key', { key: 'ack-alias' });
  expect(await kv.list(KV.captureReview, { project })).toContainEqual({ key: 'ack-key', embeddedKey: 'ack-alias' });
  await kv.delete(KV.captureReview, 'ack-key');
  await writeFile(reviewPath, '{}');expect(await kv.list(KV.captureReview)).toEqual([]);
  await writeFile(reviewPath, '{"ack-key":{"key":"ack-alias"}}');
  expect(await kv.list(KV.captureReview)).toEqual([]);
  expect(list.mock.calls.some(([input]) => input.scope === KV.captureReview)).toBe(false);
});

it.each([null, [], 'malformed', {}, { key: 'wrong-key' }].map(value => [value]))('does not count SDK completion from malformed or miskeyed local history %j', async history => {
  const path = await fixture();const row = completedRow('selected');
  await writeFile(path, JSON.stringify({ selected: row }));
  await writeFile(join(dirname(path), encodeURIComponent(KV.captureReview) + '.bin'), JSON.stringify({ selected: history }));
  const { sdk } = stateSdk({ selected: row });const kv = new StateKV(sdk as never);
  const controller = registerCaptureFunctions(sdk as never, kv);controllers.push(controller);
  expect((await controller.status()).inbox).toBeNull();
});

it('rechecks full canonical resolution and original payload only for locally marked history', async () => {
  const path = await fixture();const requestId = '00000000-0000-4000-8000-000000000001';
  const row = { ...completedRow('resolved'), sdkResolutionId: requestId, sdkResolutionState: 'committed' };
  const history: any = { key: row.key, eventId: row.eventId, sessionId: row.sessionId, project: row.project,
    hookType: row.hookType, observationId: row.observationId, status: 'completed', totalAttempts: 1,
    cycleAttempts: 1, manualRetries: 0, failures: [], requests: {}, acceptedAt: row.acceptedAt, updatedAt: row.updatedAt };
  history.sdkResolution = { version: 1, completion: 'sdk', phase: 'committed', requestId,
    sourceDigest: capturePayloadDigest(row.payload), initialProjection: 'a'.repeat(64),
    priorFailureDigest: captureFailureHistoryDigest(history), priorInboxState: 'dead',
    startedAt: row.acceptedAt, completedAt: row.updatedAt, verifiedProjection: 'b'.repeat(64) };
  await writeFile(path, JSON.stringify({ resolved: row }));
  await writeFile(join(dirname(path), encodeURIComponent(KV.captureReview) + '.bin'), JSON.stringify({ resolved: history }));
  const { sdk, store } = stateSdk({ resolved: row });store.set(KV.captureReview, new Map([[row.key, history]]));
  const kv = new StateKV(sdk as never);const get = vi.spyOn(kv, 'get');
  const controller = registerCaptureFunctions(sdk as never, kv);controllers.push(controller);
  expect((await controller.status()).inbox).toMatchObject({ sdkCompleted: 1 });
  expect(get.mock.calls.filter(([scope]) => scope === KV.captureReview)).toHaveLength(1);
  expect(get.mock.calls.filter(([scope]) => scope === KV.captureInbox)).toHaveLength(1);
  store.get(KV.captureInbox)!.set(row.key, { ...row, payload: { ...row.payload, data: { synthetic: 'changed' } } });
  expect((await controller.status()).inbox).toMatchObject({ sdkCompleted: 0 });
});

it('does not turn a projected resolution that disappears from the SDK into an ordinary completion', async () => {
  const path = await fixture();const row = completedRow('selected');
  await writeFile(path, JSON.stringify({ selected: row }));
  await writeFile(join(dirname(path), encodeURIComponent(KV.captureReview) + '.bin'), '{"selected":{"key":"selected","sdkResolution":null}}');
  const { sdk } = stateSdk({ selected: row });const kv = new StateKV(sdk as never);
  const controller = registerCaptureFunctions(sdk as never, kv);controllers.push(controller);
  expect((await controller.status()).inbox).toMatchObject({ sdkCompleted: 0 });
});

it('sees an acknowledged review resolution before its file checkpoint and refuses an uncertain review mutation', async () => {
  const path = await fixture();const row = completedRow('selected');
  await writeFile(path, JSON.stringify({ selected: row }));
  const { sdk } = stateSdk({ selected: row });const kv = new StateKV(sdk as never);
  const controller = registerCaptureFunctions(sdk as never, kv);controllers.push(controller);
  expect((await controller.status()).inbox).toMatchObject({ sdkCompleted: 1 });
  await kv.set(KV.captureReview, row.key, { key: row.key, sdkResolution: null });
  expect((await controller.status()).inbox).toMatchObject({ sdkCompleted: 0 });
  sdk.registerFunction('state::set', async () => { throw Error('synthetic unknown SDK mutation'); });
  await expect(kv.set(KV.captureReview, row.key, { key: row.key })).rejects.toThrow('synthetic unknown SDK mutation');
  expect((await controller.status()).inbox).toBeNull();
});

it('keeps per-row history GET and unknown physical projection keys without a local reader', async () => {
  vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH', '');
  const row = completedRow('legacy');const { sdk, list } = stateSdk({ legacy: row });
  list.mockImplementation(async () => [row]);
  const kv = new StateKV(sdk as never, { durability: createStateDurabilityFence({ storePath: '/synthetic-only', completion: 'sdk' }) });
  const get = vi.spyOn(kv, 'get');
  const controller = registerCaptureFunctions(sdk as never, kv);controllers.push(controller);
  expect((await controller.status()).inbox).toMatchObject({ sdkCompleted: 1 });
  expect(get.mock.calls.filter(([scope]) => scope === KV.captureReview)).toHaveLength(1);
  expect(await kv.list(KV.captureInbox, { project: (_value, key) => key })).toEqual([undefined]);
});
