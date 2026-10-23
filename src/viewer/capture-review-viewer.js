(function(){
 'use strict';
 var key='agentmemory-capture-review-pending',busy=false,pending=null,opener=null,nextCursor=null,rows=[],cursorStack=[''],historyOffsets={},job=null,pollTimer=null,polling=false,deadCount=0;
 try{var saved=JSON.parse(localStorage.getItem(key)||'null');if(saved&&(saved.kind==='job'||typeof saved.eventId==='string')&&/^[a-f0-9-]{36}$/.test(saved.requestId))pending=saved;}catch{}
 function el(tag,text,attrs){var node=document.createElement(tag);if(text!==undefined)node.textContent=text;Object.entries(attrs||{}).forEach(function(a){node.setAttribute(a[0],a[1]);});return node;}
 function button(text,id,fn){var node=el('button',text,{type:'button',class:'btn',id:id});node.addEventListener('click',fn);return node;}
 var dialog=el('dialog',undefined,{id:'capture-review-dialog','aria-labelledby':'capture-review-heading'});
 dialog.style.cssText='width:min(850px,calc(100vw - 24px));max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);box-sizing:border-box;overflow:auto;background:var(--bg,#171923);color:var(--ink,#eee);border:1px solid var(--border,#777);padding:16px;overflow-wrap:anywhere';
 var message=el('p','수집 격리 기록을 조회하세요.',{id:'capture-review-message',role:'status','aria-live':'polite'});
 message.style.cssText='position:sticky;top:0;z-index:1;background:var(--bg,#171923);padding:10px 0;white-space:pre-line';
 var summary=el('p'),list=el('div'),history=el('div');
 var select=el('select',undefined,{id:'capture-review-status','aria-label':'수집 기록 상태'});
 [['dead','격리됨'],['retrying','자동 재시도 대기'],['completed','복구 이력']].forEach(function(v){select.append(el('option',v[1],{value:v[0]}));});
 var refresh=button('상태 새로고침','capture-review-refresh',function(){return refreshAll();});
 var previous=button('이전 목록','capture-review-previous',function(){if(cursorStack.length>1){cursorStack.pop();return load(cursorStack[cursorStack.length-1]);}});
 var next=button('다음 목록','capture-review-next',function(){if(nextCursor){cursorStack.push(nextCursor);return load(nextCursor);}});
 var sameRequest=button('같은 요청 결과 확인·재요청','capture-review-same-request',function(){if(pending&&pending.kind==='job'&&!pending.accepted)return sendJob();if(pending&&pending.kind!=='job')return sendLegacy();return refreshAll();});
 var bulk=button('격리 전체 재시도','capture-review-retry-all',function(){if(confirm('현재 격리된 약 '+deadCount+'건을 서버에서 한 건씩 재시도합니다. 창을 닫아도 계속되며 중지 버튼으로 다음 항목부터 멈출 수 있습니다. 시작할까요?'))return submit(null,false,null,true);});
 var stop=button('작업 중지','capture-review-stop',async function(){if(busy||!activeJob())return;busy=true;controls();try{var result=await api('/jobs/stop','POST',{jobId:job.id});await applyJob(result);}catch{announce('중지 결과 미확정 · 서버 상태를 자동 확인합니다. 이미 진행 중인 한 건은 저장 결과를 확인합니다.');}finally{busy=false;controls();schedule();}});
 var progress=el('p','서버 재시도 작업 없음',{id:'capture-review-progress',role:'status','aria-live':'polite'});

 var close=button('닫기','capture-review-close',function(){clearTimeout(pollTimer);dialog.close();opener?.focus();});
 dialog.append(el('h2','수집 격리·복구 이력',{id:'capture-review-heading'}),message,el('p','저장 전에 실패한 수집 기록입니다. 요약·압축·그래프 격리와 별도로 집계합니다. 원인을 해결한 뒤 한 항목씩 재시도하세요. 원문과 이전 실패 이력은 보존합니다.'),select,refresh,bulk,stop,progress,summary,list,previous,next,sameRequest,history,close);
 document.body.append(dialog);
 var codes={SESSION_OBSERVATION_LIMIT:'세션 관측 한도 초과',OBSERVATION_NOT_STORED:'응답은 받았으나 실제 저장 미확인',CAPTURE_STORE_TIMEOUT:'저장 시간 초과',CAPTURE_STORE_FAILED:'수집 저장 실패 · 원인 점검 필요'};
 function announce(text){message.textContent=text;}
 function activeJob(){return job&&['running','stopping'].includes(job.status);}
 function controls(){bulk.disabled=busy||!!pending||!!activeJob()||deadCount===0;stop.disabled=busy||!activeJob()||job.stopRequested;stop.textContent=job?.stopRequested?'중지 요청됨 · 현재 항목 확인 중':'작업 중지';sameRequest.disabled=busy||!pending;previous.disabled=busy||cursorStack.length<2;next.disabled=busy||!nextCursor;select.disabled=busy;refresh.disabled=busy;list.querySelectorAll('[data-action="capture-review-retry-one"]').forEach(function(b){b.disabled=busy||!!pending||!!activeJob()||b.getAttribute('data-state')!=='dead';b.textContent=job?.current&&b.id==='capture-retry-'+job.current.eventId?'처리 중 · 결과 자동 확인':'이 항목 재시도';});}
 async function api(path,method,body){var controller=new AbortController(),timer=setTimeout(function(){controller.abort();},15000);var headers=method?{'Content-Type':'application/json'}:{};
  var token=typeof getViewerToken==='function'?getViewerToken():'';if(token)headers.Authorization='Bearer '+token;
  try{var response=await fetch((typeof REST==='string'?REST:'')+'/agentmemory/capture'+path,{method:method||'GET',headers:headers,body:body?JSON.stringify(body):undefined,signal:controller.signal});if(response.status===401&&typeof showViewerAuthPrompt==='function')showViewerAuthPrompt();var data=await response.json();if(!response.ok){var err=Error('조회 실패');err.status=response.status;throw err;}return data;}finally{clearTimeout(timer);}
 }
 function clearPending(){pending=null;try{localStorage.removeItem(key);}catch{}}
 function render(){list.replaceChildren();rows.forEach(function(row){var card=el('article');card.style.cssText='border:1px solid var(--border,#777);padding:12px;margin:12px 0;overflow-wrap:anywhere';var review=row.review||{};
  card.append(el('h3',(row.project||'프로젝트 미확인')+' · '+(row.status==='completed'?'저장 확인 완료':row.status==='dead'?'수집 격리':'재시도 대기')),el('p','세션: '+row.sessionId),el('p','이벤트: '+row.eventId),el('p',codes[row.errorCode||review.lastFailureCode]||'이전 실패 사유 확인 필요'),el('p','누적 시도 '+row.attempts+'회 · 수동 재시도 '+(review.manualRetries||0)+'회'),el('p','접수 '+row.acceptedAt+' · 갱신 '+row.updatedAt),el('p','내용 미리보기(최대 500자): '+(row.preview||'없음')));
  if(review.recoveredAt)card.append(el('p','저장 확인: '+review.recoveredAt+' · '+row.observationId));
  var retry=button('이 항목 재시도','capture-retry-'+row.eventId,function(){return submit(row.eventId,false,row.key);});retry.setAttribute('data-action','capture-review-retry-one');retry.setAttribute('data-state',row.status);if(job?.current?.eventId===row.eventId)retry.textContent='처리 중 · 결과 자동 확인';
  card.append(retry,button('실패 이력 보기','capture-history-'+row.eventId,function(){historyOffsets[row.key]=0;return showHistory(row.eventId,row.key);}));list.append(card);
 });if(!rows.length)list.append(el('p','선택한 상태의 수집 기록이 없습니다.'));controls();}
 async function showHistory(eventId,key){try{var page=await api('?review=true&eventId='+encodeURIComponent(eventId)+(key?'&key='+encodeURIComponent(key):'')+'&historyOffset='+(historyOffsets[key]||0));var row=page.items?.find(function(x){return x.eventId===eventId;});history.replaceChildren(el('h3','실패 이력 · '+eventId));(row?.failures||[]).forEach(function(f){history.append(el('p',f.at+' · 누적 시도 '+f.attempt+' · '+(codes[f.code]||f.code)+(f.legacy?' · 기존 기록에서 확인된 마지막 실패':'')));});if(!row?.failures?.length)history.append(el('p','추가 실패 이력 없음 · 기존 시도 횟수와 마지막 오류는 목록에 유지됩니다.'));if(row?.nextHistoryOffset!==null&&row?.nextHistoryOffset!==undefined)history.append(button('다음 실패 이력','capture-history-next',function(){historyOffsets[key]=row.nextHistoryOffset;return showHistory(eventId,key);}));}catch{announce('실패 이력을 조회하지 못했습니다. 원문이나 이력을 삭제하지 않았습니다.');}}
 async function legacyResult(){
  if(!pending||pending.kind==='job')return;
  var p=pending,page=await api('?review=true&eventId='+encodeURIComponent(p.eventId)+(p.key?'&key='+encodeURIComponent(p.key):''));
  var row=page.items?.find(function(x){return x.eventId===p.eventId;}),req=row?.review?.lastRequest;
  if(req?.requestId===p.requestId&&['recovered','dead'].includes(req.outcome)&&['completed','dead'].includes(row.status)){
   announce(req.outcome==='recovered'?'실제 저장 확인 완료 · '+p.eventId:'다시 격리됨 · 이전 실패 이력 보존');clearPending();await load(cursorStack[cursorStack.length-1]);
  }else announce('이전 요청 결과 확인 중 · 원문과 같은 요청 ID를 보존합니다. 새 요청을 보내지 않습니다.');
 }
 function keep(value){var text=JSON.stringify(value);localStorage.setItem(key,text);if(localStorage.getItem(key)!==text)throw Error('request ID readback failed');pending=value;}
 async function applyJob(result){
  var next=result.job;
  if(!next){if(pending)announce('서버 접수 결과 미확정 · 같은 요청 ID를 보존하고 상태를 자동 확인합니다.');return;}
  var changed=!job||job.id!==next.id||job.status!==next.status;
  job=next;
  var text=(job.status==='completed'?'작업 완료':job.status==='stopped'?'작업 중지됨':job.stopRequested?'중지 요청됨 · 진행 항목 결과 확인 중':'서버에서 재시도 중')+' · 전체 '+job.total+'건 / 저장 확인 '+job.recovered+'건 / 점검 필요 '+job.failed+'건 / 제외 '+job.skipped+'건 / 남음 '+job.remaining+'건';
  if(result.backgroundPaused&&activeJob())text+=' · 백그라운드 일시정지로 대기';
  if(job.worker?.busy&&job.worker.phaseStartedAt)text+=' · '+({loading:'서버 상태 조회',retry:'현재 항목 저장',verify:'저장 결과 인증',checkpoint:'진행 상태 보존'}[job.worker.phase]||'서버 결과 확인')+' 중 '+Math.max(0,Math.floor((Date.now()-Date.parse(job.worker.phaseStartedAt))/1000))+'초';
  if(job.worker?.lastErrorCode)text+=' · 서버 저장 확인 재시도 중 ('+job.worker.lastErrorCode+')';
  if(job.lastErrorCode)text+=' · 저장된 관측 확인 필요';
  progress.textContent=text+(activeJob()?' · 창을 닫아도 서버에서 계속됩니다.':'');
  if(pending?.kind==='job'&&pending.requestId===job.id){
   if(activeJob()){try{keep({...pending,accepted:true});}catch{};}
   else {clearPending();announce(text);}
  }
  if(!pending&&activeJob())announce(text);
  if(changed&&!activeJob()){announce(text);await load(cursorStack[cursorStack.length-1]);}
 }
 function schedule(){clearTimeout(pollTimer);if(dialog.open)pollTimer=setTimeout(pollJobs,2000);}
 async function pollJobs(){
  if(polling)return;polling=true;
  try{
   await legacyResult();
   if(!pending||pending.kind==='job'){
    var suffix=pending?.kind==='job'?'?jobId='+encodeURIComponent(pending.requestId):'';
    var result=await api('/jobs'+suffix);
    if(suffix&&result.job&&result.job.id!==pending?.requestId){try{keep({kind:'job',requestId:result.job.id,accepted:true});}catch{pending={kind:'job',requestId:result.job.id,accepted:true};}}
    if(!result.job&&suffix){var current=await api('/jobs');if(current.job&&['running','stopping'].includes(current.job.status))result=current;}
    await applyJob(result);
   }
  }catch{announce('서버 상태 조회 실패 · 원문과 요청 ID를 보존하고 자동으로 다시 확인합니다. 새 재시도는 보내지 않습니다.');}
  finally{polling=false;controls();schedule();}
 }
 async function load(cursor){try{
  var page=await api('?review=true&status='+select.value+'&limit=25'+(cursor?'&cursor='+encodeURIComponent(cursor):''));rows=page.items||[];nextCursor=page.nextCursor||null;
  var cap=page.capture?.inbox;deadCount=cap?cap.dead:select.value==='dead'?page.total:deadCount;
  summary.textContent='선택 상태 '+page.total+'건'+(cap?' · 수집 격리 '+cap.dead+'건 · 자동 재시도 '+cap.retrying+'건':'');var auto=page.capture?.automaticRecovery;if(auto?.enabled)summary.textContent+=' · 검증 복구 '+auto.resolved+'건 / 확인 중 '+auto.verifying+'건 / 점검 필요 '+auto.blocked+'건'+(auto.lastErrorCode?' · 자동 변경 보류':'')+(auto.breakerUntil>Date.now()?' · 반복 실패로 대기':'');render();
 }catch{announce('수집 목록 조회 실패 · 비어 있다고 판정하지 않습니다.');}finally{controls();}}
 async function refreshAll(){await load(cursorStack[cursorStack.length-1]);await pollJobs();}
 async function sendLegacy(){
  if(busy||!pending||pending.kind==='job')return;busy=true;controls();
  try{await api('/retry','POST',{eventId:pending.eventId,key:pending.key,requestId:pending.requestId});await legacyResult();}
  catch{announce('이전 요청 결과 미확정 · 같은 요청 ID를 보존하고 자동 확인합니다.');}
  finally{busy=false;controls();schedule();}
 }
 async function sendJob(){
  if(busy||!pending||pending.kind!=='job')return;
  busy=true;controls();announce('서버에 재시도 작업 접수 중 · 같은 요청 ID로 결과를 자동 확인합니다.');
  try{
   var body={requestId:pending.requestId,...(pending.all?{all:true}:{eventId:pending.eventId,key:pending.key})};
   var result=await api('/jobs','POST',body);
   if(result.job&&result.job.id!==pending.requestId){try{keep({kind:'job',requestId:result.job.id,accepted:true});}catch{pending={kind:'job',requestId:result.job.id,accepted:true};}}
   await applyJob(result);
  }catch(error){
   if(error.status>=400&&error.status<500){clearPending();announce('작업 접수 거부('+error.status+') · 인증과 항목 상태를 확인하세요.');}
   else announce('재시도 결과 미확정 · 원문과 요청 ID를 보존했습니다. 서버 상태를 자동 확인합니다.');
  }finally{busy=false;controls();schedule();}
 }
 async function submit(eventId,reuse,captureKey,all){
  if(busy||pending||activeJob())return;
  var value;
  try{value={kind:'job',eventId:eventId,key:captureKey,all:!!all,requestId:newInspectionRequestId()};}catch{announce('보안 난수로 요청 ID를 생성하지 못해 재시도를 보내지 않았습니다. 브라우저를 업데이트한 뒤 다시 확인하세요.');return;}
  try{keep(value);}catch(error){pending=null;announce((error.name==='QuotaExceededError'?'브라우저 저장 공간이 부족합니다.':error.name==='SecurityError'?'브라우저가 사이트 저장을 차단했습니다.':'브라우저에 요청 ID를 저장·재확인하지 못했습니다.')+' 재시도는 보내지 않았습니다. 사이트 저장 설정을 확인하세요. 기존 사이트 데이터는 지우지 마세요.');return;}
  return sendJob();
 }
 select.addEventListener('change',function(){cursorStack=[''];history.replaceChildren();return load('');});
 dialog.addEventListener('cancel',function(e){e.preventDefault();clearTimeout(pollTimer);dialog.close();opener?.focus();});
 document.addEventListener('click',function(e){var target=e.target.closest('[data-action="capture-review-open"]');if(!target)return;opener=target;dialog.showModal();refresh.focus();refreshAll();});
})();
