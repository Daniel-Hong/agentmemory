import {expect,it} from 'vitest';
import {createBackgroundControl} from '../src/ops/background-control.mjs';
import {createMemoryPressureGuard,parseMemoryPressure} from '../src/ops/memory-pressure.mjs';
const GiB=1024**3;
async function fixture(hold?:string){
 let now=1000,mono=1000,record:any=hold?{version:2,paused:true,resumePending:false,holds:['memory',hold],recovery:{attempts:0,nextAttemptAt:0}}:null;
 const m:any={total:30*GiB,available:5*GiB,pressure:{some:{avg10:0,avg60:0,total:1000},full:{avg10:0,avg60:0,total:1000}}};
 const kv:any={get:async()=>record,set:async(_:any,__:any,v:any)=>record=structuredClone(v),durability:{wait:async()=>({synced:true,mutationFailures:0}),waitForKeys:async()=>{}}};
 const control=createBackgroundControl({clock:()=>now});await control.init(kv);await control.change('pause',{source:'memory'});
 const guard=createMemoryPressureGuard({control,schedule:false,clock:()=>now,monotonicClock:()=>mono,readSample:async()=>structuredClone(m)});
 async function tick(ms=5000){now+=ms;mono+=ms;await guard.refresh();await guard.drain();}
 return {m,kv,control,guard,tick,record:()=>record,mono:(v:number)=>mono=v,async window(){await tick(0);for(let i=0;i<24;i++){m.pressure.some.total+=40;m.pressure.full.total+=39;await tick();}}};
}
it('admits bounded microstalls after 120 seconds below the old reserve without changing critical',async()=>{
 const f=await fixture();await f.tick(0);for(let i=0;i<23;i++){f.m.pressure.some.total+=40;f.m.pressure.full.total+=39;await f.tick();}
 expect(f.control.isPaused()).toBe(true);await f.tick();expect(f.control.isPaused()).toBe(false);
 expect(f.guard.snapshot()).toMatchObject({level:'normal',criticalBytes:1.5*GiB});
 await f.tick();expect(f.control.isPaused()).toBe(false);
});
it.each(['missing','nan','regression','gap','floor','spike','budget','clock'])('does not use a broken pressure window: %s',async risk=>{
 const f=await fixture();await f.tick(0);for(let i=0;i<23;i++)await f.tick();
 if(risk==='missing')delete f.m.pressure;
 if(risk==='nan')f.m.pressure.some.total=NaN;
 if(risk==='regression')f.m.pressure.full.total=0;
 if(risk==='floor')f.m.available=3.5*GiB;
 if(risk==='spike')f.m.pressure.some.avg10=1.01;
 if(risk==='budget')f.m.pressure.full.total+=121000;
 if(risk==='clock')f.mono(0);
 await f.tick(risk==='gap'?10001:5000);expect(f.control.isPaused()).toBe(true);
});
it('falls back to original recovery when PSI is absent',async()=>{const f=await fixture();delete f.m.pressure;f.m.available=7*GiB;await f.tick(0);for(let i=0;i<24;i++)await f.tick();expect(f.control.isPaused()).toBe(false);});
it.each(['spike','critical','missing'])('rechecks %s after the final storage fence',async risk=>{
 const f=await fixture();await f.tick(0);for(let i=0;i<23;i++)await f.tick();
 f.kv.durability.waitForKeys=async()=>{if(!f.record().paused){if(risk==='spike')f.m.pressure.full.avg60=.101;if(risk==='critical')f.m.available=GiB;if(risk==='missing')delete f.m.pressure;}};
 await f.tick();expect(f.control.snapshot().recovery.attempts).toBe(1);expect(f.control.snapshot().holds).toContain('memory');expect(f.control.isPaused()).toBe(true);
});
it.each(['manual','deployment','storage_error'])('preserves %s hold under pressure recovery',async hold=>{const f=await fixture(hold);await f.window();expect(f.control.snapshot().holds).toContain(hold);expect(f.control.isPaused()).toBe(true);});

it('accepts exact budgets but does not recover before actual monotonic 120 seconds',async()=>{
 const f=await fixture();f.m.pressure.some.avg10=1;f.m.pressure.some.avg60=1;f.m.pressure.full.avg10=.1;f.m.pressure.full.avg60=.1;
 await f.tick(0);for(let i=0;i<24;i++){f.m.pressure.some.total+=50000;f.m.pressure.full.total+=5000;await f.tick();}
 expect(f.control.isPaused()).toBe(false);
 const g=await fixture();await g.tick(0);for(let i=0;i<23;i++)await g.tick();g.mono(115000);await g.tick();expect(g.control.isPaused()).toBe(true);
});
it('restarts observation after a rollover and admits only a new full window',async()=>{
 const f=await fixture();await f.tick(0);for(let i=0;i<23;i++)await f.tick();f.m.pressure.some.total=0;await f.tick();expect(f.control.isPaused()).toBe(true);
 await f.tick();for(let i=0;i<23;i++)await f.tick();expect(f.control.isPaused()).toBe(true);await f.tick();expect(f.control.isPaused()).toBe(false);
});
it('pauses a recovered service on new pressure and immediately keeps critical protection',async()=>{
 const f=await fixture();await f.window();f.m.pressure.full.avg10=.101;await f.tick();expect(f.control.snapshot().holds).toContain('memory');
 f.m.available=GiB;await f.tick();expect(f.guard.snapshot().level).toBe('critical');
});
it('requires a fresh activation certificate after a sampling gap',async()=>{
 const f=await fixture();await f.tick(0);for(let i=0;i<23;i++)await f.tick();
 f.kv.durability.waitForKeys=async()=>{if(!f.record().paused)f.mono(200000);};await f.tick();expect(f.control.isPaused()).toBe(true);expect(f.control.snapshot().holds).toContain('memory');
});
it('parses Linux pressure without inventing zero pressure on malformed or partial data',()=>{
 const line='some avg10=0.01 avg60=0.02 avg300=0.03 total=1000\nfull avg10=0 avg60=0 avg300=0 total=1001';
 expect(parseMemoryPressure(line)).toMatchObject({some:{total:1000},full:{total:1001}});
 for(const text of ['',line.split('\n')[0],line.replace('total=1000','total=-1'),line.replace('avg10=0.01','avg10=NaN'),line.replace('total=1000','total=9007199254740992')])expect(parseMemoryPressure(text)).toBeNull();
});

it.each(['floor','critical','pressure'])('revokes normal resume admission after recovered %s risk',async risk=>{
 const f=await fixture();await f.window();const handlers=new Map<string,any>();const sdk:any={registerFunction:(id:string,fn:any)=>handlers.set(id,fn)};
 f.guard.install(sdk,()=>null);sdk.registerFunction('api::background-control-set',async()=>({status_code:202}));sdk.registerFunction('api::synthetic-write',async()=>({status_code:200}));
 const resume=()=>handlers.get('api::background-control-set')({body:{action:'resume'}});
 expect((await resume()).status_code).toBe(202);
 if(risk==='floor')f.m.available=3.5*GiB;if(risk==='critical')f.m.available=GiB;if(risk==='pressure')f.m.pressure.some.avg60=1.01;
 await f.tick();expect((await resume()).status_code).toBe(503);expect(f.control.snapshot().holds).toContain('memory');
 expect((await handlers.get('api::synthetic-write')({})).status_code).toBe(risk==='critical'?503:200);
});
it.each([
 'some avg10= avg60= total=\nfull avg10= avg60= total=',
 'some avg10=0x1 avg60=0 total=1\nfull avg10=0 avg60=0 total=1',
 'some avg10=Infinity avg60=0 total=1\nfull avg10=0 avg60=0 total=1',
 'some avg10=0 avg10=1 avg60=0 total=1\nfull avg10=0 avg60=0 total=1',
 'some avg10=0 avg60=0 total=1 total=2\nfull avg10=0 avg60=0 total=1',
 'some avg10= 0 avg60=0 total=1\nfull avg10=0 avg60=0 total=1',
 'some avg10=0 avg60=0 total=1\nsome avg10=0 avg60=0 total=1\nfull avg10=0 avg60=0 total=1',
])('rejects malformed PSI lexical fields instead of treating them as zero: %s',text=>{
 expect(parseMemoryPressure(text)).toBeNull();
});
it('preserves legacy 22 percent recovery after 120 seconds even with high PSI',async()=>{
 const f=await fixture();f.m.available=7*GiB;f.m.pressure.some.avg10=10;f.m.pressure.some.avg60=10;f.m.pressure.full.avg10=5;f.m.pressure.full.avg60=5;
 await f.tick(0);for(let i=0;i<23;i++)await f.tick();expect(f.control.isPaused()).toBe(true);
 await f.tick();expect(f.control.isPaused()).toBe(false);expect(f.guard.snapshot().level).toBe('normal');
});
it('does not add a pressure veto to running legacy-normal memory above 18 percent',async()=>{
 const f=await fixture();await f.window();f.m.available=6*GiB;f.m.pressure.full.avg10=10;
 await f.tick();expect(f.control.isPaused()).toBe(false);expect(f.guard.snapshot().level).toBe('normal');
});
it('still refuses below-reserve recovery when the added PSI path has sustained pressure',async()=>{
 const f=await fixture();f.m.pressure.full.avg60=1;await f.window();expect(f.control.isPaused()).toBe(true);expect(f.guard.snapshot().level).toBe('high');
});
it('never combines 119 seconds of quiet below legacy recovery with one high-PSI legacy second',async()=>{
 const f=await fixture();await f.tick(0);for(let i=0;i<23;i++)await f.tick();await f.tick(4000);
 f.m.available=7*GiB;f.m.pressure.full.avg10=10;await f.tick(1000);
 expect(f.control.isPaused()).toBe(true);expect(f.control.snapshot().recovery.attempts).toBe(0);
 for(let i=0;i<23;i++)await f.tick();expect(f.control.isPaused()).toBe(true);await f.tick();expect(f.control.isPaused()).toBe(false);
});
it('does not switch an expired PSI certificate to a fresh legacy path at the final fence',async()=>{
 const f=await fixture();await f.tick(0);for(let i=0;i<23;i++)await f.tick();
 f.kv.durability.waitForKeys=async()=>{if(!f.record().paused){f.m.available=7*GiB;f.m.pressure.full.avg10=10;}};
 await f.tick();expect(f.control.snapshot().recovery.attempts).toBe(1);expect(f.control.isPaused()).toBe(true);expect(f.control.snapshot().holds).toContain('memory');
});
it('invalidates legacy history at every activation sample even while PSI temporarily qualifies',async()=>{
 const f=await fixture();f.m.available=7*GiB;await f.tick(0);for(let i=0;i<23;i++)await f.tick();
 let sawDip=false,sawReturn=false;
 f.kv.durability.wait=async()=>{f.m.available=5*GiB;sawDip=true;return {synced:true,mutationFailures:0};};
 f.kv.durability.waitForKeys=async()=>{if(!f.record().paused){f.m.available=7*GiB;f.m.pressure.full.avg10=10;sawReturn=true;}};
 await f.tick();expect(sawDip).toBe(true);expect(sawReturn).toBe(true);expect(f.control.isPaused()).toBe(true);expect(f.control.snapshot().holds).toContain('memory');
});
