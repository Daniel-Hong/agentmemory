import {it,expect} from 'vitest';
import {waitForDevToolsPort} from './helpers/devtools-port.js';
const endpoint='42093\n/devtools/browser/11111111-1111-4111-8111-111111111111';
it('waits through absent, empty, partial port and incomplete endpoint publication',async()=>{
 let now=0,reads=0;const rows=[null,'','42','42093','42093\n/devtools/browser/',endpoint];
 const port=await waitForDevToolsPort('unused',100,()=>true,{clock:()=>now,pause:async()=>{now++;},read:()=>{const row=rows[reads++];if(row===null)throw Object.assign(Error('absent'),{code:'ENOENT'});return row!;}});
 expect(port).toBe(42093);expect(reads).toBe(6);expect(now).toBe(5);
});
it.each(['0','65536','junk'])('rejects invalid port %s until bounded deadline',async port=>{
 let now=0;await expect(waitForDevToolsPort('unused',3,()=>true,{clock:()=>now,pause:async()=>{now++;},read:()=>endpoint.replace('42093',port)})).rejects.toThrow('deadline');expect(now).toBe(3);
});
it('fails on child exit without accepting stale endpoint contents',async()=>{await expect(waitForDevToolsPort('unused',100,()=>false,{clock:()=>0,read:()=>endpoint})).rejects.toThrow('exited');});
it('propagates read permissions failure rather than retrying it',async()=>{await expect(waitForDevToolsPort('unused',100,()=>true,{clock:()=>0,read:()=>{throw Object.assign(Error('denied'),{code:'EACCES'});}})).rejects.toThrow('denied');});
