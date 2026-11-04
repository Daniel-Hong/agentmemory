import {test,vi,afterEach} from 'vitest';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readNamespaceEntries} from '../src/ops/namespace-reader.mjs';
import {createSummaryCount} from '../src/ops/summary-count.mjs';
const dirs=[];afterEach(async()=>{vi.restoreAllMocks();await Promise.all(dirs.splice(0).map(x=>rm(x,{recursive:true,force:true})))});
async function fixture(text){const root=await mkdtemp(join(tmpdir(),'namespace-admission-'));dirs.push(root);const path=join(root,'mem%3Asummaries.bin');await writeFile(path,text);return {root,path}};
test('entry admission refuses before joining and parsing an over-budget body',async()=>{
 const f=await fixture('{"a":{"x":"synthetic-body"}}'),parse=vi.spyOn(JSON,'parse');
 await assert.rejects(readNamespaceEntries(f.path,{maxEntryBytes:8,chunkSize:4}),e=>e.code==='state_namespace_entry_limit');
 assert.equal(parse.mock.calls.some(([text])=>String(text).startsWith('{"x"')),false);
});
test('opt-in measurement counts native raw JSON bytes rather than a normalized JS reserialization',async()=>{
 const f=await fixture('{"a":-0.0,"b":"한"}'),seen=[];
 await readNamespaceEntries(f.path,{measureValueBytes:true,maxEntryBytes:5,chunkSize:3,onEntry:(k,v,n)=>seen.push([k,n])});
 assert.deepEqual(seen,[['a',4],['b',5]]);
});
test('a byte-admission refusal is not cached or reported as a completed validation',async()=>{
 const f=await fixture('{"a":{"x":"synthetic-body"}}'),reader=createSummaryCount({storePath:f.root});
 await assert.rejects(reader.sdkListBytes(8),e=>e.code==='SUMMARY_COLLECTION_TOO_LARGE');
 await writeFile(f.path,'{"a":1}');assert.equal(await reader.sdkListBytes(8),3);
});
test('default onEntry call shape is preserved',async()=>{
 const f=await fixture('{"a":1}'),args=[];
 await readNamespaceEntries(f.path,{onEntry:function(){args.push(arguments.length)}});assert.deepEqual(args,[2]);
});
