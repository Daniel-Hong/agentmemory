import {expect,it} from 'vitest';
import {registerSummarizeFunction} from '../src/functions/summarize.js';
import {serializeLongSessionProvider} from '../src/ops/long-session.mjs';
import {withKeyedLock} from '../src/state/keyed-mutex.js';
import {KV} from '../src/state/schema.js';
it('prepares two sessions while the actual provider remains serialized',async()=>{
 const values=new Map<string,any>();const handlers=new Map<string,any>();let release!:()=>void;const gate=new Promise<void>(r=>release=r);let active=0,maxActive=0,calls=0;
 const kv={get:async(s:string,k:string)=>structuredClone(values.get(s+'|'+k)??null),set:async(s:string,k:string,v:any)=>{values.set(s+'|'+k,structuredClone(v));return v;},list:async(s:string)=>structuredClone([...values].filter(([k])=>k.startsWith(s+'|')).map(([,v])=>v)),update:async(s:string,k:string,changes:any[])=>{const row=values.get(s+'|'+k);for(const c of changes)row[c.path]=c.value;}};
 const provider=serializeLongSessionProvider({name:'synthetic',compress:async()=>'',summarize:async()=>{calls++;active++;maxActive=Math.max(active,maxActive);await gate;active--;return JSON.stringify({title:'synthetic',narrative:'Verified synthetic work.',keyDecisions:[],filesModified:[],concepts:[]});}},withKeyedLock);
 const sdk={registerFunction:(id:string,fn:any)=>handlers.set(id,fn),trigger:async(r:any)=>handlers.get(r.function_id)?.(r.payload)};
 for(const id of ['one','two']){await kv.set(KV.sessions,id,{id,project:'fixture',startedAt:'2026-01-01',status:'completed',observationCount:1,summaryProgress:{status:'queued'}});await kv.set(KV.observations(id),'row',{id:'row',sessionId:id,timestamp:'2026-01-01',title:'synthetic',type:'decision',sourceRaw:{hookType:'post_tool_use',toolOutput:'Synthetic evidence'}});}
 const handle=registerSummarizeFunction(sdk as never,kv as never,provider as never,undefined,{schedule:false});const work=['one','two'].map(sessionId=>handlers.get('mem::summarize')({sessionId}));
 try{await new Promise(r=>setImmediate(r));expect((await kv.get(KV.sessions,'one')).summaryProgress?.status).toBe('running');expect((await kv.get(KV.sessions,'two')).summaryProgress?.status).toBe('running');expect(calls).toBe(1);release();expect((await Promise.all(work)).every(r=>r.success)).toBe(true);expect(calls).toBe(2);expect(maxActive).toBe(1);}finally{release();await Promise.allSettled(work);await handle.stop();}
});
