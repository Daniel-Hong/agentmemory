import {afterEach,expect,it,vi} from 'vitest';
const gate=vi.hoisted(()=>({started:false,resolve:null as null|((v:any)=>void)}));
vi.mock('node:fs/promises',async original=>{
 const actual=await original<typeof import('node:fs/promises')>();return {...actual,stat:async(...args:Parameters<typeof actual.stat>)=>{
  if(args[0]!=='/synthetic-delayed')return actual.stat(...args);gate.started=true;return new Promise(resolve=>{gate.resolve=resolve;});
 }};
});
import {createSharedNamespaceReader}from'../src/ops/shared-namespace-reader.mjs';
afterEach(()=>{vi.restoreAllMocks();gate.started=false;gate.resolve=null;});
it('drains an abandoned asynchronous size classification without spinning on empty work',async()=>{
 const read=vi.fn(),reader=createSharedNamespaceReader({read,maxParallelReads:1,maxSmallParallelReads:1});const controller=new AbortController();
 const request=reader.read('/synthetic-delayed',{keys:new Set(['key']),signal:controller.signal});const rejected=expect(request).rejects.toMatchObject({name:'AbortError'});
 await vi.waitFor(()=>expect(gate.started).toBe(true));controller.abort();await rejected;
 const actual=Promise.allSettled.bind(Promise);let emptyTurns=0;
 vi.spyOn(Promise,'allSettled').mockImplementation((values:any)=>{const items=[...values];if(!items.length&&++emptyTurns>8)throw Error('empty_drain_spin');return actual(items)as any;});
 const drain=reader.drain();setImmediate(()=>gate.resolve?.({size:4}));
 try{await expect(drain).resolves.toBeUndefined();expect(read).not.toHaveBeenCalled();expect(reader.snapshot().sharedJobs).toBe(0);}
 finally{gate.resolve?.({size:4});await new Promise(resolve=>setImmediate(resolve));}
});
