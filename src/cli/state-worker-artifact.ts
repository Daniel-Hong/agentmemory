import {readFileSync,realpathSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export const STATE_ARTIFACT_PIN={artifactVersion:'0.22.22-daniel.1',upstreamCommit:'a8ed4889f54cb34cb9ffdb6e44190484d90ba950',patchSha256:'504bbb8a3b6b2eda1d4714f33c89f8ad47aa3af74dc61a99ee5efec76b9f4224'};
export function loadStateWorkerArtifact(directory:string){
 const root=realpathSync(directory),manifestPath=join(root,'manifest.json');
 if(statSync(manifestPath).size>16384)throw Error('STATE_ARTIFACT_MANIFEST_INVALID');
 const m=JSON.parse(readFileSync(manifestPath,'utf8'));
 if(m.schemaVersion!==1||m.profile!=='release'||m.binary!=='state'||m.engineVersion!=='0.25.1'||Object.entries(STATE_ARTIFACT_PIN).some(([k,v])=>m[k]!==v))throw Error('STATE_ARTIFACT_PROVENANCE_MISMATCH');
 if(process.platform!=='linux'||!['x86_64-unknown-linux-gnu','aarch64-unknown-linux-gnu'].includes(m.target)||!m.target.startsWith(process.arch==='x64'?'x86_64-':process.arch==='arm64'?'aarch64-':'unsupported'))throw Error('STATE_ARTIFACT_PLATFORM_MISMATCH');
 const path=realpathSync(join(root,'state')),stat=statSync(path);
 if(!stat.isFile()||stat.size>256*1024*1024||!(stat.mode&0o111))throw Error('STATE_ARTIFACT_BINARY_INVALID');
 const sha256=createHash('sha256').update(readFileSync(path)).digest('hex');
 if(sha256!==m.binarySha256)throw Error('STATE_ARTIFACT_HASH_MISMATCH');
 return {path,sha256};
}
