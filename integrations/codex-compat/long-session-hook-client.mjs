import { readFile, readdir, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const baseDir = () => join(process.env.AGENTMEMORY_HOME || join(homedir(), '.agentmemory'));
export async function hydrateHookEnvironment() {
  try {
    const text = await readFile(join(baseDir(), '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
async function atomicJson(path, data, onPhase) {
  const temp = path + '.' + randomUUID() + '.tmp';
  onPhase?.('queue_open');
  const fd = await open(temp, 'wx', 0o600);
  try {
    onPhase?.('queue_write'); await fd.writeFile(JSON.stringify(data));
    onPhase?.('queue_fsync'); await fd.sync();
  } finally { await fd.close(); }
  onPhase?.('queue_rename');
  await rename(temp, path);
  if (process.platform !== "win32") {
    onPhase?.('queue_directory_fsync');
    const directory = await open(join(path, ".."), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
const activeTickets = new Set();
async function acquireLock(path) {
  const dir = path + '.tickets';
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const file = join(dir, token + '.json');
  const mine = { token, pid: process.pid, choosing: true, ticket: 0 };
  activeTickets.add(token);
  async function tickets() {
    const result = [];
    for (const name of (await readdir(dir)).filter(x => x.endsWith('.json'))) {
      try {
        const value = JSON.parse(await readFile(join(dir, name), 'utf8'));
        if (!processAlive(value.pid) || value.pid === process.pid && !activeTickets.has(value.token)) {
          await unlink(join(dir, name)).catch(() => {}); continue;
        }
        result.push(value);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return result;
  }
  try {
    await atomicJson(file, mine);
    mine.ticket = Math.max(0, ...(await tickets()).map(x => x.ticket)) + 1;
    mine.choosing = false; await atomicJson(file, mine);
    const deadline = Date.now() + 150;
    while (true) {
      const others = (await tickets()).filter(x => x.token !== token);
      if (!others.some(x => x.choosing || x.ticket < mine.ticket || x.ticket === mine.ticket && x.token < token)) return { file, token };
      if (Date.now() >= deadline) { await unlink(file); activeTickets.delete(token); return null; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  } catch (e) { await unlink(file).catch(() => {}); activeTickets.delete(token); throw e; }
}
async function releaseLock(lock) { await unlink(lock.file).catch(() => {}); activeTickets.delete(lock.token); }
export class HookClient {
  constructor({ url = process.env.AGENTMEMORY_URL || 'http://127.0.0.1:3111', dir = join(baseDir(), 'hook-outbox'), timeoutMs = 1200, secret = process.env.AGENTMEMORY_SECRET || '' } = {}) {
    this.url = url.replace(/\/$/, ''); this.dir = dir; this.timeoutMs = timeoutMs; this.secret = secret;
  }
  headers() { return { 'content-type': 'application/json', ...this.secret ? { authorization: 'Bearer ' + this.secret } : {} }; }
  async enqueue(path, body) {
    this.onPhase?.('enqueue');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const eventId = body.eventId ?? randomUUID();
    const file = join(this.dir, `${Date.now()}-${process.hrtime.bigint().toString().padStart(24, "0")}-${eventId}.json`);
    await atomicJson(file, { path, body: { ...body, eventId }, enqueuedAt: new Date().toISOString() }, this.onPhase);
    this.durableQueued = true;
    return file;
  }
  async capture(body) { await this.enqueue('/agentmemory/observe', body); return this.flush(); }
  async flush({ limit = 8, budgetMs = 1500 } = {}) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const lock = await acquireLock(join(this.dir, '.flush.lock'));
    if (!lock) return false;
    const started = Date.now();
    try {
      const files = (await readdir(this.dir)).filter(x => x.endsWith('.json')).sort();
      const blockedSessions = new Set();
      let complete = true;
      let attempted = 0;
      for (const name of files) {
        if (Date.now() - started >= budgetMs) return false;
        const path = join(this.dir, name);
        let record;
        try {
          record = JSON.parse(await readFile(path, 'utf8'));
          if (!record.body || typeof record.path !== 'string') throw Error('invalid outbox record');
        } catch (e) {
          if (e.code === 'ENOENT') continue;
          await rename(path, path + '.corrupt'); complete = false; continue;
        }
        if (blockedSessions.has(record.body.sessionId) || record.nextAttemptAt > Date.now()) { blockedSessions.add(record.body.sessionId); complete = false; continue; }
        if (attempted >= limit) return false;
        attempted++;
        try {
          if (record.path === '/agentmemory/observe') {
            const { handoffObservation } = await import('./_capture.mjs');
            const outcome = await handoffObservation(record.body, this.timeoutMs, { url: this.url, headers: this.headers() });
            if (!['delivered', 'duplicate', 'spooled'].includes(outcome)) throw Error('capture handoff not confirmed: ' + outcome);
          } else {
            const response = await fetch(this.url + record.path, { method: 'POST', headers: this.headers(), body: JSON.stringify(record.body), signal: AbortSignal.timeout(this.timeoutMs) });
            if (!response.ok) throw Error('HTTP ' + response.status);
            const result = await response.json();
            if (result.success === false || result.error) throw Error('session request not acknowledged');
          }
          await unlink(path);
        } catch (e) {
          record.attempts = (record.attempts ?? 0) + 1;
          record.lastError = String(e); record.nextAttemptAt = Date.now() + Math.min(300000, 1000 * 2 ** Math.min(record.attempts - 1, 8));
          await atomicJson(path, record);
          blockedSessions.add(record.body.sessionId); complete = false;
        }
      }
      return complete;
    } finally { await releaseLock(lock); }
  }
  async context(sessionId, project) {
    this.onPhase?.('context');
    const cache = join(this.dir, `context-${Buffer.from(project).toString('hex')}.cache`);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const response = await fetch(this.url + '/agentmemory/context', { method: 'POST', headers: this.headers(), body: JSON.stringify({ sessionId, project, budget: 2000 }), signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) throw Error('context unavailable');
      const result = await response.json();
      const context = typeof result.context === 'string' ? result.context : '';
      await atomicJson(cache, { context, at: new Date().toISOString() }); return context;
    } catch {
      try {
        const old = JSON.parse(await readFile(cache, 'utf8'));
        return old.context ? `[AgentMemory cached context from ${old.at}; server unavailable]\n${old.context}` : '';
      } catch { return ''; }
    }
  }
  async startDrain() {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--drain', this.dir, this.url], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
    child.unref();
  }
}
function projectFor(cwd) {
  if (process.env.AGENTMEMORY_PROJECT_NAME) return process.env.AGENTMEMORY_PROJECT_NAME.trim();
  try { return basename(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 500 }).trim()); }
  catch { return basename(cwd); }
}
export async function runHook(event, data, client = new HookClient(), projectOverride) {
  if (process.env.AGENTMEMORY_SDK_CHILD === '1' || data.entrypoint === 'sdk-ts') return '';
  const sessionId = data.session_id || data.sessionId || data.conversation_id;
  if (typeof sessionId !== 'string' || !sessionId) return '';
  const cwd = data.cwd || data.workspace_roots?.[0] || process.cwd();
  client.onPhase?.('project');
  const project = projectOverride ?? projectFor(cwd);
  const base = { sessionId, cwd, project, timestamp: new Date().toISOString() };
  if (event === 'SessionStart') {
    await client.enqueue('/agentmemory/session/start', { sessionId, cwd, project });
  } else if (event === 'SessionEnd') {
    await client.enqueue('/agentmemory/session/end', { sessionId, hookEventName: 'SessionEnd' });
  } else {
    const map = { UserPromptSubmit: 'prompt_submit', PostToolUse: 'post_tool_use', PostToolUseFailure: 'post_tool_failure', Stop: 'agent_response', SubagentStart: 'subagent_start', SubagentStop: 'subagent_stop', PreCompact: 'pre_compact' };
    if (map[event]) {
      const captureData = { ...data, tool_name: data.tool_name ?? data.toolName,
        tool_input: data.tool_input ?? data.toolArgs,
        tool_output: data.tool_response ?? data.tool_output ?? data.tool_result ?? data.toolResult,
        prompt: data.prompt ?? data.userPrompt, message: data.last_assistant_message };
      if (event !== 'Stop' || captureData.message) await client.enqueue('/agentmemory/observe', { ...base, hookType: map[event], data: captureData });
    }
  }
  if (['SessionStart', 'UserPromptSubmit', 'SubagentStart'].includes(event) && process.env.AGENTMEMORY_HOOK_INJECT_CONTEXT !== 'false') {
    const context = await client.context(sessionId, project);
    if (context) return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
  }
  return '';
}
export async function hookMain(event) {
  const started = Date.now();
  let phase = 'environment';
  const mark = next => {
    phase = next;
    if (process.env.AGENTMEMORY_HOOK_DIAGNOSTICS === '1') process.stderr.write(`[AgentMemory hook] phase=${phase} elapsedMs=${Date.now() - started}\n`);
  };
  let client;
  // Never claim success before file and directory fsync confirm ownership.
  const deadline = setTimeout(async () => {
    process.stderr.write(`[AgentMemory hook] deadline phase=${phase} elapsedMs=${Date.now() - started} durable=${client?.durableQueued === true}\n`);
    if (client?.durableQueued) {
      try { await client.startDrain(); } catch { process.stderr.write('[AgentMemory hook] retry worker unavailable; durable outbox retained\n'); }
      process.exit(0);
    }
  }, event === 'SessionEnd' ? 2000 : 4500);
  deadline.unref();
  try {
    await hydrateHookEnvironment();
    client = new HookClient();
    client.onPhase = mark;
    if (process.env.AGENTMEMORY_CAPTURE_DRAIN_CHILD === '1') {
      clearTimeout(deadline);
      await (await import('./_capture.mjs')).runDrainChild(); return;
    }
    mark('input');
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const output = await runHook(event, JSON.parse(input), client);
    if (output) await new Promise((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
    if (client.durableQueued) { mark('drain'); await client.startDrain(); }
    mark('complete');
  } catch (error) { clearTimeout(deadline); throw error; }
}

async function drain(dir, url) {
  // This worker owns retries; do not spawn a competing one-shot drainer.
  process.env.AGENTMEMORY_CAPTURE_DRAIN_CHILD = '1';
  const client = new HookClient({ dir, url, timeoutMs: 5000 });
  const lock = await acquireLock(join(dir, '.worker.lock'));
  if (!lock) return;
  try {
    const capture = await import('./_capture.mjs');
    let managed = await capture.runDrainChild();
    let delay = 1000;
    while ((await readdir(dir)).some(x => x.endsWith('.json')) || managed?.remaining > 0) {
      const ok = await client.flush({ limit: 100, budgetMs: 15000 });
      managed = await capture.runDrainChild();
      if (ok && !managed?.remaining) delay = 1000; else delay = Math.min(60000, delay * 2);
      if ((await readdir(dir)).some(x => x.endsWith('.json')) || managed?.remaining > 0) await new Promise(resolve => setTimeout(resolve, delay));
    }
  } finally { await releaseLock(lock); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.env.AGENTMEMORY_CAPTURE_DRAIN_CHILD === '1') {
  await hydrateHookEnvironment();
  await (await import('./_capture.mjs')).runDrainChild();
} else if (process.argv[2] === '--drain') {
  await hydrateHookEnvironment();
  await drain(process.argv[3], process.argv[4]);
}
