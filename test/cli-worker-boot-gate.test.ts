import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { transpileModule, ScriptTarget, ModuleKind } from 'typescript';
import { startWorkerAndWait } from '../src/cli/readiness.js';

describe('CLI worker initialization boundary', () => {
  it('waits for worker initialization before probing readiness', async () => {
    const source = readFileSync('src/cli.ts', 'utf8');
    const start = source.indexOf('async function startWorkerForEngineState(');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\nfunction configuredEngineMayStartWorker(', start);
    expect(end).toBeGreaterThan(start);
    const output = transpileModule(source.slice(start, end).replace('import("./index.js")', 'loadWorker()'), {
      compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ES2022 },
    }).outputText;
    let initialized!: () => void;
    const workerReady = new Promise<void>(resolve => { initialized = resolve; });
    const probe = vi.fn(async () => true), finishStartup = vi.fn();
    const dependencies = {
      readEngineState: () => null, startupTimeouts: () => ({ workerMs: 1000 }),
      startWorkerAndWait, readWorkerPidfile: () => null, pidAlive: () => false,
      configuredEngineMayStartWorker: () => false, loadWorker: async () => ({ workerReady }),
      workerReadinessProbe: probe, startupInterrupted: false, engineStartupFailed: () => false,
      finishStartup,
    };
    const run = new Function('deps', `const {${Object.keys(dependencies).join(',')}} = deps;
      let startupWorkerFailure = null, importedStartupWorker = false;
      ${output}; return startWorkerForEngineState;`)(dependencies);
    let returned = false;
    const result = run().then(() => { returned = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(returned).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(finishStartup).not.toHaveBeenCalled();
    initialized(); await result;
    expect(returned).toBe(true);
    expect(probe).toHaveBeenCalledOnce();
    expect(finishStartup).toHaveBeenCalledOnce();
    const worker = readFileSync('src/index.ts', 'utf8');
    expect(worker).toContain('export const workerReady = main();');
  });
});
