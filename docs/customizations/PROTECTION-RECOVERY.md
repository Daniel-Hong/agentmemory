# Memory protection recovery — 개발 구현, 운영 미적용

2026-10-21. 기존 file-backed background control과 5초 memory guard 안에서만 회복한다. 새 job, LLM 호출, 공급자 설정, 서비스 재시작, 외부 알림은 추가하지 않는다. Investment 작업은 재개하지 않는다. 임계값은 합성 시험으로 동작을 검증한 보수적인 정책값이며, 운영 부하에서 안전을 실측했다는 뜻은 아니다.

## 영속 중지와 API 호환

기존 `mem:background-control:v1` / `manual-pause` 키에 version2 레코드를 쓴다. `paused`, `resumePending`을 유지하고 `holds`와 `recovery:{attempts,nextAttemptAt}`을 추가한다. hold는 `manual`, `deployment`, `memory`, `legacy_unknown`, `storage_error`의 고정 enum이며 동시 원인을 보존한다. snapshot은 고정 원인/숫자/기존 정제 진단만 표시한다. 사용자 ID, 원문, namespace/키, raw 요청값은 추가로 보존하거나 화면에 출력하지 않는다. 이는 전체 이벤트 감사 이력이 아니라 현재 영속 중지 사유와 유한 시도 예산이다.

기존 version 없는 `paused:true`는 `legacy_unknown`으로 해석한다. version2의 잘못된 hold/예산/paused 조합은 초기화를 거부한다. `resumePending:true`는 원인과 관계없이 `storage_error`를 추가하고 admission을 닫는다. 따라서 강제 종료 후 memory-only로 추정해 자동 재개하지 않는다. 정상 종료를 인증한 memory-only pause는 재시작 후 새로운 120초 안정 확인을 거쳐 회복할 수 있다. 레거시 데이터는 다음 제어 전환/인증된 정상 종료 때 version2로 기록한다.

내부 `change(action,{source,canResume})`의 source는 `manual|deployment|memory`다. source 생략은 항상 manual이다. HTTP POST는 기존 `{action:'pause'|'resume'}`와 명시적 `{action,reason:'deployment'}`만 받는다. HTTP에 `memory`, 사용자 정의 source, 추가 필드를 보내면400이다. 인증 및 Viewer 요청 마커 검증은 유지한다. 기존 고정 root kit의 action-only pause를 deployment로 추정하지 않는다. 공개된 kit/runtime/helper/policy는 변경하지 않았으며 새 deployment adapter 도입은 별도 관리자 검토가 필요하다.

사람의 resume은 manual/legacy_unknown/storage_error를 저장 인증 후 해제하고 자동 회복 예산을 초기화한다. memory/deployment는 유지한다. 따라서 memory 보호나 배포 hold가 남으면202여도 백그라운드는 paused이며 응답의 holds를 확인해야 한다. deployment resume은 deployment만 해제한다. memory resume은 memory만 있으며 상태가 paused이고 예산/신선도 검사를 통과했을 때만 가능하다. 자동 경로는 다른 hold를 지우지 않는다.

## 정확한 회복 정책

- high: `MemAvailable < max(2 GiB,total×20%)`; critical: `< max(0.5 GiB,total×5%)`. 경계와 같으면 해당 하위 경고가 아니다. 기존 API 제한도 유지한다.
- 회복 표본: 가용 메모리가 `max(3 GiB,total×25%)`보다 **엄격히 커야** 한다. 경계와 같으면 안정 구간을 다시 센다.
- 표본 읽기는 유한 정상 수치와 가용량 범위를 검증한다. 읽기 동안10초 초과, 이전 표본과10초 초과 간격, clock 역행, 표본 실패, 회복 경계 이하이면 연속 안정 구간을 초기화한다. 정확히10초는 허용한다. 표본이 돌아오지 않으면 admission을 열지 않는다.
- 매5초 기존 poll을 재사용한다. 연속120초 이상 정상 후, resume 준비 전·전체 저장 인증 후·최종 activation 키 인증 후마다 새 표본을 읽는다. 저장 인증 대기 중에도5초 표본 갱신은 계속되며, 실제 표본 간격이10초를 넘거나 읽기 실패/압력 재악화가 있으면 다시120초 안정 확인이 필요하다. 새 정상 표본 없이 강제로 resume하지 않는다.
- 자동 시도는 activation 전에 영속 레코드에 먼저 반영한다. 시도 후 다음 허용 시각은 각각60/120/240초 뒤다. 안정 확인과 backoff 양쪽을 만족해야 한다. 현재 시각이 다음 허용 시각과 같으면 허용한다.
- 시도 상한은3이다. 성공·실패·짧은 재정지·정상 종료·재시작은 예산을 초기화하지 않는다. 여기서 예산 기간은 **마지막 명시적 manual resume 확인 이후 전체 기간**이다. 장시간 정상 뒤에도 임의 시간으로 초기화하지 않는다. 상한에서는 사람의 확인이 필요하며, manual resume이 예산을0으로 초기화해도 memory hold는 남아 정상 안정 확인을 다시 통과해야 한다.
- 저장 실패는 storage_error로 보류한다. 자동 회복은 저장 오류를 재시도해 지우지 않는다. 사람이 resume해도 전체 저장 인증 실패 시 admission이 닫힌다.

## 직렬화·저장 경계

모든 전환은 기존 단일 changes queue를 거친다. pause 요청은 queue 대기 전에 hold 추가·revision 증가·admission 닫기를 동기적으로 수행한다. resume은 호출 순간 revision을 캡처하여 queue 진입 전 같은 실행 차례에 도착한 최신 pause도 보존한다. 진행 중인 resume은 저장 대기 전후 revision과 fresh sample을 확인한다. manual pause가 auto resume과 겹치거나 high가 돌아오면 activation을 paused로 되돌리고 인증한다. pause는 기존 작업 단위와 lifecycle drain을 기다리고 full-dirty fence를 통과한 뒤 완료한다. 같은 high poll마다 정상 paused 레코드를 다시 쓰지 않는다. 표본 읽기와 저장 전환의 Promise 수명을 분리하여 긴 pause/resume 저장 대기 중에도 critical 요청 차단 상태를 갱신한다. 대기 중인 자동 resume과 pause는 각각 하나만 유지하고, pause 호출 자체는 동기적으로 revision을 무효화한다. 겹친 표본은 호출 순서가 최신인 결과만 상태에 반영하여 늦게 끝난 이전 정상 표본이 새로운 critical을 덮지 못하게 한다. `refresh()`는 표본 처리까지만 기다리며 `drain()`/`stop()`은 대기 중인 제어 전환까지 기다린다. stop 이후 fresh 검사로 admission을 다시 열지 않는다.

running boot/activation의 `resumePending:true` crash guard를 유지한다. pause도 drain 및 full fence와 pause 레코드 인증 전까지 guard를 지우지 않는다. `commitCleanShutdown`은 기존 active/transition 검사와 외부 전체 디스크 인증 전제를 유지하고 남아 있는 holds를 보존한다. 불완전한 종료는 자동 회복 근거가 아니다.

## 표시·검증·후속 기준

Viewer는 현재 메모리 정상 여부와 유지 중인 hold를 따로 보여주며 안정 확인, backoff, 횟수 제한, 표본 실패를 고정 문구로 표시한다. 수동 재개가 memory/deployment hold를 해제하지 않는다는 문구를 표시한다. 외부 알림은 전부 별도 승인·목적지 선택 전까지 보류한다.

개발 검증은 fake clock, 합성 메모리 표본, mock store로 수행한다. `test/operations-protection-recovery.test.ts`는 경계/equality, 정상 지속, clock 역행/간격, clean/unclean 재시작, 중첩 hold, full fence/최종 activation 중 manual pause와 high 재발, 저장 쓰기·검증 실패, 예산·backoff·수동 reset을 검사한다. 기존 background-control crash guard/rollback/clean shutdown 검사도 유지한다. `test/viewer-operations.test.ts`는 현재 정상 메모리와 과거 보호 사유의 분리 및 알 수 없는 raw 원인 미표시를 검사한다.

실행 로그: 작업 폴더 `evidence/recovery-red.log`, `recovery-ui-sample-red.log`, `recovery-restored-pause-red.log`, `recovery-green.log`. 이전 focused run은5파일83시험 통과했다. 이후 sampling 분리 회귀는 `evidence/recovery-sampling-red.log`, `recovery-sampling-boundary-red.log`에서 실제 실패를 확인하고, 긴 full fence 중 critical 갱신/503, 동시 refresh·단일 시도, drain/stop, 안정 구간 재설정, 구표본 순서 역전 보존을 추가 검사한다. 최종 통합 결과는 부모 검증 기록을 기준으로 한다. sandbox Chromium3시험은 socket `Operation not permitted`로 실행하지 못했으며 `recovery-browser-sandbox.log`에 보존했다. 전체 build/skills/docs/suite 및 독립 리뷰는 부모 작업의 최종 통합 검증 항목이다. 어떤 운영 적용이나 배포도 하지 않았다. 장기기억 저장도 별도 수동 검토 전 보류다.

상위 구현으로 대체하려면 기존 영속 paused/resumePending 및 version2 hold/예산 호환, 같은 crash/shutdown 인증, 동일 concurrency/신선도/재시작 수락 시험을 먼저 통과해야 한다. 기존 사유와 예산을 지우는 rollback은 허용하지 않는다. 기존 daniel.11은 version2 holds/recovery를 읽지 않고 레코드를 다시 써 메타데이터를 잃을 수 있으므로 단순 코드 downgrade를 호환 rollback으로 취급하지 않는다. 향후 rollback 후보는 version2를 이해하면서 자동 회복만 끈 별도 검증 빌드 또는 수동 검토한 bridge여야 하며, 운영 적용 전에 별도 검토·승인한다.
