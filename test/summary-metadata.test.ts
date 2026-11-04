import {test} from 'vitest';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSummaryCount} from '../src/ops/summary-count.mjs';
async function fixture(rows){
 const root=await mkdtemp(join(tmpdir(),'summary-metadata-'));const file=join(root,'mem%3Asummaries.bin');
 await writeFile(file,JSON.stringify(rows));const live=new Map(Object.entries(rows)),gets=[];
 const kv={get:async(_,key)=>{gets.push(key);return structuredClone(live.get(key)??null)},list:async()=>{throw Error('bulk_sdk_list_forbidden')}};
 return {root,file,live,gets,reader:createSummaryCount({storePath:root,kv}),close:()=>rm(root,{recursive:true})};
}
const row=(id,project,day)=>({sessionId:id,project,createdAt:`2026-01-${String(day).padStart(2,'0')}T00:00:00Z`,title:id,narrative:'text',concepts:[],segments:[{privateText:'not metadata'}]});
test('complete metadata retains project and malformed title without exposing source body',async()=>{
 const f=await fixture({a:row('a','p',1),b:{...row('b','q',2),title:42}});
 try{assert.deepEqual(await f.reader.metadata(),[{sessionId:'a',project:'p',createdAt:'2026-01-01T00:00:00Z',title:'a'},{sessionId:'b',project:'q',createdAt:'2026-01-02T00:00:00Z',title:42}]);assert.deepEqual(f.gets,[]);}finally{await f.close()}
});
test('project recent reads only selected full records and includes pending state',async()=>{
 const f=await fixture({a:row('a','p',1),b:row('b','q',5),c:row('c','p',3)});
 try{const d=row('d','p',4);f.live.set('d',d);f.reader.record('d',true,f.reader.prepare(d));
 assert.deepEqual((await f.reader.recent('p',2)).map(x=>x.sessionId),['d','c']);assert.deepEqual(f.gets,['d','c']);}finally{await f.close()}
});
test('recent rejects changed generation instead of mixing snapshots',async()=>{
 const f=await fixture({a:row('a','p',1)});
 // Replace the full-record reader while keeping the same fixture and safe metadata path.
 const reader=createSummaryCount({storePath:f.root,kv:{get:async()=>{await writeFile(f.file,JSON.stringify({a:row('a','p',2)}));return row('a','p',1)}}});
 try{await assert.rejects(reader.recent('p',1),e=>e.code==='state_namespace_changed');}finally{await f.close()}
});
test('existing merge inputs keep their old fields and do not gain project',async()=>{
 const f=await fixture({a:row('a','p',1)});
 try{assert.deepEqual(await f.reader.inputs(),{total:1,recent:[{sessionId:'a',createdAt:'2026-01-01T00:00:00Z',title:'a',narrative:'text',concepts:[]}]});}finally{await f.close()}
});
test('metadata never omits wrong-key records as if they were absent',async()=>{
 const f=await fixture({a:row('other','p',1)});
 try{await assert.rejects(f.reader.metadata(),e=>e.code==='summary_identity_invalid');}finally{await f.close()}
});
