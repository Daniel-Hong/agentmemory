import {it,expect,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {StringDecoder} from 'node:string_decoder';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readNamespaceEntries} from '../src/ops/namespace-reader.mjs';
it('decodes the validated JSON prefix once while preserving multibyte boundaries and opaque trailer',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-single-decode-'));
 const prefix=Buffer.from(JSON.stringify({selected:{text:'한😀'.repeat(40)},other:{value:7}}));
 await writeFile(join(dir,'namespace'),Buffer.concat([prefix,Buffer.from([255,254,0,123])]));
 let decodedBytes=0;
 const decode=TextDecoder.prototype.decode,write=StringDecoder.prototype.write;
 const a=vi.spyOn(TextDecoder.prototype,'decode').mockImplementation(function(this:TextDecoder,input?:AllowSharedBufferSource,options?:TextDecodeOptions){decodedBytes+=input?.byteLength??0;return decode.call(this,input,options);});
 const b=vi.spyOn(StringDecoder.prototype,'write').mockImplementation(function(this:StringDecoder,input:Buffer){decodedBytes+=input.byteLength;return write.call(this,input);});
 try{const result=await readNamespaceEntries(join(dir,'namespace'),{chunkSize:7,keys:new Set(['selected'])});expect(result.values.get('selected')).toEqual({text:'한😀'.repeat(40)});expect(decodedBytes).toBe(prefix.byteLength);}
 finally{a.mockRestore();b.mockRestore();await rm(dir,{recursive:true,force:true});}
});

it('enforces a caller file-size ceiling on the opened inode before parsing a large entry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-opened-size-'));try{
  const path=join(dir,'namespace');await writeFile(path,JSON.stringify({x:'x'.repeat(1024)}));
  await expect(readNamespaceEntries(path,{maxFileBytes:100})).rejects.toThrow('state_namespace_file_limit');
 }finally{await rm(dir,{recursive:true,force:true});}
});
