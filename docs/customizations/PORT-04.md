# PORT-04: capture 훅 인계와 공급자 연결

기준 personal d9cef86, 승인 archive SHA256 72c827fa1d6772b6993c324a9385e06a33e8e9d7c0da81de6fd06c0469e8ac21. FORK-HANDOFF/CUSTOMIZATION-CATALOG 계약의 다음 증분 단위다. 운영 미적용.

## Global Constraints
운영 서버/클라이언트 설정·서비스·데이터·기억 변경 금지. 기존 원문/outbox/receipt/retry 이력 유지. 중앙 서버와 참여 Codex 환경별 훅을 구분한다. 인증값·원문은 저장소/로그에 넣지 않는다. 순정 top-level hook은 보존하고 compat artifact는 별도 경로에 생성한다.

## Task 1: 훅과 인계
승인된 9개 compat wrapper/client 및 빌더 이식. 유효한 observation receipt와 fsync된 관리 spool 인계 전에 legacy outbox를 삭제하지 않는다. requireReceipt 레코드는 expiry/용량 eviction 금지. 실패·malformed ACK·이미지·privacy·시간 제한 회귀를 먼저 실패 확인한다. session-end의 이벤트 식별자 유지. PORT-03 종료 admission/shouldStop 보존.
Expected: focused capture/compat 테스트 통과. 빌드는 공식 hook 이후 별도 compat artifact와 hash manifest를 생성하고 순정 wrapper를 덮어쓰지 않는다.

## Task 2: 서버 공급자 연결
명시적 native Ollama opt-in에서만 /api/chat 사용. 현행 증분 요약 JSON grammar, 그 외 현행 XML 계약 유지. 인증 헤더 미전달, 안전한 오류·출력 잘림 처리. readiness는 version/tags 메타데이터만 점검하고 lifecycle에 등록하며 요약 provider와 연결한다. 정상 종료에서 stop/drain. 순정 OpenAI/Azure/fallback 경로 유지.
Expected: native/disabled/실패/잘림과 readiness 재시도 시험 통과. 실제 모델 호출 금지.

## Task 3: 클라이언트 인수인계와 검증
README와 AI 실행 프롬프트에 환경별 발견·정확한 revision/hash·서버 gate·임시 HOME 테스트·9개 이벤트 한정 병합·기존 사용자 설정/outbox/비밀 보존·코드만 롤백을 명시한다. Linux/Windows/WSL 별 적용을 구분한다. 자동 원격 설치를 추가하지 않는다. 전체 default forks 테스트, build/generators/checks, 기존 타입 28개 비교 및 독립 리뷰 후 기록한다.
Expected: 테스트와 문서 검증 통과; 실제 Windows/Codex dispatch와 운영 연결은 미검증으로 명시한다.

## 경계 판정
비동기 embedding intent는 승인 구현의 saveVerified/publication과 결합되어 있다. 이 단위에 index 저장 전체를 끌어들이지 않고 다음 index-publication 단위에서 함께 이식한다. capture/observe의 동기 embedding 및 maxObservations 정책은 현행 유지하며 이 브랜치는 배포 후보가 아니다. capture 진행 metrics/Viewer 노출도 소비자 이식과 함께 진행한다. 아직 없는 structured compression/graph/reflection JSON 형식을 native provider에 강제하지 않는다. 수동 pause/host pressure도 모든 worker admission 및 control API가 함께 이식될 때 활성화한다. 이는 설계 대체가 아닌 의존성 순서 분할이다.

## Review Focus
legacy ownership 조기 삭제, spool fsync/expiry/eviction, hook deadline와 PreCompact 출력, remote 인증/경로 노출, 순정 hook 덮어쓰기/이중 수집, fallback 및 XML/JSON 소비자 불일치, readiness 등록/stop/drain/실제 추론 없는 probe, AI 업데이트 지시의 운영 승인 gate와 데이터 보호.

## 순정 대체
위 동일 회귀를 upstream이 통과하면 해당 compat/native 분기를 대체하고 기존 outbox 호환/이력을 검증한다. 자동 upstream 설치 금지.

## 독립 리뷰 보완
Critical 1건 및 Important 3건을 수용했다. 관리 레코드의 400/401은 retry로 보존하고 CLI/서버/hook 세 소비자가 ACK 및 retention 성공·보호 플래그를 동일하게 유지한다. retry 파일의 directory fsync 뒤에만 claimed 원본을 제거하며 동기화 실패 시 원본을 남긴다. managed pending/경쟁 중 drainer도 원격 worker 반복 조건에 넣고 단발 child 경쟁을 방지한다. native=true + fallback 조합은 이번 단위에서 명시 오류로 거부하며 native=false fallback은 유지한다. 승인 archive의 결함 보완이며 운영 적용/원문 형식 변경은 없다.

## 최종 검증 및 적용 상태
2026-10-19. 전체 기본 fork 단위 테스트 **2,770 passed / 0 failed / 기존 opt-in 4 skipped**, 실제 임시 부모 HOME 격리. build·build:codex-compat·skills:gen·docs:sync·skills:check·docs:check 통과. 타입 검사 exit2, 기존 28개 유지·신규0. 독립 리뷰 후 52개 집중 회귀 통과 및 전체 재검증 완료. 생성된 두 compat 폴더 각 12개 파일 SHA256과 README 링크 확인. 기존 thread pool 검증을 사용하지 않았다.

기준 커밋 d9cef86 대비 변경이며 최종 personal 커밋·tree와 증거 해시는 외부 PORT-04 영수증에 기록한다. 현재 custom은 0.9.30 기반으로 운영 적용/실제 Windows dispatch/III·Ollama 통합 검증을 완료한 버전이 아니다. 클라이언트 폴더는 후보 생성까지이며 사용자 설정을 변경하지 않았다. changelog 자동 기록, AgentMemory 장기기억은 조회 불가 및 별도 수동 검토 대기(저장하지 않음).
