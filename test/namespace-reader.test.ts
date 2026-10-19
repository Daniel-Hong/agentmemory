import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rename, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readNamespaceEntries } from '../src/ops/namespace-reader.mjs';
import { createStateDurabilityFence } from '../src/ops/state-durability.mjs';

const dirs: string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture(value: string|Buffer){const dir=await mkdtemp(join(tmpdir(),'am-stream-namespace-'));dirs.push(dir);const path=join(dir,'namespace.bin');await writeFile(path,value);return{dir,path};}

it.each([1,2,3,7,64])('reads literal UTF-8, escaped keys/strings, nested and primitive values at chunk size %s',async(chunkSize)=>{
  const {path}=await fixture(Buffer.concat([Buffer.from(' {"한\\uAE00":{"text":"가😀\\\"\\\\{}","array":[1,null,true,{"x":[]}]},"false":false,"num":-1.25e2,"empty":""}'),Buffer.from([255,0,123,125])]));
  const values=new Map();const result=await readNamespaceEntries(path,{chunkSize,onEntry:(key:string,value:unknown)=>values.set(key,value)});
  expect(Object.fromEntries(values)).toEqual({'한글':{text:'가😀"\\{}',array:[1,null,true,{x:[]}]},false:false,num:-125,empty:''});expect(result.entries).toBe(4);
});

it('retains only selected values while validating other records and deleted keys',async()=>{
  const {path}=await fixture('{"large":{"data":"unselected"},"kept":{"n":3},"nil":null}');
  const result=await readNamespaceEntries(path,{keys:new Set(['kept','deleted','nil']),chunkSize:4});
  expect(Object.fromEntries(result.values)).toEqual({kept:{n:3},nil:null});expect(result.entries).toBe(3);
});

it.each(['[]','{"a":}','{"a":1,}','{"a" 1}','{"a":01}','{"a":{"b":]}','{"a":"bad\\q"}','{"a":tru}','{"a":1,"a":2}','{"a":1,"\\u0061":2}'])('refuses malformed or duplicate JSON prefix %s',async(value)=>{
  const {path}=await fixture(value);await expect(readNamespaceEntries(path,{keys:new Set(['absent']),chunkSize:2})).rejects.toThrow(/state_namespace_/);
});

it.each(['','{','{"a":','{"a":"x','{"a":true','{"a":[]'])('refuses incomplete namespace %s',async(value)=>{
  const {path}=await fixture(value);await expect(readNamespaceEntries(path,{chunkSize:1})).rejects.toThrow(/state_namespace_/);
});

it('refuses malformed UTF-8 inside JSON but accepts an opaque binary archive trailer',async()=>{
  const {path}=await fixture(Buffer.concat([Buffer.from('{"a":"'),Buffer.from([255]),Buffer.from('"}') ]));
  await expect(readNamespaceEntries(path,{chunkSize:1})).rejects.toThrow(/state_namespace_/);
});

it('reports ENOENT separately and reads an empty object',async()=>{
  const {path}=await fixture('{}');expect((await readNamespaceEntries(path)).entries).toBe(0);await expect(readNamespaceEntries(path+'.missing')).rejects.toMatchObject({code:'ENOENT'});
});

it.each(['rename','inplace'])('does not certify a namespace changed during callback by %s',async(mode)=>{
  const {path}=await fixture('{"first":{"n":1},"last":{"n":2}}');let changed=false;
  await expect(readNamespaceEntries(path,{chunkSize:3,onEntry:async()=>{if(changed)return;changed=true;if(mode==='rename'){await writeFile(path+'.next','{"different":true}');await rename(path+'.next',path);}else await writeFile(path,'{}');}})).rejects.toThrow('state_namespace_changed');
});

it('fences selected/deleted values and refuses a corrupt unselected record on disk',async()=>{
  const {dir,path}=await fixture('{"kept":{"n":3},"other":false}');await rename(path,join(dir,'synthetic.bin'));
  const fence=createStateDurabilityFence({storePath:dir,timeoutMs:80,pollIntervalMs:5});
  const kv={get:async(_scope:string,key:string)=>key==='kept'?{n:3}:null};
  expect((await fence.waitForKeys(kv,[{scope:'synthetic',key:'kept'},{scope:'synthetic',key:'deleted'}])).synced).toBe(true);
  await writeFile(join(dir,'synthetic.bin'),'{"kept":{"n":3},"other":not_json}');
  await expect(fence.waitForKeys(kv,[{scope:'synthetic',key:'kept'}])).rejects.toMatchObject({code:'STATE_DURABILITY_TIMEOUT'});
});

it('streams a namespace larger than its subprocess heap budget while keeping only metadata',async()=>{
  const {path}=await fixture('');const handle=await open(path,'w');
  try {await handle.write('{');const payload='s'.repeat(64*1024);
    for(let i=0;i<1600;i++)await handle.write((i?',':'')+JSON.stringify('row_'+i)+':'+JSON.stringify({id:'row_'+i,sourceRaw:payload}));
    await handle.write('}');
  }finally{await handle.close();}
  const module=pathToFileURL(join(process.cwd(),'src/ops/namespace-reader.mjs')).href;
  const script=`import {writeFileSync} from 'node:fs';import {readNamespaceEntries} from ${JSON.stringify(module)};let records=0;const result=await readNamespaceEntries(process.argv[1],{onEntry:()=>{records++;}});writeFileSync(process.argv[2],JSON.stringify({records,bytes:result.bytesRead,maxEntryChars:result.maxEntryChars,maxRssKiB:process.resourceUsage().maxRSS}));`;
  await promisify(execFile)(process.execPath,['--max-old-space-size=64','--input-type=module','-e',script,path,path+'.result'],{timeout:20000});
  const result=JSON.parse(await readFile(path+'.result','utf8'));expect(result.records).toBe(1600);expect(result.bytes).toBeGreaterThan(100*1024*1024);expect(result.maxEntryChars).toBeLessThan(70*1024);expect(result.maxRssKiB).toBeLessThan(150*1024);
},25000);
