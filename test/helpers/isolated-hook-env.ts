import { isAbsolute, join, relative, sep } from 'node:path';

const paths = {
  HOME: '', USERPROFILE: '', XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache',
  AGENTMEMORY_HOME: 'runtime', AGENTMEMORY_RUNTIME_DIR: 'runtime', AGENTMEMORY_DATA_DIR: 'data/agentmemory',
  AGENTMEMORY_ENV_FILE: 'runtime/.env', AGENTMEMORY_CAPTURE_SPOOL_DIR: 'spool',
};

export function isolatedHookEnv(root: string, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  if (!isAbsolute(root)) throw Error('test_root_required');
  for (const key of Object.keys(paths)) if (overrides[key] !== undefined) throw Error('test_path_override_refused');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', AGENTMEMORY_SECRET: '', AGENTMEMORY_URL: 'http://127.0.0.1:1', ...overrides };
  for (const [key, suffix] of Object.entries(paths)) env[key] = join(root, suffix);
  return env;
}

export function assertIsolatedHookPaths(root: string, actual: Record<string, string>): void {
  for (const key of [...Object.keys(paths), 'nativeHome']) {
    const path = actual[key];
    if (typeof path !== 'string' || !isAbsolute(path)) throw Error('test_child_path_missing');
    const child = relative(root, path);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw Error('test_child_path_escaped');
  }
}
