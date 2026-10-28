import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({fault:''}));
vi.mock('node:fs',async()=>{const fs=await vi.importActual<typeof import('node:fs')>('node:fs');return {...fs,
 writeFileSync:(...args:any[])=>{if(state.fault==='write')throw Error('synthetic_write');return (fs.writeFileSync as any)(...args);},
 fsyncSync:(fd:number)=>{if(state.fault==='file_sync'&&!fs.fstatSync(fd).isDirectory())throw Error('synthetic_sync');if(state.fault==='dir_sync'&&fs.fstatSync(fd).isDirectory())throw Error('synthetic_dir');return fs.fsyncSync(fd);},
 renameSync:(...args:any[])=>{if(state.fault==='rename')throw Error('synthetic_rename');return (fs.renameSync as any)(...args);}};});
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {retainSdkOriginal,spoolSummary} from '../src/capture/spool.js';
let dir:string;beforeEach(()=>{state.fault='';dir=mkdtempSync(join(tmpdir(),'am-sdk-write-fault-'));});afterEach(()=>{state.fault='';rmSync(dir,{recursive:true,force:true});});
it.each(['write','file_sync','rename','dir_sync'])('retains no abandoned temporary files and safely retries after %s',fault=>{
 state.fault=fault;expect(retainSdkOriginal('http://127.0.0.1:63000','synthetic',{text:'original'},{dir})).toBe(false);
 const folder=join(dir,'local-63000.sdk-originals');expect(readdirSync(folder).filter(n=>n.endsWith('.tmp'))).toEqual([]);
 state.fault='';expect(retainSdkOriginal('http://127.0.0.1:63000','synthetic',{text:'original'},{dir})).toBe(true);expect(spoolSummary('http://127.0.0.1:63000',{dir}).sdkRetained).toBe(1);
});
