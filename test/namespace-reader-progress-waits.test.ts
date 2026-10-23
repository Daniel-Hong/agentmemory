import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
const gate=vi.hoisted(()=>({phase:'',wait:undefined as Promise<void>|undefined,entered:undefined as (()=>void)|undefined}));
vi.mock('node:fs/promises',async()=>{const fs=await vi.importActual<any>('node:fs/promises');return{...fs,open:async(...args:any[])=>{
 const pause=async(phase:string)=>{if(gate.phase===phase){gate.phase='';gate.entered?.();await gate.wait;}};
 await pause('open');const h=await fs.open(...args);
 return new Proxy(h,{get(target,key){if(key==='stat')return async(...a:any[])=>{await pause('stat');return target.stat(...a);};if(key==='close')return async()=>{if(gate.phase==='close_error'){gate.phase='';await target.close();throw Object.assign(Error('PRIVATE_IO'),{code:'EIO'});}await pause('close');return target.close();};
  if(key==='createReadStream')return(...a:any[])=>{const stream=target.createReadStream(...a);return new Proxy(stream,{get(s,k){if(k==='iterator')return(...b:any[])=>{const iter=s.iterator(...b);return{[Symbol.asyncIterator](){return this;},next:async()=>{await pause('stream');return iter.next();},return:()=>iter.return()};};const v=Reflect.get(s,k);return typeof v==='function'?v.bind(s):v;}});};
  const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
 }});
}};});
import {readNamespaceEntries} from '../src/ops/namespace-reader.mjs';
const dirs:string[]=[];afterEach(async()=>{gate.phase='';gate.wait=undefined;gate.entered=undefined;for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
for(const phase of ['open','stat','stream','close'])it('identifies an unfinished '+phase+' wait without changing completion',async()=>{
 const d=await mkdtemp(join(tmpdir(),'am-progress-wait-'));dirs.push(d);const path=join(d,'PRIVATE');await writeFile(path,'{"k":1}');
 let release!:()=>void,entered!:()=>void;gate.phase=phase;gate.wait=new Promise(r=>release=r);const ready=new Promise<void>(r=>entered=r);gate.entered=entered;
 const samples:any[]=[];let settled=false;const read=readNamespaceEntries(path,{keys:new Set(['k']),onProgress:(s:any)=>samples.push(s)}as any).finally(()=>settled=true);
 await ready;expect(settled).toBe(false);expect(samples.at(-1).readerPhase).toBe(phase);release();expect((await read).values.get('k')).toBe(1);
 expect(samples.at(-1).readerPhase).toBe('complete');expect(JSON.stringify(samples)).not.toContain('PRIVATE');
});

it('retains close failure without reporting successful certification',async()=>{
 const d=await mkdtemp(join(tmpdir(),'am-progress-close-fail-'));dirs.push(d);const p=join(d,'PRIVATE');await writeFile(p,'{"k":1}');gate.phase='close_error';const samples:any[]=[];
 await expect(readNamespaceEntries(p,{onProgress:(s:any)=>samples.push(s)}as any)).rejects.toMatchObject({code:'EIO'});
 expect(samples.at(-1)).toMatchObject({readerPhase:'complete',readerFailurePhase:'close'});expect(JSON.stringify(samples)).not.toContain('PRIVATE');
});
