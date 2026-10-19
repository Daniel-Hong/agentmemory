import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { build } from "tsdown";
import { buildCodexCompat } from "../scripts/build-codex-compat.mjs";

const root = resolve(__dirname, "..");
let sandbox: string;
let server: Server;
let home: string;
let url: string;
let status: number;
let invalidReceipt: boolean;
let bootId: string;
const requests: Array<{ path: string; body: any }> = [];
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const event = { sessionId: "synthetic-legacy", project: "compat", cwd: "/tmp/compat", hookType: "post_tool_use", timestamp: "2026-10-15T00:00:00Z", data: { tool_output: "x".repeat(4501) } };

beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), "am compatibility artifacts "));
  cpSync(join(root, "integrations/codex-compat"), join(sandbox, "integrations/codex-compat"), { recursive: true });
  await build({ entry: [join(root, "src/hooks/_capture.ts")], outDir: join(sandbox, "plugin/scripts"), format: "esm", target: "node20", config: false, tsconfig: false, dts: false, clean: false, logLevel: "silent" });
  mkdirSync(join(sandbox, "dist/hooks"), { recursive: true });
  cpSync(join(sandbox, "plugin/scripts/_capture.mjs"), join(sandbox, "dist/hooks/_capture.mjs"));
  for (const directory of ["plugin/scripts", "dist/hooks"]) {
    for (const name of ["session-start.mjs", "pre-tool-use.mjs", "notification.mjs"]) writeFileSync(join(sandbox, directory, name), "stock sentinel " + name);
  }
  await buildCodexCompat(sandbox);
}, 30_000);
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
beforeEach(async () => {
  status = 201; invalidReceipt = false; bootId = "compatboot000001"; requests.length = 0;
  home = mkdtempSync(join(tmpdir(), "am-compat-home-"));
  vi.stubEnv("AGENTMEMORY_CAPTURE_SPOOL_DIR", join(home, "spool"));
  vi.stubEnv("AGENTMEMORY_CAPTURE_DRAIN_CHILD", "1");
  vi.stubEnv("AGENTMEMORY_CAPTURE_SPOOL", "true");
  server = createServer(async (req, res) => {
    let text = ""; for await (const part of req) text += part;
    expect(req.headers.authorization).toBe("Bearer synthetic-secret");
    requests.push({ path: req.url!, body: JSON.parse(text) });
    res.setHeader("content-type", "application/json");
    if (req.url === "/agentmemory/context") res.end(JSON.stringify({ context: "synthetic context" }));
    else if (req.url !== "/agentmemory/observe") res.end(JSON.stringify({ success: true }));
    else { res.statusCode = status; res.end(JSON.stringify(invalidReceipt ? { observationId: "synthetic-observation" } : status >= 400 ? { success: false, error: "synthetic-refusal" } : { status: status === 200 ? "duplicate" : "accepted", state: "completed", observationId: "synthetic-observation", bootId, durableAfterMs: 60_000 })); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
});
afterEach(async () => { await new Promise<void>(r => server.close(() => r())); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

function records(directory: string, match: (name: string) => boolean) {
  try { return readdirSync(directory).filter(match).flatMap(name => readFileSync(join(directory, name), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))); } catch { return []; }
}
async function client(directory = "plugin/scripts") {
  const module = await import(pathToFileURL(join(sandbox, directory, "codex-compat/long-session-hook-client.mjs")).href);
  return new module.HookClient({ url, dir: join(home, "legacy"), secret: "synthetic-secret" });
}
async function hook(name: string, input: unknown) {
  return await new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [join(sandbox, "plugin/scripts/codex-compat", name + ".mjs")], { env: { PATH: process.env.PATH ?? "", HOME: home, AGENTMEMORY_HOME: join(home, ".agentmemory"), AGENTMEMORY_URL: url, AGENTMEMORY_SECRET: "synthetic-secret", AGENTMEMORY_CAPTURE_SPOOL_DIR: join(home, "spool"), AGENTMEMORY_HOOK_INJECT_CONTEXT: "true" }, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", data => { output += data; }); child.on("error", reject); child.on("exit", code => resolveResult({ code, output })); child.stdin.end(JSON.stringify(input));
  });
}
async function drain() {
  return await new Promise<number | null>((resolveResult, reject) => {
    const captureUrl = pathToFileURL(join(sandbox, "plugin/scripts/codex-compat/_capture.mjs")).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `await (await import(${JSON.stringify(captureUrl)})).runDrainChild();`], { env: { PATH: process.env.PATH ?? "", HOME: home, AGENTMEMORY_URL: url, AGENTMEMORY_SECRET: "synthetic-secret", AGENTMEMORY_CAPTURE_SPOOL_DIR: join(home, "spool"), AGENTMEMORY_CAPTURE_DRAIN_CHILD: "1" }, stdio: "ignore" });
    child.on("error", reject); child.on("exit", resolveResult);
  });
}

describe("explicit custom compatibility build artifacts", () => {
  it("preserves stock hooks and manifests all nine wrappers plus both shared clients", async () => {
    const before = readFileSync(join(sandbox, "plugin/scripts/session-start.mjs"));
    await buildCodexCompat(sandbox);
    expect(readFileSync(join(sandbox, "plugin/scripts/session-start.mjs"))).toEqual(before);
    for (const directory of ["plugin/scripts", "dist/hooks"]) {
      expect(readFileSync(join(sandbox, directory, "pre-tool-use.mjs"), "utf8")).toBe("stock sentinel pre-tool-use.mjs");
      const manifest = JSON.parse(readFileSync(join(sandbox, directory, "codex-compat/manifest.json"), "utf8"));
      expect(Object.keys(manifest.deploymentMapping)).toHaveLength(10);
      expect(manifest.canonicalSha256).toBe("c73b82fe13910bb8106516c6af402235285a0d3dc6411f4c326d6e619ec91d42");
      for (const [name, digest] of Object.entries(manifest.files)) expect(sha(readFileSync(join(sandbox, directory, "codex-compat", name)))).toBe(digest);
    }
  });
  it.each(["plugin/scripts", "dist/hooks"])("hands old outbox ownership off once to retained official capture in %s", async directory => {
    const instance = await client(directory);
    await instance.enqueue("/agentmemory/observe", event);
    const old = records(join(home, "legacy"), n => n.endsWith(".json"))[0];
    expect(await instance.flush()).toBe(true);
    expect(records(join(home, "legacy"), n => n.endsWith(".json"))).toHaveLength(0);
    const sent = records(join(home, "spool"), n => n.includes(".sent-"));
    expect(sent).toHaveLength(1); expect(sent[0].body).toEqual(old.body); expect(sent[0].eventId).toBe(old.body.eventId);
    status = 200;
    await instance.enqueue("/agentmemory/observe", old.body);
    expect(await instance.flush()).toBe(true);
    expect(requests.map(r => r.body.eventId)).toEqual([old.body.eventId, old.body.eventId]);
  });
  it.each(["plugin/scripts", "dist/hooks"])("resolves the shared capture helper after manifest placement at existing top-level %s paths", async directory => {
    const manifest = JSON.parse(readFileSync(join(sandbox, directory, "codex-compat/manifest.json"), "utf8"));
    const deployed = join(sandbox, "deployed");
    for (const [target, source] of Object.entries({ ...manifest.deploymentMapping, ...manifest.sharedCaptureMapping }) as Array<[string, string]>) {
      mkdirSync(join(deployed, directory), { recursive: true }); cpSync(join(sandbox, source), join(deployed, target));
    }
    const module = await import(pathToFileURL(join(deployed, directory, "long-session-hook-client.mjs")).href);
    const instance = new module.HookClient({ url, dir: join(home, "legacy"), secret: "synthetic-secret" });
    expect(await instance.capture(event)).toBe(true);
    expect(records(join(home, "spool"), n => n.includes(".sent-"))[0].body.data).toEqual(event.data);
    expect(records(join(home, "legacy"), n => n.endsWith(".json"))).toHaveLength(0);
  });
  it("keeps old outbox raw and ID for a successful response lacking a durability receipt", async () => {
    invalidReceipt = true;
    const instance = await client(); await instance.enqueue("/agentmemory/observe", event);
    const original = records(join(home, "legacy"), n => n.endsWith(".json"))[0];
    expect(await instance.flush()).toBe(false);
    const kept = records(join(home, "legacy"), n => n.endsWith(".json"))[0];
    expect(kept.body).toEqual(original.body); expect(kept.attempts).toBe(1);
  });
  it("hands a 503 event to a managed spool with its full raw body and stable ID", async () => {
    status = 503;
    const instance = await client(); await instance.enqueue("/agentmemory/observe", event);
    const original = records(join(home, "legacy"), n => n.endsWith(".json"))[0];
    expect(await instance.flush()).toBe(true);
    expect(records(join(home, "legacy"), n => n.endsWith(".json"))).toHaveLength(0);
    const spool = records(join(home, "spool"), n => n.endsWith(".jsonl") && !n.includes(".sent-"));
    expect(spool).toHaveLength(1); expect(spool[0].body).toEqual(original.body); expect(spool[0].body.data.tool_output).toHaveLength(4501);
    status = 201; invalidReceipt = true;
    expect(await drain()).toBe(0);
    expect(records(join(home, "spool"), n => n.endsWith(".jsonl") && !n.includes(".sent-"))[0].eventId).toBe(original.body.eventId);
    invalidReceipt = false;
    expect(await drain()).toBe(0);
    expect(records(join(home, "spool"), n => n.includes(".sent-"))[0].body).toEqual(original.body);
    expect(records(join(home, "spool"), n => n.endsWith(".jsonl") && !n.includes(".sent-"))).toHaveLength(0);
    expect(requests.every(r => r.body.eventId === original.body.eventId)).toBe(true);
  });
  it("requeues retained legacy ownership under the same event ID when the server boot changes", async () => {
    const instance = await client();
    await instance.enqueue("/agentmemory/observe", event); expect(await instance.flush()).toBe(true);
    const firstId = requests[0].body.eventId;
    bootId = "compatboot000002";
    await instance.enqueue("/agentmemory/observe", { ...event, eventId: "compat-trigger-0002" }); expect(await instance.flush()).toBe(true);
    invalidReceipt = true;
    expect(await drain()).toBe(0);
    expect(records(join(home, "spool"), n => n.endsWith(".jsonl") && !n.includes(".sent-"))[0].eventId).toBe(firstId);
    invalidReceipt = false;
    expect(await drain()).toBe(0);
    const sent = records(join(home, "spool"), n => n.includes(".sent-"));
    expect(sent.every(r => r.bootId === bootId)).toBe(true);
    expect(sent.map(r => r.eventId).sort()).toEqual([firstId, "compat-trigger-0002"].sort());
    expect(requests.filter(r => r.body.eventId === firstId)).toHaveLength(3);
  });
  it("keeps original outbox when receipt retention is disabled", async () => {
    vi.stubEnv("AGENTMEMORY_CAPTURE_SPOOL", "false");
    const instance = await client(); await instance.enqueue("/agentmemory/observe", event);
    expect(await instance.flush()).toBe(false);
    expect(records(join(home, "legacy"), n => n.endsWith(".json"))[0].body.data).toEqual(event.data);
  });
  it("retains PreCompact collection while suppressing unsupported output and context lookup", async () => {
    const result = await hook("pre-compact", { session_id: "synthetic-precompact", cwd: home, trigger: "auto" });
    expect(result).toEqual({ code: 0, output: "" });
    await vi.waitFor(() => expect(requests.map(r => r.path)).toEqual(["/agentmemory/observe"]));
    expect(requests[0].body.hookType).toBe("pre_compact");
  });
  it.each([["session-start", "SessionStart"], ["prompt-submit", "UserPromptSubmit"], ["subagent-start", "SubagentStart"]])("retains supported JSON context marker for %s", async (name, eventName) => {
    const result = await hook(name, { session_id: "synthetic-context", cwd: home, userPrompt: "synthetic prompt" });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toEqual({ hookSpecificOutput: { hookEventName: eventName, additionalContext: "synthetic context" } });
  });
});

it('replays the last remote event after recovery without another hook',async()=>{
 status=503;const instance=await client();await instance.enqueue('/agentmemory/observe',event);
 const child=spawn(process.execPath,[join(sandbox,'plugin/scripts/codex-compat/long-session-hook-client.mjs'),'--drain',join(home,'legacy'),url],{env:{PATH:process.env.PATH??'',HOME:home,AGENTMEMORY_HOME:join(home,'.agentmemory'),AGENTMEMORY_URL:url,AGENTMEMORY_SECRET:'synthetic-secret',AGENTMEMORY_CAPTURE_SPOOL_DIR:join(home,'spool')},stdio:'ignore'});
 const exited=new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
 const safety=setTimeout(()=>child.kill('SIGKILL'),9000);
 try{
  await vi.waitFor(()=>{expect(requests.length).toBeGreaterThanOrEqual(2);expect(records(join(home,'legacy'),n=>n.endsWith('.json'))).toHaveLength(0);},{timeout:3000});
  status=201;
  await vi.waitFor(()=>expect(records(join(home,'spool'),n=>n.includes('.sent-'))).toHaveLength(1),{timeout:6000});
  expect(await exited).toBe(0);expect(requests.length).toBeGreaterThanOrEqual(3);
  expect(new Set(requests.map(r=>r.body.eventId)).size).toBe(1);
  expect(records(join(home,'spool'),n=>n.includes('.sent-'))[0].body.data).toEqual(event.data);
 }finally{clearTimeout(safety);child.kill('SIGKILL');await exited;}
},10000);
