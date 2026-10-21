import ts from 'typescript';
import {Script,createContext} from 'node:vm';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const ensure=(condition,code)=>{if(!condition)throw Error(code);};
const selectedNames=new Set(['GiB','SAFE_APIS','MEMORY_RECOVERY_ENABLED']);
function isolatedGuard(bundle){
 const file=ts.createSourceFile('reviewed-recovery-bundle.mjs',bundle,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 ensure(file.parseDiagnostics.length===0,'compiled_guard_shape_unsupported');
 const functions=file.statements.filter(s=>ts.isFunctionDeclaration(s)&&s.name?.text==='createMemoryPressureGuard');
 ensure(functions.length===1&&functions[0].body,'compiled_guard_shape_unsupported');
 const constants=new Map();
 for(const statement of file.statements){
  if(!ts.isVariableStatement(statement))continue;
  for(const declaration of statement.declarationList.declarations){
   if(!ts.isIdentifier(declaration.name)||!selectedNames.has(declaration.name.text))continue;
   const name=declaration.name.text,value=declaration.initializer;
   ensure(!constants.has(name)&&value,'compiled_guard_shape_unsupported');
   let valid=false;
   if(name==='MEMORY_RECOVERY_ENABLED')valid=value.kind===ts.SyntaxKind.TrueKeyword||value.kind===ts.SyntaxKind.FalseKeyword;
   if(name==='GiB')valid=/^1024\s*\*\*\s*3$/.test(value.getText(file))||ts.isNumericLiteral(value)&&Number(value.text)===1024**3;
   if(name==='SAFE_APIS')valid=ts.isNewExpression(value)&&ts.isIdentifier(value.expression)&&value.expression.text==='Set'&&value.arguments?.length===1&&ts.isArrayLiteralExpression(value.arguments[0])&&value.arguments[0].elements.every(v=>ts.isStringLiteral(v));
   ensure(valid,'compiled_guard_shape_unsupported');constants.set(name,`const ${name}=${value.getText(file)};`);
  }
 }
 const context=createContext({setInterval(){throw Error('unexpected_scheduled_work');},clearInterval(){}},{codeGeneration:{strings:false,wasm:false}});
 const body=functions[0].getText(file).replace(/^export\s+/,'');
 return new Script([...constants.values(),body,'createMemoryPressureGuard;'].join('\n')).runInContext(context,{timeout:1000});
}
export async function verifyRecoveryBundle({bundle,manifest,expectedVersion}={}){
 const profile=manifest?.agentmemoryCompatibility;
 ensure(typeof manifest?.version==='string'&&/^0\.9\.30-daniel\.[1-9][0-9]*$/.test(manifest.version)&&(!expectedVersion||manifest.version===expectedVersion)&&profile&&Object.keys(profile).sort().join(',')==='automaticMemoryRecovery,backgroundControlVersion'&&profile.backgroundControlVersion===2&&profile.automaticMemoryRecovery===false,'recovery_manifest_invalid');
 ensure(typeof bundle==='string','compiled_guard_shape_unsupported');
 const createGuard=isolatedGuard(bundle);
 let now=1000,available=8*1024**3,reads=0,resumes=0,pauses=0,releasePause;
 const pausePending=new Promise(r=>{releasePause=r;});
 const control={snapshot:()=>({status:'paused',pausedRequested:true,holds:['memory'],recovery:{attempts:2,maxAttempts:3,nextAttemptAt:0}}),change(action){if(action==='resume'){resumes++;return Promise.resolve(this.snapshot());}pauses++;return pausePending;}};
 const guard=createGuard({control,schedule:false,clock:()=>now,readSample:async()=>{reads++;return{total:16*1024**3,available};}});
 try{
  ensure(guard.snapshot().automaticMemoryRecovery===false,'compiled_recovery_not_disabled');
  for(let i=0;i<80;i++){now+=5000;await guard.refresh();await guard.drain();}
  ensure(resumes===0&&guard.snapshot().recoveryStatus==='disabled','compiled_recovery_not_disabled');
  available=0;now+=5000;await guard.refresh();
  const handlers=new Map(),sdk={registerFunction(id,handler){handlers.set(id,handler);}};
  guard.install(sdk,()=>null);sdk.registerFunction('api::synthetic-write',async()=>({status_code:200}));
  const response=await handlers.get('api::synthetic-write')({});
  ensure(response.status_code===503&&guard.snapshot().level==='critical'&&pauses===1,'compiled_pressure_guard_unverified');
  let drained=false,stopped=false;
  const drain=guard.drain().then(()=>{drained=true;}),stop=guard.stop().then(()=>{stopped=true;});
  await Promise.resolve();await Promise.resolve();
  const drainWaited=!drained,stopWaited=!stopped;
  ensure(drainWaited&&stopWaited,'compiled_transition_wait_unverified');
  releasePause();await drain;await stop;
  const before=reads;await guard.refresh();ensure(reads===before,'compiled_stop_unverified');
  return{verified:true,version:manifest.version,backgroundControlVersion:2,automaticMemoryRecovery:false,automaticResumeCalls:resumes,criticalStatus:response.status_code,drainWaited,stopWaited,syntheticSamples:reads};
 }finally{releasePause();await guard.stop();}
}
export async function verifyRecoveryArtifact(packagePath,expectedVersion){
 packagePath=resolve(packagePath);
 const entry=name=>execFileSync('tar',['-xOf',packagePath,'package/'+name],{encoding:'utf8',maxBuffer:128*1024*1024});
 const manifest=JSON.parse(entry('package.json')),bundle=entry('dist/index.mjs');
 const result=await verifyRecoveryBundle({bundle,manifest,expectedVersion});
 return{...result,packageSha256:createHash('sha256').update(await readFile(packagePath)).digest('hex'),bootstrapExecuted:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [packagePath,version,...extra]=process.argv.slice(2);
 ensure(packagePath&&!extra.length,'usage: verify-recovery-artifact.mjs PACKAGE [VERSION]');
 console.log(JSON.stringify(await verifyRecoveryArtifact(packagePath,version),null,2));
}
