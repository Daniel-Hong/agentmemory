import {it,expect,afterEach} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {prepareNativeMigration,finalizeNativeMigration,nativeMigrationForMarker,resolveNativeStoreConfig} from '../src/ops/native-lease-migration.mjs';
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
function fixture(){
 const d=mkdtempSync(join(tmpdir(),'native-migration-'));dirs.push(d);const store=join(d,'store'),runtime=join(d,'runtime'),proc=join(d,'proc'),exe=join(d,'iii'),config=join(d,'native.yaml');mkdirSync(store);mkdirSync(runtime);writeFileSync(exe,'known-native-executable');
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
 const epoch={host:'a'.repeat(64),bootId:'11111111-1111-1111-1111-111111111111',endpoint:'ws://localhost:1000',pidNamespace:'pid:[1]',netNamespace:'net:[1]',workerUid:1000,worker:{pid:100,start:'10'},engine:{pid:200,start:'20'}};
 const marker={version:3,store:hash(store),epoch,clean:false};const original=JSON.stringify(marker);writeFileSync(join(store,'.agentmemory-writer.lock'),original);
 writeFileSync(join(store,'synthetic.json'),JSON.stringify({raw:'source',offset:42,holds:['manual'],unknown:true}));
 for(const p of [epoch.worker,epoch.engine]){mkdirSync(join(proc,String(p.pid)),{recursive:true});writeFileSync(join(proc,String(p.pid),'stat'),p.pid+' (native) '+['S',...Array(18).fill('0'),p.start].join(' '));}
 symlinkSync(exe,join(proc,'200/exe'));writeFileSync(join(proc,'200/cmdline'),exe+'\0--config\0'+config+'\0');
 writeFileSync(config,JSON.stringify({workers:[{name:'iii-state',config:{adapter:{name:'kv',config:{store_method:'file_based',file_path:store}}}}]}));
 writeFileSync(join(runtime,'engine-state.json'),JSON.stringify({kind:'native',compatVersion:'0.22.1',processStart:'20',binPath:exe,configPath:config}));
 const evidence:any={capture:()=>epoch,current:()=>true,gone:()=>true};
 const options={storePath:store,runtimeDir:runtime,expectedExecutable:exe,engineEvidence:evidence,procRoot:proc};
 const stop=()=>{rmSync(join(proc,'100'),{recursive:true});rmSync(join(proc,'200'),{recursive:true})};
 return {d,store,runtime,proc,exe,config,epoch,original,evidence,options,stop};
}
it('preserves original bytes and store, issues receipt offline, validates exact v3 migration',()=>{
 const f=fixture(),proof=prepareNativeMigration(f.options);
 expect(()=>finalizeNativeMigration({storePath:f.store,proof,procRoot:f.proc,pidAlive:()=>false})).toThrow('MIGRATION_PRIOR_PROCESS_ALIVE');
 f.stop();const result=finalizeNativeMigration({storePath:f.store,proof,procRoot:f.proc,pidAlive:()=>false});
 expect(readFileSync(join(f.store,'.agentmemory-writer.lock'),'utf8')).toBe(f.original);
 expect(JSON.parse(readFileSync(join(f.store,'synthetic.json'),'utf8'))).toEqual({raw:'source',offset:42,holds:['manual'],unknown:true});
 const epoch={...f.epoch,state:{store:JSON.parse(f.original).store}};
 expect(nativeMigrationForMarker(f.store,f.original,epoch,f.evidence)?.sourceSha256).toBe(result.sourceSha256);
 expect(nativeMigrationForMarker(f.store,f.original+' ',epoch,f.evidence)).toBeNull();
 expect(()=>finalizeNativeMigration({storePath:f.store,proof,procRoot:f.proc,pidAlive:()=>false})).toThrow('MIGRATION_RECEIPT_EXISTS');
});
it.each(['config','store','start','executable'])('rejects mismatched live native %s proof',kind=>{
 const f=fixture();
 if(kind==='config')writeFileSync(join(f.proc,'200/cmdline'),f.exe+'\0--config\0/wrong\0');
 if(kind==='store')writeFileSync(f.config,JSON.stringify({workers:[{name:'iii-state',config:{adapter:{name:'kv',config:{store_method:'file_based',file_path:f.d}}}}]}));
 if(kind==='start')writeFileSync(join(f.proc,'200/stat'),'200 (native) '+['S',...Array(18).fill('0'),'21'].join(' '));
 if(kind==='executable'){const other=join(f.d,'other');writeFileSync(other,'other');f.options.expectedExecutable=other;}
 expect(()=>prepareNativeMigration(f.options)).toThrow();
});
it('rejects changed executable/config after capture and interrupted receipt publication',()=>{
 const f=fixture(),proof=prepareNativeMigration(f.options);f.stop();writeFileSync(f.exe,'changed');
 expect(()=>finalizeNativeMigration({storePath:f.store,proof,procRoot:f.proc,pidAlive:()=>false})).toThrow('MIGRATION_ARTIFACT_CHANGED');
 writeFileSync(f.exe,'known-native-executable');
 expect(()=>finalizeNativeMigration({storePath:f.store,proof,procRoot:f.proc,pidAlive:()=>false,publish:(path:string,bytes:string)=>{writeFileSync(path,bytes);throw Error('injected_sync_failure')}})).toThrow('injected_sync_failure');
 expect(nativeMigrationForMarker(f.store,f.original,{...f.epoch,state:{store:JSON.parse(f.original).store}},f.evidence)).toBeNull();
 expect(readFileSync(join(f.store,'.agentmemory-writer.lock'),'utf8')).toBe(f.original);
});
it('first state-bound acquisition records migration provenance and never rewinds source data',async()=>{
 const f=fixture(),proof=prepareNativeMigration(f.options);f.stop();finalizeNativeMigration({storePath:f.store,proof,procRoot:f.proc,pidAlive:()=>false});
 const {acquireFileWriterLease,fileWriterRecoveryAdmitted}=await import('../src/ops/file-writer-lease.mjs');
 const epoch={...f.epoch,worker:{pid:101,start:'11'},engine:{pid:201,start:'21'},state:{pid:301,start:'31',instanceId:'22222222-2222-4222-8222-222222222222',store:JSON.parse(f.original).store,executableSha256:'a'.repeat(64)}};
 const lease=acquireFileWriterLease(f.store,{evidence:{...f.evidence,capture:()=>epoch}});
 try{
 expect(fileWriterRecoveryAdmitted(lease)).toBe(true);
 const marker=JSON.parse(readFileSync(join(f.store,'.agentmemory-writer.lock'),'utf8'));
 expect(marker.version).toBe(4);expect(marker.migration.sourceSha256).toBe(proof.sourceSha256);
 expect(readFileSync(join(f.store,'.agentmemory-migrations',proof.sourceSha256+'.json'),'utf8')).toContain(proof.sourceSha256);
 expect(JSON.parse(readFileSync(join(f.store,'synthetic.json'),'utf8')).holds).toEqual(['manual']);
 }finally{lease.close();}
});
it('derives process start from verified marker/proc for older native metadata without newer optional fields',()=>{
 const f=fixture();writeFileSync(join(f.runtime,'engine-state.json'),JSON.stringify({kind:'native',binPath:f.exe,configPath:f.config}));
 expect(prepareNativeMigration(f.options).epoch.engine.start).toBe('20');
});
it('reconciles only a normal offline clean transition while preserving original proof and both markers',async()=>{
 const f=fixture(),proof=prepareNativeMigration(f.options),saved=JSON.stringify(proof);
 const final=JSON.stringify({...JSON.parse(f.original),clean:true});writeFileSync(join(f.store,'.agentmemory-writer.lock'),final);
 expect(()=>finalizeNativeMigration({storePath:f.store,proof,procRoot:f.proc,pidAlive:()=>false})).toThrow('MIGRATION_PRIOR_PROCESS_ALIVE');
 f.stop();const result=finalizeNativeMigration({storePath:f.store,proof,procRoot:f.proc,pidAlive:()=>false});
 expect(result.reconciledCleanShutdown).toBe(true);expect(result.preparedSourceSha256).toBe(proof.sourceSha256);expect(JSON.stringify(proof)).toBe(saved);
 const receipt=JSON.parse(readFileSync(result.path,'utf8'));expect(receipt.proof.sourceMarker).toBe(f.original);expect(receipt.finalMarker).toBe(final);
 expect(readFileSync(join(f.store,'.agentmemory-writer.lock'),'utf8')).toBe(final);
 const epoch={...f.epoch,state:{store:JSON.parse(final).store}};
 expect(nativeMigrationForMarker(f.store,final,epoch,f.evidence)?.sourceSha256).toBe(result.sourceSha256);
 expect(nativeMigrationForMarker(f.store,f.original,epoch,f.evidence)).toBeNull();
 expect(()=>finalizeNativeMigration({storePath:f.store,proof,procRoot:f.proc,pidAlive:()=>false})).toThrow('MIGRATION_RECEIPT_EXISTS');
 const {acquireFileWriterLease,fileWriterRecoveryAdmitted}=await import('../src/ops/file-writer-lease.mjs');
 const next={...epoch,worker:{pid:101,start:'11'},engine:{pid:201,start:'21'},state:{...epoch.state,pid:301,start:'31',instanceId:'22222222-2222-4222-8222-222222222222',executableSha256:'a'.repeat(64)}};
 const lease=acquireFileWriterLease(f.store,{evidence:{...f.evidence,capture:()=>next}});
 try{expect(fileWriterRecoveryAdmitted(lease)).toBe(true);expect(JSON.parse(readFileSync(join(f.store,'.agentmemory-writer.lock'),'utf8')).migration.sourceSha256).toBe(result.sourceSha256);}finally{lease.close();}

 expect(JSON.parse(readFileSync(join(f.store,'synthetic.json'),'utf8'))).toEqual({raw:'source',offset:42,holds:['manual'],unknown:true});
});
it.each(['epoch','store','version','blocked','uncertain','extra','clean-reversal'])('rejects offline %s changes rather than refreshing proof',kind=>{
 const f=fixture(),proof=prepareNativeMigration(f.options);f.stop();const changed:any={...JSON.parse(f.original),clean:true};
 if(kind==='epoch')changed.epoch={...changed.epoch,engine:{pid:200,start:'21'}};
 if(kind==='store')changed.store='different';if(kind==='version')changed.version=4;
 if(kind==='blocked')changed.blockedUntilBoot=true;if(kind==='uncertain')changed.uncertaintyBootId='other';
 if(kind==='extra')changed.unexpected='evidence';if(kind==='clean-reversal'){proof.sourceMarker=JSON.stringify(changed);proof.sourceSha256=createHash('sha256').update(proof.sourceMarker).digest('hex');changed.clean=false;}
 writeFileSync(join(f.store,'.agentmemory-writer.lock'),JSON.stringify(changed));
 expect(()=>finalizeNativeMigration({storePath:f.store,proof,procRoot:f.proc,pidAlive:()=>false})).toThrow('MIGRATION_MARKER_CHANGED');
});

it('does not admit an interrupted clean-transition receipt publication',()=>{
 const f=fixture(),proof=prepareNativeMigration(f.options);f.stop();const final=JSON.stringify({...JSON.parse(f.original),clean:true});writeFileSync(join(f.store,'.agentmemory-writer.lock'),final);
 expect(()=>finalizeNativeMigration({storePath:f.store,proof,procRoot:f.proc,pidAlive:()=>false,publish:(path:string,bytes:string)=>{writeFileSync(path,bytes);throw Error('interrupted')}})).toThrow('interrupted');
 expect(nativeMigrationForMarker(f.store,final,{...f.epoch,state:{store:JSON.parse(final).store}},f.evidence)).toBeNull();
 expect(readFileSync(join(f.store,'.agentmemory-writer.lock'),'utf8')).toBe(final);
});

it('resolves reviewed native name-only state through persisted cwd config and pins its digest',()=>{
 const f=fixture();symlinkSync(f.d,join(f.proc,'200/cwd'));mkdirSync(join(f.d,'config'));
 const path=join(f.d,'config/iii-state.yaml'),body={id:'iii-state',value:{adapter:{name:'kv',config:{store_method:'file_based',file_path:f.store}}}};writeFileSync(path,JSON.stringify(body));
 const args={workers:[{name:'iii-state'}],store:f.store,exeSha256:'a44eba0ca91a2805ea43355e30aec482a688eab33ac84801aec65f6636142654',procRoot:f.proc,pid:200};
 const persistence=resolveNativeStoreConfig(args);expect(persistence).toMatchObject({path,cwd:f.d,sha256:createHash('sha256').update(JSON.stringify(body)).digest('hex')});
 expect(()=>resolveNativeStoreConfig({...args,exeSha256:'unknown'})).toThrow('MIGRATION_STORE_CONFIG_MISMATCH');
 expect(()=>resolveNativeStoreConfig({...args,workers:[{name:'iii-state'},{name:'configuration'}]})).toThrow('MIGRATION_STORE_CONFIG_MISMATCH');
 const proof=prepareNativeMigration(f.options);proof.native.persistence=persistence;f.stop();writeFileSync(path,JSON.stringify({...body,value:{adapter:{name:'redis'}}}));
 expect(()=>finalizeNativeMigration({storePath:f.store,proof,procRoot:f.proc,pidAlive:()=>false})).toThrow('MIGRATION_PERSISTED_CONFIG_CHANGED');
});
it.each(['store','placeholder','id','unknown-field'])('rejects unproven persisted native %s config',kind=>{
 const f=fixture();symlinkSync(f.d,join(f.proc,'200/cwd'));mkdirSync(join(f.d,'config'));
 const body:any={id:'iii-state',value:{adapter:{name:'kv',config:{store_method:'file_based',file_path:f.store}}}};
 if(kind==='store')body.value.adapter.config.file_path=f.d;
 if(kind==='placeholder')body.value.adapter.config.file_path='${STORE}';
 if(kind==='id')body.id='other';if(kind==='unknown-field')body.value.unknown=true;
 writeFileSync(join(f.d,'config/iii-state.yaml'),JSON.stringify(body));
 expect(()=>resolveNativeStoreConfig({workers:[{name:'iii-state'}],store:f.store,exeSha256:'a44eba0ca91a2805ea43355e30aec482a688eab33ac84801aec65f6636142654',procRoot:f.proc,pid:200})).toThrow();
});
