import {it,expect,vi} from 'vitest';
vi.mock('../src/ops/metrics-cpu-capacity.mjs',()=>({getCpuCapacityCores:async()=>8}));
import {registerHealthMonitor} from '../src/health/monitor.js';
it('collector resolves effective capacity and drains an admitted publication',async()=>{
 const rows=new Map();let release!:()=>void;const blocked=new Promise<void>(r=>release=r);let published=false;
 const kv={set:async(_s:string,k:string,value:unknown)=>{if(k==='latest'){await blocked;published=true;}rows.set(k,value);},get:async(_s:string,k:string)=>rows.get(k)};
 const sdk={trigger:async()=>({workers:[]})};
 const monitor=registerHealthMonitor(sdk as never,kv as never);
 await vi.waitFor(()=>expect(rows.has('_probe')).toBe(true));
 monitor.stop();let drained=false;const drain=monitor.drain().then(()=>drained=true);
 await new Promise(r=>setTimeout(r,5));expect(drained).toBe(false);
 release();await drain;expect(published).toBe(true);
 expect(rows.get('latest').cpu.capacityCores).toBe(8);
 expect(Number.isFinite(rows.get('latest').cpu.capacityPercent)).toBe(true);
 expect(rows.get('latest').connectionState).toBe('connected');
});

import {operationalHealth,operationalState} from '../src/ops/context.js';
it('health resolves asynchronous operational snapshots before JSON publication',async()=>{
 operationalState.embeddingRecovery={snapshot:async()=>({status:'current',pendingCount:0})};
 try{const result=await operationalHealth();expect(JSON.parse(JSON.stringify(result)).embeddingRecovery).toEqual({status:'current',pendingCount:0});}
 finally{delete operationalState.embeddingRecovery;}
});
