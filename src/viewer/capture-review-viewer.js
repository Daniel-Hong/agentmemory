(function(){
 'use strict';
 var key='agentmemory-capture-review-pending',busy=false,pending=null,opener=null,nextCursor=null,rows=[],cursorStack=[''],historyOffsets={};
 try{var saved=JSON.parse(localStorage.getItem(key)||'null');if(saved&&typeof saved.eventId==='string'&&/^[a-f0-9-]{36}$/.test(saved.requestId))pending=saved;}catch{}
 function el(tag,text,attrs){var node=document.createElement(tag);if(text!==undefined)node.textContent=text;Object.entries(attrs||{}).forEach(function(a){node.setAttribute(a[0],a[1]);});return node;}
 function button(text,id,fn){var node=el('button',text,{type:'button',class:'btn',id:id});node.addEventListener('click',fn);return node;}
 var dialog=el('dialog',undefined,{id:'capture-review-dialog','aria-labelledby':'capture-review-heading'});
 dialog.style.cssText='width:min(850px,calc(100vw - 24px));max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);box-sizing:border-box;overflow:auto;background:var(--bg,#171923);color:var(--ink,#eee);border:1px solid var(--border,#777);padding:16px;overflow-wrap:anywhere';
 var message=el('p','수집 격리 기록을 조회하세요.',{id:'capture-review-message',role:'status','aria-live':'polite'});
 message.style.cssText='position:sticky;top:0;z-index:1;background:var(--bg,#171923);padding:10px 0;white-space:pre-line';
 var summary=el('p'),list=el('div'),history=el('div');
 var select=el('select',undefined,{id:'capture-review-status','aria-label':'수집 기록 상태'});
 [['dead','격리됨'],['retrying','자동 재시도 대기'],['completed','복구 이력']].forEach(function(v){select.append(el('option',v[1],{value:v[0]}));});
 var refresh=button('상태 새로고침','capture-review-refresh',function(){return load(cursorStack[cursorStack.length-1]);});
 var previous=button('이전 목록','capture-review-previous',function(){if(cursorStack.length>1){cursorStack.pop();return load(cursorStack[cursorStack.length-1]);}});
 var next=button('다음 목록','capture-review-next',function(){if(nextCursor){cursorStack.push(nextCursor);return load(nextCursor);}});
 var sameRequest=button('같은 요청 결과 확인·재요청','capture-review-same-request',function(){if(pending)return submit(pending.eventId,true,pending.key);});
 var close=button('닫기','capture-review-close',function(){dialog.close();opener?.focus();});
 dialog.append(el('h2','수집 격리·복구 이력',{id:'capture-review-heading'}),message,el('p','저장 전에 실패한 수집 기록입니다. 요약·압축·그래프 격리와 별도로 집계합니다. 원인을 해결한 뒤 한 항목씩 재시도하세요. 원문과 이전 실패 이력은 보존합니다.'),select,refresh,summary,list,previous,next,sameRequest,history,close);
 document.body.append(dialog);
 var codes={SESSION_OBSERVATION_LIMIT:'세션 관측 한도 초과',OBSERVATION_NOT_STORED:'응답은 받았으나 실제 저장 미확인',CAPTURE_STORE_TIMEOUT:'저장 시간 초과',CAPTURE_STORE_FAILED:'수집 저장 실패 · 원인 점검 필요'};
 function announce(text){message.textContent=text;dialog.scrollTop=0;}
 function controls(){sameRequest.disabled=busy||!pending;previous.disabled=busy||cursorStack.length<2;next.disabled=busy||!nextCursor;select.disabled=busy;refresh.disabled=busy;list.querySelectorAll('[data-action="capture-review-retry-one"]').forEach(function(b){b.disabled=busy||!!pending||b.getAttribute('data-state')!=='dead';});}
 async function api(path,method,body){var controller=new AbortController(),timer=setTimeout(function(){controller.abort();},15000);var headers=method?{'Content-Type':'application/json'}:{};
  var token=typeof getViewerToken==='function'?getViewerToken():'';if(token)headers.Authorization='Bearer '+token;
  try{var response=await fetch((typeof REST==='string'?REST:'')+'/agentmemory/capture'+path,{method:method||'GET',headers:headers,body:body?JSON.stringify(body):undefined,signal:controller.signal});if(response.status===401&&typeof showViewerAuthPrompt==='function')showViewerAuthPrompt();var data=await response.json();if(!response.ok){var err=Error('조회 실패');err.status=response.status;throw err;}return data;}finally{clearTimeout(timer);}
 }
 function clearPending(){pending=null;try{localStorage.removeItem(key);}catch{}}
 function render(){list.replaceChildren();rows.forEach(function(row){var card=el('article');card.style.cssText='border:1px solid var(--border,#777);padding:12px;margin:12px 0;overflow-wrap:anywhere';var review=row.review||{};
  card.append(el('h3',(row.project||'프로젝트 미확인')+' · '+(row.status==='completed'?'저장 확인 완료':row.status==='dead'?'수집 격리':'재시도 대기')),el('p','세션: '+row.sessionId),el('p','이벤트: '+row.eventId),el('p',codes[row.errorCode||review.lastFailureCode]||'이전 실패 사유 확인 필요'),el('p','누적 시도 '+row.attempts+'회 · 수동 재시도 '+(review.manualRetries||0)+'회'),el('p','접수 '+row.acceptedAt+' · 갱신 '+row.updatedAt),el('p','내용 미리보기(최대 500자): '+(row.preview||'없음')));
  if(review.recoveredAt)card.append(el('p','저장 확인: '+review.recoveredAt+' · '+row.observationId));
  var retry=button('이 항목 재시도','capture-retry-'+row.eventId,function(){return submit(row.eventId,false,row.key);});retry.setAttribute('data-action','capture-review-retry-one');retry.setAttribute('data-state',row.status);
  card.append(retry,button('실패 이력 보기','capture-history-'+row.eventId,function(){historyOffsets[row.key]=0;return showHistory(row.eventId,row.key);}));list.append(card);
 });if(!rows.length)list.append(el('p','선택한 상태의 수집 기록이 없습니다.'));controls();}
 async function showHistory(eventId,key){try{var page=await api('?review=true&eventId='+encodeURIComponent(eventId)+(key?'&key='+encodeURIComponent(key):'')+'&historyOffset='+(historyOffsets[key]||0));var row=page.items?.find(function(x){return x.eventId===eventId;});history.replaceChildren(el('h3','실패 이력 · '+eventId));(row?.failures||[]).forEach(function(f){history.append(el('p',f.at+' · 누적 시도 '+f.attempt+' · '+(codes[f.code]||f.code)+(f.legacy?' · 기존 기록에서 확인된 마지막 실패':'')));});if(!row?.failures?.length)history.append(el('p','추가 실패 이력 없음 · 기존 시도 횟수와 마지막 오류는 목록에 유지됩니다.'));if(row?.nextHistoryOffset!==null&&row?.nextHistoryOffset!==undefined)history.append(button('다음 실패 이력','capture-history-next',function(){historyOffsets[key]=row.nextHistoryOffset;return showHistory(eventId,key);}));}catch{announce('실패 이력을 조회하지 못했습니다. 원문이나 이력을 삭제하지 않았습니다.');}}
 async function reconcile(){if(!pending)return;var p=pending;var page=await api('?review=true&eventId='+encodeURIComponent(p.eventId)+(p.key?'&key='+encodeURIComponent(p.key):''));var row=page.items?.find(function(x){return x.eventId===p.eventId;});var req=row?.review?.lastRequest;
  if(req?.requestId===p.requestId&&req.finishedAt){announce(req.outcome==='recovered'?'실제 저장 확인 완료 · '+p.eventId:req.outcome==='dead'?'다시 격리됨 · 원인을 확인하세요. 이전 실패 이력은 유지됩니다.':'재시도 예약 · 저장은 아직 완료되지 않았습니다.');clearPending();}
  else announce('이전 재시도 결과 미확정 · '+p.requestId+'\n새 요청을 만들지 않고 같은 요청 결과만 확인합니다.');
 }
 async function load(cursor){try{var page=await api('?review=true&status='+select.value+'&limit=25'+(cursor?'&cursor='+encodeURIComponent(cursor):''));rows=page.items||[];nextCursor=page.nextCursor||null;var cap=page.capture?.inbox;summary.textContent='선택 상태 '+page.total+'건'+(cap?' · 수집 격리 '+cap.dead+'건 · 자동 재시도 '+cap.retrying+'건':'');render();await reconcile();if(!pending)controls();}
  catch{announce(pending?'이전 재시도 결과 미확정 · 연결을 확인한 뒤 같은 요청 결과를 조회하세요.':'수집 목록 조회 실패 · 비어 있다고 판정하지 않습니다.');}finally{controls();}}
 async function submit(eventId,reuse,captureKey){if(busy||pending&&!reuse)return;if(!reuse){try{pending={eventId:eventId,key:captureKey,requestId:crypto.randomUUID()};localStorage.setItem(key,JSON.stringify(pending));}catch{pending=null;announce('요청 ID를 보존할 수 없어 재시도를 보내지 않았습니다.');return;}}
  busy=true;controls();announce('선택 항목 재시도 요청 중 · '+pending.eventId+'\n실제 저장 결과를 확인하고 있습니다. 다시 누르지 않아도 됩니다.');
  try{var result=await api('/retry','POST',pending);var event=pending.eventId;if(result.recovered>0){announce('실제 저장 확인 완료 · '+event);clearPending();}else if(result.dead>0){announce('다시 격리됨 · 원인을 확인하세요. 이전 실패 이력은 유지됩니다.');clearPending();}else{announce('재시도 결과 미확정 · 같은 요청 ID를 보존했습니다.');}await load(cursorStack[cursorStack.length-1]);}
  catch(error){if(error.status>=400&&error.status<500&&!reuse){clearPending();announce('재시도 요청 거부('+error.status+') · 인증과 항목 상태를 확인하세요.');}else announce('재시도 결과 미확정 · 원문과 요청 ID를 보존했습니다. 새 요청 대신 상태 새로고침으로 확인하세요.');}
  finally{busy=false;controls();}}
 select.addEventListener('change',function(){cursorStack=[''];history.replaceChildren();return load('');});
 dialog.addEventListener('cancel',function(e){e.preventDefault();dialog.close();opener?.focus();});
 document.addEventListener('click',function(e){var target=e.target.closest('[data-action="capture-review-open"]');if(!target)return;opener=target;dialog.showModal();refresh.focus();load('');});
})();
