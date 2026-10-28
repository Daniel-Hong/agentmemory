import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { nativeCompatOptions, nativeCompatIdentityMatches, nativeCompatWorkerIdentityMatches, nativeCompatCleanupAction, renderNativeCompatConfig } from "../src/cli/native-compat.js";

const ports = { restPort: 3211, streamPort: 3212, viewerPort: 3213, enginePort: 49234 };
const seed = stringify({ workers: [
  { name: "iii-worker-manager", config: { port: 49134, host: "127.0.0.1" } },
  { name: "iii-http", config: { port: 3111 } },
  { name: "iii-state", config: { adapter: { name: "kv", config: { store_method: "file_based", file_path: "./data/state_store.db", save_interval_ms: 2000 } } } },
  { name: "iii-stream", config: { port: 3112, adapter: { name: "kv", config: { store_method: "file_based", file_path: "./data/stream_store", save_interval_ms: 2000 } } } },
  { name: "iii-exec", config: { exec: ["node dist/index.mjs"] } },
] });

describe("explicit native 0.22.1 compatibility", () => {
  it("does nothing unless explicitly selected", () => {
    expect(nativeCompatOptions([], {})).toBeNull();
  });
  it("requires explicit absolute binary and seed config paths with no version override", () => {
    expect(() => nativeCompatOptions(["--native-compat"], {})).toThrow(/AGENTMEMORY_NATIVE_III_BIN/);
    expect(() => nativeCompatOptions(["--native-compat"], { AGENTMEMORY_NATIVE_III_BIN: "iii", AGENTMEMORY_III_CONFIG: "/tmp/seed.yaml" })).toThrow(/absolute/);
    expect(() => nativeCompatOptions(["--native-compat", "--no-engine"], {})).toThrow(/no-engine/);
    expect(() => nativeCompatOptions(["--native-compat"], { AGENTMEMORY_NATIVE_III_BIN: "/tmp/iii", AGENTMEMORY_III_CONFIG: "/tmp/seed.yaml", AGENTMEMORY_III_VERSION: "0.25.0" })).toThrow(/0.22.1/);
    expect(() => nativeCompatOptions(["--native-compat"], { AGENTMEMORY_NATIVE_III_BIN: "/tmp/iii", AGENTMEMORY_III_CONFIG: "/tmp/seed.yaml", III_ENGINE_URL: "ws://remote:49134" })).toThrow(/loopback/);
    expect(nativeCompatOptions(["--native-compat"], { AGENTMEMORY_NATIVE_III_BIN: "/tmp/iii", AGENTMEMORY_III_CONFIG: "/tmp/seed.yaml" })).toEqual({ binPath: "/tmp/iii", configPath: "/tmp/seed.yaml" });
  });
  it("renders file stores and ports while preventing seed-owned worker execution", () => {
    const result = parse(renderNativeCompatConfig(seed, "/tmp/native-data", ports));
    expect(result.workers[0].config.port).toBe(49234);
    expect(result.workers.some((worker: any) => worker.name === "iii-exec")).toBe(false);
    expect(result.workers[1].config.port).toBe(3211);
    expect(result.workers[2].config.adapter.config.file_path).toBe("/tmp/native-data/state_store.db");
    expect(result.workers[3].config.port).toBe(3212);
    expect(result.workers[3].config.adapter.config.file_path).toBe("/tmp/native-data/stream_store");
    expect(result.workers[2].config.adapter.config.save_interval_ms).toBe(2000);
  });
  it("rejects missing builtin state and non-file state rather than falling back", () => {
    expect(() => renderNativeCompatConfig("workers: []", "/tmp/data", ports)).toThrow(/iii-state/);
    expect(() => renderNativeCompatConfig(seed.replaceAll("file_based", "redis"), "/tmp/data", ports)).toThrow(/file_based/);
  });
});

describe("native compatibility identity", () => {
  it("requires exact executable, config argument and process start identity", () => {
    const state = { binPath: "/tmp/iii", configPath: "/tmp/runtime.yaml", processStart: "123" };
    expect(nativeCompatIdentityMatches(state, "/tmp/iii", ["/tmp/iii", "--config", "/tmp/runtime.yaml", "--no-update-check"], "123")).toBe(true);
    expect(nativeCompatIdentityMatches(state, "/tmp/foreign", ["/tmp/iii", "--config", "/tmp/runtime.yaml"], "123")).toBe(false);
    expect(nativeCompatIdentityMatches(state, "/tmp/iii", ["/tmp/iii", "--config", "/tmp/other.yaml"], "123")).toBe(false);
    expect(nativeCompatIdentityMatches(state, "/tmp/iii", ["/tmp/iii", "--config", "/tmp/runtime.yaml"], "124")).toBe(false);
  });
});

describe("native seed boundaries", () => {
  it("requires a configured engine listener instead of implicit engine defaults", () => {
    const config = parse(seed);
    config.workers.shift();
    expect(() => renderNativeCompatConfig(stringify(config), "/tmp/data", ports)).toThrow(/iii-worker-manager/);
  });
});

describe("native CLI rejection", () => {
  it("rejects a synthetic 0.25 binary without invoking its lifecycle or Compose", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "native-cli-rejection-"));
    try {
      const home = join(dir, "home");
      mkdirSync(join(home, ".agentmemory"), { recursive: true });
      writeFileSync(join(home, ".agentmemory", "preferences.json"), JSON.stringify({ schemaVersion: 1, firstRunAt: "2026-01-01", skipSplash: true }));
      const bin = join(dir, "iii");
      const log = join(dir, "invocations");
      writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nprintf 'iii 0.25.0\\n'\n`, { mode: 0o755 });
      const config = join(dir, "seed.yaml");
      writeFileSync(config, seed);
      const envFile = join(dir, "empty.env");
      writeFileSync(envFile, "");
      const port = 18111;
      const enginePort = 49111;
      const viewerPort = 18113;
      const result = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "--native-compat", "--port", String(port)], {
        cwd: process.cwd(), encoding: "utf8", timeout: 15000,
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: dir,
          XDG_CONFIG_HOME: join(dir, "config"), XDG_CACHE_HOME: join(dir, "cache"), XDG_DATA_HOME: join(dir, "xdg-data"),
          AGENTMEMORY_ENV_FILE: envFile, AGENTMEMORY_DATA_DIR: join(dir, "data"), AGENTMEMORY_RUNTIME_DIR: join(dir, "runtime"),
          AGENTMEMORY_CAPTURE_SPOOL_DIR: join(dir, "spool"), AGENTMEMORY_NATIVE_III_BIN: bin, AGENTMEMORY_III_CONFIG: config,
          III_ENGINE_PORT: String(enginePort), III_VIEWER_PORT: String(viewerPort), AGENTMEMORY_METRICS_PORT: "24464",
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain("must report iii-engine 0.22.1");
      expect(readFileSync(log, "utf8").trim()).toBe("--version");
      expect(existsSync(join(home, ".agentmemory", "engine-state.json"))).toBe(false);
      expect(existsSync(join(dir, "data", "iii-config.runtime.yaml"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("native worker ownership", () => {
  const identity = { pid: 1234, executable: "/tmp/node", argvSha256: createHash("sha256").update(JSON.stringify(["/tmp/node", "--import", "tsx", "/tmp/cli.ts", "--native-compat"])).digest("hex"), processStart: "900" };
  it("accepts only the exact worker identity recorded from our tracked worker", () => {
    expect(nativeCompatWorkerIdentityMatches(identity, 1234, identity)).toBe(true);
  });
  it.each([
    [undefined, 1234, identity],
    [identity, 5678, identity],
    [identity, 1234, { ...identity, processStart: "901" }],
    [identity, 1234, { ...identity, executable: "/tmp/other-node" }],
    [identity, 1234, { ...identity, argvSha256: createHash("sha256").update(JSON.stringify(["/tmp/node", "/tmp/other.ts"])).digest("hex") }],
    [identity, 1234, undefined],
  ])("refuses absent, reused or foreign worker evidence without relying on the pidfile", (expected, pidfile, current) => {
    expect(nativeCompatWorkerIdentityMatches(expected, pidfile, current)).toBe(false);
  });
});

describe("native stop worker preflight", () => {
  it("signals neither synthetic child and preserves state for missing, reused and forged worker identities", async () => {
    const fs = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawn, spawnSync } = await import("node:child_process");
    const dir = fs.mkdtempSync(join(tmpdir(), "native-stop-identity-"));
    const home = join(dir, "home");
    const runtime = join(home, ".agentmemory");
    fs.mkdirSync(runtime, { recursive: true });
    const config = join(dir, "seed.yaml");
    const envFile = join(dir, "empty.env");
    fs.writeFileSync(config, "workers: []\n");
    fs.writeFileSync(envFile, "");
    const marker = join(dir, "signals");
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: dir,
      AGENTMEMORY_ENV_FILE: envFile, AGENTMEMORY_III_CONFIG: config, AGENTMEMORY_DATA_DIR: join(dir, "data"),
      AGENTMEMORY_RUNTIME_DIR: runtime, AGENTMEMORY_CAPTURE_SPOOL_DIR: join(dir, "spool"), III_ENGINE_PORT: "49111" };
    const trap = `process.on('SIGTERM',()=>{require('fs').appendFileSync(${JSON.stringify(marker)},'signal\\n');process.exit(0)});`;
    const engine = spawn(process.execPath, ["--eval", trap + "require('http').createServer((req,res)=>res.end('fixture')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})", "--", "--config", config], { env, stdio: ["ignore", "pipe", "pipe"] });
    const worker = spawn(process.execPath, ["--eval", trap + "console.log('ready');setInterval(()=>{},1000)"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const start = (pid: number) => { const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19]; };
    try {
      const port = await new Promise<number>((done, reject) => { engine.stdout.once("data", chunk => done(Number(String(chunk).trim()))); engine.once("error", reject); });
      await new Promise<void>((done, reject) => { worker.stdout.once("data", () => done()); worker.once("error", reject); });
      const ownWorker = { pid: worker.pid!, executable: fs.readlinkSync(`/proc/${worker.pid}/exe`), processStart: start(worker.pid!), argvSha256: createHash("sha256").update(JSON.stringify(fs.readFileSync(`/proc/${worker.pid}/cmdline`, "utf8").split("\0").filter(Boolean))).digest("hex") };
      const base = { kind: "native", compatVersion: "0.22.1", binPath: fs.readlinkSync(`/proc/${engine.pid}/exe`), configPath: config, processStart: start(engine.pid!), restPort: port, enginePort: 49111 };
      for (const [workerIdentity, pidfile] of [[undefined, worker.pid!], [{ ...ownWorker, processStart: "0" }, worker.pid!], [ownWorker, engine.pid!]] as const) {
        const state = JSON.stringify({ ...base, workerIdentity });
        fs.writeFileSync(join(runtime, "engine-state.json"), state);
        fs.writeFileSync(join(runtime, "iii.pid"), String(engine.pid));
        fs.writeFileSync(join(runtime, "worker.pid"), String(pidfile));
        const result = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "stop", "--port", String(port)], { env, cwd: process.cwd(), encoding: "utf8", timeout: 15000 });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain("worker identity is absent or changed");
        expect(fs.existsSync(marker)).toBe(false);
        expect(fs.readFileSync(join(runtime, "engine-state.json"), "utf8")).toBe(state);
        expect(fs.readFileSync(join(runtime, "worker.pid"), "utf8")).toBe(String(pidfile));
      }
      const stateFile = join(runtime, "engine-state.json");
      fs.writeFileSync(stateFile, JSON.stringify(base));
      fs.writeFileSync(join(runtime, "worker.pid"), String(worker.pid));
      const preload = join(dir, "remove-state-after-first-read.mjs");
      fs.writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const read=fs.readFileSync;fs.readFileSync=function(path,...args){const value=read.call(this,path,...args);if(String(path)===${JSON.stringify(stateFile)})fs.unlinkSync(path);return value};syncBuiltinESMExports();`);
      const raced = spawnSync(process.execPath, ["--import", preload, "--import", "tsx", resolve("src/cli.ts"), "stop", "--native-compat", "--force", "--port", String(port)], { env, cwd: process.cwd(), encoding: "utf8", timeout: 15000 });
      expect(raced.error).toBeUndefined();
      expect(raced.status).toBe(1);
      expect(raced.stdout + raced.stderr).toContain("worker identity is absent or changed");
      expect(fs.existsSync(marker)).toBe(false);
      fs.writeFileSync(stateFile, JSON.stringify({ ...base, workerIdentity: ownWorker }));
      const calls = join(dir, "attempted-signals");
      const expiryPreload = join(dir, "remove-state-on-signal.mjs");
      fs.writeFileSync(expiryPreload, `import fs from 'node:fs';const now=Date.now;let advance=0;Date.now=()=>now()+(advance+=700000);const kill=process.kill;process.kill=function(pid,signal){if(pid===${worker.pid}&&(signal==='SIGTERM'||signal==='SIGKILL')){fs.appendFileSync(${JSON.stringify(calls)},signal+'\\n');if(fs.existsSync(${JSON.stringify(stateFile)}))fs.unlinkSync(${JSON.stringify(stateFile)});return true}return kill.call(this,pid,signal)};`);
      const expired = spawnSync(process.execPath, ["--import", expiryPreload, "--import", "tsx", resolve("src/cli.ts"), "stop", "--force", "--port", String(port)], { env, cwd: process.cwd(), encoding: "utf8", timeout: 15000 });
      expect(expired.error).toBeUndefined();
      expect(expired.status).toBe(1);
      expect(fs.readFileSync(calls, "utf8")).toContain("SIGTERM");
      expect(fs.readFileSync(calls, "utf8")).not.toContain("SIGKILL");
      expect(fs.existsSync(marker)).toBe(false);
      fs.writeFileSync(stateFile, JSON.stringify({ ...base, workerIdentity: ownWorker, flushWaitMs: 12000 }));
      const waitLog = join(dir, "publication-waits");
      const flushPreload = join(dir, "mock-drain-and-capture-wait.mjs");
      fs.writeFileSync(flushPreload, `import fs from 'node:fs';const kill=process.kill;const gone=new Set();process.kill=function(pid,signal){if(signal===0&&gone.has(pid))throw Object.assign(Error('gone'),{code:'ESRCH'});if((pid===${worker.pid}||pid===${engine.pid})&&(signal==='SIGTERM'||signal==='SIGKILL')){fs.appendFileSync(${JSON.stringify(calls)},signal+'\\n');if(signal==='SIGTERM'){gone.add(pid);if(pid===${worker.pid}){fs.writeFileSync(${JSON.stringify(join(runtime, "shutdown-receipt.json"))},JSON.stringify({pid,at:new Date().toISOString(),completed:true,verified:false,durability:{completion:'sdk',completed:true,synced:false,mutationFailures:0}}));if(fs.existsSync(${JSON.stringify(stateFile)}))fs.unlinkSync(${JSON.stringify(stateFile)})}}return true}return kill.call(this,pid,signal)};const timeout=globalThis.setTimeout;globalThis.setTimeout=(callback,ms,...args)=>{if(ms>=3000){fs.appendFileSync(${JSON.stringify(waitLog)},String(ms)+'\\n');return timeout(callback,0,...args)}return timeout(callback,ms,...args)};`);
      const flushed = spawnSync(process.execPath, ["--import", flushPreload, "--import", "tsx", resolve("src/cli.ts"), "stop", "--force", "--port", String(port)], { env, cwd: process.cwd(), encoding: "utf8", timeout: 15000 });
      expect(flushed.error).toBeUndefined();
      expect(flushed.status).toBe(0);
      expect(fs.readFileSync(waitLog, "utf8").trim().split("\n").map(Number)).toContain(12000);
      expect(fs.readFileSync(calls, "utf8")).not.toContain("SIGKILL");
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      for (const child of [worker, engine]) { child.kill("SIGTERM"); await new Promise<void>(done => child.exitCode !== null ? done() : child.once("exit", () => done())); }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});

describe("native failed-start cleanup", () => {
  it("never signals an exited engine or an engine without pinned identity", () => {
    expect(nativeCompatCleanupAction(false, false, true)).toBe("exited");
    expect(nativeCompatCleanupAction(true, false, false)).toBe("preserve");
    expect(nativeCompatCleanupAction(true, false, true)).toBe("terminate");
  });
  it("preserves engine and metadata when a worker began and drain is not verified", () => {
    expect(nativeCompatCleanupAction(true, true, true)).toBe("preserve");
  });
});

describe("native startup prior ownership", () => {
  it("refuses a live prior worker with missing/changed pidfile and unresolved metadata before probing or spawning the binary", async () => {
    const fs = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawn, spawnSync } = await import("node:child_process");
    const { createServer } = await import("node:net");
    const dir=fs.mkdtempSync(join(tmpdir(),"native-prior-worker-")),home=join(dir,"home"),runtime=join(home,".agentmemory"),config=join(dir,"seed.yaml"),envFile=join(dir,"empty.env"),marker=join(dir,"signals"),binLog=join(dir,"binary-calls"),bin=join(dir,"iii");
    fs.mkdirSync(runtime,{recursive:true});fs.writeFileSync(config,seed);fs.writeFileSync(envFile,"");fs.writeFileSync(join(runtime,"preferences.json"),JSON.stringify({schemaVersion:1,firstRunAt:"2026-01-01",skipSplash:true}));
    fs.writeFileSync(bin,`#!/bin/sh\nprintf 'called' >> '${binLog}'\nprintf '0.22.1\\n'\n`,{mode:0o755});
    const env={PATH:process.env.PATH,HOME:home,USERPROFILE:home,TMPDIR:dir,AGENTMEMORY_ENV_FILE:envFile,AGENTMEMORY_III_CONFIG:config,AGENTMEMORY_NATIVE_III_BIN:bin,AGENTMEMORY_DATA_DIR:join(dir,"data"),AGENTMEMORY_RUNTIME_DIR:runtime,AGENTMEMORY_CAPTURE_SPOOL_DIR:join(dir,"spool"),III_ENGINE_PORT:"49111"};
    const child=spawn(process.execPath,["--eval",`process.on('SIGTERM',()=>{require('fs').appendFileSync(${JSON.stringify(marker)},'signal');process.exit(0)});console.log('ready');setInterval(()=>{},1000)`],{env,stdio:["ignore","pipe","pipe"]});
    try {
      await new Promise<void>((done,reject)=>{child.stdout.once("data",()=>done());child.once("error",reject)});
      const listener=createServer();await new Promise<void>((done,reject)=>{listener.once("error",reject);listener.listen(0,"127.0.0.1",done)});const port=(listener.address()as{port:number}).port;await new Promise<void>(done=>listener.close(()=>done()));
      const raw=fs.readFileSync(`/proc/${child.pid}/stat`,"utf8"),processStart=raw.slice(raw.lastIndexOf(")")+2).split(/\s+/)[19];
      const workerIdentity={pid:child.pid!,processStart,executable:fs.readlinkSync(`/proc/${child.pid}/exe`),argvSha256:createHash("sha256").update(JSON.stringify(fs.readFileSync(`/proc/${child.pid}/cmdline`,"utf8").split("\0").filter(Boolean))).digest("hex")};
      const prior={kind:"native",compatVersion:"0.22.1",workerIdentity,configPath:config,restPort:port};
      for(const [saved,pidfile] of [[JSON.stringify(prior),undefined],[JSON.stringify(prior),"99999999"],["{malformed",undefined],[JSON.stringify({kind:"unknown"}),undefined],[JSON.stringify({...prior,workerIdentity:undefined}),undefined]]as const){
        fs.writeFileSync(join(runtime,"engine-state.json"),saved);if(pidfile)fs.writeFileSync(join(runtime,"worker.pid"),pidfile);else fs.rmSync(join(runtime,"worker.pid"),{force:true});
        const result=spawnSync(process.execPath,["--import","tsx",resolve("src/cli.ts"),"--native-compat","--port",String(port)],{env,cwd:process.cwd(),encoding:"utf8",timeout:15000});
        expect(result.error).toBeUndefined();expect(result.status).toBe(1);expect(result.stdout+result.stderr).toContain("prior lifecycle");expect(fs.existsSync(binLog)).toBe(false);expect(fs.existsSync(marker)).toBe(false);expect(fs.readFileSync(join(runtime,"engine-state.json"),"utf8")).toBe(saved);
      }
      for(const saved of [undefined,"{malformed",JSON.stringify({kind:"unknown"})]){
        if(saved)fs.writeFileSync(join(runtime,"engine-state.json"),saved);else fs.rmSync(join(runtime,"engine-state.json"),{force:true});fs.writeFileSync(join(runtime,"worker.pid"),String(child.pid));
        const result=spawnSync(process.execPath,["--import","tsx",resolve("src/cli.ts"),"stop","--native-compat","--force","--port",String(port)],{env,cwd:process.cwd(),encoding:"utf8",timeout:15000});
        expect(result.error).toBeUndefined();expect(result.status).toBe(1);expect(result.stdout+result.stderr).toContain("requires valid compatibility lifecycle state");expect(fs.existsSync(marker)).toBe(false);
      }
      const unsupported=JSON.stringify({...prior,compatVersion:"unsupported"});fs.writeFileSync(join(runtime,"engine-state.json"),unsupported);
      const rejected=spawnSync(process.execPath,["--import","tsx",resolve("src/cli.ts"),"stop","--force","--port",String(port)],{env,cwd:process.cwd(),encoding:"utf8",timeout:15000});
      expect(rejected.error).toBeUndefined();expect(rejected.status).toBe(1);expect(rejected.stdout+rejected.stderr).toContain("Unsupported native compatibility lifecycle version");expect(fs.existsSync(marker)).toBe(false);expect(fs.readFileSync(join(runtime,"engine-state.json"),"utf8")).toBe(unsupported);
    }finally{child.kill("SIGTERM");await new Promise<void>(done=>child.exitCode!==null?done():child.once("exit",()=>done()));fs.rmSync(dir,{recursive:true,force:true});}
  },20000);
});
