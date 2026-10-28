import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {auditServerSdkBundle} from '../scripts/audit-server-sdk-bundle.mjs';
let root:string;
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),'am-closure-audit-'));await mkdir(join(root,'dist'));
 for(const [name,version]of Object.entries({'iii-sdk':'0.25.0','@iii-dev/helpers':'0.25.0',yaml:'2.8.1',json5:'2.2.3'})){
  await mkdir(join(root,'node_modules',name),{recursive:true});await writeFile(join(root,'node_modules',name,'package.json'),JSON.stringify({version}));
 }
 await writeFile(join(root,'dist/cli.mjs'),"import fs from 'node:fs';export const cli=true;");await writeFile(join(root,'dist/index.mjs'),"export const worker=true;");
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
it('binds every runtime executable and its literal import inventory',async()=>{
 await mkdir(join(root,'dist/chunks'));await writeFile(join(root,'dist/chunks/sdk.mjs'),'export const sdk=true;');
 const result=await auditServerSdkBundle(root);expect(Object.keys(result.files)).toEqual(['dist/chunks/sdk.mjs','dist/cli.mjs','dist/index.mjs']);expect(Object.keys(result.externalSpecifiers)).toEqual(Object.keys(result.files));expect(result.externalSpecifiers['dist/cli.mjs']).toEqual(['node:fs']);expect(result.mode).toBe('bundled-sdk0.25-v1');
});
it.each(["import 'iii-sdk';","export {http} from '@iii-dev/helpers/http';","await import('yaml');","require('json5');","import '@opentelemetry/api';"] )('rejects changed SDK externals instead of claiming a closed runtime: %s',async source=>{
 await writeFile(join(root,'dist/index.mjs'),source);await expect(auditServerSdkBundle(root)).rejects.toThrow('SDK_SERVER_EXTERNAL_DEPENDENCY');
});
it('requires both real server entrypoints',async()=>{await rm(join(root,'dist/index.mjs'));await expect(auditServerSdkBundle(root)).rejects.toThrow('SDK_SERVER_ENTRY_MISSING');});

it('rejects installed SDK version mismatch',async()=>{await writeFile(join(root,'node_modules/iii-sdk/package.json'),JSON.stringify({version:'0.22.1'}));await expect(auditServerSdkBundle(root)).rejects.toThrow('SDK_SERVER_VERSION_MISMATCH');});
