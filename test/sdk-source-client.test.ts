import {afterEach,beforeEach,expect,it,vi} from 'vitest';import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {retainSdkOriginal} from '../src/capture/spool.js';import {restoreSdkOriginal} from '../src/capture/delivery.js';
let dir:string;const url='http://127.0.0.1:63000';const body={eventId:'synthetic_selected_001',captureCompletion:'sdk-v1',hookType:'post_tool_use',sessionId:'synthetic',project:'synthetic',cwd:'/synthetic',timestamp:'2026-10-27T00:00:00Z',data:{tool_output:'original'}};
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'am-source-select-'));});afterEach(()=>rmSync(dir,{recursive:true,force:true}));
it('re-enqueues one selected retained source exactly once and never removes or rewrites it',async()=>{
 expect(retainSdkOriginal(url,body.eventId,body,{dir})).toBe(true);const folder=join(dir,'local-63000.sdk-originals'),path=join(folder,readdirSync(folder)[0]);const before=readFileSync(path,'utf8');
 const post=vi.fn(async(b:any)=>{expect(b).toEqual(body);return {status:201,body:{eventId:body.eventId,completed:true,completion:'sdk',durable:false,sourceRestore:'sdk-v1',status:'restored'}};});
 expect(await restoreSdkOriginal(url,body.eventId,post,{dir})).toMatchObject({completed:true,status:'restored'});expect(post).toHaveBeenCalledTimes(1);expect(readFileSync(path,'utf8')).toBe(before);
});
it.each([404,409,503])('holds the original with no ordinary-send fallback at HTTP %s',async status=>{
 retainSdkOriginal(url,body.eventId,body,{dir});const post=vi.fn(async()=>({status,body:{code:'SDK_SOURCE_HELD'}}));expect((await restoreSdkOriginal(url,body.eventId,post,{dir})).completed).toBe(false);expect(post).toHaveBeenCalledTimes(1);expect(readdirSync(join(dir,'local-63000.sdk-originals'))).toHaveLength(1);
});
it('does not send missing sources or accept incomplete/mismatched completion',async()=>{
 const post=vi.fn();expect((await restoreSdkOriginal(url,body.eventId,post,{dir})).completed).toBe(false);expect(post).not.toHaveBeenCalled();retainSdkOriginal(url,body.eventId,body,{dir});
 expect((await restoreSdkOriginal(url,body.eventId,async()=>({status:201,body:{completed:true,completion:'sdk',durable:false,eventId:body.eventId}}),{dir})).completed).toBe(false);
});
