import {it,expect,afterEach,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
const race=vi.hoisted(()=>({afterRead:null as null|((path:string)=>void)}));
vi.mock('node:fs',async importOriginal=>{const fs=await importOriginal<any>();return {...fs,readdirSync:(path:any,...args:any[])=>{const result=fs.readdirSync(path,...args);race.afterRead?.(String(path));return result;}};});
afterEach(()=>{race.afterRead=null;});
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
async function fixture(){
 const d=mkdtempSync(join(tmpdir(),'state-epoch-'));dirs.push(d);const proc=join(d,'proc'),store=join(d,'store'),exe=join(d,'state');
 mkdirSync(store);writeFileSync(exe,'trusted-binary');
 const epoch:any={bootId:'11111111-1111-1111-1111-111111111111',engine:{pid:200,start:'20'},worker:{pid:100,start:'10'},workerUid:1000,netNamespace:'net:[1]',pidNamespace:'pid:[1]',endpoint:'ws://127.0.0.1:1000'};
 const write=(p:string,v:string)=>{mkdirSync(join(p,'..'),{recursive:true});writeFileSync(p,v)};
 const stat=(pid:number,start:string)=>pid+' (state) '+['S',...Array(18).fill('0'),start].join(' ');
 for(const pid of [200,300]){write(join(proc,pid+'/stat'),stat(pid,pid===200?'20':'30'));write(join(proc,pid+'/status'),'Uid:\t1000 1000 1000 1000');mkdirSync(join(proc,pid+'/ns'));symlinkSync('net:[1]',join(proc,pid+'/ns/net'));symlinkSync('pid:[1]',join(proc,pid+'/ns/pid'));mkdirSync(join(proc,pid+'/fd'));mkdirSync(join(proc,pid+'/net'))}
 symlinkSync(exe,join(proc,'300/exe'));symlinkSync('socket:[600]',join(proc,'300/fd/3'));symlinkSync('socket:[500]',join(proc,'200/fd/3'));
 write(join(proc,'300/net/tcp'),'0: 0100007F:07D0 0100007F:03E8 01 0 0 0 1000 0 600\n0: 0100007F:03E8 0100007F:07D0 01 0 0 0 1000 0 500');write(join(proc,'300/net/tcp6'),'');
 const identity={version:1,pid:300,start:'30',instanceId:'22222222-2222-4222-8222-222222222222',bootId:epoch.bootId,adapter:'kv',storePath:store};
 const engineEvidence:any={capture:()=>epoch,current:()=>true,gone:()=>true,bootIdentity:()=>epoch.bootId};
 const expectedExecutable={path:exe,sha256:createHash('sha256').update('trusted-binary').digest('hex')};
 const m=await import('../src/ops/state-epoch.mjs');
 return {d,proc,store,exe,identity,epoch,write,stat,engineEvidence,expectedExecutable,m};
}
it('binds immutable State identity, trusted executable and engine-owned socket pair',async()=>{
 const f=await fixture();const evidence=f.m.createStateBoundEvidence({...f,storePath:f.store,procRoot:f.proc});
 const e=evidence.capture();expect(e?.state.instanceId).toBe(f.identity.instanceId);expect(evidence.current(e!)).toBe(true);
 f.write(join(f.proc,'300/stat'),f.stat(300,'31'));expect(evidence.current(e!)).toBe(false);
});
it.each(['hash','store','socket','boot','uid'])('rejects State %s mismatch',async(kind)=>{
 const f=await fixture();
 if(kind==='hash')f.expectedExecutable.sha256='f'.repeat(64);
 if(kind==='store')f.identity.storePath=f.d;
 if(kind==='socket')rmSync(join(f.proc,'200/fd/3'));
 if(kind==='boot')f.identity.bootId='33333333-3333-4333-8333-333333333333';
 if(kind==='uid')f.write(join(f.proc,'300/status'),'Uid:\t0 0 0 0');
 expect(()=>f.m.createStateBoundEvidence({...f,storePath:f.store,procRoot:f.proc})).toThrow();
});
it('pins state RPCs to one immutable instance and preserves non-state SDK calls',async()=>{
 const {pinStateClient}=await import('../src/ops/state-epoch.mjs');const seen:any[]=[];
 const sdk:any={trigger:(req:any)=>{seen.push(req);return Promise.resolve(true)}};
 const client=pinStateClient(sdk,'state::22222222-2222-4222-8222-222222222222::');
 await client.trigger({function_id:'state::set_ack',payload:{value:1}});
 await client.trigger({function_id:'engine::workers::list',payload:{}});
 expect(seen.map(r=>r.function_id)).toEqual(['state::22222222-2222-4222-8222-222222222222::set_ack','engine::workers::list']);
});
it('rejects completion if binding changes during an awaited pinned RPC',async()=>{
 const {pinStateClient}=await import('../src/ops/state-epoch.mjs');let current=true;
 const client=pinStateClient({trigger:async()=>{current=false;return true}} as any,'state::22222222-2222-4222-8222-222222222222::',()=>current);
 await expect(client.trigger({function_id:'state::set_ack',payload:{}})).rejects.toThrow('STATE_WRITER_IDENTITY_CHANGED');
});
it('reports the failing State identity component without weakening checks',async()=>{
 const f=await fixture();const evidence=f.m.createStateBoundEvidence({...f,storePath:f.store,procRoot:f.proc});const epoch=evidence.capture()!;
 rmSync(join(f.proc,'200/fd/3'));expect(evidence.current(epoch)).toBe(false);expect(evidence.diagnostic?.()).toBe('STATE_ENGINE_SOCKET_OWNER_UNVERIFIED');
});
it('attaches phase and reason to identity rejection',async()=>{
 const {pinStateClient}=await import('../src/ops/state-epoch.mjs');
 const client=pinStateClient({trigger:async()=>true} as any,'state::22222222-2222-4222-8222-222222222222::',()=>false,()=> 'STATE_UID_CHANGED');
 await expect(client.trigger({function_id:'state::set',payload:{}})).rejects.toMatchObject({phase:'before_dispatch',diagnostic:'STATE_UID_CHANGED'});
});
it('ignores over 1MiB of unrelated host TCP rows while verifying owned sockets',async()=>{
 const f=await fixture();const table=join(f.proc,'300/net/tcp');const prior=(await import('node:fs')).readFileSync(table,'utf8');
 f.write(table,('0: 0100007F:0AAA 0100007F:0BBB 06 0 0 0 1000 0 0\n').repeat(26000)+prior);
 const evidence=f.m.createStateBoundEvidence({...f,storePath:f.store,procRoot:f.proc});expect(evidence.capture()?.state.instanceId).toBe(f.identity.instanceId);
});

it('reobserves an accepted socket missing from the earlier engine FD snapshot',async()=>{
 const f=await fixture();rmSync(join(f.proc,'200/fd/3'));let reads=0;
 race.afterRead=path=>{if(path===join(f.proc,'200/fd')&&++reads===1)symlinkSync('socket:[500]',join(path,'3'));};
 const evidence=f.m.createStateBoundEvidence({...f,storePath:f.store,procRoot:f.proc});expect(evidence.capture()?.state.instanceId).toBe(f.identity.instanceId);expect(reads).toBeGreaterThan(1);
});
it('does not retry through process replacement during socket reobservation',async()=>{
 const f=await fixture();rmSync(join(f.proc,'200/fd/3'));let reads=0;
 race.afterRead=path=>{if(path===join(f.proc,'200/fd')&&++reads===1){symlinkSync('socket:[500]',join(path,'3'));f.write(join(f.proc,'300/stat'),f.stat(300,'31'));}};
 expect(()=>f.m.createStateBoundEvidence({...f,storePath:f.store,procRoot:f.proc})).toThrow();expect(reads).toBe(1);
});
it('bounds socket reobservation and still rejects persistent foreign ownership',async()=>{
 const f=await fixture();rmSync(join(f.proc,'200/fd/3'));let reads=0;race.afterRead=path=>{if(path===join(f.proc,'200/fd'))reads++;};
 expect(()=>f.m.createStateBoundEvidence({...f,storePath:f.store,procRoot:f.proc})).toThrow();expect(reads).toBeLessThanOrEqual(3);
});
