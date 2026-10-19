import { availableParallelism } from 'node:os';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';

// Linux affinity respects cpusets; cgroup quotas can further restrict it, including fractional cores.
export async function getCpuCapacityCores({ platform = process.platform, parallelism = availableParallelism, read = path => readFile(path, 'utf8') } = {}) {
  try {
    let cores = parallelism();
    if (!Number.isFinite(cores) || cores <= 0) return null;
    if (platform !== 'linux') return cores;
    const membership = (await read('/proc/self/cgroup')).split('\n').find(line => line.startsWith('0::'));
    if (!membership) return null;
    const group = membership.slice(3);
    if (!group.startsWith('/') || group.split('/').some(part => part === '..' || part === '.')) return null;
    const mounts = (await read('/proc/self/mountinfo')).split('\n').filter(line => line.includes(' - cgroup2 '));
    const decode = value => value.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    let mount;
    for (const line of mounts) {
      const fields = line.split(' ');
      const root = decode(fields[3]);
      if (root === '/' || group === root || group.startsWith(root + '/')) {
        if (!mount || root.length > mount.root.length) mount = { root, path: decode(fields[4]) };
      }
    }
    if (!mount) return null;
    const suffix = mount.root === '/' ? group : group.slice(mount.root.length);
    const leaf = posix.join(mount.path, suffix);
    try {
      const cpuset = (await read(posix.join(leaf, 'cpuset.cpus.effective'))).trim();
      if (cpuset) {
        let count = 0;
        let previousEnd = -1;
        for (const part of cpuset.split(',')) {
          const match = /^(\d+)(?:-(\d+))?$/.exec(part);
          if (!match) return null;
          const start = Number(match[1]);
          const end = Number(match[2] ?? match[1]);
          if (!Number.isSafeInteger(end) || end < start || start <= previousEnd) return null;
          count += end - start + 1;
          previousEnd = end;
        }
        cores = Math.min(cores, count);
      }
    } catch (err) { if (err.code !== 'ENOENT') return null; }
    let directory = leaf;
    while (true) {
      let value;
      try { value = (await read(posix.join(directory, 'cpu.max'))).trim(); }
      catch (err) {
        if (err.code !== 'ENOENT') return null;
        // A disabled local CPU controller has no cpu.max; verify the group and inspect its ancestors.
        if (directory !== mount.path) await read(posix.join(directory, 'cgroup.events'));
      }
      if (value !== undefined) {
        const match = /^(max|\d+)\s+(\d+)$/.exec(value);
        if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0) return null;
        if (match[1] !== 'max') {
          if (!Number.isSafeInteger(Number(match[1]))) return null;
          const quotaCores = Number(match[1]) / Number(match[2]);
          if (!Number.isFinite(quotaCores) || quotaCores <= 0) return null;
          cores = Math.min(cores, quotaCores);
        }
      }
      if (directory === mount.path) break;
      directory = posix.dirname(directory);
    }
    return Number.isFinite(cores) && cores > 0 ? cores : null;
  } catch { return null; }
}
