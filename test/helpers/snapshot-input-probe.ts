import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSnapshotFunction } from '../../src/functions/snapshot.js';
import { KV } from '../../src/state/schema.js';
const handlers = new Map<string, (payload: any) => Promise<any>>();
const records = new Map<string, Map<string, unknown>>();
const sdk = {
  registerFunction:(id:string, handler:any)=>handlers.set(id, handler),
  trigger:(id:string, payload:any)=>handlers.get(id)!(payload),
};
const kv = {
  get:async(scope:string, id:string)=>records.get(scope)?.get(id) ?? null,
  set:async(scope:string, id:string, value:unknown)=>{
    if (!records.has(scope)) records.set(scope,new Map());
    records.get(scope)!.set(id,value); return value;
  },
  list:async(scope:string)=>[...(records.get(scope)?.values() ?? [])],
};

const dir = await mkdtemp(join(tmpdir(), 'am-snapshot-input-probe-'));
let previous: WeakRef<unknown[]> | undefined;
let outputStarted = false, previousReleased = false;
const calls: string[] = [];
const read = kv.list;
kv.list = async (scope: string, options?: unknown) => {
  if (!scope.startsWith('mem:obs:')) return read(scope);
  if (JSON.stringify(options) !== '{"observationConsistency":"opened-generation"}') throw Error('wrong consistency');
  if (previous) {
    const temps = (await readdir(dir)).filter(name => name.startsWith('state.json.') && name.endsWith('.tmp'));
    outputStarted = temps.length === 1 && (await stat(join(dir, temps[0]))).size > 0;
    await new Promise(resolve => setImmediate(resolve));
    global.gc!();
    await new Promise(resolve => setImmediate(resolve));
    global.gc!();
    previousReleased = previous.deref() === undefined;
    if (!outputStarted || !previousReleased) throw Object.assign(Error('accumulated observations'), {code:'INPUT_RETAINED'});
  }
  calls.push(scope);
  const rows = Array.from({length:20}, (_, n) => ({id:scope+'-'+n, text:'x'.repeat(calls.length === 1 ? 4096 : 1024)}));
  previous = new WeakRef(rows);
  return rows as never;
};
const recovery = registerSnapshotFunction(sdk as never, kv as never, dir);
try {
  for (let n = 0; n < 3; n++) await kv.set(KV.sessions, 's'+n, {id:'s'+n});
  const result = await sdk.trigger('mem::snapshot-create', {}) as any;
  const archive = result.success ? JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) : null;
  await writeFile(process.argv[2], JSON.stringify({success:result.success, errorCode:result.errorCode, outputStarted, previousReleased, calls, stats:result.snapshot?.stats, counts:archive && Object.values(archive.observations).map((rows:any)=>rows.length)}));
} finally {
  await recovery.stop();
  await rm(dir, {recursive:true, force:true});
}
