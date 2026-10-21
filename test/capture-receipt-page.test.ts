import {it,expect,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCaptureReceiptPage} from '../src/capture/receipt-page.js';
import {KV} from '../src/state/schema.js';
const swap=vi.hoisted(()=>({path:'',replacement:'',enabled:false}));
vi.mock('node:fs/promises',async original=>{
 const fs=await original<typeof import('node:fs/promises')>();
 return {...fs,stat:async(path:any,options?:any)=>{const info=await fs.stat(path,options);if(swap.enabled&&path===swap.path){swap.enabled=false;await fs.rename(swap.replacement,swap.path);}return info;}};
});
it('streams only safe receipt metadata with bounded pagination and refuses oversized shards even for limit one',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-receipt-page-'));try{
  const page=createCaptureReceiptPage(dir),path=join(dir,encodeURIComponent(KV.captureEvents('00'))+'.bin');
  const key='cap_'+'0'.repeat(40),row={key,eventId:'synthetic-event',completedAt:'2026-10-21T00:00:00Z',sessionId:'NEVER RETURN',project:'NEVER RETURN'};
  await writeFile(path,JSON.stringify({[key]:row}));
  expect(await page({shard:'00',offset:0,limit:1})).toEqual({items:[{key,eventId:'synthetic-event',completedAt:new Date(row.completedAt).toISOString(),state:'completed'}],nextOffset:null});
  await writeFile(path,'x'.repeat(4*1024*1024+1));await expect(page({shard:'00',offset:0,limit:1})).rejects.toThrow('CAPTURE_RECEIPT_PAGE_LIMIT');
  await expect(page({shard:'../',offset:0,limit:1})).rejects.toThrow('INVALID_RECEIPT_QUERY');
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('refuses a larger inode swapped after the pathname size precheck',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-receipt-page-swap-'));try{
  const path=join(dir,encodeURIComponent(KV.captureEvents('00'))+'.bin');await writeFile(path,'{}');
  await writeFile(path+'.next',JSON.stringify({x:'x'.repeat(4*1024*1024)}));
  Object.assign(swap,{path,replacement:path+'.next',enabled:true});
  await expect(createCaptureReceiptPage(dir)({shard:'00',offset:0,limit:1})).rejects.toThrow('state_namespace_file_limit');
 }finally{swap.enabled=false;await rm(dir,{recursive:true,force:true});}
});
