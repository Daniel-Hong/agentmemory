import {afterEach,expect,it} from 'vitest';
import {mkdtemp,writeFile,rename,unlink,rm,utimes} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {readNamespaceEntries} from '../src/ops/namespace-reader.mjs';
const dirs:string[]=[];afterEach(async()=>{await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'am-snapshot-generation-'));dirs.push(dir);const file=join(dir,'synthetic.bin');const value={a:{id:'a',text:'old'},b:{id:'b',text:'original'}};await writeFile(file,JSON.stringify(value));return{file,value};}
it.each(['replacement','unlink'])('snapshot opened generation retains complete original rows after %s',async mode=>{
 const{file,value}=await fixture();const rows=new Map();let changed=false;
 const result=await readNamespaceEntries(file,{consistency:'opened-generation',chunkSize:3,onEntry:async(k:string,v:unknown)=>{rows.set(k,v);if(changed)return;changed=true;if(mode==='unlink')await unlink(file);else{await writeFile(file+'.next',JSON.stringify({next:{id:'new'}}));await rename(file+'.next',file);}}});
 expect(Object.fromEntries(rows)).toEqual(value);expect(result.entries).toBe(2);
});
it('default strict reading continues to refuse atomic replacement',async()=>{
 const{file}=await fixture();let changed=false;
 await expect(readNamespaceEntries(file,{chunkSize:3,onEntry:async()=>{if(changed)return;changed=true;await writeFile(file+'.next','{}');await rename(file+'.next',file);}})).rejects.toMatchObject({code:'state_namespace_changed'});
});
it('opened generation refuses in-place modification even when JSON remains valid',async()=>{
 const{file,value}=await fixture();let changed=false;
 await expect(readNamespaceEntries(file,{consistency:'opened-generation',chunkSize:3,onEntry:async()=>{if(changed)return;changed=true;await writeFile(file,JSON.stringify(value).replace('old','new'));await utimes(file,new Date(),new Date('2030-01-01T00:00:00Z'));}})).rejects.toMatchObject({code:'state_namespace_changed'});
});
it.each(['{"a":1,"a":2}','{"a":','{"a":invalid}'])('opened generation still rejects corrupt/incomplete input %s',async text=>{const{file}=await fixture();await writeFile(file,text);await expect(readNamespaceEntries(file,{consistency:'opened-generation'})).rejects.toThrow(/state_namespace_/);});
it('opened generation distinguishes open-before-absent from unlink-after-open',async()=>{const{file}=await fixture();await unlink(file);await expect(readNamespaceEntries(file,{consistency:'opened-generation'})).rejects.toMatchObject({code:'ENOENT'});});
it('rejects unsupported consistency modes before reading',async()=>{const{file}=await fixture();await expect(readNamespaceEntries(file,{consistency:'relaxed'})).rejects.toMatchObject({code:'state_namespace_consistency_invalid'});});
it('opened generation permits replacement across periodic descriptor checks',async()=>{
 const{file,value}=await fixture();const rows=new Map();let changed=false;
 await readNamespaceEntries(file,{consistency:'opened-generation',chunkSize:3,checkIntervalBytes:1,onEntry:async(k:string,v:unknown)=>{rows.set(k,v);if(changed)return;changed=true;await writeFile(file+'.next','{}');await rename(file+'.next',file);}});
 expect(Object.fromEntries(rows)).toEqual(value);
});
it('opened generation keeps cancellation and closes its descriptor',async()=>{
 const{file}=await fixture();const controller=new AbortController();const phases:string[]=[];
 await expect(readNamespaceEntries(file,{consistency:'opened-generation',chunkSize:3,signal:controller.signal,onEntry:()=>controller.abort(),onProgress:(p:any)=>phases.push(p.readerPhase)})).rejects.toMatchObject({name:'AbortError'});
 expect(phases.slice(-2)).toEqual(['close','complete']);
});
it('opened generation does not excuse a metadata change while the inode remains linked',async()=>{
 const{file}=await fixture();const {chmod}=await import('node:fs/promises');let changed=false;
 await expect(readNamespaceEntries(file,{consistency:'opened-generation',chunkSize:3,onEntry:async()=>{if(changed)return;changed=true;await chmod(file,0o600);}})).rejects.toMatchObject({code:'state_namespace_changed'});
});
it('opened generation preserves malformed UTF-8 rejection and callback failure cleanup',async()=>{
 const{file}=await fixture();await writeFile(file,Buffer.from([123,34,97,34,58,34,255,34,125]));
 await expect(readNamespaceEntries(file,{consistency:'opened-generation',chunkSize:1})).rejects.toMatchObject({code:'state_namespace_utf8'});
 await writeFile(file,'{"a":1}');const phases:string[]=[];
 await expect(readNamespaceEntries(file,{consistency:'opened-generation',onEntry:()=>{throw Error('synthetic callback');},onProgress:(p:any)=>phases.push(p.readerPhase)})).rejects.toThrow('synthetic callback');
 expect(phases.slice(-2)).toEqual(['close','complete']);
});
