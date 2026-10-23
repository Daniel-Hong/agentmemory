import {expect,it,afterEach} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const dirs:string[]=[];afterEach(()=>{for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});});
async function fixture(){
 const d=mkdtempSync(join(tmpdir(),'am-engine-evidence-'));dirs.push(d);const proc=join(d,'proc');
 const write=(p:string,s:string)=>{mkdirSync(join(p,'..'),{recursive:true});writeFileSync(p,s);};
 write(join(proc,'sys/kernel/random/boot_id'),'11111111-1111-1111-1111-111111111111');write(join(d,'machine-id'),'fixture-host');write(join(d,'iii.pid'),'200');
 const stat=(pid:number,start:number)=>`${pid} (fixture) ${['S',...Array(18).fill('0'),String(start)].join(' ')}`;
 write(join(proc,'100/stat'),stat(100,10));write(join(proc,'200/stat'),stat(200,20));
 for(const pid of [100,200]){mkdirSync(join(proc,`${pid}/ns`),{recursive:true});symlinkSync('net:[fixture]',join(proc,`${pid}/ns/net`));symlinkSync('pid:[100]',join(proc,`${pid}/ns/pid`));}
 symlinkSync('/usr/bin/iii',join(proc,'200/exe'));mkdirSync(join(proc,'200/fd'));symlinkSync('socket:[500]',join(proc,'200/fd/3'));symlinkSync('socket:[501]',join(proc,'200/fd/4'));
 const row=(local:string,remote:string,state:string,inode:number)=>`0: ${local} ${remote} ${state} 0 0 0 1000 0 ${inode}`;
 const listen=row('0100007F:03E8','00000000:0000','0A',500),connected=row('0100007F:03E8','0100007F:07D0','01',501);
 write(join(proc,'200/net/tcp'),listen+'\n'+connected);write(join(proc,'200/net/tcp6'),'');
 let liveness=false;let peer:any={remoteAddress:'127.0.0.1',remotePort:1000,localAddress:'127.0.0.1',localPort:2000};
 const {createEngineEpochEvidence}=await import('../src/ops/engine-epoch.mjs');
 const evidence=createEngineEpochEvidence({engineUrl:'ws://localhost:1000',enginePidPath:join(d,'iii.pid'),peer:()=>typeof peer==='function'?peer():peer,procRoot:proc,machineIdPath:join(d,'machine-id'),workerPid:100,workerUid:1000,pidAlive:()=>liveness});
 return {d,proc,write,stat,evidence,setPeer:(p:any)=>peer=p,setLiveness:(v:boolean)=>liveness=v,listen,connected};
}
it('binds a local engine to the actual SDK TCP peer and process identities',async()=>{const f=await fixture(),v=f.evidence.capture();expect(v).toMatchObject({worker:{pid:100,start:'10'},engine:{pid:200,start:'20'}});expect(f.evidence.current(v)).toBe(true);expect(f.evidence.gone({pid:201,start:'30'})).toBe(true);expect(f.evidence.gone({pid:200,start:'20'})).toBe(false);f.write(join(f.proc,'200/stat'),f.stat(200,21));expect(f.evidence.gone({pid:200,start:'20'})).toBe(true);expect(f.evidence.current(v)).toBe(false);});
it.each(['foreign-peer','unowned-socket','duplicate-listen','namespace','missing-process','missing-peer'])('refuses %s evidence',async(kind)=>{
 const f=await fixture();if(kind==='foreign-peer')f.setPeer({remoteAddress:'192.0.2.1',remotePort:1000,localAddress:'127.0.0.1',localPort:2000});
 if(kind==='unowned-socket')rmSync(join(f.proc,'200/fd/4'));
 if(kind==='duplicate-listen')f.write(join(f.proc,'200/net/tcp'),f.listen+'\n'+f.listen.replace('500','502')+'\n'+f.connected);
 if(kind==='namespace'){rmSync(join(f.proc,'200/ns/net'));symlinkSync('net:[different]',join(f.proc,'200/ns/net'));}
 if(kind==='missing-process')rmSync(join(f.proc,'200/stat'));
 if(kind==='missing-peer')f.setPeer(null);
 expect(f.evidence.capture()).toBeNull();
});

it('does not treat hidden-but-live processes as terminated',async()=>{const f=await fixture();f.setLiveness(true);expect(f.evidence.gone({pid:201,start:'30'})).toBe(false);});
it('supports the actual IPv6 loopback socket tuple without DNS assumptions',async()=>{const f=await fixture(),address='00000000000000000000000001000000';f.setPeer({remoteAddress:'::1',remotePort:1000,localAddress:'::1',localPort:2000});f.write(join(f.proc,'200/net/tcp'),'');f.write(join(f.proc,'200/net/tcp6'),f.listen.replaceAll('0100007F',address).replace('00000000:0000','00000000000000000000000000000000:0000')+'\n'+f.connected.replaceAll('0100007F',address));expect(f.evidence.capture()).not.toBeNull();});
it('refuses a socket peer that changes while evidence is being captured',async()=>{const f=await fixture();let calls=0;f.setPeer(()=>({remoteAddress:'127.0.0.1',remotePort:1000,localAddress:'127.0.0.1',localPort:++calls===1?2000:2001}));expect(f.evidence.capture()).toBeNull();});
