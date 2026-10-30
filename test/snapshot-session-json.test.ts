import {afterEach, expect, it} from 'vitest';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {snapshotSessionJsonChunks, readSnapshotJson} from '../src/ops/snapshot-json.mjs';
import {publishSnapshotFile} from '../src/ops/snapshot-recovery.mjs';

const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'am-session-json-'));dirs.push(dir);await writeFile(join(dir,'state.json'),'previous');return dir;}
async function collect(source:AsyncIterable<string>){let text='';for await(const chunk of source)text+=chunk;return text;}
const archive=()=>({version:'synthetic',timestamp:'fixed',sessions:[{id:'s1'},{id:'empty'},{id:'s2'}],memories:[{id:'m',text:'한😀\\"\n'}],graphNodes:[],graphEdges:[],observations:{},accessLogs:[{memoryId:'m',count:1}]});

it('streams every observation with legacy JSON bytes, field order and restore compatibility',async()=>{
 const value=archive();const rows:Record<string,unknown[]>={s1:[{id:'o1',sourceRaw:{raw:'한😀\\"\n'}}],empty:[],s2:[{id:'o2',facts:[1,null,false]}]};
 const text=await collect(snapshotSessionJsonChunks(value,['s1','empty','s2'],async(id:string)=>rows[id]));
 const expected={...value,observations:{s1:rows.s1,s2:rows.s2}};
 expect(text).toBe(JSON.stringify(expected,null,2));
 expect(await readSnapshotJson(Readable.from([Buffer.from(text)]))).toEqual(expected);
});

it('keeps an empty observations object and native record toJSON keys',async()=>{
 const value=archive();value.memories=[{id:'m',toJSON(key:string){return{id:'m',key};}}] as any;
 expect(await collect(snapshotSessionJsonChunks(value,['empty'],async()=>[]))).toBe(JSON.stringify(value,null,2));
});

it('preserves own special session keys without mutating an observations prototype',async()=>{
 const value=archive();const expected=JSON.parse('{"__proto__":[{"id":"p"}],"constructor":[{"id":"c"}]}');
 const text=await collect(snapshotSessionJsonChunks(value,['__proto__','constructor'],async(id:string)=>expected[id]));
 expect(text).toBe(JSON.stringify({...value,observations:expected},null,2));
 const restored:any=await readSnapshotJson(Readable.from([Buffer.from(text)]));
 expect(Object.hasOwn(restored.observations,'__proto__')).toBe(true);
 expect(Object.getPrototypeOf(restored.observations)).toBe(Object.prototype);
});

it.each(['read','shape','serialization'])('preserves the previous snapshot and cleans temp after a later session %s failure',async mode=>{
 const dir=await fixture(), error=Object.assign(Error('synthetic read'),{code:'SYNTHETIC_READ'});const reads:string[]=[];
 const content=snapshotSessionJsonChunks(archive(),['s1','s2'],async(id:string)=>{
  reads.push(id);if(id==='s1')return[{id:'o1',text:'x'.repeat(70000)}];
  if(mode==='read')throw error;
  if(mode==='shape')return[{}];
  return[{id:'o2',toJSON(){throw new RangeError('synthetic serialization');}}];
 });
 const result=publishSnapshotFile(dir,'state.json',content);
 if(mode==='read')await expect(result).rejects.toBe(error);
 else if(mode==='shape')await expect(result).rejects.toMatchObject({code:'SNAPSHOT_RECORD_INVALID',snapshotPhase:'serialize'});
 else await expect(result).rejects.toMatchObject({name:'RangeError',snapshotPhase:'serialize'});
 expect(reads).toEqual(['s1','s2']);
 expect(await readFile(join(dir,'state.json'),'utf8')).toBe('previous');
 expect(await readdir(dir)).toEqual(['state.json']);
});

it('cancels between sessions without publishing or reading later sessions',async()=>{
 const dir=await fixture(), controller=new AbortController();const reads:string[]=[];
 const content=snapshotSessionJsonChunks(archive(),['s1','s2','s3'],async(id:string)=>{
  reads.push(id);if(id==='s2')controller.abort();return[{id:'o-'+id,text:'x'.repeat(70000)}];
 });
 await expect(publishSnapshotFile(dir,'state.json',content,{signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
 expect(reads).toEqual(['s1','s2']);expect(await readFile(join(dir,'state.json'),'utf8')).toBe('previous');
 expect(await readdir(dir)).toEqual(['state.json']);
});
