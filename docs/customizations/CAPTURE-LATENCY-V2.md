# 수집 지연·훅 마감 대응 통합 후보 v2

2026-10-19. 사용자 지시: 남은 개선/대응을 끝내 한 번에 배포할 후보로 준비한다. 기존 PORT-01..08 설계와 원문·제보·기억 이력 보존, 수동 장기기억 검토 정책을 유지한다. 이 문서는 운영 적용 승인이 아니다.

## 변경과 경계

1. `mem::observe`는 기존 세션 잠금 안에서 durable ID를 단건 조회한다. 이미 저장된 기록은 기존 prompt ledger/색인 복구 뒤 중복 ACK한다. 원문을 다시 쓰지 않는다.
2. file backend의 신규 관측은 기존 observation reader의 `captureSummary`를 사용한다. 최초 한 번은 namespace를 스트리밍으로 검증하며 저장 키별 ID·요약 JSON byte 수·source byte 수만 유지한다. 원문은 캐시에 남기지 않는다. 이후 성공한 StateKV set/update/delete의 기존 record 경계에서 메타데이터를 갱신한다. 신규 저장소·파일 형식·의존성·timer는 없다. Redis 및 reader 없는 기존 소비자는 원래 경로를 유지한다.
3. 원래 live source 예산 계산의 UTF-8 JSON byte 수, 배열 쉼표, 고정 envelope,8MiB source/15MiB frame/64KiB 여유, source 정규화·축약·생략을 그대로 적용한다. count는 모든 저장 키를 세고, 예산에서는 교체되는 동일 ID만 제외한다. 세션 상한·원문/sourceRaw 보존·import/compress 경로는 유지한다.
4. cold load는 동시 요청이 공유하며 읽는 동안의 성공한 쓰기·삭제를 overlay한다. 읽기 실패는 빈 세션으로 인증하지 않는다. StateKV mutation이 실패해 실제 반영 여부가 불명확하거나 metadata 기록이 실패하면 해당 scope의 budget을 폐기하고 `observation_budget_mutation_uncertain`으로 이후 신규 수집을 차단한다. 기존 기록 replay는 계속 단건 확인할 수 있다. 이 상태를 임의로 초기화하지 않으며 저장 상태를 확인한 정상 재연결/재시작의 새 reader에서 재구성한다. inbox/retry/dead-letter 기록은 기존 정책대로 보존한다.
5. file backend는 기존 단일 StateKV writer 계약을 따른다. 실행 중 외부 프로세스가 namespace 파일을 직접 고치는 것을 지원하지 않는다. 재시작 시 캐시는 버리고 현재 저장 파일과 pending 경계에서 재구성한다. 외부 파일 수정·DB migration을 위한 기능이 아니다.
6. Codex compat hook은 기존 file/directory fsync 완료 후 watchdog에서 retry worker 시작을 최대100ms만 기다린다. 일반 이벤트4.5초/SessionEnd2초의 자체 마감과 호스트6초/3초 제한을 유지한다. worker 시작이 멈춰도 durable outbox를 보존한다. fsync 이전에는 성공 종료하지 않는다. 진단에 event/phase/elapsedMs/durable을 남기며 원문·세션·비밀값은 넣지 않는다. 과거6초실패의 정확한 phase는 사후 복원하지 못했으므로 미확정으로 유지한다.

## 수락·검증

- source 예산을 기존 배열 방식과 byte 단위로 비교한다. Unicode,source 예산 소진,frame 소진,기존 raw/summary/source 보존을 시험한다.
- cold 동시 변경·단일 초기화·실패 후 재조회·실제 저장 키/중복 ID·StateKV set/update/delete·동시 신규 수집/상한·durable replay·모호한 쓰기 실패 차단을 검증한다.
- 실제 HTTP context 서버가 응답하지 않는 경우와 retry worker 시작이 멈춘 경우에도 마감·outbox 보존을 확인한다. POSIX에서 검증한 결과는 Windows 실제 이벤트 인증을 대신하지 않는다.
- 약145MB/2,100개 기록을 128MiB heap 프로세스로 읽고100개 신규 메타데이터 갱신과2,200개 재구성을 검증한다. cold 약2.1초/warm p95 약0.52ms/max RSS 약106MiB는 조회·계산 경로의 실측이며 네트워크·엔진 저장·fsync 처리량을 뜻하지 않는다.
- 별도 임시 HOME/데이터/포트의 실제 CLI/iii로 동시 신규 수집·중복·원문 export·제보/제한 Codex·pause·검증된 정상 종료·재시작을 시험한다. 모델은 합성이며 운영 추론을 실행하지 않는다.
- 최종 전체 suite/build/compat/skills/docs/type 비교/제보 UI·HTTP/guard·archive read-back은 새 통합 후보 영수증에 기록한다. 이전 v1과 조사 묶음을 수정하지 않는다. 실패한 탐색/fixture 시험도 새 증거에 보존한다.

## 배포·유지보수

새 후보는 PORT-01..08과 이 변경을 함께 포함한다. source commit/tree, npm SHA, 동일한 두 검증표, 실제 npm 설치 트리의 guard 및 보존본을 고정한다. 클라이언트별 README/AI 프롬프트를 함께 제공하고 기존 outbox/spool·인증·설정을 유지한다. 서버만 바꿔서는 이미 설치된 클라이언트 watchdog이 갱신되지 않는다.

운영 적용 직전 최신 가이드·현재 서비스/대기·현행 baseline guard를 다시 확인한다. 기존 preferences.json 누락을 오래된 백업으로 복원하거나 guard에서 몰래 제외하지 않는다. baseline 조정 및 정상 종료/최신 데이터 보존은 운영 인수 절차다. 고정 v1을 덮어쓰거나 새 코드에 옛 chunk를 섞지 않는다. rollback은 코드만 되돌리고 최신 원문·제보·커서·retry·Lesson·metrics를 되감지 않는다.

장기기억 후보는 이 문서/체인지로그/최종 커밋 참조와 검증된 단일 writer·예산·deadline 교훈만 별도 수동 검토한다. 자동 remember/evolve/forget은 수행하지 않는다. 순정이 같은 bounded capture·예산 동등성·실패 보존 시험을 통과하면 이 커스텀을 대체한다.
