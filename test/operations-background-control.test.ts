import { describe, expect, it, vi } from "vitest";
import { createBackgroundControl, registerBackgroundControlApi } from "../src/ops/background-control.mjs";

function gate() { let resolve!: (value?: unknown) => void; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(saved: unknown = null) {
  let value = saved;
  const kv = { get: async () => value, set: async (_scope: string, _key: string, v: unknown) => { value = v; },
    durability: { wait: async (): Promise<any> => ({ synced: true, mutationFailures: 0 }), flushStable: async (): Promise<any> => ({ success: true }), keys: () => [], waitForKeys: async () => {} } };
  return { kv, saved: () => value };
}

describe("background transition status and safe diagnostics", () => {
  it("keeps cold-start admission closed until the crash guard reaches disk", async () => {
    const f = fixture({ paused: false }), disk = gate();
    f.kv.durability.waitForKeys = async () => { await disk.promise; };
    const control = createBackgroundControl(), initializing = control.init(f.kv);
    await tick();
    expect(control.snapshot()).toMatchObject({ status: "initializing", pausedRequested: true });
    expect(f.saved()).toEqual({ version:2, paused:false, resumePending:true, holds:[], recovery:{attempts:0,nextAttemptAt:0} });
    expect((await control.run(() => 42)).deferred).toBe(true);
    await expect(control.commitCleanShutdown()).rejects.toMatchObject({ code: "BACKGROUND_CLEAN_SHUTDOWN_UNSAFE" });
    disk.resolve(); await initializing;
    expect(control.snapshot()).toMatchObject({ status: "running", pausedRequested: false });
  });

  it("refuses clean error recovery while an admitted operation remains active", async () => {
    const f = fixture({ paused: false }), work = gate();
    const control = createBackgroundControl(); await control.init(f.kv);
    const running = control.run(() => work.promise);
    f.kv.set = async () => { throw Object.assign(Error("fixture_write_failed"), { code: "EACCES" }); };
    await expect(control.change("pause")).rejects.toThrow("background_storage_unavailable");
    expect(control.snapshot()).toMatchObject({ status: "error", pausedRequested: true, activeOperations: 1 });
    await expect(control.commitCleanShutdown()).rejects.toMatchObject({ code: "BACKGROUND_CLEAN_SHUTDOWN_UNSAFE" });
    work.resolve(); await running;
  });

  it("shows admitted work, worker drain, and disk confirmation separately with elapsed times", async () => {
    let now = 1000;
    const f = fixture(), work = gate(), publication = gate(), stable = gate(), disk = gate();
    f.kv.durability.wait = async () => { await stable.promise; await disk.promise; return { synced: true, mutationFailures: 0 }; };
    const control = createBackgroundControl({ clock: () => now });
    await control.init(f.kv, () => publication.promise);
    f.kv.durability.waitForKeys = async () => { await disk.promise; };
    const task = control.run(() => work.promise);
    await control.change("pause");
    now = 1700;
    expect(control.snapshot()).toMatchObject({ status: "pausing", activeOperations: 1, transition: { action: "pause", stage: "active_work", startedAt: 1000, elapsedMs: 700, stageElapsedMs: 700 } });
    expect((await control.run(() => 42)).deferred).toBe(true);
    work.resolve(); await task; await tick();
    expect(control.snapshot().transition.stage).toBe("worker_drain");
    now = 2700; publication.resolve(); await tick();
    expect(control.snapshot().transition).toMatchObject({ stage: "storage", stageStartedAt: 2700 });
    stable.resolve({ success: true }); await tick();
    expect(control.snapshot().status).toBe("pausing");
    now = 3700; disk.resolve(); await control.settled();
    expect(control.snapshot()).toMatchObject({ status: "paused", transition: { stage: "complete", completedAt: 3700, elapsedMs: 2700 } });
    now = 10_000; expect(control.snapshot().transition.elapsedMs).toBe(2700);
  });

  it("shows resuming and keeps admission closed until request and disk confirmation finish", async () => {
    const f = fixture({ paused: true }), request = gate(), disk = gate();
    f.kv.set = async () => { await request.promise; };
    f.kv.durability.waitForKeys = async () => { await disk.promise; };
    const control = createBackgroundControl(); await control.init(f.kv);
    const resume = control.change("resume"); await tick();
    expect(control.snapshot()).toMatchObject({ status: "resuming", pausedRequested: true, transition: { action: "resume", stage: "request" } });
    expect((await control.run(() => 42)).deferred).toBe(true);
    request.resolve(); await tick();
    expect(control.snapshot()).toMatchObject({ status: "resuming", pausedRequested: true, transition: { stage: "storage" } });
    await expect(control.infer(() => 42)).rejects.toMatchObject({ providerUnavailable: true, code: "BACKGROUND_PAUSED" });
    disk.resolve(); await resume;
    expect(control.snapshot()).toMatchObject({ status: "running", pausedRequested: false, transition: { stage: "complete" } });
    expect(await control.run(() => 42)).toBe(42);
  });

  it.each(["pause", "resume"])("keeps safe returned storage diagnostics when %s fails", async action => {
    const f = fixture(action === "resume" ? { paused: true } : null);
    f.kv.durability.wait = async () => { throw Object.assign(Error("synthetic storage failure"), { code: "STATE_DURABILITY_TIMEOUT", diagnostics: {
      category: "state_durability", errorCode: "STATE_NAMESPACE_NOT_COMMITTED", stage: "capture", keyCount: 9, scopeCount: 2, capturedKeyCount: 3, elapsedMs: 50, waitMs: 50,
      namespace: "/PRIVATE_PATH", sourceRaw: "PRIVATE_RAW", token: "PRIVATE_TOKEN",
    } }); };
    const control = createBackgroundControl(); await control.init(f.kv);
    if (action === "resume") await expect(control.change(action)).rejects.toThrow("background_storage_unavailable");
    else { await control.change(action); await control.settled(); }
    const snapshot = control.snapshot();
    expect(snapshot).toMatchObject({ status: "error", pausedRequested: true, error: "background_storage_unavailable", diagnostics: {
      errorCode: "STATE_DURABILITY_TIMEOUT", causeCode: "STATE_NAMESPACE_NOT_COMMITTED", category: "state_durability", stage: "capture", keyCount: 9, scopeCount: 2, capturedKeyCount: 3, elapsedMs: 50, waitMs: 50,
    } });
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
    expect(f.saved()).toEqual({version:2,paused:true,resumePending:true,holds:action==='resume'?['legacy_unknown','storage_error']:['manual','storage_error'],recovery:{attempts:0,nextAttemptAt:0}});
    expect((await control.run(() => 42)).deferred).toBe(true);
  });

  it("retains a thrown write failure code and blocks admission if resume rollback also fails", async () => {
    const f = fixture({ paused: true });
    let calls = 0;
    f.kv.set = async () => { calls++; throw Object.assign(Error("PRIVATE_FILE_CONTENT"), { code: calls === 1 ? "EACCES" : "EROFS" }); };
    const control = createBackgroundControl(); await control.init(f.kv);
    await expect(control.change("resume")).rejects.toThrow("background_storage_unavailable");
    expect(control.snapshot()).toMatchObject({ status: "error", pausedRequested: true, diagnostics: { errorCode: "EACCES", rollbackErrorCode: "EROFS", stage: "request" } });
    expect(JSON.stringify(control.snapshot())).not.toContain("PRIVATE_FILE_CONTENT");
  });

  it("exposes resuming on GET and retains a safe failure in the POST error body", async () => {
    const f = fixture({ paused: true }), disk = gate(), handlers = new Map<string, any>();
    f.kv.durability.waitForKeys = async () => { await disk.promise; throw Object.assign(Error("PRIVATE_STORAGE_DETAILS"), {
      code: "STATE_DURABILITY_TIMEOUT", diagnostics: { category: "state_durability", stage: "verify", errorCode: "STATE_NOT_COMMITTED", keyCount: 2, capturedKeyCount: 2, elapsedMs: 50 },
    }); };
    const control = createBackgroundControl(); await control.init(f.kv);
    registerBackgroundControlApi({ registerFunction: (id: string, handler: any) => handlers.set(id, handler), registerTrigger: () => {} }, "fixture", control);
    const request = { headers: { authorization: "Bearer fixture", "x-agentmemory-background": "1", "content-type": "application/json" }, body: { action: "resume" } };
    const posting = handlers.get("api::background-control-set")(request); await tick();
    const reading = await handlers.get("api::background-control-get")(request);
    expect(reading).toMatchObject({ status_code: 200, body: { control: { status: "resuming", pausedRequested: true, transition: { stage: "storage" } } } });
    disk.resolve();
    const failed = await posting;
    expect(failed).toMatchObject({ status_code: 503, body: { success: false, control: { status: "error", pausedRequested: true, diagnostics: { errorCode: "STATE_DURABILITY_TIMEOUT", causeCode: "STATE_NOT_COMMITTED", stage: "verify", capturedKeyCount: 2, elapsedMs: 50 } } } });
    expect(JSON.stringify(failed)).not.toContain("PRIVATE_STORAGE_DETAILS");
  });

  it("exposes the storage failure while the pause rollback acknowledgement is still waiting", async () => {
    const f = fixture({ paused: true }), rollback = gate();
    let pauseWrites = 0;
    f.kv.set = async (_scope, _key, value: any) => { if (value.paused && ++pauseWrites > 1) await rollback.promise; };
    f.kv.durability.wait = async () => { throw Object.assign(Error("synthetic storage failure"), { code: "STATE_DURABILITY_TIMEOUT" }); };
    const control = createBackgroundControl(); await control.init(f.kv);
    const resuming = control.change("resume"); await tick();
    expect(control.snapshot()).toMatchObject({ status: "error", pausedRequested: true, diagnostics: { errorCode: "STATE_DURABILITY_TIMEOUT", stage: "storage" } });
    expect((await control.run(() => 42)).deferred).toBe(true);
    rollback.resolve(); await expect(resuming).rejects.toThrow("background_storage_unavailable");
  });
});


it('certifies all preceding writes once through wait without a duplicate stable flush',async()=>{
 const f=fixture({paused:true}),whole=vi.fn(async()=>({synced:true,mutationFailures:0})),legacy=vi.fn(async()=>({success:true}));
 f.kv.durability.wait=whole;f.kv.durability.flushStable=legacy;const pair=vi.spyOn(f.kv.durability,'waitForKeys');
 const control=createBackgroundControl();await control.init(f.kv);await control.change('resume');
 expect(whole).toHaveBeenCalledOnce();expect(legacy).not.toHaveBeenCalled();expect(pair).toHaveBeenCalledTimes(2);
});
it.each([undefined,{}, {synced:false,mutationFailures:0},{synced:true,mutationFailures:1},{synced:true}, {synced:true,mutationFailures:Number.NaN}])('keeps resume admission closed for an uncertified full wait result %j',async result=>{
 const f=fixture({paused:true});f.kv.durability.wait=async()=>result;const control=createBackgroundControl();await control.init(f.kv);
 await expect(control.change('resume')).rejects.toThrow('background_storage_unavailable');expect(control.snapshot()).toMatchObject({status:'error',pausedRequested:true,diagnostics:{phase:'resume_storage',precedingWritesVerified:false,rollbackVerified:true}});
 expect(f.saved()).toEqual({version:2,paused:true,resumePending:true,holds:['legacy_unknown','storage_error'],recovery:{attempts:0,nextAttemptAt:0}});
});
it('fails closed when the full-dirty wait API is unavailable',async()=>{
 const f=fixture({paused:true});delete (f.kv.durability as any).wait;const control=createBackgroundControl();await control.init(f.kv);
 await expect(control.change('resume')).rejects.toThrow('background_storage_unavailable');expect(control.snapshot()).toMatchObject({status:'error',pausedRequested:true});
});
