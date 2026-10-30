import {spawn} from 'node:child_process';
const fail=code=>Object.assign(Error(code),{code});
const arrays=new Set(['sessions','memories','graphNodes','graphEdges','accessLogs']);
const own=(o,k,v)=>Object.defineProperty(o,k,{value:v,writable:true,enumerable:true,configurable:true});
const indent=n=>' '.repeat(n);
function encoded(key,value,depth,inArray=false){
 const text=JSON.stringify({[key]:value},null,2);
 if(text==='{}')return inArray?'null':undefined;
 const prefix='{\n  '+JSON.stringify(key)+': ';
 return text.slice(prefix.length,-2).replace(/\n/g,'\n'+indent(depth-2));
}
function* arrayChunks(value,depth){
 if(!value.length){yield '[]';return;}
 yield '[\n';
 for(let n=0;n<value.length;n++){if(n)yield ',\n';yield indent(depth+2);yield encoded(String(n),value[n],depth+2,true);}
 yield '\n'+indent(depth)+']';
}
function* propertyValueChunks(key,value){
 const framed=typeof value?.toJSON!=='function'&&(Array.isArray(value)||(key==='observations'&&value&&typeof value==='object'));
 const scalar=framed?undefined:encoded(key,value,2);if(!framed&&scalar===undefined)return;
 if(framed&&Array.isArray(value))yield* arrayChunks(value,2);
 else if(framed){
  yield '{';let sessions=0;
  for(const[session,rows]of Object.entries(value)){
   if(rows===undefined||typeof rows==='function'||typeof rows==='symbol')continue;
   const framedRows=Array.isArray(rows)&&typeof rows.toJSON!=='function';const scalarRow=framedRows?undefined:encoded(session,rows,4);if(!framedRows&&scalarRow===undefined)continue;
   yield sessions++?',\n':'\n';yield '    '+JSON.stringify(session)+': ';
   if(framedRows)yield* arrayChunks(rows,4);else yield scalarRow;
  }
  yield sessions?'\n  }':'}';
 }else yield scalar;
}
export function* snapshotJsonChunks(archive){
 try{
  yield '{';let count=0;
  for(const[key,value]of Object.entries(archive)){
   if(value===undefined||typeof value==='function'||typeof value==='symbol')continue;
   const chunks=propertyValueChunks(key,value),first=chunks.next();if(first.done)continue;
   yield count++?',\n':'\n';yield '  '+JSON.stringify(key)+': ';yield first.value;yield* chunks;
  }
  yield count?'\n}':'}';
 }catch(error){try{error.snapshotPhase='serialize';}catch{}throw error;}
}

export async function* snapshotSessionJsonChunks(archive,sessionIds,readObservations){
 yield '{';let count=0;
 for(const[key,value]of Object.entries(archive)){
  if(key==='observations'){
   yield count++?',\n':'\n';yield '  "observations": {';let sessions=0;
   for(const session of sessionIds){
    let rows=await readObservations(session);
    if(!rows.length){rows=null;continue;}
    try{
     validateSnapshotArchive({observations:{[session]:rows}});
     yield sessions++?',\n':'\n';yield '    '+JSON.stringify(session)+': ';
     yield* arrayChunks(rows,4);
    }catch(error){try{error.snapshotPhase='serialize';}catch{}throw error;}
    rows=null;
   }
   yield sessions?'\n  }':'}';
  }else{
   try{
    if(value===undefined||typeof value==='function'||typeof value==='symbol')continue;
    const chunks=propertyValueChunks(key,value),first=chunks.next();if(first.done)continue;
    yield count++?',\n':'\n';yield '  '+JSON.stringify(key)+': ';yield first.value;yield* chunks;
   }catch(error){try{error.snapshotPhase='serialize';}catch{}throw error;}
  }
 }
 yield count?'\n}':'}';
}

export async function readSnapshotJson(source,{signal}={}){
 const iterator=source[Symbol.asyncIterator](),decoder=new TextDecoder('utf-8',{ignoreBOM:true});let text='',offset=0,ended=false;
 const abort=()=>source.destroy?.(signal.reason??fail('SNAPSHOT_READ_ABORTED'));
 signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true});
 async function peek(){
  signal?.throwIfAborted();
  while(offset>=text.length){
   if(ended)return null;
   const next=await iterator.next();signal?.throwIfAborted();offset=0;
   if(next.done){ended=true;text=decoder.decode();}else text=decoder.decode(next.value,{stream:true});
  }
  return text[offset];
 }
 async function space(){while(await peek()!==null){const match=/[^ \t\r\n]/g;match.lastIndex=offset;const found=match.exec(text);if(found){offset=found.index;return;}offset=text.length;}}
 async function token(expected){await space();if(await peek()!==expected)throw fail('SNAPSHOT_JSON_INVALID');offset++;}
 async function value(){
  await space();const first=await peek();if(first===null)throw fail('SNAPSHOT_JSON_INVALID');
  const kind=first==='"'?'string':first==='{'||first==='['?'compound':'primitive';let quoted=false,escape=false,depth=0,done=false;const parts=[];
  while(!done){
   if(await peek()===null){if(kind!=='primitive')throw fail('SNAPSHOT_JSON_INVALID');break;}
   const start=offset;
   for(;offset<text.length;offset++){
    if(kind==='primitive'){if(/[,}\] \t\r\n]/.test(text[offset])){done=true;break;}continue;}
    if(quoted&&!escape){const delimiter=/["\\]/g;delimiter.lastIndex=offset;if(!delimiter.test(text)){offset=text.length;break;}offset=delimiter.lastIndex-1;}
    if(kind==='compound'&&!quoted){const structural=/["{}\[\]]/g;structural.lastIndex=offset;if(!structural.test(text)){offset=text.length;break;}offset=structural.lastIndex-1;}
    const c=text[offset];
    if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"'){quoted=false;if(kind==='string'){offset++;done=true;break;}}}
    else if(c==='"')quoted=true;
    else if(c==='{'||c==='[')depth++;
    else if(c==='}'||c===']'){if(--depth===0){offset++;done=true;break;}}
   }
   parts.push(text.slice(start,offset));
  }
  try{return JSON.parse(parts.join(''));}catch{throw fail('SNAPSHOT_JSON_INVALID');}
 }
 async function object(entry){
  await token('{');await space();if(await peek()==='}'){offset++;return;}
  while(true){await space();if(await peek()!=='"')throw fail('SNAPSHOT_JSON_INVALID');const key=await value();await token(':');await entry(key);await space();const next=await peek();offset++;if(next==='}')return;if(next!==',')throw fail('SNAPSHOT_JSON_INVALID');}
 }
 async function array(entry){
  await token('[');await space();if(await peek()===']'){offset++;return;}
  while(true){await entry();await space();const next=await peek();offset++;if(next===']')return;if(next!==',')throw fail('SNAPSHOT_JSON_INVALID');}
 }
 async function discard(){await space();const next=await peek();if(next==='{')await object(()=>discard());else if(next==='[')await array(()=>discard());else await value();}
 async function rows(){await space();if(await peek()!=='[')return value();const result=[];await array(async()=>result.push(await value()));return result;}
 try{
  const archive={};
  await object(async key=>{
   if(arrays.has(key))own(archive,key,await rows());
   else if(key==='observations'){
    await space();if(await peek()!=='{'){own(archive,key,await value());return;}
    const observations={};await object(async session=>own(observations,session,await rows()));own(archive,key,observations);
   }else if(key==='version'||key==='timestamp')own(archive,key,await value());
   else await discard();
  });
  await space();if(await peek()!==null)throw fail('SNAPSHOT_JSON_INVALID');return archive;
 }finally{signal?.removeEventListener('abort',abort);if(!ended)await iterator.return?.();}
}

export async function readGitSnapshot(dir,commitHash,{signal}={}){
 signal?.throwIfAborted();
 const child=spawn('git',['show',`${commitHash}:state.json`],{cwd:dir,stdio:['ignore','pipe','pipe']});let spawnError,terminationRequested=false;
 const terminate=()=>{if(!terminationRequested&&child.exitCode===null&&child.signalCode===null){terminationRequested=true;child.kill('SIGTERM');}};
 const closed=new Promise(resolve=>{child.once('error',error=>{spawnError=error;});child.once('close',(code,terminationSignal)=>resolve({code,terminationSignal}));});
 child.stderr?.on('data',()=>{});child.stdout?.on('error',()=>{});
 const abort=()=>{child.stdout?.destroy(signal.reason??fail('SNAPSHOT_READ_ABORTED'));terminate();};
 signal?.addEventListener('abort',abort,{once:true});
 try{
  if(!child.stdout)throw fail('SNAPSHOT_GIT_READ_FAILED');
  const archive=await readSnapshotJson(child.stdout,{signal});const result=await closed;
  signal?.throwIfAborted();if(spawnError||result.code!==0||result.terminationSignal)throw fail('SNAPSHOT_GIT_READ_FAILED');return archive;
 }catch(error){child.stdout?.destroy();terminate();const result=await closed;signal?.throwIfAborted();if(spawnError||(!terminationRequested&&(result.code!==0||result.terminationSignal)))throw fail('SNAPSHOT_GIT_READ_FAILED');throw error;}
 finally{signal?.removeEventListener('abort',abort);}
}

export function validateSnapshotArchive(archive){
 const record=(value,key)=>{if(!value||typeof value!=='object'||Array.isArray(value)||typeof value[key]!=='string'||!value[key].length)throw fail('SNAPSHOT_RECORD_INVALID');};
 for(const name of arrays){
  const values=archive[name];if(values===null||values===undefined)continue;
  if(!Array.isArray(values))throw fail('SNAPSHOT_SHAPE_INVALID');
  for(const value of values)record(value,name==='accessLogs'?'memoryId':'id');
 }
 const observations=archive.observations;
 if(observations!==null&&observations!==undefined){
  if(typeof observations!=='object'||Array.isArray(observations))throw fail('SNAPSHOT_SHAPE_INVALID');
  for(const values of Object.values(observations)){
   if(!Array.isArray(values))throw fail('SNAPSHOT_SHAPE_INVALID');
   for(const value of values)record(value,'id');
  }
 }
}
