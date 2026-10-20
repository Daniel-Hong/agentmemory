import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {describe,it,expect} from 'vitest';
const updater=readFileSync('src/viewer/update-viewer.js','utf8');
const styles=readFileSync('src/viewer/index.html','utf8').match(/<style>([\s\S]*?)<\/style>/)![1];
describe.skipIf(spawnSync('google-chrome',['--version'],{encoding:'utf8',timeout:5000}).status!==0)('real update interaction',()=>{
 it.each([[390,844,'light'],[1280,900,'light'],[390,844,'dark']])('keeps request/progress/failure visible at %ix%i/%s and sends one POST',(width,height,theme)=>{
  const dir=mkdtempSync(join(tmpdir(),'am-update-browser-'));
  const script=`
window.result={};var posts=0,offline=false;var id='12345678-1234-4234-8234-123456789012';
var job={jobId:id,candidateId:'next',status:'running',phase:'latest_private_backup_verified',events:[{phase:'preflight_verified'},{phase:'normal_shutdown_verified'},{phase:'latest_private_backup_verified'}]};
var candidate={id:'next',version:'next',sourceCommit:'a'.repeat(40),packageSha256:'b'.repeat(64),approved:true,changeSummary:'변경 설명 '.repeat(200),tests:['검증 '.repeat(150)]};
window.fetch=async(url,opts)=>{if(offline)throw Error('offline');if(opts.method==='POST'){posts++;await new Promise(r=>setTimeout(r,80));}return new Response(JSON.stringify(String(url).endsWith('/updates')?{available:true,currentVersion:'old',candidates:[candidate],jobs:posts?[job]:[]}:job),{status:200});};
setTimeout(async()=>{try{
 document.getElementById('update-launch').click();await new Promise(r=>setTimeout(r,30));
 var dialog=document.getElementById('update-dialog'),apply=document.getElementById('update-apply'),message=document.getElementById('update-message');
 dialog.scrollTop=dialog.scrollHeight;apply.click();apply.click();apply.click();
 var rect=message.getBoundingClientRect();result.immediateVisible=rect.top>=0&&rect.bottom<=innerHeight;result.disabled=apply.disabled;result.immediateText=message.textContent;
 await new Promise(r=>setTimeout(r,120));result.progress=document.getElementById('update-progress').textContent;
 offline=true;document.getElementById('update-refresh').click();await new Promise(r=>setTimeout(r,30));result.pendingPreserved=!!localStorage.getItem('agentmemory-update-pending');
 offline=false;job={...job,status:'failed',phase:'failed',failure:{errorCode:'USER_PHASE_FAILED',failedPhase:'latest_private_backup_verified',recoveryStatus:'restored'}};
 document.getElementById('update-refresh').click();await new Promise(r=>setTimeout(r,40));
 rect=message.getBoundingClientRect();result.failureVisible=rect.top>=0&&rect.bottom<=innerHeight;result.failure=message.textContent;result.disabledAfterFailure=apply.disabled;result.pendingCleared=!localStorage.getItem('agentmemory-update-pending');result.posts=posts;
 apply.click();result.postsAfterClick=posts;result.horizontalOverflow=document.documentElement.scrollWidth>innerWidth;result.messageColor=getComputedStyle(message).color;result.bodyColor=getComputedStyle(document.body).color;function lum(rgb){var a=rgb.match(/[0-9.]+/g).slice(0,3).map(v=>{var x=Number(v)/255;return x<=0.04045?x/12.92:Math.pow((x+0.055)/1.055,2.4);});return a[0]*0.2126+a[1]*0.7152+a[2]*0.0722;}var fg=lum(result.messageColor),bg=lum(getComputedStyle(dialog).backgroundColor);result.contrast=(Math.max(fg,bg)+0.05)/(Math.min(fg,bg)+0.05);
 document.getElementById('evidence').textContent=JSON.stringify(result);
 }catch(e){document.getElementById('evidence').textContent=JSON.stringify({error:String(e.stack||e)});}},0);`;
  writeFileSync(join(dir,'fixture.html'),`<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style></head><body><main style="flex:1">Synthetic dashboard</main><footer class="viewer-footer"><span id="footer-feedback">report issue</span></footer><pre id="evidence" hidden></pre><script>${updater}</script><script>${script}</script></body></html>`);
  const run=spawnSync('google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run','--user-data-dir='+join(dir,'profile'),'--virtual-time-budget=1500','--window-size='+width+','+height,'--screenshot='+join(dir,'preview.png'),'--dump-dom','file://'+join(dir,'fixture.html')],{encoding:'utf8',timeout:25000,maxBuffer:2000000});
  expect(run.status,run.stderr.slice(-500)).toBe(0);const match=run.stdout.match(/<pre id="evidence"[^>]*>([\s\S]*?)<\/pre>/);expect(match).not.toBeNull();const result=JSON.parse(match![1].replaceAll('&quot;','"').replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>'));writeFileSync(join(dir,'evidence.json'),JSON.stringify(result,null,2));
  expect(result.error).toBeUndefined();expect(result.immediateVisible).toBe(true);expect(result.disabled).toBe(true);expect(result.immediateText).toContain('접수');expect(result.progress).toContain('백업');expect(result.pendingPreserved).toBe(true);expect(result.failureVisible).toBe(true);expect(result.failure).toContain('이전 버전');expect(result.failure).toContain('실패');expect(result.disabledAfterFailure).toBe(true);expect(result.pendingCleared).toBe(true);expect(result.posts).toBe(1);expect(result.postsAfterClick).toBe(1);expect(result.horizontalOverflow).toBe(false);expect(result.contrast).toBeGreaterThanOrEqual(4.5);
 },30000);
});
