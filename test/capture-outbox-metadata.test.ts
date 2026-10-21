import {it,expect,afterEach} from 'vitest';
import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dirs:string[]=[];afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
it('counts retained local ownership without reading bodies, following symlinks, or leaking filenames',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'am-outbox-meta-'));dirs.push(dir);
 await writeFile(join(dir,'100-123-synthetic-event.json'),'INVALID PRIVATE BODY');
 await writeFile(join(dir,'context.cache'),'PRIVATE CACHE');
 await symlink(join(dir,'100-123-synthetic-event.json'),join(dir,'linked.json'));
 const module=await import('../src/capture/outbox-metadata.js').catch(()=>({createOutboxMetadata:undefined}));
 expect(module.createOutboxMetadata).toBeTypeOf('function');
 const inspect=module.createOutboxMetadata!(dir);const summary=await inspect();
 expect(summary).toMatchObject({records:1,complete:true,available:true});expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|synthetic-event|linked/);
 await writeFile(join(dir,'new.json'),'unread');expect(await inspect()).toEqual(summary);
});
