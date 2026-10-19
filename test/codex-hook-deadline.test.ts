import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { HookClient, runHook } from "../integrations/codex-compat/long-session-hook-client.mjs";

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "am-hook-deadline-")); dirs.push(dir); return dir; };
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const input = { session_id: "synthetic-deadline", cwd: "/tmp", tool_output: "synthetic-raw" };

// A foreground flush of the existing backlog would fail these tests.
describe("Codex foreground durable handoff", () => {
  it.each(["PostToolUse", "PostToolUseFailure", "Stop", "PreCompact", "SessionStart", "SessionEnd", "UserPromptSubmit", "SubagentStart", "SubagentStop"])("queues %s without transmitting the backlog", async event => {
    vi.stubEnv("AGENTMEMORY_HOOK_INJECT_CONTEXT", "false");
    const dir = fixture();
    const client = new HookClient({ dir, url: "http://127.0.0.1:1", secret: "" });
    client.flush = async () => { throw Error("foreground backlog transmission"); };
    await runHook(event, { ...input, last_assistant_message: "synthetic response" }, client, "synthetic-project");
    const files = readdirSync(dir).filter(name => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
    expect(record.body.sessionId).toBe(input.session_id);
    expect(record.body.eventId).toBeTypeOf("string");
    if (record.path === "/agentmemory/observe") expect(record.body.data.tool_output).toBe(input.tool_output);
  });

  it("does not mark ownership durable when the outbox cannot be written", async () => {
    const dir = fixture(); const unavailable = join(dir, "outbox"); writeFileSync(unavailable, "synthetic obstruction");
    const client = new HookClient({ dir: unavailable, url: "http://127.0.0.1:1", secret: "" });
    await expect(client.enqueue("/agentmemory/observe", { sessionId: input.session_id })).rejects.toThrow();
    expect(client.durableQueued).not.toBe(true);
  });

  it("preserves context injection after durable prompt enqueue", async () => {
    const dir = fixture(); const client = new HookClient({ dir, url: "http://127.0.0.1:1", secret: "" });
    client.flush = async () => { throw Error("foreground backlog transmission"); };
    client.context = async () => {
      expect(readdirSync(dir).filter(name => name.endsWith(".json"))).toHaveLength(1);
      return "synthetic-context";
    };
    expect(JSON.parse(await runHook("UserPromptSubmit", input, client, "synthetic-project"))).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "synthetic-context" } });
  });

  it.each([
    ["UserPromptSubmit", "HookClient.prototype.context = async function () { this.onPhase?.('context'); await new Promise(() => setInterval(() => {}, 1000)); };", "context", 5500],
    ["PostToolUse", "setInterval(() => {}, 1000);", "complete", 5500],
    ["SessionEnd", "const enqueue=HookClient.prototype.enqueue; HookClient.prototype.enqueue = async function (...args) { await enqueue.apply(this,args); this.onPhase?.('retained'); await new Promise(() => setInterval(() => {}, 1000)); };", "retained", 2800],
  ])("returns %s before its host deadline after durable handoff even when later work stalls", async (event, setup, phase, budget) => {
    const dir = fixture();
    writeFileSync(join(dir, "client.mjs"), `globalThis.fetch = async () => { throw Error('unexpected fixture HTTP'); };\n` + readFileSync(join(process.cwd(), "integrations/codex-compat/long-session-hook-client.mjs"), "utf8"));
    writeFileSync(join(dir, "entry.mjs"), `import { HookClient, hookMain } from './client.mjs'; ${setup} await hookMain('${event}');`);
    writeFileSync(join(dir, "_capture.mjs"), `export const runDrainChild=async()=>{ globalThis.fetch=async()=>new Response(JSON.stringify({success:true})); }; export const handoffObservation=async()=> { await new Promise(r=>setTimeout(r,100)); return 'delivered'; };`);
    writeFileSync(join(dir, "input.json"), JSON.stringify(input));
    const inputFd = openSync(join(dir, "input.json"), "r"); const errorPath = join(dir, "stderr"); const errorFd = openSync(errorPath, "w");
    const started = Date.now();
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [join(dir, "entry.mjs")], { env: { PATH: process.env.PATH, HOME: dir, AGENTMEMORY_HOME: dir, AGENTMEMORY_URL: "http://127.0.0.1:1", AGENTMEMORY_PROJECT_NAME: "synthetic-project" }, stdio: [inputFd, "ignore", errorFd] });
      const safety = setTimeout(() => child.kill('SIGKILL'), 6500);
      child.on("error", reject); child.on("exit", (code, signal) => { clearTimeout(safety); resolve({ code, signal }); });
    });
    closeSync(inputFd); closeSync(errorFd);
    expect(result).toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(budget);
    expect(readFileSync(errorPath, "utf8")).toMatch(new RegExp(`deadline phase=${phase} elapsedMs=\\d+ durable=true`));
    await vi.waitFor(() => expect(readdirSync(join(dir, "hook-outbox")).filter(name => name.endsWith(".json"))).toHaveLength(0));
  }, 8000);

  it("reports phase timings without copying the payload or session into diagnostics", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "client.mjs"), `globalThis.fetch = async () => { throw Error('unexpected fixture HTTP'); };\n` + readFileSync(join(process.cwd(), "integrations/codex-compat/long-session-hook-client.mjs"), "utf8"));
    writeFileSync(join(dir, "entry.mjs"), `import { hookMain } from './client.mjs'; await hookMain('PostToolUse');`);
    writeFileSync(join(dir, "_capture.mjs"), `export const isDrainChild=()=>false; export const runDrainChild=async()=>{}; export const handoffObservation=async()=> 'delivered';`);
    writeFileSync(join(dir, "input.json"), JSON.stringify(input));
    const inputFd = openSync(join(dir, "input.json"), "r");
    const errorPath = join(dir, "stderr");
    const errorFd = openSync(errorPath, "w");
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [join(dir, "entry.mjs")], { env: { PATH: process.env.PATH, HOME: dir, AGENTMEMORY_HOME: dir, AGENTMEMORY_URL: "http://127.0.0.1:1", AGENTMEMORY_PROJECT_NAME: "synthetic-project", AGENTMEMORY_HOOK_DIAGNOSTICS: "1" }, stdio: [inputFd, "ignore", errorFd] });
      child.on("error", reject); child.on("exit", code => resolve({ code, stderr: readFileSync(errorPath, "utf8") }));
    });
    closeSync(inputFd); closeSync(errorFd);
    expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(result.stderr).toMatch(/phase=enqueue elapsedMs=\d+/);
    expect(result.stderr).toMatch(/phase=queue_fsync elapsedMs=\d+/);
    if (process.platform !== "win32") expect(result.stderr).toMatch(/phase=queue_directory_fsync elapsedMs=\d+/);
    expect(result.stderr).toMatch(/phase=complete elapsedMs=\d+/);
    expect(result.stderr).not.toContain(input.session_id);
    expect(result.stderr).not.toContain(input.tool_output);
    // Await the detached worker before removing its synthetic home.
    await vi.waitFor(() => expect(readdirSync(join(dir, "hook-outbox")).filter(name => name.endsWith(".json"))).toHaveLength(0));
  });
});

it('keeps a remote managed retry worker alive without another legacy event',async()=>{
 const dir=fixture();
 writeFileSync(join(dir,'client.mjs'),readFileSync(join(process.cwd(),'integrations/codex-compat/long-session-hook-client.mjs'),'utf8'));
 writeFileSync(join(dir,'_capture.mjs'),`import {appendFileSync} from 'node:fs';let calls=0;export async function runDrainChild(){calls++;appendFileSync(${JSON.stringify(join(dir,'calls'))},'probe\\n');return {remaining:calls<2?1:0};}`);
 const result=await new Promise<number|null>((resolve,reject)=>{
  const child=spawn(process.execPath,[join(dir,'client.mjs'),'--drain',dir,'http://127.0.0.1:1'],{env:{PATH:process.env.PATH,HOME:dir,AGENTMEMORY_HOME:dir},stdio:'ignore'});
  const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolve(code);});
 });
 expect(result).toBe(0);expect(readFileSync(join(dir,'calls'),'utf8').trim().split('\n')).toHaveLength(2);
});
