import {
  chmodSync,
  constants,
  fstatSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";
import { resolveDataDir } from "../cli-data-dir.js";
import { scrubRecord } from "../functions/privacy.js";
import { stableStringify } from "./event-id.js";

export interface SpoolRecord {
  v: 1;
  eventId: string;
  spooledAt: string;
  reason: string;
  attempts: number;
  body: Record<string, unknown>;
  bootId?: string;
  requireReceipt?: boolean;
  holdReason?: "SDK_COMPLETION_ONLY";
}

export interface SentMark {
  bootId: string;
  durableAfterMs: number;
}

export interface SentReconcile {
  released: number;
  requeued: number;
}

export interface SpoolPolicy {
  enabled: boolean;
  maxBytes: number;
  maxAgeMs: number;
  maxRecordBytes: number;
}

export interface SpoolStats {
  spooled: number;
  dropped: number;
  droppedBytes: number;
  expired: number;
  delivered: number;
  duplicates: number;
  rejected: number;
  lastSpooledAt?: string;
  lastSpoolReason?: string;
  lastDropAt?: string;
  lastDropReason?: string;
  lastDrainAt?: string;
  lastDrainDelivered?: number;
  lastDrainDuplicates?: number;
  lastDrainRejected?: number;
  lastDrainRemaining?: number;
  lastDrainError?: string;
}

export interface SpoolPaths {
  dir: string;
  name: string;
  file: string;
  lock: string;
  drainLock: string;
  stats: string;
}

export interface SpoolSummary {
  enabled: boolean;
  path: string;
  records: number;
  bytes: number;
  oldestAt: string | null;
  retained: number;
  retainedBytes: number;
  sdkRetained: number;
  sdkRetainedBytes: number;
  maxBytes: number;
  maxAgeHours: number;
  stats: SpoolStats;
}

export type SendOutcome = "delivered" | "duplicate" | "rejected" | "retry" | "held";

export interface DrainResult {
  claimed: number;
  delivered: number;
  duplicates: number;
  rejected: number;
  expired: number;
  corrupt: number;
  remaining: number;
  error?: string;
  held?: number;
  skipped?: "locked" | "empty" | "disabled";
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MIN_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_AGE_HOURS = 168;
const LOCK_STALE_MS = 10_000;
const DRAIN_LOCK_STALE_MS = 120_000;
const ORPHAN_CLAIM_MS = 120_000;
const LOCK_WAIT_MS = 500;
const IMAGE_PLACEHOLDER = "[image dropped from capture spool]";
const BOOT_ID_RE = /^[A-Za-z0-9]{8,64}$/;
const SENT_FILE_RE = /^([A-Za-z0-9]{8,64})-(\d+)\.jsonl$/;
const SENT_BUCKET_MS = 1000;
// Cover the maximum one-hour state flush interval plus its safety margin.
const MAX_DURABLE_AFTER_MS = 61 * 60_000;

function emptyStats(): SpoolStats {
  return { spooled: 0, dropped: 0, droppedBytes: 0, expired: 0, delivered: 0, duplicates: 0, rejected: 0 };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
  const n = parseInt(raw.trim(), 10);
  return n > 0 ? n : fallback;
}

export function spoolPolicy(env: NodeJS.ProcessEnv = process.env): SpoolPolicy {
  const maxBytes = Math.max(MIN_MAX_BYTES, positiveInt(env["AGENTMEMORY_CAPTURE_SPOOL_MAX_BYTES"], DEFAULT_MAX_BYTES));
  const maxAgeHours = positiveInt(env["AGENTMEMORY_CAPTURE_SPOOL_MAX_AGE_HOURS"], DEFAULT_MAX_AGE_HOURS);
  return {
    enabled: env["AGENTMEMORY_CAPTURE_SPOOL"] !== "false",
    maxBytes,
    maxAgeMs: maxAgeHours * 3600_000,
    maxRecordBytes: Math.min(256 * 1024, Math.floor(maxBytes / 4)),
  };
}

export function spoolDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["AGENTMEMORY_CAPTURE_SPOOL_DIR"];
  if (explicit && explicit.trim()) return resolve(explicit.trim());
  return join(resolveDataDir({ args: [], env }).dataDir, "capture-spool");
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function spoolTargetName(url: string): string {
  try {
    const u = new URL(url);
    const host = LOOPBACK.has(u.hostname) ? "local" : u.hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return `${host}-${port}`;
  } catch {
    return "local-3111";
  }
}

export function spoolPaths(url: string, dir: string = spoolDir()): SpoolPaths {
  const name = spoolTargetName(url);
  return {
    dir,
    name,
    file: join(dir, `${name}.jsonl`),
    lock: join(dir, `${name}.lock`),
    drainLock: join(dir, `${name}.drain.lock`),
    stats: join(dir, `${name}.stats.json`),
  };
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
}

function syncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryLock(path: string, staleMs: number): boolean {
  try {
    const fd = openSync(path, "wx", 0o600);
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
    try {
      if (Date.now() - statSync(path).mtimeMs > staleMs) unlinkSync(path);
    } catch {}
    return false;
  }
}

function releaseLock(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

function withLock<T>(path: string, fn: (locked: boolean) => T, waitMs = LOCK_WAIT_MS): T {
  const deadline = Date.now() + waitMs;
  let locked = tryLock(path, LOCK_STALE_MS);
  while (!locked && Date.now() < deadline) {
    sleepSync(5);
    locked = tryLock(path, LOCK_STALE_MS);
  }
  try {
    return fn(locked);
  } finally {
    if (locked) releaseLock(path);
  }
}

export function readSpoolStats(paths: SpoolPaths): SpoolStats {
  try {
    const parsed = JSON.parse(readFileSync(paths.stats, "utf-8")) as Partial<SpoolStats>;
    return { ...emptyStats(), ...parsed };
  } catch {
    return emptyStats();
  }
}

function writeStats(paths: SpoolPaths, patch: (stats: SpoolStats) => void): void {
  try {
    const stats = readSpoolStats(paths);
    patch(stats);
    const tmp = `${paths.stats}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(stats), { mode: 0o600 });
    renameSync(tmp, paths.stats);
  } catch {}
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function withoutImage(body: Record<string, unknown>): Record<string, unknown> {
  const data = body["data"];
  if (!data || typeof data !== "object" || Array.isArray(data)) return body;
  const d = data as Record<string, unknown>;
  if (d["image_data"] === undefined) return body;
  return { ...body, data: { ...d, image_data: IMAGE_PLACEHOLDER } };
}

function parseLines(text: string): { records: SpoolRecord[]; corrupt: number } {
  const records: SpoolRecord[] = [];
  let corrupt = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as SpoolRecord;
      if (rec && typeof rec.eventId === "string" && rec.body && typeof rec.body === "object") records.push(rec);
      else corrupt++;
    } catch {
      corrupt++;
    }
  }
  return { records, corrupt };
}

function isExpired(rec: SpoolRecord, policy: SpoolPolicy, now: number): boolean {
  if (rec.requireReceipt || rec.holdReason==="SDK_COMPLETION_ONLY") return false;
  const at = Date.parse(rec.spooledAt);
  return Number.isFinite(at) && now - at > policy.maxAgeMs;
}

function serialize(records: SpoolRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
}

function rewriteLocked(paths: SpoolPaths, records: SpoolRecord[]): void {
  const tmp = `${paths.file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, serialize(records));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, paths.file);
}

function pruneExpiredLocked(paths: SpoolPaths, policy: SpoolPolicy): number {
  if (!existsSync(paths.file)) return 0;
  const { records } = parseLines(readFileSync(paths.file, "utf-8"));
  const now = Date.now();
  const kept = records.filter((r) => !isExpired(r, policy, now));
  const expired = records.length - kept.length;
  if (expired > 0) rewriteLocked(paths, kept);
  return expired;
}

export interface AppendResult {
  spooled: boolean;
  dropped?: "disabled" | "too-large" | "full" | "error";
}

export function appendSpool(
  url: string,
  eventId: string,
  body: Record<string, unknown>,
  reason: string,
  options: { policy?: SpoolPolicy; dir?: string; attempts?: number; preserveImages?: boolean; requireReceipt?: boolean } = {},
): AppendResult {
  const policy = options.policy ?? spoolPolicy();
  if (!policy.enabled) return { spooled: false, dropped: "disabled" };
  const paths = spoolPaths(url, options.dir);
  const note = (dropReason: NonNullable<AppendResult["dropped"]>, bytes: number) => {
    writeStats(paths, (s) => {
      s.dropped++;
      s.droppedBytes += bytes;
      s.lastDropAt = new Date().toISOString();
      s.lastDropReason = dropReason;
    });
    return { spooled: false, dropped: dropReason } as AppendResult;
  };
  try {
    ensureDir(paths.dir);
    const record: SpoolRecord = {
      v: 1,
      eventId,
      spooledAt: new Date().toISOString(),
      reason,
      attempts: options.attempts ?? 0,
      body: scrubRecord(JSON.parse(JSON.stringify(body)), { scrubKeys: true }),
      ...(options.requireReceipt ? { requireReceipt: true } : {}),
    };
    let line = JSON.stringify(record) + "\n";
    if (Buffer.byteLength(line) > policy.maxRecordBytes && !options.preserveImages) {
      record.body = withoutImage(record.body);
      line = JSON.stringify(record) + "\n";
    }
    const bytes = Buffer.byteLength(line);
    if (bytes > policy.maxRecordBytes) return note("too-large", bytes);
    return withLock(paths.lock, (locked) => {
      let expired = 0;
      if (locked && fileSize(paths.file) + bytes > policy.maxBytes) expired = pruneExpiredLocked(paths, policy);
      const over = fileSize(paths.file) + sentBytes(paths) + sdkOriginals(paths).bytes + bytes - policy.maxBytes;
      if (locked && over > 0) evictSent(paths, over);
      if (fileSize(paths.file) + sentBytes(paths) + sdkOriginals(paths).bytes + bytes > policy.maxBytes) {
        if (expired) writeStats(paths, (s) => void (s.expired += expired));
        return note("full", bytes);
      }
      const fd = openSync(paths.file, "a", 0o600);
      try {
        writeSync(fd, line);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      syncDirectory(paths.dir);
      syncDirectory(join(paths.dir, ".."));
      writeStats(paths, (s) => {
        s.spooled++;
        s.expired += expired;
        s.lastSpooledAt = record.spooledAt;
        s.lastSpoolReason = reason;
      });
      return { spooled: true } as AppendResult;
    });
  } catch {
    return { spooled: false, dropped: "error" };
  }
}

interface SentSegment {
  file: string;
  bootId: string;
  dueAt: number;
  bytes: number;
}

function listSent(paths: SpoolPaths): SentSegment[] {
  const segments: SentSegment[] = [];
  let entries: string[];
  try {
    entries = readdirSync(paths.dir);
  } catch {
    return segments;
  }
  const prefix = `${paths.name}.sent-`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const match = entry.slice(prefix.length).match(SENT_FILE_RE);
    if (!match) continue;
    const file = join(paths.dir, entry);
    segments.push({ file, bootId: match[1]!, dueAt: Number(match[2]), bytes: fileSize(file) });
  }
  return segments;
}

function sentBytes(paths: SpoolPaths): number {
  return listSent(paths).reduce((n, s) => n + s.bytes, 0);
}

function evictSent(paths: SpoolPaths, need: number): void {
  let freed = 0;
  for (const seg of listSent(paths).sort((a, b) => a.dueAt - b.dueAt)) {
    if (freed >= need) return;
    try {
      const parsed = parseLines(readFileSync(seg.file, "utf-8"));
      if (parsed.corrupt || parsed.records.some(record => record.requireReceipt)) continue;
      unlinkSync(seg.file);
      freed += seg.bytes;
    } catch {}
  }
}

export function parseSentMark(body: unknown): SentMark | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const bootId = (body as Record<string, unknown>)["bootId"];
  const after = (body as Record<string, unknown>)["durableAfterMs"];
  if (typeof bootId !== "string" || !BOOT_ID_RE.test(bootId)) return null;
  if (typeof after !== "number" || !Number.isFinite(after) || after < 0) return null;
  return { bootId, durableAfterMs: Math.min(Math.ceil(after), MAX_DURABLE_AFTER_MS) };
}

function sdkOriginals(paths: SpoolPaths): { records: number; bytes: number } {
  let records=0,bytes=0;
  try { for(const name of readdirSync(join(paths.dir,`${paths.name}.sdk-originals`))){
    if(!/^[a-f0-9]{64}(?:\.envelope-[a-f0-9]{64})?\.json(?:\.[a-f0-9-]+\.tmp)?$/.test(name))continue;
    bytes+=statSync(join(paths.dir,`${paths.name}.sdk-originals`,name)).size;if(name.endsWith('.json'))records++;
  }}catch{}
  return {records,bytes};
}

export function readSdkOriginal(url:string,eventId:string,options:{dir?:string;policy?:SpoolPolicy}={}):Record<string,unknown>{
 if(!/^[A-Za-z0-9_.:-]{8,128}$/.test(eventId))throw Error('SDK_SOURCE_SELECTION_INVALID');
 const paths=spoolPaths(url,options.dir),folder=join(paths.dir,`${paths.name}.sdk-originals`),identity=createHash('sha256').update(eventId).digest('hex');
 return withLock(paths.lock,locked=>{
  if(!locked)throw Error('SDK_SOURCE_SELECTION_BUSY');
  if(readdirSync(folder).some(name=>name.startsWith(identity+'.envelope-')))throw Error('SDK_SOURCE_SELECTION_AMBIGUOUS');
  const fd=openSync(join(folder,identity+'.json'),constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
   const stat=fstatSync(fd);if(!stat.isFile()||stat.size>(options.policy??spoolPolicy()).maxRecordBytes)throw Error('SDK_SOURCE_FORMAT_UNSUPPORTED');
   const rec=JSON.parse(readFileSync(fd,'utf8'));
   if(rec.v!==1||rec.eventId!==eventId||rec.completion!=='sdk'||rec.durable!==false||rec.body?.eventId!==eventId||rec.body?.captureCompletion!=='sdk-v1')throw Error('SDK_SOURCE_SELECTION_INVALID');
   return rec.body;
  }finally{closeSync(fd);}
 });
}

function sameSdkEnvelopeSource(a:Record<string,unknown>,b:Record<string,unknown>):boolean {
 const source=(body:Record<string,unknown>)=>{
  const value={...body};
  if(typeof a.timestamp==='string'&&typeof b.timestamp==='string')delete value.timestamp;
  if(body.hookType==='prompt_submit'&&body.data&&typeof body.data==='object'&&!Array.isArray(body.data)){
   const data={...body.data} as Record<string,unknown>;
   if(typeof data.prompt==='string'&&data.backfill===true)delete data.backfill;
   value.data=data;
  }
  return value;
 };
 return isDeepStrictEqual(source(a),source(b));
}

export function retainSdkOriginal(url:string,eventId:string,body:Record<string,unknown>,options:{dir?:string;policy?:SpoolPolicy}={}):boolean {
 const policy=options.policy??spoolPolicy();if(!policy.enabled)return false;
 const paths=spoolPaths(url,options.dir);
 const retainedBody=scrubRecord(JSON.parse(JSON.stringify(body)),{scrubKeys:true});
 const line=JSON.stringify({v:1,eventId,body:retainedBody,completion:'sdk',durable:false})+'\n';
 const bytes=Buffer.byteLength(line);if(bytes>policy.maxRecordBytes)return false;
 try {
  ensureDir(paths.dir);
  return withLock(paths.lock,locked=>{
   if(!locked)return false;
   const folder=join(paths.dir,`${paths.name}.sdk-originals`);ensureDir(folder);
   const identity=createHash('sha256').update(eventId).digest('hex');
   let file=join(folder,identity+'.json');
   if(existsSync(file)){
    const prior=JSON.parse(readFileSync(file,'utf8'));
    if(prior.eventId!==eventId)return false;
    if(!isDeepStrictEqual(prior.body,retainedBody)){
     if(!prior.body||!sameSdkEnvelopeSource(prior.body,retainedBody))return false;
     file=join(folder,identity+'.envelope-'+createHash('sha256').update(stableStringify(retainedBody)).digest('hex')+'.json');
    }
   }
   if(existsSync(file)){
    const prior=JSON.parse(readFileSync(file,'utf8'));
    if(prior.eventId!==eventId||!isDeepStrictEqual(prior.body,retainedBody))return false;
    const fd=openSync(file,'r');try{fsyncSync(fd);}finally{closeSync(fd);}syncDirectory(folder);syncDirectory(paths.dir);syncDirectory(join(paths.dir,'..'));return true;
   }
   if(fileSize(paths.file)+sentBytes(paths)+sdkOriginals(paths).bytes+bytes>policy.maxBytes)return false;
   const temp=file+'.'+randomUUID()+'.tmp';
   try{
    const fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,line);fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temp,file);syncDirectory(folder);syncDirectory(paths.dir);syncDirectory(join(paths.dir,'..'));return true;
   }finally{try{unlinkSync(temp);}catch{}}
  });
 }catch{return false;}
}

export function retainSent(
  url: string,
  eventId: string,
  body: Record<string, unknown>,
  mark: SentMark,
  options: { policy?: SpoolPolicy; dir?: string; now?: number; preserveImages?: boolean; requireReceipt?: boolean } = {},
): boolean {
  const policy = options.policy ?? spoolPolicy();
  if (!policy.enabled || !BOOT_ID_RE.test(mark.bootId)) return false;
  const paths = spoolPaths(url, options.dir);
  const now = options.now ?? Date.now();
  try {
    ensureDir(paths.dir);
    const record: SpoolRecord = {
      v: 1,
      eventId,
      spooledAt: new Date(now).toISOString(),
      reason: "sent",
      attempts: 0,
      body: scrubRecord(JSON.parse(JSON.stringify(body)), { scrubKeys: true }),
      bootId: mark.bootId,
      ...(options.requireReceipt ? { requireReceipt: true } : {}),
    };
    let line = JSON.stringify(record) + "\n";
    if (Buffer.byteLength(line) > policy.maxRecordBytes && !options.preserveImages) {
      record.body = withoutImage(record.body);
      line = JSON.stringify(record) + "\n";
    }
    const bytes = Buffer.byteLength(line);
    if (bytes > policy.maxRecordBytes) return false;
    const dueAt = Math.ceil((now + mark.durableAfterMs) / SENT_BUCKET_MS) * SENT_BUCKET_MS;
    const file = join(paths.dir, `${paths.name}.sent-${mark.bootId}-${dueAt}.jsonl`);
    return withLock(paths.lock, () => {
      if (fileSize(paths.file) + sentBytes(paths) + sdkOriginals(paths).bytes + bytes > policy.maxBytes) return false;
      const fd = openSync(file, "a", 0o600);
      try {
        writeSync(fd, line);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      syncDirectory(paths.dir);
      syncDirectory(join(paths.dir, ".."));
      return true;
    });
  } catch {
    return false;
  }
}

export function reconcileSent(
  url: string,
  bootId: string,
  options: { policy?: SpoolPolicy; dir?: string; now?: number } = {},
): SentReconcile {
  const result: SentReconcile = { released: 0, requeued: 0 };
  const policy = options.policy ?? spoolPolicy();
  if (!policy.enabled) return result;
  const paths = spoolPaths(url, options.dir);
  const now = options.now ?? Date.now();
  for (const seg of listSent(paths)) {
    if (seg.bootId === bootId) {
      if (seg.dueAt > now) continue;
      try {
        unlinkSync(seg.file);
        result.released++;
      } catch {}
      continue;
    }
    const target = join(paths.dir, `${paths.name}.draining-${process.pid}-${now}-${result.requeued}.jsonl`);
    try {
      renameSync(seg.file, target);
    } catch {
      continue;
    }
    try {
      utimesSync(target, 0, 0);
    } catch {}
    result.requeued++;
  }
  return result;
}

function claimFiles(paths: SpoolPaths): string[] {
  const claimed: string[] = [];
  try {
    const prefix = `${paths.name}.draining-`;
    for (const entry of readdirSync(paths.dir)) {
      if (!entry.startsWith(prefix) || !entry.endsWith(".jsonl")) continue;
      const full = join(paths.dir, entry);
      try {
        if (Date.now() - statSync(full).mtimeMs > ORPHAN_CLAIM_MS) claimed.push(full);
      } catch {}
    }
  } catch {}
  if (fileSize(paths.file) > 0) {
    const target = join(paths.dir, `${paths.name}.draining-${process.pid}-${Date.now()}.jsonl`);
    withLock(paths.lock, (locked) => {
      if (!locked) return;
      try {
        renameSync(paths.file, target);
        claimed.push(target);
      } catch {}
    });
  }
  return claimed;
}

function requeueLocked(paths: SpoolPaths, leftover: SpoolRecord[]): void {
  if (leftover.length === 0) return;
  const existing = existsSync(paths.file) ? parseLines(readFileSync(paths.file, "utf-8")).records : [];
  rewriteLocked(paths, [...leftover, ...existing]);
}

function requeueUnlocked(paths: SpoolPaths, leftover: SpoolRecord[]): void {
  if (leftover.length === 0) return;
  const target = join(paths.dir, `${paths.name}.draining-${process.pid}-${Date.now()}-requeue.jsonl`);
  const fd = openSync(target, "wx", 0o600);
  try {
    writeSync(fd, serialize(leftover));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    utimesSync(target, 0, 0);
  } catch {}
}

export function spoolHasRecords(url: string, dir?: string): boolean {
  const paths=spoolPaths(url,dir);
  if(fileSize(paths.file)>0)return true;
  try{return readdirSync(paths.dir).some(name=>name.startsWith(paths.name+'.draining-')&&name.endsWith('.jsonl')&&fileSize(join(paths.dir,name))>0);}catch{return false;}
}

export function drainInProgress(url: string, dir?: string): boolean {
  const paths = spoolPaths(url, dir);
  try {
    return Date.now() - statSync(paths.drainLock).mtimeMs < DRAIN_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

export async function drainSpool(
  url: string,
  send: (record: SpoolRecord) => Promise<SendOutcome>,
  options: { policy?: SpoolPolicy; dir?: string; maxRecords?: number; deadlineMs?: number; shouldStop?: () => boolean } = {},
): Promise<DrainResult> {
  const policy = options.policy ?? spoolPolicy();
  const result: DrainResult = { claimed: 0, delivered: 0, duplicates: 0, rejected: 0, expired: 0, corrupt: 0, remaining: 0 };
  const paths = spoolPaths(url, options.dir);
  if (!existsSync(paths.dir)) return { ...result, skipped: "empty" };
  try {
    ensureDir(paths.dir);
  } catch {}
  if (!tryLock(paths.drainLock, DRAIN_LOCK_STALE_MS)) return { ...result, skipped: "locked" };
  try {
    const files = claimFiles(paths);
    if (files.length === 0) return { ...result, skipped: "empty" };
    const records: SpoolRecord[] = [];
    for (const file of files) {
      try {
        const parsed = parseLines(readFileSync(file, "utf-8"));
        records.push(...parsed.records);
        result.corrupt += parsed.corrupt;
      } catch {}
    }
    result.claimed = records.length;
    const seen = new Set<string>();
    const now = Date.now();
    const deadline = options.deadlineMs ? now + options.deadlineMs : Number.POSITIVE_INFINITY;
    const maxRecords = options.maxRecords ?? Number.POSITIVE_INFINITY;
    const leftover: SpoolRecord[] = [];
    let stopped = false;
    let processed = 0;
    for (const rec of records) {
      if (options.shouldStop?.()) { leftover.push(rec); continue; }
      const identity=rec.eventId+":"+(rec.body.captureCompletion==="sdk-v1"?"sdk":"legacy");
      if (!rec.requireReceipt && !rec.holdReason && seen.has(identity)) {
        result.duplicates++;
        continue;
      }
      if(!rec.requireReceipt&&!rec.holdReason)seen.add(identity);
      if(rec.holdReason==="SDK_COMPLETION_ONLY"){leftover.push(rec);result.held=(result.held??0)+1;continue;}
      if (isExpired(rec, policy, now)) {
        result.expired++;
        continue;
      }
      if (stopped || processed >= maxRecords || Date.now() > deadline) {
        leftover.push(rec);
        continue;
      }
      processed++;
      let outcome: SendOutcome;
      try {
        outcome = await send(rec);
      } catch (err) {
        outcome = "retry";
        result.error = err instanceof Error ? err.message : String(err);
      }
      if (rec.requireReceipt && outcome === "rejected") outcome = "retry";
      if(outcome==="held"){leftover.push({...rec,holdReason:"SDK_COMPLETION_ONLY"});result.held=(result.held??0)+1;continue;}
      if (outcome === "delivered") result.delivered++;
      else if (outcome === "duplicate") result.duplicates++;
      else if (outcome === "rejected") result.rejected++;
      else {
        stopped = true;
        leftover.push({ ...rec, attempts: (rec.attempts ?? 0) + 1 });
      }
    }
    result.remaining = leftover.length;
    withLock(paths.lock, (locked) => (locked ? requeueLocked(paths, leftover) : requeueUnlocked(paths, leftover)), 2000);
    if (leftover.some(record => record.requireReceipt || record.holdReason)) syncDirectory(paths.dir);
    for (const file of files) {
      try {
        unlinkSync(file);
      } catch {}
    }
    writeStats(paths, (s) => {
      s.delivered += result.delivered;
      s.duplicates += result.duplicates;
      s.rejected += result.rejected;
      s.expired += result.expired;
      s.lastDrainAt = new Date().toISOString();
      s.lastDrainDelivered = result.delivered;
      s.lastDrainDuplicates = result.duplicates;
      s.lastDrainRejected = result.rejected;
      s.lastDrainRemaining = result.remaining;
      if (result.error) s.lastDrainError = result.error;
      else delete s.lastDrainError;
    });
    return result;
  } finally {
    releaseLock(paths.drainLock);
  }
}

export function spoolSummary(url: string, options: { policy?: SpoolPolicy; dir?: string } = {}): SpoolSummary {
  const policy = options.policy ?? spoolPolicy();
  const paths = spoolPaths(url, options.dir);
  let records = 0;
  let bytes = 0;
  let oldestAt: string | null = null;
  const files: string[] = [];
  if (existsSync(paths.file)) files.push(paths.file);
  try {
    for (const entry of readdirSync(paths.dir)) {
      if (entry.startsWith(`${paths.name}.draining-`) && entry.endsWith(".jsonl")) files.push(join(paths.dir, entry));
    }
  } catch {}
  for (const file of files) {
    try {
      const text = readFileSync(file, "utf-8");
      bytes += Buffer.byteLength(text);
      for (const rec of parseLines(text).records) {
        records++;
        if (!oldestAt || rec.spooledAt < oldestAt) oldestAt = rec.spooledAt;
      }
    } catch {}
  }
  let retained = 0;
  let retainedBytes = 0;
  for (const seg of listSent(paths)) {
    try {
      const text = readFileSync(seg.file, "utf-8");
      retainedBytes += Buffer.byteLength(text);
      retained += parseLines(text).records.length;
    } catch {}
  }
  return {
    enabled: policy.enabled,
    path: paths.file,
    records,
    bytes,
    oldestAt,
    retained,
    retainedBytes,
    sdkRetained:sdkOriginals(paths).records,
    sdkRetainedBytes:sdkOriginals(paths).bytes,
    maxBytes: policy.maxBytes,
    maxAgeHours: Math.round(policy.maxAgeMs / 3600_000),
    stats: readSpoolStats(paths),
  };
}
