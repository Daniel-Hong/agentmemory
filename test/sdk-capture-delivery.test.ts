import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as spool from '../src/capture/spool.js';
import {sendCapture} from '../src/capture/delivery.js';
import {captureStatusCode,captureResponseBody} from '../src/triggers/api.js';
let dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'am-sdk-delivery-'));});
afterEach(()=>{rmSync(dir,{recursive:true,force:true});});
const url='http://127.0.0.1:63000';
const body={eventId:'synthetic_event_001',hookType:'post_tool_use',sessionId:'synthetic',project:'synthetic',cwd:'/synthetic',timestamp:'2026-10-27T00:00:00Z',data:{text:'original'}};
const done={status:'accepted',state:'sdk_completed',eventId:body.eventId,observationId:'synthetic-obs',attempts:1} as any;
function record(b:any=body){return {v:1 as const,eventId:b.eventId,body:b,attempts:0,reason:'test',spooledAt:new Date().toISOString()};}
it('acknowledges only explicitly opted-in completed SDK work without claiming disk durability',()=>{
 expect(captureStatusCode(done,'sdk','sdk-v1')).toBe(201);
 expect(captureResponseBody(done,null,'sdk','sdk-v1')).toMatchObject({completion:'sdk',completed:true,durable:false});
 expect(captureStatusCode(done,'sdk')).toBe(503);
 expect(captureStatusCode({...done,state:'retrying'},'sdk','sdk-v1')).toBe(503);
});
it('retains a fresh original before posting and separates it from retransmission after success/restart',async()=>{
 const post=vi.fn(async(b:any)=>{
  expect(spool.spoolSummary(url,{dir}).sdkRetained).toBe(1);
  expect(b.captureCompletion).toBe('sdk-v1');
  return {status:201,body:{...done,completion:'sdk',completed:true,durable:false}};
 });
 expect(await sendCapture(record(),post,url,{dir,fresh:true})).toBe('delivered');
 expect(await sendCapture(record(),post,url,{dir,fresh:true})).toBe('delivered');
 expect(spool.spoolSummary(url,{dir})).toMatchObject({records:0,sdkRetained:1});
 expect(await spool.drainSpool(url,post as any,{dir})).toMatchObject({claimed:0});
});
it('never upgrades old or receipt-required rows and parks permanent SDK holds without blocking new work',async()=>{
 spool.appendSpool(url,body.eventId,body,'old',{dir,requireReceipt:true});
 const next={...body,eventId:'synthetic_event_002',captureCompletion:'sdk-v1'};
 spool.appendSpool(url,next.eventId,next,'new',{dir});
 const post=vi.fn(async(b:any)=> b.captureCompletion==='sdk-v1'?{status:201,body:{...done,eventId:b.eventId,completion:'sdk',completed:true,durable:false}}:{status:503,body:{reason:'SDK_COMPLETION_ONLY',completion:'sdk',durable:false}});
 const drain=()=>spool.drainSpool(url,r=>sendCapture(r,post,url,{dir}),{dir});
 expect(await drain()).toMatchObject({remaining:1,delivered:1});
 const first=readFileSync(spool.spoolPaths(url,dir).file,'utf8');expect(JSON.parse(first).attempts).toBe(0);
 expect(JSON.parse(first).holdReason).toBe('SDK_COMPLETION_ONLY');
 expect(await drain()).toMatchObject({remaining:1});expect(post).toHaveBeenCalledTimes(2);
 expect(readFileSync(spool.spoolPaths(url,dir).file,'utf8')).toBe(first);
});
it('does not post or overwrite a conflicting retained original',async()=>{
 const post=vi.fn(async()=>({status:201,body:{...done,completion:'sdk',completed:true,durable:false}}));
 expect(await sendCapture(record(),post,url,{dir,fresh:true})).toBe('delivered');
 expect(await sendCapture(record({...body,data:{text:'different'}}),post,url,{dir,fresh:true})).toBe('retry');
 expect(post).toHaveBeenCalledTimes(1);
});
it('fails closed on SDK replies without matching event/completion and on full/disabled retention',async()=>{
 for(const response of [{...done,completion:'sdk',durable:false},{...done,eventId:'wrong',completion:'sdk',completed:true,durable:false}]){
  expect(await sendCapture(record(),async()=>({status:201,body:response}),url,{dir,fresh:true})).toBe('retry');
 }
 const post=vi.fn();expect(await sendCapture(record({...body,eventId:'synthetic_disabled'}),post,url,{dir,fresh:true,policy:{enabled:false,maxBytes:1000,maxRecordBytes:1000,maxAgeMs:1000}})).toBe('retry');expect(post).not.toHaveBeenCalled();
});
it('retains new originals with old servers and never treats unproven old protected rows as delivered',async()=>{
 const old=async()=>({status:201,body:{status:'accepted'}});
 expect(await sendCapture(record(),old,url,{dir,fresh:true})).toBe('delivered');
 expect(spool.spoolSummary(url,{dir}).sdkRetained).toBe(1);
 expect(await sendCapture({...record(),requireReceipt:true},old,url,{dir})).toBe('retry');
});
it('includes retained originals in the spool capacity without expiring or evicting them',async()=>{
 const policy={enabled:true,maxBytes:900,maxRecordBytes:800,maxAgeMs:1};
 expect(await sendCapture(record(),async()=>({status:201,body:{...done,completion:'sdk',completed:true,durable:false}}),url,{dir,fresh:true,policy})).toBe('delivered');
 const kept=spool.spoolSummary(url,{dir,policy}).sdkRetainedBytes;expect(kept).toBeGreaterThan(0);
 let full=false;for(let i=0;i<10;i++)if(!spool.appendSpool(url,'synthetic_'+i,{data:'x'.repeat(150)},'test',{dir,policy,requireReceipt:true}).spooled)full=true;
 expect(full).toBe(true);expect(spool.spoolSummary(url,{dir,policy}).sdkRetained).toBe(1);
});
it('does not expire parked originals during append capacity pruning',async()=>{
 const policy={enabled:true,maxBytes:1500,maxRecordBytes:1000,maxAgeMs:1};
 spool.appendSpool(url,body.eventId,body,'old',{dir,policy});
 await spool.drainSpool(url,async()=> 'held',{dir,policy:{...policy,maxAgeMs:60000}});
 await new Promise(r=>setTimeout(r,5));
 for(let i=0;i<12;i++)spool.appendSpool(url,'filler_'+i,{text:'x'.repeat(150)},'fill',{dir,policy,requireReceipt:true});
 expect(readFileSync(spool.spoolPaths(url,dir).file,'utf8')).toContain(body.eventId);
});
it('never removes a protected same-ID original when a newer SDK row appears first',async()=>{
 const fresh={...body,captureCompletion:'sdk-v1'};
 spool.appendSpool(url,body.eventId,fresh,'new',{dir});spool.appendSpool(url,body.eventId,body,'old',{dir,requireReceipt:true});
 const post=async(b:any)=>b.captureCompletion?{status:201,body:{...done,completion:'sdk',completed:true,durable:false}}:{status:503,body:{reason:'SDK_COMPLETION_ONLY'}};
 expect(await spool.drainSpool(url,r=>sendCapture(r,post,url,{dir}),{dir})).toMatchObject({remaining:1});
 expect(JSON.parse(readFileSync(spool.spoolPaths(url,dir).file,'utf8')).requireReceipt).toBe(true);
});
