import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {isolatedHookEnv,assertIsolatedHookPaths} from "./helpers/isolated-hook-env.js";
import {spawnSync} from "node:child_process";

const HOOKS_DIR = join(import.meta.dirname, "..", "plugin", "scripts");

function runHook(
  scriptName: string,
  stdin: string,
  env: Record<string, string>,
): Promise<{ exitCode: number | null }> {
  const home = mkdtempSync(join(tmpdir(), 'am-hook-child-'));
  let childEnv: NodeJS.ProcessEnv;
  try {
    childEnv = isolatedHookEnv(home, env);
    const probe = spawnSync(process.execPath, ['-e', "const out={nativeHome:require('node:os').homedir()};for(const k of ['HOME','USERPROFILE','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','AGENTMEMORY_HOME','AGENTMEMORY_RUNTIME_DIR','AGENTMEMORY_DATA_DIR','AGENTMEMORY_ENV_FILE','AGENTMEMORY_CAPTURE_SPOOL_DIR'])out[k]=process.env[k];process.stdout.write(JSON.stringify(out));"], { env: childEnv, cwd: home, encoding: 'utf8' });
    if (probe.error || probe.status !== 0) throw Error('test_child_preflight_failed');
    assertIsolatedHookPaths(home, JSON.parse(probe.stdout));
  } catch (error) {
    rmSync(home, {recursive:true,force:true});
    throw error;
  }
  return new Promise<{ exitCode: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(HOOKS_DIR, scriptName)], {
      env: childEnv,
      cwd: home,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode }));
    child.stdin.write(stdin);
    child.stdin.end();
  }).finally(() => rmSync(home, {recursive:true,force:true}));
}

describe("post-tool-use hook — capture filter", () => {
  let server: Server;
  let observeCalls = 0;
  let port = 0;
  let onObserve: (() => void) | undefined;

  afterEach(async () => {
    observeCalls = 0;
    onObserve = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  async function assertNoObserveAfterHook(
    hook: Promise<{ exitCode: number | null }>,
    { settleMs = 300 } = {},
  ): Promise<{ exitCode: number | null }> {
    const result = await hook;
    const deadline = Date.now() + settleMs;
    while (Date.now() < deadline) {
      if (observeCalls !== 0) {
        throw new Error(`unexpected observe call(s): ${observeCalls}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return result;
  }

  async function startServer() {
    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/agentmemory/observe") {
        observeCalls += 1;
        onObserve?.();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") port = addr.port;
        resolve();
      });
    });
  }

  it("does not observe memory_* MCP tools", async () => {
    await startServer();
    const payload = JSON.stringify({
      session_id: "ses_test",
      tool_name: "mcp__agentmemory__memory_smart_search",
      tool_input: { query: "hooks" },
      tool_output: "results",
    });
    const result = await assertNoObserveAfterHook(
      runHook("post-tool-use.mjs", payload, {
        AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(observeCalls).toBe(0);
  });

  it("still observes normal tools", async () => {
    await startServer();
    const payload = JSON.stringify({
      session_id: "ses_test",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_output: "ok",
    });
    const observeSeen = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("observe request never arrived")),
        2000,
      );
      onObserve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    const result = await runHook("post-tool-use.mjs", payload, {
      AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
    });
    await observeSeen;
    expect(result.exitCode).toBe(0);
    expect(observeCalls).toBe(1);
  });
});
