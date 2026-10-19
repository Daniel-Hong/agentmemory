import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('CLI worker initialization boundary', () => {
  it('does not begin the readiness deadline while worker initialization is pending', async () => {
    const source = readFileSync('src/cli.ts', 'utf8');
    const start = source.indexOf('async function startWorkerForEngineState()');
    const body = source.slice(source.indexOf('{', start) + 1, source.indexOf('\n}\n', start));
    let initialized!: () => void;
    const workerReady = new Promise<void>(resolve => { initialized = resolve; });
    const run = new Function('readWorkerPidfile', 'pidAlive', 'configuredEngineMayStartWorker', 'waitForConfiguredWorker', 'loadWorker',
      'return (async()=>{' + body.replace(/: Promise<void>/g, '').replace('import("./index.js")', 'loadWorker()') + '})()');
    let returned = false;
    const result = run(() => null, () => false, () => false, async () => false, async () => ({ workerReady }))
      .then(() => { returned = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(returned).toBe(false);
    initialized(); await result;
    expect(returned).toBe(true);
    const worker = readFileSync('src/index.ts', 'utf8');
    expect(worker).toContain('export const workerReady = main();');
  });
});
