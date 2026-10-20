# 수집 격리 보존·선택 재시도 — daniel.8

사용자 승인: 실패 원문과 이력을 유지하고 원인 해결 후 선택한 기록만 재시도하며, 실제 저장 확인 뒤 복구 성공으로 표시한다. 운영 변경·재처리는 구현 시험과 구별한다.

## 원인과 변경

운영 .7의 capture dead는 자동 sweep에서 제외됐지만 boot prune의 1000건/168시간 기준에서 삭제될 수 있었다. direct observe의 세션4500 한도가 내구 수집에도 적용돼 원인을 해소하지 않은 재시도가 다시 격리됐다. 기존 격리 UI는 summary/compress/graph만 집계하고 capture dead 상세는 CLI 안내에 그쳤다. 수동 retry는 attempts를0으로 초기화하고 성공 시 inbox를 삭제해 실패 이력과 모호한 요청 추적을 잃었다.

새 코드는 미처리 dead 자동 폐기를 제거하고 내구 captureKey 경로에 한해 세션 수집 한도를 우회한다. 직접 mem::observe 한도와 per-record/페이지 응답 예산·inbox admission 제한은 유지한다. raw/sourceRaw, 기존 ID·설정·벡터·원문·요약 커서는 바꾸지 않는다. 정체 원인을 해결하지 않은 기록은 자동으로 재생하지 않는다.

`mem:capture:review`에는 실패한 이벤트의 안전한 metadata만 기록한다: key/eventId/session/project/접수·갱신 시각, 누적 attempts, 별도 cycleAttempts, 실패 시도별 코드·시각, 수동 requestId·결과, 검증된 observationId/복구 시각. payload를 복제하지 않으며 inbox의 원문은 복구 전까지 보존한다. 완료 history는 inbox 제거/재시작과 별도로 보존한다. 기존 데이터에 과거 상세가 없으면 legacy의 마지막 실패만 표시하고 임의로5회 전체 이력을 만들어내지 않는다. history를 무단 purge/병합하는 기능은 없다.

원본을 삭제하지 않고 기능을 롤백할 수 있으나, 옛 코드 .7의 dead prune은 다시 활성화되므로 rollback 전 보존 대책이 필요하다. 새 scope는 기존 iii KV를 통한 정상 저장으로 생성하고 DB migration/직접 DB 수정은 하지 않는다. 완성된 dedup marker에 대한 기존 retention은 변경하지 않는다.

## 동작과 안전 경계

Health/운영 영역의 ‘수집 격리·복구 이력 보기’에서 격리/자동 재시도/복구 기록을 조회한다. 기존 ‘활성 격리’ 카드는 ‘요약·후처리 격리’로 이름을 명확히 한다. 수집 미완료와 후처리 격리 수를 합산해 고유 원문 수로 표시하지 않는다.

목록은 25건씩, API 최대50건이며 (acceptedAt,key)의 cursor로 이동한다. 기존 capture API/CLI 기본 응답은 호환 유지한다. preview는 최대500자이고 failure detail은50개씩 조회한다. 본문을 HTML로 넣지 않고 textContent를 사용한다. 인증/권한은 기존 REST/Viewer bearer와 proxy 경계를 유지한다.

같은 eventId가 여러 세션에 있어도 key를 포함한 한 항목만 재시도한다. requestId는 canonical UUIDv4이며 결과가 불명확하면 브라우저에 남겨 새 요청을 막는다. 같은 key/requestId는 이미 끝난 결과를 재조회하거나 예약 준비만 이어가고 SDK 호출을 반복하지 않는다. 요청은 등록 후 적용되는 별도 관리자 업데이트와 무관하며 root 권한을 사용하지 않는다.

재시도 실패는 누적 attempts와 failure history를 계속 늘린다. 새 수동 cycle에서만 cycleAttempts를 새로 시작하고 자동 재시도 예산을 적용한다. 서버 응답에 observationId만 있어도 복구로 처리하지 않으며 실제 선택 세션의 저장 row를 확인한다. ID 없는 dedup은 저장 관측을 확인할 수 없으면 원본을 유지한다. prepared intent 저장 후 scheduling 실패, completed history 저장 후 inbox 제거 실패는 같은 요청/기존 sweep로 안전하게 정리하고 원문·누적 횟수·이미 확인된 recoveredAt을 유지한다. 상태 저장 오류는 성공으로 숨기지 않는다.

API: GET /agentmemory/capture?review=true&status=dead|retrying|completed&limit=25&cursor=...; 단일 detail은 eventId와 key 및 historyOffset을 사용한다. POST /agentmemory/capture/retry는 eventId/key/requestId만 whitelist한다. 기존 all:true API는 호환 유지하되 대시보드와 권고에서는 제공하지 않는다. malformed cursor/request/key는 거부한다.

## 실제 검증과 적용

증거 묶음의 각 로그를 참조한다. 기준 .7 suite3057/skip4, 최종 .8 full3076/skip4, 빌드·문서·스킬 검사 및 compatibility13 동일성을 확인했다. 실제 iii와 격리 CLI의 .7→.8 전환에서 한도 오류 재현·선택 복구·원문·이력 재시작 보존 등11개 검사를 통과했다. 타입 진단은 기존24개와 동일한지 별도 비교하며 `tsc` 통과라고 표현하지 않는다. 실제 Chromium 모바일390×844 light/dark·desktop1280×900에서 한 번 클릭/중복 클릭 차단/XSS 미실행/가로 overflow 없음/네트워크 불확실성의 request ID 유지와 저장 확인 시 해제를 검증한다. 합성 KV·임시 HOME·fake network만 사용한다.

변경은 독립 worktree/branch fix/capture-quarantine-recovery에서 이뤄지며 source/personal의 다른 세션 자동 등록 변경을 건드리지 않는다. 최종 commit/bundle/시험 결과와 미확인 항목은 root 결과 REPORT.md를 기준으로 한다. 현재 운영 .7에 이 패치를 적용하거나 실제 dead 재시도/초기화/전역 drain하지 않았다.

별도 후속: 거대한 호스트 outbox 선두(약5.6MB) 인계와 뒤 기록 정체는 클라이언트 문제이며 이 패치가 해결했다고 주장하지 않는다. 13개 compatibility hook이 바뀌지 않으므로 재설치하지 않는다. 기존 실패5회는 개별 eventId/시각을 기록하지 않아 정확한 식별이 불가능하고, partial counterpart 원본만 확인했다. 원문 복구는 키·같은 host identity의 다른 event ID 중복을 먼저 대조하고 명시 대상만 처리해야 한다.

## upstream 대체 기준과 기억

새 upstream에서 미처리 원문 보존, 장기 세션 수집, 실패 이력, 검증된 선택 재시도/불확실 요청 중복 방지가 동등하게 구현되면 같은 회귀 시험과 데이터 호환 증거 후 커스텀을 제거한다. 단순 UI 유사성으로 대체하지 않는다. 운영 사실과 제보 이력은 체인지로그로 보존하고 장기기억은 별도 수동 검토 후 저장한다.
