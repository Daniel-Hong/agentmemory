import {expect,it,vi} from 'vitest';
import {createInflightBodyReader} from '../src/ops/inflight-body-reader.mjs';
it('falls back without retaining flights above the source-byte admission cap',async()=>{
 const read=createInflightBodyReader();let release!:()=>void;const gate=new Promise<void>(r=>release=r);const load=vi.fn(async()=>{await gate;return new Map([['x',{id:'synthetic'}]]);});
 const a=read({key:'a',fileBytes:400*1024*1024,load}),b=read({key:'b',fileBytes:200*1024*1024,load}),c=read({key:'b',fileBytes:200*1024*1024,load});
 await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(3));release();await Promise.all([a,b,c]);
});
it('falls back after eight active scopes and releases the admission after settlement',async()=>{
 const read=createInflightBodyReader();let release!:()=>void;const gate=new Promise<void>(r=>release=r);const load=vi.fn(async()=>{await gate;return new Map([['x',{id:'synthetic'}]]);});
 const jobs=Array.from({length:8},(_,i)=>read({key:String(i),fileBytes:1,load}));jobs.push(read({key:'extra',fileBytes:1,load}),read({key:'extra',fileBytes:1,load}));
 await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(10));release();await Promise.all(jobs);
 let nextRelease!:()=>void;const nextGate=new Promise<void>(r=>nextRelease=r),nextLoad=vi.fn(async()=>{await nextGate;return new Map();});
 const p=read({key:'next',fileBytes:1,load:nextLoad}),q=read({key:'next',fileBytes:1,load:nextLoad});await vi.waitFor(()=>expect(nextLoad).toHaveBeenCalledTimes(1));nextRelease();await Promise.all([p,q]);
});
it('holds admission until an aborted physical load has actually unwound',async()=>{
 const read=createInflightBodyReader(),c=new AbortController();let release!:()=>void;const gate=new Promise<void>(r=>release=r);const load=vi.fn(async()=>{await gate;return new Map();});
 const p=read({key:'old',fileBytes:400*1024*1024,signal:c.signal,load}),done=Promise.allSettled([p]);await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(1));c.abort();await done;
 const a=read({key:'new',fileBytes:200*1024*1024,load}),b=read({key:'new',fileBytes:200*1024*1024,load});await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(3));release();await Promise.all([a,b]);
});
for(const cancelled of [0,1])it(`protects the other consumer when consumer ${cancelled} aborts during clone yield`,async()=>{
 const read=createInflightBodyReader(),signals=[new AbortController(),new AbortController()],source=new Map(Array.from({length:8},(_,i)=>[String(i),{nested:{id:i}}]));let ticks=0,cloned=0;
 const clock=vi.spyOn(performance,'now').mockImplementation(()=>ticks+=5),original=structuredClone,clone=vi.spyOn(globalThis,'structuredClone').mockImplementation(value=>{if(++cloned===1)setImmediate(()=>signals[cancelled].abort());return original(value);});
 try{let release!:()=>void;const gate=new Promise<void>(r=>release=r),load=async()=>{await gate;return source;};const jobs=signals.map(c=>read({key:'x',fileBytes:1024,signal:c.signal,load})),done=Promise.allSettled(jobs);release();const out=await done;
 expect(out[cancelled].status).toBe('rejected');expect(out[1-cancelled].status).toBe('fulfilled');if(out[1-cancelled].status==='fulfilled')expect(out[1-cancelled].value).toEqual(source);
 }finally{clone.mockRestore();clock.mockRestore();}
});
