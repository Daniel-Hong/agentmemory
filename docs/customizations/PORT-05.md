# PORT-05: 비동기 임베딩·색인 저장 인증

> Agentic worker: superpowers:executing-plans로 inline 실행하고 마지막 독립 리뷰를 수행한다.

Goal: 수집 ACK와 임베딩 추론 대기를 분리하고, 대상 색인이 디스크에서 인증된 뒤에만 retry intent를 완료한다.
Architecture: 승인 archive의 embedding-recovery 및 IndexPersistence.saveVerified를 기존 KV/vector/lifecycle에 연결한다. 대상 ID·세대별 저장 인증을 사용하고 기존 원문·요약·기억을 변경하지 않는다.
Spec: FORK-HANDOFF/CUSTOMIZATION-CATALOG index-publication/capture-embedding-admission, PORT-04의 후속 경계. 기준 personal e4556cc62730f9aa71ad4abab60f0ba00e908206. archive SHA256 72c827fa1d6772b6993c324a9385e06a33e8e9d7c0da81de6fd06c0469e8ac21.

## Global Constraints
운영 적용·재시작·모델 호출·운영 데이터 migration 금지. 합성 KV/파일만 사용한다. sourceRaw/summary cursor/segments/retry/이력/Lesson/metrics 보존. 기존 PORT-03 종료/PORT-04 spool 보호를 유지한다. 신규 의존성 금지. 전체 시험은 실제 임시 부모 HOME과 default forks를 사용한다. 기존 타입 진단28과 신규를 구별한다.

## Task 1: 항목별 저장 인증
- [x] 승인 index-persistence 회귀를 먼저 실행하여 새 저장 인증·migration 보존 실패를 확인한다.
- [x] archive의 scoped saveVerified, 삭제 주소 보존, 200-key bounded fence 및 legacy 교체 인증을 이식한다.
- [x] 저장 오류/불일치/다른 세대/무관 dirty/재시작/합성 migration 회귀를 통과한다.
Expected: 검증 실패는 성공으로 바뀌지 않으며 미확인 legacy snapshot은 보존한다. 실제 데이터 migration은 실행하지 않는다.

## Task 2: durable intent와 capture/복구 연결
- [x] capture가 모델 대신 intent를 저장하고 응답하는 실패 회귀를 실행한다.
- [x] 승인 recovery, search API 및 observe/capture 중복 처리 연결을 이식한다. KV scope와 타입 선언을 추가한다.
- [x] canonical 변경/삭제/재시도·복원/stop-drain 및 실제 worker wiring을 검증한다.
Expected: 실패 intent/inbox 보존, 저장 인증 뒤 완료, 같은 ID 중복 추론 방지, 종료 후 신규 진입 차단. 기존 full-backfill opt-in/auto-compress/session limit 보존.

## Task 3: 검증·기록·포크 반영
- [x] build→compat build→skills/docs 생성·검사→전체 회귀→타입 기준 비교.
- [x] 새 컨텍스트 독립 리뷰1회, 중요한 발견은 RED→GREEN 보완 및 전체 재검증.
- [x] changelog/검증 영수증/남은 범위/기억 수동 검토 상태를 기록하고 검증 tree만 personal에 반영한다. main 보존.
Expected: 신규 실패/타입 진단0. 운영 미적용·실제 통합 검증 대기로 보고하며 별도 승인 체계처럼 표현하지 않는다.

## Review Focus
동일 ID의 canonical 변경·삭제와 publication 경합, 실패한 디스크 인증 뒤 retry 삭제, legacy snapshot 조기 정리, 무관 vector dirty로 반복 추론/잘못된 meta count, 초기화 중 capture/종료 admission, 다른 embedding 공급자를 chat readiness로 막는 문제, 명시 동의 없는 전체 과거 reembedding, auto-compress 호환과 원문 보존. 각 조건은 합성 시험 또는 실제 wiring 회귀로 확인한다.

## 의존성 판정 및 최소 대안
기존 관측 수 제한과 auto-compress의 SDK Void dispatch를 유지한다. 두 경로 모두 먼저 synthetic 검색/intent를 확보하고, Viewer 이벤트 형식은 현재대로 유지한다. feature-lifecycle/enrichment/pause/pressure/Viewer 전체는 후속이다.
승인 archive의 자동 reconcile는 전체 과거 관측을 재임베딩할 수 있다. 기존 backfill opt-in을 유지하기 위해 자동 reconcile는 이 기능의 committed 기록만 대상으로 한다. 기존 gap은 순정 cutoff/opt-in backfill로 처리하며 capture 실패 창은 durable inbox/재전달로 복구한다.
chat readiness는 embedding이 동일 OpenAI-compatible origin일 때만 공유한다. worker는 load/replay 후 설치하고 boot 완료 뒤 timer를 시작한다. 저장 namespace는 변경하지 않으며 새 intent/committed scope만 추가한다. 코드 롤백 시 새 scope·최신 원문을 보존하고 구버전의 자동 cleanup을 수행하지 않는다.

## 순정 대체
같은 capture ACK/원문/실패 intent/항목별 disk fence/삭제·재시작/legacy 보존 회귀를 upstream이 통과하면 대응 커스텀을 대체한다. live 데이터의 destructive contraction은 별도 작업이다.

## 독립 리뷰 후 보완
Important3을 수용했다. file backend는 canonical+intent의 disk fence를 신규/중복 ACK 및 inference 전에 통과해야 한다. committed marker도 디스크 확인 뒤 retry를 제거한다. marker 저장·삭제 뒤 canonical 변경/복원/조회 실패는 retry로 보존한다. 기존 entity/intent lock의 순서를 뒤집지 않는다. 모든 legacy replacement fence 뒤 실제 bucket 행/개수/값/meta를 다시 비교한다. 실제 운영 데이터에 migration을 실행하지 않았다.

최초 전체 시험2797 pass/3 fail/기존4 skip은 최종 성공이 아니다. 기존 즉시 벡터 복원 기대와 multimodal mock을 새 비동기 API에 연결한 뒤 관련38 시험 통과. 독립 리뷰 RED8/40pass→GREEN63. 최종 전체·빌드·타입 결과는 아래에 기록한다.

## 최종 결과와 유지보수 경계
2026-10-19. 전체 테스트 **2810 passed / 0 failed / 기존 opt-in 4 skipped**, 실제 임시 부모 HOME/default forks. build·build:codex-compat·skills:gen·docs:sync·skills:check·docs:check 통과. 타입 검사 exit2, 기존 진단28 유지·신규0. 두 compat 산출물의 각12파일 SHA256 read-back 확인. 원문/요약/기억 회귀와 기존 멀티모달 시험을 유지했다.

file backend의 capture intent·canonical·completion marker에는 실제 파일 fence를 사용한다. 다른 backend는 기존 SDK/readback 계약을 유지하며 POSIX disk durability로 인증했다고 주장하지 않는다. legacy 교체 검증은 합성 파일/KV에서만 수행했다. live III/Ollama/전원 장애/원격 Codex/Windows 시험은 후속 통합 검증 범위다.

변경은 personal 포크에만 반영한다. 운영 서버·클라이언트 설정 미적용이며 별도 승인 시스템을 새로 만든 것이 아니다. 수동 pause/pressure·bounded API/Viewer 전체는 다음 소비자 이식 단위에 남는다. 기존 PORT-04 고정 후보 ZIP을 바꾸거나 새 운영 배포 묶음으로 재명명하지 않는다. 코드 롤백에서도 최신 intent/committed namespace 및 원문·이력을 보존한다. 장기기억은 조회 불가 및 별도 수동 검토 대기, 저장하지 않았다. 최종 commit/tree·증거 해시는 프로젝트 outputs/port-05-embedding-publication/receipt.json에서 확인한다.
