import { expect, it, vi } from 'vitest';
import { registerEventTriggers } from '../src/triggers/events.js';
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
it('retains direct lifecycle functions without requiring the removed durable queue worker',async()=>{
 const handlers=new Map<string,any>();const trigger=vi.fn(async()=>({observationId:'synthetic'}));
 const sdk={registerFunction:(id:string,fn:any)=>handlers.set(id,fn),registerTrigger:(config:any)=>{if(config.type==='durable:subscriber')throw Error('removed trigger provider');},trigger};
 expect(()=>registerEventTriggers(sdk as never,{}as never)).not.toThrow();
 for(const id of ['event::session::started','event::session::stopped','event::session::ended','event::observation'])expect(handlers.has(id)).toBe(true);
 expect(await handlers.get('event::observation')({sessionId:'synthetic'})).toEqual({observationId:'synthetic'});
 expect(trigger).toHaveBeenCalledWith({function_id:'mem::observe',payload:{sessionId:'synthetic'}});
});
it('executes retained direct start and end handlers and updates the project index',async()=>{
 const {KV}=await import('../src/state/schema.js');const {getProjectSessionIndex}=await import('../src/state/session-index.js');
 const rows=new Map<string,any>();const handlers=new Map<string,any>();const kv={get:async(s:string,k:string)=>rows.get(s+'|'+k)??null,set:async(s:string,k:string,v:any)=>{rows.set(s+'|'+k,v);return v;},list:async(s:string)=>[...rows].filter(([k])=>k.startsWith(s+'|')).map(([,v])=>v),update:async(s:string,k:string,changes:any[])=>{const row=rows.get(s+'|'+k);for(const c of changes)row[c.path]=c.value;}};
 const sdk={registerFunction:(id:string,fn:any)=>handlers.set(id,fn),registerTrigger:()=>{},trigger:async()=>({context:'synthetic'})};registerEventTriggers(sdk as never,kv as never);
 expect(await handlers.get('event::session::started')({sessionId:'synthetic',project:'fixture',cwd:'/fixture'})).toMatchObject({session:{status:'active'}});
 expect((await getProjectSessionIndex(kv as never,'fixture'))?.map(row=>row.id)).toEqual(['synthetic']);
 expect(await handlers.get('event::session::ended')({sessionId:'synthetic'})).toMatchObject({success:true,ended:true});expect(await kv.get(KV.sessions,'synthetic')).toMatchObject({status:'completed'});
});
