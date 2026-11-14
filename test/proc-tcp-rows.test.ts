import {it,expect,afterEach} from 'vitest';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {readOwnedTcpRows} from '../src/ops/proc-tcp-rows.mjs';
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
function file(text:string){const d=mkdtempSync(join(tmpdir(),'proc-tcp-'));dirs.push(d);const p=join(d,'tcp');writeFileSync(p,text);return p;}
const row='0: 0100007F:03E8 0100007F:07D0 01 0 0 0 1000 0 501';
it('reads owned rows across chunk boundaries and final unterminated line',()=>{const p=file(('unrelated\n').repeat(8000)+row+'\n'+('other\n').repeat(12000)+row);expect(readOwnedTcpRows(p,new Set(['501']))).toHaveLength(2);});
it('bounds retained owned rows rather than total host table',()=>{expect(()=>readOwnedTcpRows(file((row+'\n').repeat(5)),new Set(['501']))).toThrow('PROC_TCP_OWNED_ROW_LIMIT');});
it('rejects malformed oversized lines with bounded scratch space',()=>{expect(()=>readOwnedTcpRows(file('x'.repeat(70000)),new Set(['501']))).toThrow('PROC_TCP_LINE_LIMIT');});
it('ignores unrelated established sockets but preserves duplicate owned rows for caller refusal',()=>{const p=file(row+'\n'+row.replace('501','999')+'\n'+row);expect(readOwnedTcpRows(p,new Set(['501']))).toHaveLength(2);});
