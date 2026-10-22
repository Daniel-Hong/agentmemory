import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSharedNamespaceReader} from '../src/ops/shared-namespace-reader.mjs';
import {readNamespaceEntries} from '../src/ops/namespace-reader.mjs';
import {safeFailureDetails} from '../src/ops/provider-readiness.mjs';

const turn=async()=>{await Promise.resolve();await Promise.resolve();};
function harness(){
 const calls:any[]=[];
 const reader=createSharedNamespaceReader({read:((_path:string,options:any)=>new Promise((resolve,reject)=>{
  const abort=()=>reject(options.signal.reason);options.signal?.addEventListener('abort',abort,{once:true});
  calls.push({open(){options.onOpen?.({fileBytes:100,privateValue:'PRIVATE'});},finish(){options.signal?.removeEventListener('abort',abort);options.onRead?.({fileBytes:100,bytesRead:100,complete:true});resolve({values:new Map([['private-key',1]]),signature:'PRIVATE'});},fail(){options.signal?.removeEventListener('abort',abort);reject(Object.assign(Error('PRIVATE'),{code:'EIO'}));}});
 }))as any});
 const request=(events:any[],onRead=vi.fn(),controller=new AbortController())=>reader.read('/PRIVATE-path',{keys:new Set(['private-key']),signal:controller.signal,onRead,onDiagnostic:(e:any)=>events.push(e)}as any);
 return{reader,calls,request};
}

it('reports the one physical scan to every active consumer and correlates lifecycle without keys',async()=>{
 const h=harness(),a:any[]=[],b:any[]=[],one=vi.fn(),two=vi.fn();
 const p=h.request(a,one),q=h.request(b,two);await turn();h.calls[0].open();h.calls[0].finish();await Promise.all([p,q]);
 expect(h.calls).toHaveLength(1);expect(one).toHaveBeenCalledTimes(1);expect(two).toHaveBeenCalledTimes(1);
 expect(a.map(e=>e.phase)).toEqual(['queued','started','opened','completed']);
 expect(b.map(e=>e.phase)).toEqual(['joined','started','opened','completed']);
 expect(new Set([...a,...b].map(e=>e.readId)).size).toBe(1);
 expect(a.at(-1)).toMatchObject({bytesRead:100,fileBytes:100,complete:true});
 expect(JSON.stringify([a,b])).not.toMatch(/PRIVATE|private-key|signature|path/);
});

it('identifies a late shared join and keeps cancellation isolated',async()=>{
 const h=harness(),a:any[]=[],b:any[]=[],ownerRead=vi.fn(),followerRead=vi.fn(),controller=new AbortController();
 const p=h.request(a,ownerRead,controller);const rejected=expect(p).rejects.toMatchObject({name:'AbortError'});await turn();h.calls[0].open();
 const q=h.request(b,followerRead);await turn();controller.abort();await rejected;h.calls[0].finish();await q;
 expect(b[0]).toMatchObject({phase:'joined',started:true,fileBytes:100,readId:a[0].readId});expect(b[0].ageMs).toBeGreaterThanOrEqual(0);
 expect(a.at(-1)).toMatchObject({phase:'aborted',started:true});expect(ownerRead).not.toHaveBeenCalled();expect(followerRead).toHaveBeenCalledTimes(1);
 expect(b.at(-1).phase).toBe('completed');expect(h.reader.snapshot()).toMatchObject({startedReads:1,activeReads:0,activeWaiters:0});
});

it('keeps observer throws and rejected promises out of read success and failure semantics',async()=>{
 const h=harness();
 const p=h.reader.read('/PRIVATE-path',{keys:new Set(['private-key']),onDiagnostic:()=>{throw Error('diagnostic');},onRead:()=>Promise.reject(Error('diagnostic'))}as any);
 await turn();h.calls[0].open();h.calls[0].finish();expect((await p).values.get('private-key')).toBe(1);
 const q=h.reader.read('/PRIVATE-path',{keys:new Set(['private-key']),onDiagnostic:()=>Promise.reject(Error('diagnostic'))}as any);
 const rejected=expect(q).rejects.toMatchObject({code:'EIO'});await turn();h.calls[1].fail();await rejected;
});

it('diagnoses direct fallback and all-waiter cancellation without cached success',async()=>{
 const h=harness(),a:any[]=[],c=new AbortController();
 const p=h.reader.read('/PRIVATE-path',{keys:new Set(['private-key']),onEntry:()=>{},onDiagnostic:(e:any)=>a.push(e)}as any);await turn();h.calls[0].open();h.calls[0].finish();await p;
 expect(a.map(e=>e.phase)).toEqual(['started','opened','completed']);
 const b:any[]=[];const q=h.request(b,vi.fn(),c);const rejected=expect(q).rejects.toMatchObject({name:'AbortError'});await turn();c.abort();await rejected;await turn();
 expect(b.at(-1)).toMatchObject({phase:'aborted',started:true});await h.reader.drain();expect(h.reader.snapshot().activeReads).toBe(0);
});

const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
it('reports file opening from the existing stat without leaking path, signature or values',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-diagnostic-open-'));dirs.push(dir);const path=join(dir,'PRIVATE.bin');await writeFile(path,'{"private-key":1}');
 const events:any[]=[];let opened=false;
 const result=await readNamespaceEntries(path,{keys:new Set(['private-key']),onOpen:(info:any)=>{opened=true;events.push(info);},onEntry:()=>expect(opened).toBe(true)}as any);
 expect(result.values.get('private-key')).toBe(1);expect(events).toEqual([{fileBytes:17}]);
 expect(JSON.stringify(events)).not.toMatch(/PRIVATE|private-key|signature|path/);
});
it('ignores open-observer failures while still rejecting corrupt namespaces',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-diagnostic-open-'));dirs.push(dir);const path=join(dir,'file.bin');await writeFile(path,'{}');
 await expect(readNamespaceEntries(path,{onOpen:()=>{throw Error('diagnostic');}}as any)).resolves.toMatchObject({entries:0});
 await writeFile(path,'{"a":}');await expect(readNamespaceEntries(path,{onOpen:()=>Promise.reject(Error('diagnostic'))}as any)).rejects.toMatchObject({code:'state_namespace_corrupt'});
});
it('retains only an epoch-bound anonymous certificate reference in compression diagnostics',()=>{
 const ref='a'.repeat(32)+':123';
 expect(safeFailureDetails({diagnostics:{category:'state_durability',errorCode:'STATE_READBACK_TIMEOUT',certificateRef:ref,body:'PRIVATE',sessionId:'PRIVATE'}})).toEqual({category:'state_durability',errorCode:'STATE_READBACK_TIMEOUT',certificateRef:ref});
 for(const bad of ['session-private:123','a'.repeat(32)+':0','a'.repeat(32)+':1 PRIVATE'])expect(safeFailureDetails({diagnostics:{certificateRef:bad}})).toEqual({});
});
it('isolates diagnostic payload mutation between shared consumers',async()=>{
 const h=harness(),events:any[]=[];
 const one=h.reader.read('/PRIVATE-path',{keys:new Set(['private-key']),onDiagnostic:(event:any)=>{event.phase='PRIVATE';},onRead:(info:any)=>{info.bytesRead=999;}}as any);
 const observer=vi.fn();const two=h.request(events,observer);await turn();h.calls[0].open();h.calls[0].finish();await Promise.all([one,two]);
 expect(events.map(e=>e.phase)).toEqual(['joined','started','opened','completed']);expect(observer.mock.calls[0][0].bytesRead).toBe(100);expect(events.at(-1).bytesRead).toBe(100);
});
it('ignores a throwing certificate-reference accessor without changing existing failure fields',()=>{
 const details={category:'state_durability',get certificateRef(){throw Error('diagnostic');}};
 expect(()=>safeFailureDetails({diagnostics:details})).not.toThrow();expect(safeFailureDetails({diagnostics:details})).toEqual({category:'state_durability'});
});
