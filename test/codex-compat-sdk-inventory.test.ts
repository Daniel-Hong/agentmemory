import {afterEach, expect, it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {buildCodexCompat} from '../scripts/build-codex-compat.mjs';
import {auditServerSdkBundle} from '../scripts/audit-server-sdk-bundle.mjs';
const roots:string[]=[];
afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'am-compat-sdk-inventory-'));roots.push(root);
 cpSync(resolve('integrations/codex-compat'),join(root,'integrations/codex-compat'),{recursive:true});
 for(const dir of ['plugin/scripts','dist/hooks']){mkdirSync(join(root,dir),{recursive:true});writeFileSync(join(root,dir,'_capture.mjs'),'function handoffObservation(){}\nexport { handoffObservation };\n');}
 for(const name of ['cli.mjs','index.mjs'])writeFileSync(join(root,'dist',name),'export {};\n');
 for(const [name,version]of Object.entries({'iii-sdk':'0.25.1','@iii-dev/helpers':'0.25.1',yaml:'2.8.1',json5:'2.2.3'})){
  mkdirSync(join(root,'node_modules',name),{recursive:true});writeFileSync(join(root,'node_modules',name,'package.json'),JSON.stringify({version}));
 }
 writeFileSync(join(root,'dist/server-sdk-bundle.json'),JSON.stringify(await auditServerSdkBundle(root)));
 return root;
}
it('refreshes an existing SDK inventory after compatibility scripts extend dist',async()=>{
 const root=await fixture();await buildCodexCompat(root);
 const actual=JSON.parse(readFileSync(join(root,'dist/server-sdk-bundle.json'),'utf8'));
 expect(actual).toEqual(await auditServerSdkBundle(root));
 expect(actual.files).toHaveProperty('dist/hooks/codex-compat/session-start.mjs');
});
it('propagates the unchanged SDK audit rejection instead of claiming refreshed closure',async()=>{
 const root=await fixture();writeFileSync(join(root,'node_modules/iii-sdk/package.json'),JSON.stringify({version:'unreviewed'}));
 await expect(buildCodexCompat(root)).rejects.toThrow('SDK_SERVER_VERSION_MISMATCH');
});
