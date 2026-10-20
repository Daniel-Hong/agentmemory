(function () {
 'use strict';
 var key='agentmemory-update-pending',pending=null,catalog=null,lastJob=null,opener=null,timer=null,polls=0,busy=false,missing=false;
 var statuses={queued:'업데이트 요청 대기',running:'업데이트 적용 중',applied_pending_acceptance:'적용됨 · 최종 확인 대기',failed:'업데이트 실패',interrupted:'업데이트 중단 · 관리자 점검 필요'};
 var phases={queued:'요청 접수',applying:'사전 점검 시작',preflight_verified:'사전 점검 통과',normal_shutdown_requested:'기존 서버 정상 종료 중',normal_shutdown_verified:'정상 종료 확인',latest_private_backup_verified:'최신 데이터 백업 확인',versioned_package_verified:'새 버전 설치 확인',activating_code_and_hooks:'실행 경로 전환',ready_to_start:'새 버전 시작 준비',new_version_started:'새 버전 시작',runtime_and_data_verified:'실행·데이터 보존 확인',code_archives_readback_verified:'코드 보존본 확인',applied_pending_live_acceptance:'적용됨 · 최종 확인 대기',awaiting_acceptance:'적용됨 · 최종 확인 대기'};
 var reasons={INSTALL_PATH_NOT_WRITABLE:'설치 경로에 쓰기 권한이 없습니다. 서버 중지 전에 차단했습니다.',DEPENDENCY_REUSE_NOT_COMPATIBLE:'기존 의존성과 새 버전이 호환되지 않습니다.',BACKUP_READBACK_FAILED:'백업 재조회 검증에 실패했습니다.',SHUTDOWN_NOT_VERIFIED:'정상 종료 저장 인증을 확인하지 못했습니다.',USER_PHASE_FAILED:'사용자 권한 설치·보존 단계가 실패했습니다.'};
 var recoveries={not_needed:'기존 서버를 중지하지 않았습니다.',restored:'이전 버전 서버를 재시작하고 일시정지·저장 상태를 확인했습니다.',manual_required:'자동 복구 조건을 충족하지 못했습니다. 관리자 점검이 필요합니다.',restore_failed:'이전 서버의 복구 확인에 실패했습니다. 관리자 점검이 필요합니다.'};
 function el(tag,text,attrs){var n=document.createElement(tag);if(text!==undefined)n.textContent=text;Object.entries(attrs||{}).forEach(function(p){n.setAttribute(p[0],p[1]);});return n;}
 function button(label,id,fn){var b=el('button',label,{type:'button',class:'btn',id:id});b.addEventListener('click',fn);return b;}
 function newId(){if(typeof crypto.randomUUID==='function')return crypto.randomUUID();var b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h=Array.from(b,function(v){return v.toString(16).padStart(2,'0');}).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}
 function restore(){try{var saved=JSON.parse(localStorage.getItem(key)||'null');if(saved&&typeof saved.requestId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(saved.requestId)&&typeof saved.candidateId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(saved.candidateId))pending={requestId:saved.requestId,candidateId:saved.candidateId};}catch{}}
 restore();
 var launch=button('업데이트','update-launch',open),anchor=document.getElementById('footer-feedback');(anchor?.parentNode||document.body).appendChild(launch);
 var dialog=el('dialog',undefined,{id:'update-dialog',role:'dialog','aria-modal':'true','aria-labelledby':'update-heading'});
 dialog.style.cssText='box-sizing:border-box;width:min(760px,calc(100vw - 24px));max-width:calc(100vw - 24px);max-height:90vh;overflow:auto;background:var(--bg,#171923);color:var(--ink,#eee);border:1px solid #777;padding:20px;border-radius:8px;overflow-wrap:anywhere';
 var message=el('p','',{id:'update-message',role:'status','aria-live':'polite'}),summary=el('div'),details=el('div'),history=el('div');
 message.style.cssText='position:sticky;top:0;z-index:1;background:var(--bg,#171923);padding:12px 0;border-bottom:2px solid var(--border,#777);white-space:pre-line';
 var progress=el('ol',undefined,{id:'update-progress','aria-label':'확인된 업데이트 단계'});
 function announce(text){message.textContent=text;dialog.scrollTop=0;}
 var select=el('select',undefined,{id:'update-candidate'});select.style.cssText='display:block;max-width:100%;margin:8px 0';select.addEventListener('change',renderCandidate);
 var apply=button('이 후보 적용','update-apply',function(){return submit(false);}),retry=button('같은 요청 ID로 재시도','update-retry',function(){return submit(true);});retry.disabled=true;
 var refresh=button('상태 새로고침','update-refresh',async function(){polls=0;await load();}),closeButton=button('닫기','update-close',close);
 dialog.append(el('h2','개인 포크 업데이트',{id:'update-heading'}),message,progress,summary,el('label','승인된 후보',{for:'update-candidate'}),select,details,apply,retry,refresh,closeButton,history);document.body.appendChild(dialog);
 function controls(){var failed=(catalog?.jobs||[]).concat(lastJob?[lastJob]:[]).some(function(j){return j.candidateId===select.value&&['failed','interrupted'].includes(j.status);});apply.disabled=busy||!!pending||!catalog?.available||!selected()||failed||(catalog.jobs||[]).some(function(j){return ['queued','running','interrupted'].includes(j.status);});apply.textContent=busy?'업데이트 요청 중…':pending?'진행 상태 확인 중…':failed?'실패한 후보 · 새 후보 필요':'이 후보 적용';retry.disabled=busy||!pending||!(missing||lastJob?.status==='queued');}
 function selected(){return (catalog?.candidates||[]).find(function(c){return c.id===select.value&&c.approved===true;});}
 function clearTimer(){if(timer!==null)clearTimeout(timer);timer=null;}
 function schedule(){clearTimer();if(dialog.open&&pending&&!missing&&polls<30)timer=setTimeout(async function(){timer=null;polls++;await checkJob();},4000);}
 function waiting(){message.textContent='업데이트 중·서버 재시작 대기 · 응답을 받지 못해 현재 상태는 미확정입니다.\n마지막 요청 ID: '+pending.requestId+' · 같은 요청을 조회하며 새 요청은 보내지 않습니다.';schedule();controls();}
 async function api(path,method,body){
  var headers=method?{'Content-Type':'application/json','x-agentmemory-update':'1'}:{};
  var token=typeof getViewerToken==='function'?getViewerToken():'';if(token)headers.Authorization='Bearer '+token;
  var controller=new AbortController(),timeout=setTimeout(function(){controller.abort();},15000);
  try{var response=await fetch((typeof REST==='string'?REST:'')+'/agentmemory/updates'+path,{method:method||'GET',headers:headers,body:body?JSON.stringify(body):undefined,signal:controller.signal});
   if(response.status===401&&typeof showViewerAuthPrompt==='function')showViewerAuthPrompt();
   var data=await response.json();if(!response.ok){var error=Error('요청 실패');error.status=response.status;throw error;}return data;
  }finally{clearTimeout(timeout);}
 }
 function renderCandidate(){details.replaceChildren();var c=selected();if(c){details.append(el('h3',c.version),el('p',c.changeSummary),el('p','전체 소스 커밋: '+c.sourceCommit),el('p','패키지 SHA256: '+c.packageSha256),el('h4','실제 검증 결과'));var list=el('ul');(c.tests||[]).forEach(function(test){list.append(el('li',test));});details.append(list,el('p','적용 후 운영 인수와 다른 클라이언트의 적용 상태를 별도로 확인합니다.'));}controls();}
 function renderCatalog(){summary.replaceChildren();summary.append(el('p','현재 버전: '+(catalog.currentVersion||'확인 필요')));
  if(!catalog.available)summary.append(el('p','관리자 최초 설정 필요 · 승인 목록과 독립 실행 경계를 서버 관리자에게 확인하세요.'));
  var before=select.value;select.replaceChildren();var candidates=(catalog.candidates||[]).filter(function(c){return c.approved===true;});candidates.forEach(function(c){select.append(el('option',c.version+' · '+c.id,{value:c.id}));});select.value=candidates.some(function(c){return c.id===before;})?before:(candidates[0]?.id||'');
  if(catalog.available&&!candidates.length)summary.append(el('p','등록된 후보 없음'));
  history.replaceChildren(el('h3','적용 이력'));
  (catalog.jobs||[]).forEach(function(job){history.append(el('p',(statuses[job.status]||'상태 확인 필요')+' · '+job.candidateId+' · '+job.jobId+(job.errorCode?' · 오류 코드: '+job.errorCode:'')));if(job.events?.length){var events=el('ul');job.events.forEach(function(event){events.append(el('li',(event.at||'')+' · '+(event.phase||event.status||'')+(event.errorCode?' · '+event.errorCode:'')));});history.append(events);}});
  if(!pending&&catalog.jobs?.length)lastJob=catalog.jobs[0];
  renderCandidate();
 }
 function showJob(job){lastJob=job;missing=false;var text=(statuses[job.status]||'업데이트 상태 확인 필요')+' · '+job.jobId;
  progress.replaceChildren();(job.events||[]).forEach(function(event){if(phases[event.phase])progress.append(el('li',phases[event.phase]+(event.at?' · '+event.at:'')));});
  if(phases[job.phase])text+='\n현재 단계: '+phases[job.phase];
  if(job.status==='failed'){
   var failure=job.failure||{},last=(job.events||[]).filter(function(e){return phases[e.phase];}).pop();
   text+='\n마지막 확인 단계: '+(phases[failure.failedPhase]||phases[last?.phase]||'확인 필요');
   text+='\n'+(reasons[failure.errorCode]||'적용 작업이 실패했습니다. 오류 코드: '+(failure.errorCode||job.errorCode||'확인 필요'));
   text+='\n'+(recoveries[failure.recoveryStatus]||'서버 복구 여부는 아직 확인되지 않았습니다. 관리자 점검이 필요합니다.');
   text+='\n같은 후보를 반복 적용하지 말고 수정된 새 후보를 사용하세요.';
   announce(text);
  }else message.textContent=text;
  if(job.status==='applied_pending_acceptance'||job.status==='failed'){
   clearTimer();pending=null;try{localStorage.removeItem(key);}catch{};
  }else if(job.status==='interrupted'){clearTimer();}else schedule();controls();
 }
 async function checkJob(){if(!pending)return;try{showJob(await api('/jobs/'+encodeURIComponent(pending.requestId)));}
  catch(error){if(error.status===404){missing=true;message.textContent='요청 기록 없음 · 같은 요청 ID로 재시도할 수 있습니다: '+pending.requestId;clearTimer();controls();}else waiting();}
 }
 async function load(){clearTimer();try{catalog=await api('');renderCatalog();if(!pending){if(lastJob)showJob(lastJob);else message.textContent='후보를 선택하면 적용할 수 있습니다.';}}
  catch{if(pending)waiting();else{message.textContent='업데이트 목록을 조회하지 못했습니다. 상태 새로고침으로 다시 확인하세요.';controls();}}
  if(pending)await checkJob();
 }
 async function submit(reuse){if(busy)return;if(reuse){if(!pending||!(missing||lastJob?.status==='queued'))return;}else{if(pending||!catalog?.available||!selected())return;
   try{pending={requestId:newId(),candidateId:selected().id};localStorage.setItem(key,JSON.stringify(pending));}
   catch{pending=null;announce('요청 ID를 저장하지 못해 적용을 요청하지 않았습니다. 브라우저 저장소를 확인하세요.');controls();return;}
  }
  busy=true;missing=false;controls();clearTimer();announce('업데이트 요청 전송 중 · '+pending.requestId+'\n접수 결과를 기다리고 있습니다. 다시 누르지 않아도 됩니다.');
  try{showJob(await api('/jobs','POST',{requestId:pending.requestId,candidateId:pending.candidateId}));}
  catch(error){if(error.status>=400&&error.status<500){if(reuse){announce('재시도 요청이 거부됐습니다('+error.status+'). 기존 요청 ID는 보존합니다: '+pending.requestId+'\n인증을 확인한 뒤 상태 새로고침으로 기존 요청을 조회하세요.');schedule();}else{pending=null;try{localStorage.removeItem(key);}catch{};announce('업데이트 요청이 거부됐습니다('+error.status+'). 인증·후보 상태를 확인하고 상태 새로고침을 누르세요. 서버 적용 여부를 추측해 재전송하지 않습니다.');}}else waiting();}
  finally{busy=false;controls();}
 }
 async function open(){opener=document.activeElement;dialog.showModal();polls=0;closeButton.focus();await load();}
 function close(){clearTimer();dialog.close();opener?.focus();}
 dialog.addEventListener('close',function(){clearTimer();opener?.focus();});
 dialog.addEventListener('cancel',function(event){event.preventDefault();close();});
 dialog.addEventListener('keydown',function(event){if(event.key==='Escape'){event.preventDefault();close();return;}if(event.key!=='Tab')return;
  var nodes=Array.from(dialog.querySelectorAll('button:not([disabled]),select:not([disabled]),[tabindex="0"]')),first=nodes[0],last=nodes[nodes.length-1];
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
 });
 controls();
}());
