import {expect,it,vi} from 'vitest';
const calls=vi.hoisted(()=>({create:0,reset:0,enable:0,disable:0}));
vi.mock('node:perf_hooks',async original=>{
 const actual=await original<typeof import('node:perf_hooks')>();return{...actual,monitorEventLoopDelay:()=>{calls.create++;return{count:0,max:0,mean:NaN,reset(){calls.reset++;},enable(){calls.enable++;},disable(){calls.disable++;}};}};
});
import {createSharedNamespaceReader} from '../src/ops/shared-namespace-reader.mjs';
const turn=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
it('uses one lazy monitor per reader and resets only when the outstanding-caller window changes',async()=>{
 let release:any;const events:any[]=[];
 const r=createSharedNamespaceReader({read:async()=>new Promise(resolve=>release=()=>resolve({values:new Map([['k',1]]),signature:'s'}))});
 expect(calls.create).toBe(0);
 const controller=new AbortController(),one=r.read('/synthetic',{keys:new Set(['k']),signal:controller.signal,onDiagnostic:(v:any)=>events.push(v)});const rejected=expect(one).rejects.toMatchObject({name:'AbortError'});await turn();const two=r.read('/synthetic',{keys:new Set(['k'])});await turn();
 expect(calls).toEqual({create:1,reset:1,enable:1,disable:0});controller.abort();await rejected;expect(calls.disable).toBe(0);release();await two;await r.drain();expect(calls.disable).toBe(1);
 const next=r.read('/synthetic',{keys:new Set(['k'])});await turn();release();await next;await r.drain();expect(calls).toEqual({create:1,reset:2,enable:2,disable:2});
 const aborted=events.find(v=>v.phase==='aborted');expect(aborted.admission).toMatchObject({loopDelaySamples:0,outstandingPhysicalReads:1});expect(aborted.admission.loopDelayMaxMs).toBeUndefined();
});
