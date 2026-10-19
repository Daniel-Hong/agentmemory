import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { transpileModule, ScriptTarget, ModuleKind } from "typescript";

function fixture({ running = false, verified = false, missingReceipt = false, workerStops = true, engineStops = true, receiptAt = "fresh" as string | number | null } = {}) {
  const source = readFileSync("src/cli.ts", "utf8");
  const helperStart = source.indexOf("async function stopWorkerPid("), helperEnd = source.indexOf("\ntype NativeRemovalStopResult", helperStart);
  const start = source.indexOf("async function runStop("), end = source.indexOf("async function runMcp(", start);
  const output = transpileModule(source.slice(helperStart, helperEnd) + source.slice(start, end), { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ES2022 } }).outputText;
  const p = { intro: vi.fn(), outro: vi.fn(), log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }, spinner: () => ({ start: vi.fn(), stop: vi.fn() }) };
  let generatedReceiptAt: string | undefined;
  const dependencies = {
    p, args: [], IS_WINDOWS: false, SHUTDOWN_HARD_EXIT_MS: 6000,
    assertRuntimePortOwnership: vi.fn(async () => {}), getRestPort: () => 3111,
    readEngineState: () => ({ kind: "native" }), isEngineRunning: async () => running,
    findEnginePidsByPort: () => running ? [202] : [], readEnginePidfile: () => running ? 202 : null, readWorkerPidfile: () => 101,
    clearEnginePidfile: vi.fn(), clearEngineState: vi.fn(), clearWorkerPidfile: vi.fn(),
    signalAndWait: vi.fn(async (pid: number) => { if (pid === 101) generatedReceiptAt = new Date().toISOString(); return pid === 101 ? workerStops : engineStops; }), waitForEngineFlush: vi.fn(async () => {}),
    readFileSync: () => { if (missingReceipt) throw Error("fixture missing receipt"); return JSON.stringify({ pid: 101, at: receiptAt === "fresh" ? generatedReceiptAt : receiptAt, verified, durability: { synced: verified, mutationFailures: 0 } }); },
    runtimeMetadataPath: (name: string) => `/fixture/${name}`, discoverComposeFile: () => null,
    pidCommand: () => "iii", isForeignPortHolder: () => false, stopDockerEngine: vi.fn(),
    process: { exit: vi.fn((code: number) => { throw Error(`exit:${code}`); }) },
  };
  const load = new Function("deps", `const {${Object.keys(dependencies).join(",")}} = deps; ${output}; return runStop;`);
  return { ...dependencies, run: load(dependencies) as () => Promise<void> };
}

afterEach(() => vi.restoreAllMocks());

describe("CLI worker durability verification", () => {
  it.each([false, true])("preserves orphan metadata when the receipt cannot certify writes (missing=%s)", async (missingReceipt) => {
    const f = fixture({ missingReceipt });
    await expect(f.run()).rejects.toThrow("exit:1");
    expect(f.signalAndWait).toHaveBeenCalledOnce();
    expect(f.signalAndWait.mock.calls[0].slice(0, 2)).toEqual([101, "SIGTERM"]);
    expect(f.clearWorkerPidfile).not.toHaveBeenCalled(); expect(f.clearEnginePidfile).not.toHaveBeenCalled(); expect(f.clearEngineState).not.toHaveBeenCalled();
    expect(f.p.outro).not.toHaveBeenCalled();
    expect(JSON.stringify(f.p.log.error.mock.calls)).toContain("uncertain");
  });

  it("refuses to stop an available engine when worker drain or receipt verification fails", async () => {
    const f = fixture({ running: true });
    await expect(f.run()).rejects.toThrow("exit:1");
    expect(f.signalAndWait).toHaveBeenCalledOnce(); expect(f.signalAndWait.mock.calls[0][0]).toBe(101);
    expect(f.waitForEngineFlush).not.toHaveBeenCalled();
    expect(f.clearWorkerPidfile).not.toHaveBeenCalled(); expect(f.clearEnginePidfile).not.toHaveBeenCalled(); expect(f.clearEngineState).not.toHaveBeenCalled();
  });

  it("keeps the engine and metadata when the worker does not exit", async () => {
    const f = fixture({ running: true, verified: true, workerStops: false });
    await expect(f.run()).rejects.toThrow("exit:1");
    expect(f.signalAndWait).toHaveBeenCalledOnce(); expect(f.waitForEngineFlush).not.toHaveBeenCalled();
    expect(f.clearWorkerPidfile).not.toHaveBeenCalled(); expect(f.clearEnginePidfile).not.toHaveBeenCalled(); expect(f.clearEngineState).not.toHaveBeenCalled();
  });

  it("keeps metadata when an engine does not exit after verified worker shutdown", async () => {
    const f = fixture({ running: true, verified: true, engineStops: false });
    await expect(f.run()).rejects.toThrow("exit:1");
    expect(f.signalAndWait.mock.calls.map(call => call[0])).toEqual([101, 202]);
    expect(f.clearWorkerPidfile).not.toHaveBeenCalled(); expect(f.clearEnginePidfile).not.toHaveBeenCalled(); expect(f.clearEngineState).not.toHaveBeenCalled();
  });

  it.each([
    ["stale", new Date(Date.now() - 60000).toISOString()],
    ["malformed", "not-a-timestamp"],
    ["missing", null],
    ["numeric", Date.now()],
    ["future", new Date(Date.now() + 60000).toISOString()],
  ])("refuses a %s timestamp even when the receipt has the same PID and success flags", async (_kind, receiptAt) => {
    const f = fixture({ running: true, verified: true, receiptAt });
    await expect(f.run()).rejects.toThrow("exit:1");
    expect(f.signalAndWait).toHaveBeenCalledOnce(); expect(f.waitForEngineFlush).not.toHaveBeenCalled();
    expect(f.clearWorkerPidfile).not.toHaveBeenCalled(); expect(f.clearEnginePidfile).not.toHaveBeenCalled(); expect(f.clearEngineState).not.toHaveBeenCalled();
  });

  it("fails closed when the system clock moves backward during worker shutdown", async () => {
    const f = fixture({ running: true, verified: true, receiptAt: new Date(1500).toISOString() });
    vi.spyOn(Date, "now").mockReturnValueOnce(2000).mockReturnValueOnce(1000);
    await expect(f.run()).rejects.toThrow("exit:1");
    expect(f.signalAndWait).toHaveBeenCalledOnce(); expect(f.waitForEngineFlush).not.toHaveBeenCalled();
    expect(f.clearWorkerPidfile).not.toHaveBeenCalled(); expect(f.clearEnginePidfile).not.toHaveBeenCalled(); expect(f.clearEngineState).not.toHaveBeenCalled();
  });

  it("clears orphan metadata only after the worker's durable receipt is verified", async () => {
    const f = fixture({ verified: true }); await f.run();
    expect(f.process.exit).not.toHaveBeenCalled();
    expect(f.clearWorkerPidfile).toHaveBeenCalledOnce(); expect(f.clearEnginePidfile).toHaveBeenCalledOnce(); expect(f.clearEngineState).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.p.outro.mock.calls)).toContain("persisted");
  });

  it("stops a healthy engine only after verifying the worker's durable receipt", async () => {
    const f = fixture({ running: true, verified: true }); await f.run();
    expect(f.signalAndWait.mock.calls.map(call => call[0])).toEqual([101, 202]);
    expect(f.waitForEngineFlush).toHaveBeenCalledOnce(); expect(f.process.exit).not.toHaveBeenCalled();
  });
});
