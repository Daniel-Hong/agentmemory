import {it,expect} from 'vitest';
import {createFeatureLifecycle} from '../src/ops/feature-lifecycle.mjs';
import {withKeyedLock} from '../src/state/keyed-mutex.js';
import {KV} from '../src/state/schema.js';
it('shutdown waits for an admitted initialization write',async()=>{
 let release!:(value:null)=>void;const gate=new Promise<null>(r=>release=r);let written=false;
 const kv={get:()=>gate,set:async()=>{written=true;}};
 const worker=createFeatureLifecycle({kv,KV,withKeyedLock,provider:null,schedule:false});
 let stopped=false;const finish=worker.stop().then(()=>stopped=true);
 await new Promise(r=>setTimeout(r,5));expect(stopped).toBe(false);
 release(null);await finish;expect(written).toBe(true);
});
