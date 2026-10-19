import { expect, it } from 'vitest';
import { registerFileIndexFunction } from '../src/functions/file-index.js';
import { registerHealthMonitor } from '../src/health/monitor.js';
import { KV } from '../src/state/schema.js';
import { createShutdownIngress } from '../src/ops/shutdown-ingress.mjs';
import { mockKV, mockSdk } from './helpers/mocks.js';
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
it('keeps a response and ingress drain pending until its access record is saved',async()=>{
 const kv=mockKV(),sdk=mockSdk(),read=gate(),entered=gate();
 await kv.set(KV.sessions,'ses_old',{id:'ses_old',startedAt:'2026-10-01T00:00:00Z'});
 await kv.set(KV.observations('ses_old'),'obs_keep',{id:'obs_keep',sessionId:'ses_old',files:['a.ts'],title:'kept',narrative:'raw reference preserved',importance:8});
 const get=kv.get;kv.get=async(...args:Parameters<typeof get>)=>{if(args[0]===KV.accessLog){entered.release();await read.promise;}return get(...args);};
 const ingress=createShutdownIngress();ingress.install(sdk as never,()=>null);registerFileIndexFunction(sdk as never,kv as never);
 let response=false;const request=sdk.trigger({function_id:'mem::file-context',payload:{files:['a.ts']}}).then(()=>{response=true;});
 await entered.promise;ingress.close();let drained=false;const drain=ingress.drain().then(()=>{drained=true;});
 await new Promise(resolve=>setTimeout(resolve,10));
 try {expect(response).toBe(false);expect(drained).toBe(false);}finally{read.release();await Promise.all([request,drain]);}
 expect(await get(KV.accessLog,'obs_keep')).toMatchObject({count:1});
});
it('drains an active health collection before the final storage fence',async()=>{
 const kv=mockKV(),engine=gate(),entered=gate();
 const sdk={trigger:async()=>{entered.release();await engine.promise;return {workers:[]};}};
 const health=registerHealthMonitor(sdk as never,kv as never);
 await entered.promise;health.stop();let drained=false;
 const pending=Promise.resolve((health as any).drain?.()).then(()=>{drained=true;});
 try {await new Promise(resolve=>setTimeout(resolve,10));expect(drained).toBe(false);}finally{engine.release();await pending;}
 expect(await kv.get(KV.health,'latest')).toMatchObject({connectionState:'connected'});
});
