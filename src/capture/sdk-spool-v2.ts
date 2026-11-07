import type { Stats } from 'node:fs';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const MiB = 1024 * 1024;
const BLOCK = 4096;
const INPUT_LIMIT = 8 * MiB;
const ORIGINAL_LIMIT = 256 * MiB;
const QUEUE_LIMIT = 5 * MiB;
const QUEUE_TRANSITION_RESERVE = 2 * BLOCK;
const ACK_TRANSITION_RESERVE = 64 * 1024 + BLOCK;
const CHUNK_LIMIT = 256 * 1024;
const ID = /^[a-f0-9]{64}$/;
type Owner = { pid: number; start: string; boot: string };
type Ref = { v: 2; targetHash: string; sourceId: string; state: 'pending' | 'sending' | 'held'; attempts: number; nextAttemptAt: number; owner?: Owner; reason?: 'RETRY' | 'HELD' | 'UNKNOWN_SEND' };
type Manifest = { v: 2; sourceId: string; targetHash: string; eventId: string; bytes: number; hash: string; chunks: Array<{ name: string; bytes: number; hash: string }>; conflict: boolean; completed: boolean };
// Optional deadline uses performance.now(); omitted callers retain the 150ms lock wait.
export type SdkSpoolV2Options = { dir?: string; deadline?: number; maxOriginalBytes?: number; maxQueueBytes?: number; maxInputBytes?: number; chunkBytes?: number; onPhase?: (phase: string) => void };
export type RetainedSdkSource = { sourceId: string; duplicate: boolean; conflict: boolean; completed?: boolean; body: Record<string, unknown> };

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function charge(size: number): number { return Math.max(BLOCK, Math.ceil(size / BLOCK) * BLOCK); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
function sourceValue(body: Record<string, unknown>, ignoreStringTimestamp: boolean): Record<string, unknown> {
  const value = { ...body };
  if (ignoreStringTimestamp && typeof value.timestamp === 'string') delete value.timestamp;
  if (body.hookType === 'prompt_submit' && body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    const data = { ...body.data } as Record<string, unknown>;
    if (typeof data.prompt === 'string' && data.backfill === true) delete data.backfill;
    value.data = data;
  }
  return value;
}
function sameSource(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ignoreTimestamp = typeof a.timestamp === 'string' && typeof b.timestamp === 'string';
  return isDeepStrictEqual(sourceValue(a, ignoreTimestamp), sourceValue(b, ignoreTimestamp));
}
function sourceFingerprint(body: Record<string, unknown>): string {
  return digest(canonical({ stringTimestamp: typeof body.timestamp === 'string', value: sourceValue(body, true) }));
}
function ownerIdentity(pid = process.pid): Owner | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const start = fields[19];
    if (!start || !/^\d+$/.test(start)) fail('STORE_BUSY');
    return { pid, start, boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
  } catch (error) { if (code(error) === 'ENOENT') return null; fail('STORE_BUSY'); }
}
function validOwner(value: unknown): value is Owner {
  const owner = value as Owner;
  return !!owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.start === 'string' && typeof owner.boot === 'string';
}
function alive(owner: Owner): boolean {
  if (!validOwner(owner)) fail('STORE_BUSY');
  const current = ownerIdentity(owner.pid);
  return !!current && current.start === owner.start && current.boot === owner.boot;
}
function privateStat(stat: Stats, directory: boolean): void {
  const uid = process.geteuid?.();
  if (uid === undefined || stat.uid !== uid || (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600)) fail('STORE_UNSAFE');
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) fail('STORE_UNSAFE');
}
function regularRead(path: string, max: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd); privateStat(stat, false);
    if (stat.size > max) fail('STORE_UNSAFE');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function syncDirectory(path: string, privateDirectory = true): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) fail('STORE_UNSAFE');
    if (privateDirectory) privateStat(stat, true);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
function checkDirectory(path: string, privateDirectory = true): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('STORE_UNSAFE');
  if (privateDirectory) privateStat(stat, true);
}
function ensureDirectory(path: string, privateRoot: string): void {
  const absolute = resolve(path); const root = parse(absolute).root;
  const isPrivate = (value: string) => value === privateRoot || value.startsWith(privateRoot + '/');
  let cursor = root;
  for (const part of absolute.slice(root.length).split('/').filter(Boolean)) {
    cursor = join(cursor, part);
    try { checkDirectory(cursor, isPrivate(cursor)); } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
      try { mkdirSync(cursor, { mode: 0o700 }); syncDirectory(join(cursor, '..'), isPrivate(join(cursor, '..'))); } catch (createError) { if (code(createError) !== 'EEXIST') throw createError; }
      checkDirectory(cursor, isPrivate(cursor));
    }
  }
}
function measure(path: string): number {
  const stat = lstatSync(path); privateStat(stat, stat.isDirectory());
  const own = Math.max(charge(stat.size), stat.blocks * 512);
  return own + (stat.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + measure(join(path, name)), 0) : 0);
}
function limit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) fail('STORE_OPTIONS_INVALID');
  return value;
}

/** Linux-only durable source storage. The lock covers all targets and every quota decision.
 * Source/staging files are never reclaimed. Disk charges are conservative logical bytes,
 * rounded to 4 KiB and at least stat.blocks*512; they are not filesystem hard quotas.
 * The queue includes a 4 KiB lease plus queue/root directory charges (12 KiB minimum).
 * Writes additionally reserve a parent-directory block, and 256 bytes per new chunk-directory entry.
 * Admission cannot consume transition workspace: existing refs may use an additional 8 KiB,
 * and completed manifests an additional 68 KiB. Preserved crash temporaries count toward both.
 * /usr/bin/flock is required; no lock fallback, lease deletion, or source cleanup exists. */
export class SdkSpoolV2 {
  readonly dir: string;
  private readonly originals: string;
  private readonly queue: string;
  private readonly lease: string;
  private readonly maxOriginalBytes: number;
  private readonly maxQueueBytes: number;
  private readonly maxInputBytes: number;
  private readonly chunkBytes: number;
  private readonly onPhase?: (phase: string) => void;
  private readonly deadline?: number;
  constructor(options: SdkSpoolV2Options = {}) {
    const path = options.dir ?? process.env.AGENTMEMORY_SDK_CAPTURE_V2_DIR ?? join(homedir(), '.local', 'share', 'agentmemory', 'capture-spool-sdk-v2');
    if (!isAbsolute(path)) fail('STORE_OPTIONS_INVALID');
    this.dir = resolve(path); this.originals = join(this.dir, 'originals'); this.queue = join(this.dir, 'queue'); this.lease = join(this.queue, 'lease.lock');
    this.maxOriginalBytes = limit(options.maxOriginalBytes, ORIGINAL_LIMIT);
    this.maxQueueBytes = limit(options.maxQueueBytes, QUEUE_LIMIT);
    if (this.maxOriginalBytes < BLOCK || this.maxQueueBytes < 3 * BLOCK) fail('STORE_OPTIONS_INVALID');
    this.maxInputBytes = limit(options.maxInputBytes, INPUT_LIMIT);
    this.chunkBytes = limit(options.chunkBytes, CHUNK_LIMIT);
    this.onPhase = options.onPhase;
    if (options.deadline !== undefined && (!Number.isFinite(options.deadline) || options.deadline < 0)) fail('STORE_OPTIONS_INVALID');
    this.deadline = options.deadline;
  }
  private phase(name: string): void { this.onPhase?.(name); }
  private init(): void {
    ensureDirectory(this.dir, this.dir);
    for (const name of readdirSync(this.dir)) {
      if (name !== 'originals' && name !== 'queue') fail('STORE_UNSAFE');
      checkDirectory(join(this.dir, name));
    }
    for (const path of [this.originals, this.queue]) ensureDirectory(path, this.dir);
  }
  private rawUsage(): { originalBytes: number; queueBytes: number } {
    return { originalBytes: measure(this.originals), queueBytes: measure(this.queue) + BLOCK };
  }
  private budget(kind: 'original' | 'queue', additional: number, transition = false): void {
    const usage = kind === 'original' ? measure(this.originals) : measure(this.queue) + BLOCK;
    const maximum = kind === 'original' ? this.maxOriginalBytes : this.maxQueueBytes;
    const reserve = transition ? kind === 'original' ? ACK_TRANSITION_RESERVE : QUEUE_TRANSITION_RESERVE : 0;
    if (usage + additional > maximum + reserve) fail(kind === 'original' ? 'ORIGINALS_FULL' : 'QUEUE_FULL');
  }
  private writeFile(path: string, bytes: Buffer | string): void {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { privateStat(fstatSync(fd), false); writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  }
  private atomicJson(path: string, value: unknown, kind?: 'original' | 'queue', beforePublish?: string, transition = false): void {
    const bytes = Buffer.from(canonical(value));
    if (kind && bytes.length > (kind === 'queue' ? BLOCK : 64 * 1024)) fail('SOURCE_UNVERIFIED');
    if (kind) this.budget(kind, charge(bytes.length) + BLOCK, transition);
    const temp = path + '.' + randomUUID() + '.tmp';
    this.writeFile(temp, bytes);
    if (beforePublish) this.phase(beforePublish);
    renameSync(temp, path); syncDirectory(join(path, '..'));
  }
  private async locked<T>(operation: () => T): Promise<T> {
    const operationDeadline = this.deadline;
    let fd: number | undefined;
    try {
      if (process.platform !== 'linux') fail('STORE_LOCK_UNSUPPORTED');
      this.init();
      fd = openSync(this.lease, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const stat = fstatSync(fd);
      privateStat(stat, false);
      if (stat.size !== 0) fail('STORE_UNSAFE');
      const deadline = operationDeadline ?? performance.now() + 150;
      while (true) {
        if (operationDeadline !== undefined && performance.now() >= deadline) fail('STORE_BUSY');
        // flock inherits this open file description; its exit does not release our fd's lock.
        const lock = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 150 });
        if (lock.error || lock.signal || lock.status !== 0 && lock.status !== 73) fail('STORE_LOCK_UNSUPPORTED');
        if (lock.status === 0) break;
        if (performance.now() >= deadline) fail('STORE_BUSY');
        await new Promise(resolveWait => setTimeout(resolveWait, 5));
      }
      fsyncSync(fd); syncDirectory(this.queue);
      if (operationDeadline !== undefined && performance.now() >= deadline) fail('STORE_BUSY');
      return operation();
    } catch (error) {
      if (typeof code(error) === 'string' && /^(SOURCE_|ORIGINALS_|QUEUE_|STORE_)/.test(code(error)!)) throw error;
      return fail('STORE_IO');
    } finally {
      // Never unlink the lease: all processes must open the same inode.
      if (fd !== undefined) closeSync(fd);
    }
  }
  private key(target: string, eventId: string): string { return digest(digest(target) + '\0' + eventId); }
  private conflictKey(target: string, eventId: string, body: Record<string, unknown>): string { return digest(this.key(target, eventId) + '\0conflict\0' + sourceFingerprint(body)); }
  private manifest(target: string, sourceId: string): Manifest {
    if (!ID.test(sourceId)) fail('SOURCE_UNVERIFIED');
    try {
      const folder = join(this.originals, sourceId); checkDirectory(folder);
      const manifest = JSON.parse(regularRead(join(folder, 'manifest.json'), 64 * 1024).toString()) as Manifest;
      if (!manifest || manifest.v !== 2 || manifest.sourceId !== sourceId || manifest.targetHash !== digest(target) || typeof manifest.eventId !== 'string' || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0 || manifest.bytes > this.maxInputBytes || !ID.test(manifest.hash) || typeof manifest.conflict !== 'boolean' || typeof manifest.completed !== 'boolean' || !Array.isArray(manifest.chunks) || !manifest.chunks.length || manifest.chunks.length > this.maxInputBytes) fail('SOURCE_UNVERIFIED');
      return manifest;
    } catch (error) { if (code(error) === 'STORE_UNSAFE') throw error; fail('SOURCE_UNVERIFIED'); }
  }
  private source(target: string, sourceId: string): { manifest: Manifest; body: Record<string, unknown> } {
    try {
      const manifest = this.manifest(target, sourceId), folder = join(this.originals, sourceId);
      let bytes = 0;
      const chunks = manifest.chunks.map((chunk, index) => {
        if (chunk.name !== String(index).padStart(6, '0') + '.chunk' || !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0 || chunk.bytes > CHUNK_LIMIT || !ID.test(chunk.hash)) fail('SOURCE_UNVERIFIED');
        const value = regularRead(join(folder, chunk.name), CHUNK_LIMIT);
        bytes += value.length;
        if (bytes > this.maxInputBytes || value.length !== chunk.bytes || digest(value) !== chunk.hash) fail('SOURCE_UNVERIFIED');
        return value;
      });
      const data = Buffer.concat(chunks);
      if (data.length !== manifest.bytes || digest(data) !== manifest.hash) fail('SOURCE_UNVERIFIED');
      const body = JSON.parse(data.toString('utf8'));
      if (!body || Array.isArray(body) || typeof body !== 'object' || body.eventId !== manifest.eventId || canonical(body) !== data.toString('utf8')) fail('SOURCE_UNVERIFIED');
      const expectedId = manifest.conflict ? this.conflictKey(target, manifest.eventId, body) : this.key(target, manifest.eventId);
      if (sourceId !== expectedId) fail('SOURCE_UNVERIFIED');
      this.phase('source_verified');
      return { manifest, body };
    } catch (error) { if (code(error) === 'STORE_UNSAFE') throw error; fail('SOURCE_UNVERIFIED'); }
  }
  private prepareSource(target: string, eventId: string, body: Record<string, unknown>): { normalized: Record<string, unknown>; bytes: Buffer } {
    let normalized: Record<string, unknown>; let bytes: Buffer;
    try {
      normalized = JSON.parse(JSON.stringify(body));
      if (!normalized || Array.isArray(normalized) || typeof normalized !== 'object' || normalized.eventId !== eventId || !eventId || typeof target !== 'string' || !target) fail('SOURCE_UNVERIFIED');
      bytes = Buffer.from(canonical(normalized));
    } catch { fail('SOURCE_UNVERIFIED'); }
    if (bytes.length > this.maxInputBytes) fail('SOURCE_TOO_LARGE');
    return { normalized, bytes };
  }
  private retainSource(target: string, eventId: string, normalized: Record<string, unknown>, bytes: Buffer): RetainedSdkSource {
    let sourceId = this.key(target, eventId); let conflict = false;
    try {
      lstatSync(join(this.originals, sourceId));
      const prior = this.source(target, sourceId);
      if (sameSource(prior.body, normalized)) return { sourceId, duplicate: true, conflict: false, completed: prior.manifest.completed, body: prior.body };
      conflict = true; sourceId = this.conflictKey(target, eventId, normalized);
      try {
        lstatSync(join(this.originals, sourceId));
        const priorConflict = this.source(target, sourceId);
        if (!priorConflict.manifest.conflict || !sameSource(priorConflict.body, normalized)) fail('SOURCE_UNVERIFIED');
        return { sourceId, duplicate: true, conflict: true, completed: false, body: priorConflict.body };
      } catch (error) { if (code(error) !== 'ENOENT') throw error; }
    } catch (error) { if (code(error) !== 'ENOENT') throw error; }
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += this.chunkBytes) chunks.push(bytes.subarray(offset, offset + this.chunkBytes));
    const manifest: Manifest = { v: 2, sourceId, targetHash: digest(target), eventId, bytes: bytes.length, hash: digest(bytes), chunks: chunks.map((value, index) => ({ name: String(index).padStart(6, '0') + '.chunk', bytes: value.length, hash: digest(value) })), conflict, completed: false };
    const manifestBytes = canonical(manifest);
    if (Buffer.byteLength(manifestBytes) > 64 * 1024) fail('SOURCE_TOO_LARGE');
    this.budget('original', BLOCK + charge((chunks.length + 1) * 256) + charge(Buffer.byteLength(manifestBytes)) + chunks.reduce((sum, value) => sum + charge(value.length), 0));
    const stage = join(this.originals, '.stage-' + randomUUID());
    mkdirSync(stage, { mode: 0o700 }); syncDirectory(this.originals);
    for (let index = 0; index < chunks.length; index++) { this.writeFile(join(stage, manifest.chunks[index].name), chunks[index]); this.phase('chunk_fsynced'); }
    this.writeFile(join(stage, 'manifest.json'), manifestBytes); this.phase('manifest_fsynced');
    syncDirectory(stage); this.phase('source_before_publish');
    renameSync(stage, join(this.originals, sourceId)); syncDirectory(this.originals); this.phase('source_published');
    const verified = this.source(target, sourceId);
    return { sourceId, duplicate: false, conflict, completed: false, body: verified.body };
  }
  async retain(target: string, eventId: string, body: Record<string, unknown>): Promise<RetainedSdkSource> {
    const { normalized, bytes } = this.prepareSource(target, eventId, body);
    return this.locked(() => this.retainSource(target, eventId, normalized, bytes));
  }
  async retainAndEnqueue(target: string, eventId: string, body: Record<string, unknown>): Promise<{ retained: RetainedSdkSource; referenceAcknowledged: boolean; error?: unknown }> {
    const { normalized, bytes } = this.prepareSource(target, eventId, body);
    return this.locked(() => {
      const retained = this.retainSource(target, eventId, normalized, bytes);
      if (retained.conflict) return { retained, referenceAcknowledged: false };
      if (retained.completed) return { retained, referenceAcknowledged: true };
      // Source publication is not rolled back if queue admission or I/O fails.
      try { this.enqueueSource(target, retained.sourceId); }
      catch (error) { return { retained, referenceAcknowledged: false, error }; }
      return { retained, referenceAcknowledged: true };
    });
  }
  async load(target: string, sourceId: string): Promise<Record<string, unknown>> {
    if (!ID.test(sourceId)) fail('SOURCE_UNVERIFIED');
    return this.locked(() => this.source(target, sourceId).body);
  }
  private refPath(sourceId: string): string { if (!ID.test(sourceId)) fail('SOURCE_UNVERIFIED'); return join(this.queue, sourceId + '.ref'); }
  private readRef(target: string, sourceId: string): Ref {
    try {
      const ref = JSON.parse(regularRead(this.refPath(sourceId), BLOCK).toString()) as Ref;
      if (!ref || ref.v !== 2 || ref.sourceId !== sourceId || ref.targetHash !== digest(target) || !['pending', 'sending', 'held'].includes(ref.state) || !Number.isSafeInteger(ref.attempts) || ref.attempts < 0 || !Number.isSafeInteger(ref.nextAttemptAt) || ref.nextAttemptAt < 0 || ref.state === 'sending' && !validOwner(ref.owner)) fail('SOURCE_UNVERIFIED');
      return ref;
    } catch (error) { if (code(error) === 'ENOENT' || code(error) === 'STORE_UNSAFE') throw error; fail('SOURCE_UNVERIFIED'); }
  }
  private writeRef(ref: Ref, transition = true): void { this.atomicJson(this.refPath(ref.sourceId), ref, 'queue', undefined, transition); this.phase('reference_published'); }
  private enqueueSource(target: string, sourceId: string): void {
    const { manifest } = this.source(target, sourceId);
    if (manifest.conflict) fail('SOURCE_CONFLICT');
    if (manifest.completed) return;
    try { this.readRef(target, sourceId); return; } catch (error) { if (code(error) !== 'ENOENT') throw error; }
    this.writeRef({ v: 2, targetHash: digest(target), sourceId, state: 'pending', attempts: 0, nextAttemptAt: 0 }, false);
  }
  async enqueue(target: string, sourceId: string): Promise<void> {
    return this.locked(() => this.enqueueSource(target, sourceId));
  }
  async pending(target: string): Promise<Array<{ sourceId: string; state: 'pending' | 'sending' | 'held'; attempts: number; nextAttemptAt: number }>> {
    return this.locked(() => {
      const result: Ref[] = [];
      for (const file of readdirSync(this.queue).filter(file => /^[a-f0-9]{64}\.ref$/.test(file))) {
        const peek = JSON.parse(regularRead(join(this.queue, file), BLOCK).toString()) as Ref;
        if (peek.targetHash !== digest(target)) continue;
        const ref = this.readRef(target, file.slice(0, -4));
        if (ref.state === 'sending' && !alive(ref.owner!)) { ref.state = 'held'; ref.reason = 'UNKNOWN_SEND'; delete ref.owner; this.writeRef(ref); }
        try { if (this.manifest(target, ref.sourceId).completed) continue; } catch { ref.state = 'held'; }
        result.push(ref);
      }
      return result.map(({ sourceId, state, attempts, nextAttemptAt }) => ({ sourceId, state, attempts, nextAttemptAt }));
    });
  }
  async markSending(target: string, sourceId: string, expectedHeldSource?: Record<string, unknown>): Promise<void> {
    await this.claimSource(target, sourceId, expectedHeldSource);
  }
  async claimForSend(target: string, sourceId: string, sendDeadline?: number): Promise<Record<string, unknown>> {
    return this.claimSource(target, sourceId, undefined, sendDeadline);
  }
  private async claimSource(target: string, sourceId: string, expectedHeldSource?: Record<string, unknown>, sendDeadline?: number): Promise<Record<string, unknown>> {
    if (sendDeadline !== undefined && !Number.isFinite(sendDeadline)) fail('STORE_OPTIONS_INVALID');
    return this.locked(() => {
      const source = this.source(target, sourceId);
      if (source.manifest.conflict || source.manifest.completed) fail('SOURCE_HELD');
      const ref = this.readRef(target, sourceId);
      if (expectedHeldSource) {
        if (ref.state !== 'held' || ref.owner || !isDeepStrictEqual(source.body, expectedHeldSource)) fail('SOURCE_HELD');
      } else {
        if (ref.state === 'sending') {
          if (alive(ref.owner!)) fail('SOURCE_SENDING');
          ref.state = 'held'; ref.reason = 'UNKNOWN_SEND'; delete ref.owner; this.writeRef(ref);
        }
        if (ref.state !== 'pending') fail('SOURCE_HELD');
        if (ref.nextAttemptAt > Date.now()) fail('SOURCE_BACKOFF');
      }
      const owner = ownerIdentity(); if (!owner) fail('STORE_BUSY');
      // Only a ref verified pending under this lease can be reported as spooled.
      if (sendDeadline !== undefined && performance.now() >= sendDeadline) fail('SOURCE_SEND_BUDGET_EXHAUSTED');
      ref.state = 'sending'; ref.owner = owner;
      this.writeRef(ref); this.phase('send_intent_fsynced');
      return source.body;
    });
  }
  async acknowledge(target: string, sourceId: string): Promise<void> {
    return this.locked(() => {
      const source = this.source(target, sourceId);
      if (source.manifest.conflict) fail('SOURCE_CONFLICT');
      if (!source.manifest.completed) {
        const ref = this.readRef(target, sourceId);
        if (ref.state !== 'sending' || !isDeepStrictEqual(ref.owner, ownerIdentity())) fail('SOURCE_HELD');
        source.manifest.completed = true;
        this.atomicJson(join(this.originals, sourceId, 'manifest.json'), source.manifest, 'original', 'ack_before_publish', true);
        this.phase('ack_fsynced');
      }
      try { unlinkSync(this.refPath(sourceId)); syncDirectory(this.queue); } catch (error) { if (code(error) !== 'ENOENT') throw error; }
    });
  }
  async retry(target: string, sourceId: string, _reason: string): Promise<void> {
    return this.locked(() => {
      const ref = this.readRef(target, sourceId);
      if (ref.state !== 'sending' || !isDeepStrictEqual(ref.owner, ownerIdentity())) fail('SOURCE_HELD');
      ref.attempts = Math.min(1_000_000, ref.attempts + 1); ref.nextAttemptAt = Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(9, ref.attempts - 1));
      ref.state = 'pending'; ref.reason = 'RETRY'; delete ref.owner; this.writeRef(ref);
    });
  }
  async hold(target: string, sourceId: string, _reason: string): Promise<void> {
    return this.locked(() => { const ref = this.readRef(target, sourceId); if (ref.state !== 'sending' || !isDeepStrictEqual(ref.owner, ownerIdentity())) fail('SOURCE_HELD'); ref.state = 'held'; ref.reason = 'HELD'; delete ref.owner; this.writeRef(ref); });
  }
  async usage(): Promise<{ originalBytes: number; queueBytes: number }> { return this.locked(() => this.rawUsage()); }
}
