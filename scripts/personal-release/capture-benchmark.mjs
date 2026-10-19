#!/usr/bin/env node
// Synthetic reader/metadata benchmark; never starts a service or opens production data.
import assert from 'node:assert/strict';
import {mkdtemp,open,rm,stat,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createObservationReader} from '../../src/ops/observation-pages.mjs';
import {budgetLiveObservationSource} from '../../src/functions/observation-source-budget.js';

const root=await mkdtemp(join(tmpdir(),'am-capture-metadata-benchmark-'));
const scope='mem:obs:synthetic',path=join(root,encodeURIComponent(scope)+'.bin');
const baseCount=2100,newCount=100;
const written=new Map();
function row(i){return {id:'obs_synthetic_'+i,sessionId:'synthetic',timestamp:'2026-10-19T00:00:00Z',title:'synthetic',narrative:'retained',facts:[],files:[],concepts:[],source:{hookType:'post_tool_use',originalBytes:8,truncated:false,toolOutput:'retained'},sourceRaw:{raw:'x'.repeat(64*1024)}};}
async function seed(count){const fd=await open(path+'.next','w');try{await fd.write('{');for(let i=0;i<count;i++){const value=written.get(i)||row(i);await fd.write((i?',':'')+JSON.stringify(value.id)+':'+JSON.stringify(value));}await fd.write('}');}finally{await fd.close();}await rename(path+'.next',path);}
try{
 await seed(baseCount);
 const reader=createObservationReader({storePath:root,kv:{get:async()=>null}});
 let began=performance.now();const cpu=process.cpuUsage();
 const initial=await reader.captureSummary(scope);const coldMs=performance.now()-began;
 assert.equal(initial.count,baseCount);
 const samples=[];
 for(let i=baseCount;i<baseCount+newCount;i++){
  began=performance.now();const incoming=row(i),budget=await reader.captureSummary(scope,incoming.id);
  const retained=budgetLiveObservationSource(incoming,budget);assert.equal(retained.sourceRaw.raw,incoming.sourceRaw.raw);
  reader.record(scope,incoming.id,retained);written.set(i,retained);samples.push(performance.now()-began);
 }
 assert.equal((await reader.captureSummary(scope)).count,baseCount+newCount);
 // Publish the same synthetic rows, then rebuild with a fresh reader as after restart.
 await seed(baseCount+newCount);
 const restarted=createObservationReader({storePath:root,kv:{get:async()=>null}});
 const rebuilt=await restarted.captureSummary(scope);
 assert.equal(rebuilt.count,baseCount+newCount);
 assert.deepEqual(rebuilt,await reader.captureSummary(scope));
 samples.sort((a,b)=>a-b);const usage=process.cpuUsage(cpu);
 console.log(JSON.stringify({synthetic:true,productionTouched:false,namespaceBytes:(await stat(path)).size,initialRecords:baseCount,newRecords:newCount,coldMs:Math.round(coldMs),warmP95Ms:+samples[Math.floor(samples.length*.95)].toFixed(3),warmMaxMs:+samples.at(-1).toFixed(3),cpuMs:Math.round((usage.user+usage.system)/1000),maxRssKiB:process.resourceUsage().maxRSS,restartCount:rebuilt.count,rawPreserved:true,limit:'Metadata/reader path only; actual engine/network/disk ACK throughput is a separate smoke test.'}));
}finally{await rm(root,{recursive:true,force:true});}
