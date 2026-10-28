import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const fault=vi.hoisted(()=>({kind:''}));
vi.mock('node:fs',async()=>{
  const fs=await vi.importActual<typeof import('node:fs')>('node:fs');
  return {...fs,
    writeFileSync:(...args:any[])=>{if(fault.kind==='write')throw Error('synthetic_write');return (fs.writeFileSync as any)(...args);},
    fsyncSync:(fd:number)=>{const directory=fs.fstatSync(fd).isDirectory();if(fault.kind===(directory?'dir_sync':'file_sync'))throw Error('synthetic_sync');return fs.fsyncSync(fd);},
    renameSync:(...args:any[])=>{if(fault.kind==='rename')throw Error('synthetic_rename');return (fs.renameSync as any)(...args);},
  };
});
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readSdkOriginal,retainSent,reconcileSent,spoolHasRecords,spoolPaths,spoolSummary} from '../src/capture/spool.js';
import {restoreSdkOriginal,sendCapture} from '../src/capture/delivery.js';

let dir:string;
beforeEach(()=>{fault.kind='';dir=mkdtempSync(join(tmpdir(),'am-sdk-envelope-'));});
afterEach(()=>{fault.kind='';rmSync(dir,{recursive:true,force:true});});
const url='http://127.0.0.1:63000';
const body={eventId:'synthetic_envelope_001',hookType:'prompt_submit',sessionId:'synthetic',project:'synthetic',cwd:'/synthetic',timestamp:'2026-10-28T00:00:00Z',data:{prompt:'same source'}};
const variant={...body,timestamp:'2026-10-03T10:00:00.000Z',data:{prompt:'same source',backfill:true}};
const record=(value:Record<string,unknown>)=>({eventId:body.eventId,body:value});
const response={status:201,body:{status:'accepted',eventId:body.eventId,completion:'sdk',completed:true,durable:false}};
const archive=()=>join(spoolPaths(url,dir).dir,spoolPaths(url,dir).name+'.sdk-originals');
const files=()=>readdirSync(archive()).filter(name=>name.endsWith('.json')).sort();

it('preserves the first original and the host timestamp envelope before posting the unchanged current body',async()=>{
  await sendCapture(record(body),async()=>response,url,{dir,fresh:true});
  const primary=files()[0],original=readFileSync(join(archive(),primary),'utf8');
  const post=vi.fn(async(value:any)=>{
    expect(spoolSummary(url,{dir}).sdkRetained).toBe(2);
    expect(value).toEqual({...variant,captureCompletion:'sdk-v1'});
    return response;
  });
  expect(await sendCapture(record(variant),post,url,{dir,fresh:true})).toBe('delivered');
  expect(post).toHaveBeenCalledOnce();
  expect(readFileSync(join(archive(),primary),'utf8')).toBe(original);
  const bodies=files().map(name=>JSON.parse(readFileSync(join(archive(),name),'utf8')).body);
  expect(bodies).toContainEqual({...body,captureCompletion:'sdk-v1'});
  expect(bodies).toContainEqual({...variant,captureCompletion:'sdk-v1'});
});

it('retains a timestamp-only retry envelope once even when object key order changes',async()=>{
  await sendCapture(record(body),async()=>response,url,{dir,fresh:true});
  const retry={...body,timestamp:'2026-10-28T00:00:01Z'};
  expect(await sendCapture(record(retry),async()=>response,url,{dir,fresh:true})).toBe('delivered');
  const before=files();
  const reordered={data:retry.data,timestamp:retry.timestamp,cwd:retry.cwd,project:retry.project,sessionId:retry.sessionId,hookType:retry.hookType,eventId:retry.eventId};
  expect(await sendCapture(record(reordered),async()=>response,url,{dir,fresh:true})).toBe('delivered');
  expect(files()).toEqual(before);expect(before).toHaveLength(2);
});

it.each([
  {...variant,data:{prompt:'different source',backfill:true}},
  {...variant,project:'different-project'},
  {...variant,cwd:'/different'},
  {...variant,data:{prompt:'same source',backfill:'different'}},
])('does not post or overwrite a real source or identity conflict: %j',async conflict=>{
  await sendCapture(record(body),async()=>response,url,{dir,fresh:true});
  const original=readFileSync(join(archive(),files()[0]),'utf8'),post=vi.fn(async()=>response);
  expect(await sendCapture(record(conflict),post,url,{dir,fresh:true})).toBe('retry');
  expect(post).not.toHaveBeenCalled();expect(files()).toHaveLength(1);
  expect(readFileSync(join(archive(),files()[0]),'utf8')).toBe(original);
});

it('does not treat a non-prompt backfill field as envelope metadata',async()=>{
  const tool={...body,hookType:'post_tool_use',data:{tool_output:'same source'}};
  await sendCapture(record(tool),async()=>response,url,{dir,fresh:true});
  const post=vi.fn(async()=>response);
  expect(await sendCapture(record({...tool,timestamp:variant.timestamp,data:{...tool.data,backfill:true}}),post,url,{dir,fresh:true})).toBe('retry');
  expect(post).not.toHaveBeenCalled();expect(files()).toHaveLength(1);
});

it('counts envelopes against total quota and refuses before POST without deleting originals',async()=>{
  await sendCapture(record(body),async()=>response,url,{dir,fresh:true});
  const used=spoolSummary(url,{dir}).sdkRetainedBytes,post=vi.fn(async()=>response);
  expect(await sendCapture(record(variant),post,url,{dir,fresh:true,policy:{enabled:true,maxBytes:used+1,maxRecordBytes:4096,maxAgeMs:1}})).toBe('retry');
  expect(post).not.toHaveBeenCalled();expect(files()).toHaveLength(1);
  expect(spoolSummary(url,{dir}).sdkRetainedBytes).toBe(used);
});

it('enforces the record-size limit for an envelope independently of the total quota',async()=>{
  await sendCapture(record(body),async()=>response,url,{dir,fresh:true});
  const used=spoolSummary(url,{dir}).sdkRetainedBytes,post=vi.fn(async()=>response);
  expect(await sendCapture(record(variant),post,url,{dir,fresh:true,policy:{enabled:true,maxBytes:100000,maxRecordBytes:used+1,maxAgeMs:1}})).toBe('retry');
  expect(post).not.toHaveBeenCalled();expect(files()).toHaveLength(1);
});

it('holds event-ID-only restoration when envelopes make selection ambiguous and does not post',async()=>{
  await sendCapture(record(body),async()=>response,url,{dir,fresh:true});
  expect(readSdkOriginal(url,body.eventId,{dir})).toMatchObject(body);
  await sendCapture(record(variant),async()=>response,url,{dir,fresh:true});
  expect(()=>readSdkOriginal(url,body.eventId,{dir})).toThrow('SDK_SOURCE_SELECTION_AMBIGUOUS');
  const before=files().map(name=>readFileSync(join(archive(),name),'utf8')),post=vi.fn(async()=>response);
  expect(await restoreSdkOriginal(url,body.eventId,post,{dir})).toMatchObject({completed:false,status:'held'});
  expect(post).not.toHaveBeenCalled();expect(files().map(name=>readFileSync(join(archive(),name),'utf8'))).toEqual(before);
});

it('detects originals requeued into draining files without treating retained sent files as pending',()=>{
  expect(retainSent(url,body.eventId,body,{bootId:'a'.repeat(24),durableAfterMs:1000},{dir,now:1000})).toBe(true);
  expect(spoolHasRecords(url,dir)).toBe(false);
  expect(reconcileSent(url,'b'.repeat(24),{dir,now:2000}).requeued).toBe(1);
  expect(spoolHasRecords(url,dir)).toBe(true);
});

it.each(['write','file_sync','rename','dir_sync'])('preserves primary, cleans owned envelope temporaries and retries after %s failure',async kind=>{
  await sendCapture(record(body),async()=>response,url,{dir,fresh:true});
  const primary=files()[0],before=readFileSync(join(archive(),primary),'utf8'),post=vi.fn(async()=>response);
  fault.kind=kind;
  expect(await sendCapture(record(variant),post,url,{dir,fresh:true})).toBe('retry');
  expect(post).not.toHaveBeenCalled();expect(readFileSync(join(archive(),primary),'utf8')).toBe(before);
  expect(readdirSync(archive()).some(name=>name.endsWith('.tmp'))).toBe(false);
  fault.kind='';
  expect(await sendCapture(record(variant),post,url,{dir,fresh:true})).toBe('delivered');
  expect(readFileSync(join(archive(),primary),'utf8')).toBe(before);
  expect(spoolSummary(url,{dir}).sdkRetained).toBe(2);
});

it('counts an interrupted envelope temporary against quota and holds ambiguous restore selection',async()=>{
  await sendCapture(record(body),async()=>response,url,{dir,fresh:true});
  const primary=files()[0],used=spoolSummary(url,{dir}).sdkRetainedBytes;
  const temp=primary.replace('.json','.envelope-'+'c'.repeat(64)+'.json.00000000-0000-4000-8000-000000000000.tmp');
  writeFileSync(join(archive(),temp),'x'.repeat(1024));
  expect(spoolSummary(url,{dir})).toMatchObject({sdkRetained:1,sdkRetainedBytes:used+1024});
  const post=vi.fn(async()=>response);
  expect(await sendCapture(record(variant),post,url,{dir,fresh:true,policy:{enabled:true,maxBytes:used+1024,maxRecordBytes:4096,maxAgeMs:1}})).toBe('retry');
  expect(post).not.toHaveBeenCalled();expect(readFileSync(join(archive(),temp),'utf8')).toBe('x'.repeat(1024));
  expect(()=>readSdkOriginal(url,body.eventId,{dir})).toThrow('SDK_SOURCE_SELECTION_AMBIGUOUS');
});
