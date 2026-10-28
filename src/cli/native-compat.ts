import { isAbsolute, join, resolve } from "node:path";
import { parse, stringify } from "yaml";

export const NATIVE_COMPAT_VERSION = "0.22.1";

export function nativeCompatOptions(args: string[], env: NodeJS.ProcessEnv): { binPath: string; configPath: string } | null {
  if (!args.includes("--native-compat")) return null;
  if (args.includes("--no-engine")) throw new Error("--native-compat cannot be combined with --no-engine.");
  if (env.AGENTMEMORY_III_VERSION && env.AGENTMEMORY_III_VERSION !== NATIVE_COMPAT_VERSION) {
    throw new Error("--native-compat requires iii-engine 0.22.1; remove the conflicting version override.");
  }
  for (const value of [env.III_ENGINE_URL, env.III_URL]) {
    if (!value) continue;
    const url = new URL(value);
    if (url.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
      throw new Error("Native compatibility requires a local loopback ws engine URL.");
    }
    if (env.III_ENGINE_URL && env.III_URL && env.III_ENGINE_URL !== env.III_URL) throw new Error("Native compatibility engine URLs must agree.");
  }
  const binPath = env.AGENTMEMORY_NATIVE_III_BIN;
  const configPath = env.AGENTMEMORY_III_CONFIG;
  if (!binPath || !isAbsolute(binPath)) throw new Error("--native-compat requires an absolute AGENTMEMORY_NATIVE_III_BIN path to an installed iii-engine 0.22.1.");
  if (!configPath || !isAbsolute(configPath)) throw new Error("--native-compat requires an absolute AGENTMEMORY_III_CONFIG seed path.");
  return { binPath, configPath };
}

export function renderNativeCompatConfig(seed: string, dataDir: string, ports: { restPort: number; streamPort: number; viewerPort: number; enginePort: number }): string {
  const config = parse(seed);
  if (!config || !Array.isArray(config.workers)) throw new Error("Native seed must contain builtin workers, including iii-state.");
  for (const port of Object.values(ports)) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Native listener ports must be valid TCP ports.");
  }
  if (new Set(Object.values(ports)).size !== 4) throw new Error("Native listener ports must be distinct.");
  const worker = (name: string) => {
    const matches = config.workers.filter((entry: any) => entry?.name === name);
    if (matches.length !== 1 || !matches[0].config) throw new Error(`Native seed requires exactly one ${name} builtin worker.`);
    return matches[0].config;
  };
  for (const [name, filename] of [["iii-state", "state_store.db"], ["iii-stream", "stream_store"]]) {
    const store = worker(name!).adapter;
    if (store?.name !== "kv" || store.config?.store_method !== "file_based") throw new Error(`Native ${name} must use kv file_based storage.`);
    const previous = store.config.file_path;
    if (typeof previous !== "string" || !previous) throw new Error(`Native ${name} requires a file_path.`);
    store.config.file_path = join(dataDir, filename!);
  }
  worker("iii-http").port = ports.restPort;
  worker("iii-http").host = "127.0.0.1";
  worker("iii-stream").port = ports.streamPort;
  worker("iii-stream").host = "127.0.0.1";
  worker("iii-worker-manager").host = "127.0.0.1";
  worker("iii-worker-manager").port = ports.enginePort;
  config.workers = config.workers.filter((entry: any) => entry?.name !== "iii-exec");
  return stringify(config);
}

export function nativeCompatIdentityMatches(state: { binPath?: string; configPath: string; processStart?: string }, executable: string, argv: string[], processStart: string): boolean {
  const index = argv.indexOf("--config");
  return Boolean(state.binPath && state.processStart && state.processStart === processStart &&
    executable && resolve(executable) === resolve(state.binPath) && index >= 0 &&
    argv[index + 1] === state.configPath);
}

export interface NativeCompatWorkerIdentity { pid: number; executable: string; argvSha256: string; processStart: string }
export function nativeCompatWorkerIdentityMatches(expected: NativeCompatWorkerIdentity | undefined, pidfile: number | null, current: NativeCompatWorkerIdentity | undefined): boolean {
  return Boolean(expected && current && Number.isSafeInteger(expected.pid) && expected.pid > 0 &&
    expected.pid === pidfile && current.pid === expected.pid && /^\d+$/.test(expected.processStart) &&
    expected.processStart === current.processStart && expected.executable && expected.executable === current.executable &&
    /^[a-f0-9]{64}$/.test(expected.argvSha256) && expected.argvSha256 === current.argvSha256);
}

export function nativeCompatCleanupAction(engineRunning: boolean, workerStarted: boolean, identityMatches: boolean): "exited" | "preserve" | "terminate" {
  if (workerStarted) return "preserve";
  if (!engineRunning) return "exited";
  return identityMatches ? "terminate" : "preserve";
}
