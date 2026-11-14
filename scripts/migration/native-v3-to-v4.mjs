#!/usr/bin/env node
// Explicit two-phase, no production defaults. Store bytes are never restored or reset.
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {registerWorker} from 'iii-sdk';
import {createEngineEpochEvidence,waitForEngineEpoch} from '../../src/ops/engine-epoch.mjs';
import {prepareNativeMigration,saveNativeMigrationProof,finalizeNativeMigration} from '../../src/ops/native-lease-migration.mjs';
const [mode,...args]=process.argv.slice(2),values={};
for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||!args[i+1])throw Error('Expected explicit --name value pairs');values[args[i].slice(2)]=args[i+1];}
for(const key of ['store','proof'])if(!values[key])throw Error('Required --'+key);
const storePath=resolve(values.store),proofPath=resolve(values.proof);
if(mode==='prepare'){
 for(const key of ['runtime','native-executable','engine-url'])if(!values[key])throw Error('Required --'+key);
 const runtimeDir=resolve(values.runtime),sdk=registerWorker(values['engine-url'],{workerName:'native-migration-proof',enableMetricsReporting:false,otel:{enabled:false}});
 try{
  const evidence=createEngineEpochEvidence({engineUrl:values['engine-url'],enginePidPath:join(runtimeDir,'iii.pid'),engineStatePath:join(runtimeDir,'engine-state.json'),peer:()=>{const s=sdk.ws?._socket;return s?{remoteAddress:s.remoteAddress,remotePort:s.remotePort,localAddress:s.localAddress,localPort:s.localPort}:null;}});
  await waitForEngineEpoch(evidence);
  const proof=prepareNativeMigration({storePath,runtimeDir,expectedExecutable:resolve(values['native-executable']),engineEvidence:evidence});
  saveNativeMigrationProof(proof,proofPath);
  console.log(JSON.stringify({prepared:true,sourceSha256:proof.sourceSha256,requiresOfflineFinalization:true}));
 }finally{await sdk.shutdown();}
}else if(mode==='finalize'){
 const result=finalizeNativeMigration({storePath,proof:JSON.parse(readFileSync(proofPath,'utf8'))});
 console.log(JSON.stringify({...result,finalized:true,markerRewritten:false,storeRestored:false}));
}else throw Error('Usage: prepare --store PATH --proof NEW_FILE --runtime PATH --native-executable FILE --engine-url URL; finalize --store PATH --proof FILE');
