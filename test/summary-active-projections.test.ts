import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StateKV} from '../src/state/kv.js';
const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
const row=(i:number)=>({sessionId:'s'+i,createdAt:new Date(1700000000000+i*1000).toISOString(),title:'title'+i,narrative:'full narrative'+i,concepts:['concept'+i],sourceProjectionSnapshots:{unneeded:'retained-source'},keyDecisions:['not used here']});
async function fixture(rows:Record<string,unknown>){
 const dir=await mkdtemp(join(tmpdir(),'am-active-summaries-'));dirs.push(dir);vi.stubEnv('AGENTMEMORY_STATE_STORE_PATH',dir);
 const path=join(dir,encodeURIComponent('mem:summaries')+'.bin');await writeFile(path,JSON.stringify(rows));
 const trigger=vi.fn(async({function_id,payload}:any)=>{if(function_id==='state::set')return {new_value:payload.value};if(function_id==='state::delete')return true;if(function_id==='state::update')return {new_value:row(99)};throw Error('full_summary_sdk_read_forbidden');});
 return {kv:new StateKV({trigger} as never),trigger,path};
}
it('returns exactly the existing newest20 semantic inputs and total, without unused source fields',async()=>{
 const rows=Object.fromEntries(Array.from({length:25},(_,i)=>['key'+i,row(i)]));const {kv,trigger}=await fixture(rows);
 const actual=await kv.getSummaryMergeInputs();const recent=Object.values(rows).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).slice(0,20).map(({sessionId,createdAt,title,narrative,concepts})=>({sessionId,createdAt,title,narrative,concepts}));
 expect(actual).toEqual({total:25,recent});expect(trigger).not.toHaveBeenCalled();
});
it('provides the exact sessionId set including duplicate IDs and different physical keys',async()=>{
 const {kv}=await fixture({a:row(1),b:row(1),differentKey:row(2)});expect(await kv.getSummarySessionIds()).toEqual(new Set(['s1','s2']));
});
it('overlays completed SDK state and does not resurrect a deleted row after old publication',async()=>{
 const {kv,path}=await fixture({a:row(1),b:row(2)});await kv.set('mem:summaries','a',row(99));await kv.delete('mem:summaries','b');await kv.set('mem:summaries','c',row(3));
 expect((await kv.getSummaryMergeInputs()).recent.map(s=>s.sessionId)).toEqual(['s99','s3']);expect(await kv.getSummarySessionIds()).toEqual(new Set(['s99','s3']));
 await writeFile(path,JSON.stringify({a:row(1),b:row(2)}));expect(await kv.getSummarySessionIds()).toEqual(new Set(['s99','s3']));
});
it('keeps stable tie ordering and recovers the next eligible row after deleting a top result',async()=>{
 const rows=Object.fromEntries(Array.from({length:25},(_,i)=>['k'+i,{...row(i),createdAt:row(1).createdAt}]));const{kv}=await fixture(rows);
 await kv.delete('mem:summaries','k0');expect((await kv.getSummaryMergeInputs()).recent.map(s=>s.sessionId)).toEqual(Array.from({length:20},(_,i)=>'s'+(i+1)));
});
it('does not treat unavailable identities or corrupt inputs as an empty collection',async()=>{
 const {kv,path}=await fixture({a:row(1)});await writeFile(path,'{"a":');await expect(kv.getSummarySessionIds()).rejects.toThrow(/state_namespace/);await expect(kv.getSummaryMergeInputs()).rejects.toThrow(/state_namespace/);
});
it('does not guess the semantic order of tied selected or boundary pending records',async()=>{
 const rows=Object.fromEntries(Array.from({length:21},(_,i)=>['k'+i,{...row(i),createdAt:row(1).createdAt}]));const{kv}=await fixture(rows);
 await kv.set('mem:summaries','k20',{...row(20),createdAt:row(1).createdAt});
 await expect(kv.getSummaryMergeInputs()).rejects.toThrow('summary_projection_order_uncertain');
 expect((await kv.getSummarySessionIds()).size).toBe(21);expect(await kv.countSummaries()).toBe(21);
});
it('retains IDs when only semantic metadata exceeds its bounded retention',async()=>{
 const {kv}=await fixture({a:row(1)});await kv.set('mem:summaries','new',{...row(2),narrative:'x'.repeat(8*1024*1024)});
 await expect(kv.getSummaryMergeInputs()).rejects.toThrow('summary_projection_unavailable');
 expect(await kv.getSummarySessionIds()).toEqual(new Set(['s1','s2']));expect(await kv.countSummaries()).toBe(2);
});
it('does not alias caller or consumer arrays into completed SDK projection metadata',async()=>{
 const {kv}=await fixture({});const value=row(1);await kv.set('mem:summaries','k',value);value.concepts.push('not saved');
 const first=await kv.getSummaryMergeInputs();expect(first.recent[0].concepts).toEqual(['concept1']);first.recent[0].concepts.push('consumer mutation');
 expect((await kv.getSummaryMergeInputs()).recent[0].concepts).toEqual(['concept1']);
});
it('rejects uninterpretable semantic dates without weakening ID or count access',async()=>{
 const{kv}=await fixture({a:{...row(1),createdAt:'invalid'}});await expect(kv.getSummaryMergeInputs()).rejects.toThrow('summary_projection_date_invalid');
 expect(await kv.getSummarySessionIds()).toEqual(new Set(['s1']));expect(await kv.countSummaries()).toBe(1);
});
it('pins projected JSON at SDK dispatch rather than reading a caller object after completion',async()=>{
 const{kv,trigger}=await fixture({});let entered!:()=>void,release!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});let saved:any;
 trigger.mockImplementationOnce(async({payload}:any)=>{saved=JSON.parse(JSON.stringify(payload.value));entered();await gate;return {new_value:saved};});
 const value=row(1),pending=kv.set('mem:summaries','k',value);await ready;value.sessionId='changed';value.title='changed';value.concepts.push('changed');release();await pending;
 expect(await kv.getSummarySessionIds()).toEqual(new Set([saved.sessionId]));expect((await kv.getSummaryMergeInputs()).recent[0].concepts).toEqual(saved.concepts);
});
it('preserves native per-key write order when an older reply would arrive later',async()=>{
 const{kv,trigger}=await fixture({});let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});let native:any;
 trigger.mockImplementation(async({payload}:any)=>{const value=JSON.parse(JSON.stringify(payload.value));native=value;if(value.sessionId==='s1'){entered();await gate;}return {new_value:value};});
 const first=kv.set('mem:summaries','k',row(1));await ready;const second=kv.set('mem:summaries','k',row(2));await new Promise(r=>setImmediate(r));release();await Promise.all([first,second]);
 expect((await kv.getSummaryMergeInputs()).recent[0].sessionId).toBe(native.sessionId);
});
