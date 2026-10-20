import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readNamespaceEntries } from '../src/ops/namespace-reader.mjs';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(body: string) {
  const dir = await mkdtemp(join(tmpdir(), 'am-measurement-')); dirs.push(dir);
  const path = join(dir, 'PRIVATE_PATH.bin'); await writeFile(path, body); return path;
}
it('reports numeric scan metadata once without values or paths and preserves selected values', async () => {
  const body = '{"PRIVATE_KEY":{"secret":"PRIVATE_VALUE"}}'; const path = await fixture(body);
  const samples: unknown[] = [];
  const result = await readNamespaceEntries(path, { keys: new Set(['PRIVATE_KEY']), onRead: (x: unknown) => samples.push(x) });
  expect(result.values.get('PRIVATE_KEY')).toEqual({ secret: 'PRIVATE_VALUE' });
  expect(samples).toEqual([{ fileBytes: Buffer.byteLength(body), bytesRead: Buffer.byteLength(body), entries: 1, complete: true }]);
  expect(JSON.stringify(samples)).not.toContain('PRIVATE');
});
it('reports a partial failed scan without masking malformed JSON', async () => {
  const path = await fixture('{"PRIVATE_KEY":false,'); const samples: any[] = [];
  await expect(readNamespaceEntries(path, { onRead: (x: unknown) => samples.push(x) })).rejects.toMatchObject({ code: 'state_namespace_incomplete' });
  expect(samples).toHaveLength(1); expect(samples[0]).toMatchObject({ complete: false, entries: 1, fileBytes: 21 });
});
it('isolates observer exceptions from both a successful read and a validation error', async () => {
  const onRead = () => { throw Error('PRIVATE_OBSERVER_ERROR'); };
  await expect(readNamespaceEntries(await fixture('{"k":1}'), { onRead })).resolves.toMatchObject({ entries: 1 });
  await expect(readNamespaceEntries(await fixture('{"k":'), { onRead })).rejects.toMatchObject({ code: 'state_namespace_incomplete' });
});

it('isolates asynchronous observer rejection without changing the read result', async () => {
  const path = await fixture('{"k":1}');
  await expect(readNamespaceEntries(path, { onRead: async () => { throw Error('PRIVATE_ASYNC_ERROR'); } })).resolves.toMatchObject({ entries: 1 });
  await new Promise(resolve => setImmediate(resolve));
});

it('reports a pre-aborted scan once with known file size and zero scanned bytes', async () => {
  const body = '{"PRIVATE_KEY":1}'; const path = await fixture(body);
  const controller = new AbortController(); controller.abort(); const samples: any[] = [];
  await expect(readNamespaceEntries(path, { signal: controller.signal, onRead: (x: unknown) => samples.push(x) }))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(samples).toEqual([{ fileBytes: Buffer.byteLength(body), bytesRead: 0, entries: 0, complete: false }]);
  expect(JSON.stringify(samples)).not.toContain('PRIVATE');
});

it('reports a mid-scan abort once with truthful partial bytes and incomplete status', async () => {
  const body = JSON.stringify({ PRIVATE_KEY: 1, tail: 'x'.repeat(16384) }); const path = await fixture(body);
  const controller = new AbortController(); const samples: any[] = [];
  await expect(readNamespaceEntries(path, { chunkSize: 32, signal: controller.signal,
    onEntry: () => controller.abort(), onRead: (x: unknown) => samples.push(x) }))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(samples).toHaveLength(1);
  expect(samples[0]).toMatchObject({ fileBytes: Buffer.byteLength(body), entries: 1, complete: false });
  expect(samples[0].bytesRead).toBeGreaterThan(0); expect(samples[0].bytesRead).toBeLessThan(Buffer.byteLength(body));
  expect(samples[0].bytesRead % 32).toBe(0); expect(JSON.stringify(samples)).not.toContain('PRIVATE');
});

it('reports replacement rejection once without falsely marking a fully parsed old inode as complete', async () => {
  const body = '{"PRIVATE_KEY":1,"tail":2}'; const path = await fixture(body); const samples: any[] = [];
  let replaced = false;
  await expect(readNamespaceEntries(path, { chunkSize: 8,
    onEntry: () => { if (!replaced) { replaced = true; writeFileSync(path + '.next', '{"replacement":3}'); renameSync(path + '.next', path); } },
    onRead: (x: unknown) => samples.push(x) })).rejects.toMatchObject({ code: 'state_namespace_changed' });
  expect(samples).toEqual([{ fileBytes: Buffer.byteLength(body), bytesRead: Buffer.byteLength(body), entries: 2, complete: false }]);
  expect(JSON.stringify(samples)).not.toContain('PRIVATE');
});
