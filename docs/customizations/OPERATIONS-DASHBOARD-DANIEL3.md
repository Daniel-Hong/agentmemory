# daniel.3 — 저장 인증·임베딩 복구 및 대시보드 업데이트

2026-10-19. 상태: 구현·격리 검증, 운영 미적용. 기준은 personal의 daniel.2이며 변경된 원문/제보/기억 데이터 스키마는 없다. 기존 순정 구조와 저장·복구·Viewer를 재사용하며 새 의존성을 추가하지 않는다.

## 진단과 최소 변경

화면의 capture stalled/18초 실패는 공급자가 꺼졌다는 설명만으로 해결되지 않는다. 현재 공급자는 ready였으나 hot observation namespace의 저장 인증이 state_namespace_changed로 반복 실패했다. iii 0.22.1의 tmp→rename 쓰기에 맞춰 두 번의 전체 파싱을 한 번의 완전 검증과 fsync 전후 동일 파일 signature 확인으로 줄인다. content 변경/rename/dirty generation 발생 시 인증하지 않고 재시도한다. 읽기 deadline은 AbortSignal로 제한하고 운영 timeout은 늘리지 않는다. 합성 벤치마크 개선은 운영 복구 증명이 아니다.

임베딩 queue는 initialize를 replay 이후 await한 다음 등록하고, 기존 durable retry 항목을 먼저 표시한다. committed 정리는 한 회차 50개 후 retry5개를 처리하여 초기 전체 정리가 실제 작업을 독점하지 않게 한다. pause 중에도 상태를 읽지만 추론하지 않는다. backfill의 선택된 항목은 실패 항목 뒤의 의도까지 영속 인계하며, 전체 한도를 초과한 잔여는 limited로 표시한다. 완료 인증 전 기존 backfill marker를 제거하지 않는다. 기존 벡터15,616개와 retry 이력은 삭제하거나 전역 재등록하지 않는다.

Semantic facts의 provider_unavailable은 과거 실행 실패이다. 현재 공급자가 준비되었으면 retry_pending을 표시하며 과거 오류·시각·facts를 보존한다. 새로운 성공 전에는 성공으로 바꾸지 않는다. Audit351MiB 안내에서도 삭제 명령을 제거했고 파일은 그대로 둔다. session/index check timeout은 부하 해소 이후 운영 인수에서 다시 확인한다.

## 대시보드 업데이트 계약

Viewer footer의 업데이트 버튼은 현재 개인 버전, root 승인 후보의 변경 내용/전체 commit/package SHA256/실제 검증, 작업·phase 이력을 표시한다. 인증 REST는 GET /agentmemory/updates, POST /agentmemory/updates/jobs, GET /agentmemory/updates/jobs/:id이다. POST는 UUID와 candidateId 두 필드, JSON/x-agentmemory-update 및 요청 출처 검사를 요구한다. Viewer proxy는 해당 경로에만 marker를 전달한다.

요청은 사용자 전용 durable ticket으로 먼저 저장한다. 고정 helper는 root 승인 목록의 후보만 별도 systemd 작업으로 실행하며 서버 중지와 독립한다. 실행 코드는 root-owned vault에서 정확한 파일 집합/해시/권한을 다시 확인한다. 관리자 등록은 전체 실행/import/subprocess 의존성 검토를 요구하며 사용자 쓰기 가능한 outputs 코드를 그대로 root 실행 후보로 등록하지 않는다. 처음에는 승인 후보 목록이 비어 있는 것이 정상이다. 다운로드/빌드/등록 자동화나 원격 클라이언트 업데이트는 이번 범위가 아니다.

UUID는 요청 전 localStorage에 보존한다. POST 응답 유실 시 같은 ID로 상태 조회/명시 재시도를 하며, queued만 재dispatch할 수 있다. running/완료/실패는 중복 실행하지 않는다. 서버 미응답은 재시작 대기로 표시하고 유한 회수 재접속한다. 이전 부팅이나 확인된 비실행 unit의 미완료 작업은 interrupted로 남기고 관리자 확인 전 새 작업도 막는다. 자동 재실행·kill·데이터 되감기는 없다. 공개 진행은 고정 phase whitelist와 오류 코드만 포함하고 원문/비밀/백업 경로/프로그램 출력은 private에 둔다.

최초 설치는 scripts/personal-release/install-dashboard-updates.py이며 runner·요청 helper·두 systemd unit·제한 sudoers만 설치한다. 비밀번호를 웹에서 받지 않는다. 설치·등록·복구 절차는 scripts/personal-release/DASHBOARD-UPDATES.md를 따른다. 정상 종료 인증→최신 private 백업→고정 package→설치/전환→시작→데이터/guard→전체 archive read-back 흐름은 기존 배포 거래를 재사용한다. 실패 시 자동 데이터 복원을 하지 않고 점검 지점과 최신 데이터를 보존한다.

## 검증 및 적용 경계

전체2,987 pass/0 fail/기존4 skip, feedback40/0, runner+installer22/0, 실제 격리 CLI/iii8/0. build/compat/docs/skills 통과. 전체 타입 검사는 기존 진단이 남으며 성공으로 보고하지 않는다. API/UI 테스트는 queued/interrupted/권한/중복/복구·안전한 DOM/키보드 등을 포함한다. 실제 Viewer에서 daniel.3 표시와 업데이트 창의 최초 관리자 설정 필요/적용 비활성 상태를 확인했다. 검증 로그·벤치마크·후속 proxy 연결 결과는 outputs/post-deployment-followups-v3/에 보존한다. 독립 리뷰 Critical/Important 잔여 없음.

운영 적용은 별도 고정 후보와 새 배포 묶음으로 진행한다. 원문/sourceRaw/커서/완료 ID/retry/격리/제보/Lesson/metrics/outbox를 보존하고 예전 백업으로 최신 데이터를 덮어쓰지 않는다. 기존 Windows daniel.2 클라이언트 wrapper 해시는 동일성 확인 후 재적용 불필요로 안내하며 미관측 이벤트는 별도로 남긴다. 적용 후 공급자·저장 인증·capture completion 증가·임베딩 committed 증가·잔여 감소·session/index timeout 재발 여부를 관측한 뒤 복구를 판정한다. 운영 검증을 위해 임의 추론/consolidate/전체 queue replay를 실행하지 않는다.

장기기억에는 이번 원인/재발 방지와 이 문서 참조만 별도 수동 검토 후 기록한다. 현재 자동 저장·통합·덮어쓰기는 하지 않았고 기억 반영은 보류다. upstream 동등 구현이 생기면 동일 수락 시험과 데이터 호환성을 확인하여 대응 custom 코드를 제거하며 이력은 남긴다.
