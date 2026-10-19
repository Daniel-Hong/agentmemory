# 세 번째 이식: 저장 내구성·정상 종료

기준: personal e95a6a906f44433c4227e656c8dfa54582bab3f9, PORT-01/02 및 reviewed-source archive 72c827fa1d6772b6993c324a9385e06a33e8e9d7c0da81de6fd06c0469e8ac21. 상위 명세는 FORK-HANDOFF와 CUSTOMIZATION-CATALOG의 durability/shutdown-cli 계약이다.

## Global Constraints
운영 적용·서비스 재시작·실제 추론·운영 데이터 변경·기억 자동 저장 금지. sourceRaw, 요약 완료 ID/좌표/segments, retry/격리 이력, Lesson, metrics 보존. SDK ACK나 프로세스 종료만으로 디스크 저장을 인증하지 않는다. 필요한 mutation·종료 경계만 연결한다. 기존 배포 묶음 불변.

## Task 1: KV 저장 확인
고정 archive fence/namespace reader를 scoped 선언과 이식하고 StateKV mutation 세 경로에 연결한다. Redis 동작 유지, bounded 조회는 후속이다. 먼저 injected fence 무시 행동을 실패 확인한 뒤 임시 디스크에서 publication, 실패 유지, 삭제/Unicode/경합/dirty generation, freeze, 안전한 진단 및 bounded drain을 검증한다.
Expected: focused tests pass; 실패를 인증하지 않고 최신 dirty generation을 지우지 않는다.

## Task 2: 종료와 호출부
기존 lifecycle/ingress/verified-shutdown 재사용. 등록 전 ingress 설치, 초기화 gate, idempotent shutdown, timer/진행 작업 추적, 마지막 index save 및 drain/freeze/readback 연결. workerReady와 CLI 두 import 호출부 연결, 최신 동일 PID 영수증 확인 전 engine/metadata 정리 금지. capture 내부 종료 admission/drain만 최소 연결한다. 수동 pause/공급자/Viewer는 후속이다. Redis/경로 미설정은 디스크 인증 불가로 실패 처리한다.
Expected: receipt/ingress/init/stop regressions pass; 실패/timeout은 verified=false 및 비정상 종료.

## Task 3: 최종 검증·기록·personal 반영
build, skills generation/docs sync/checks, 전체 단위 테스트 및 기존 28개 type diagnostics 비교. 독립 리뷰의 중요한 발견은 회귀 재현 후 보완한다. 체인지로그·영수증·미검증 범위를 남기고 검증 tree와 동일한 커밋만 personal에 반영한다.
Expected: 신규 테스트 실패 및 타입 진단 0. 실제 daemon/model 시험은 별도 후속, 운영 적용 금지.

## Review Focus
ACK/디스크 혼동, 최신 generation 조기 제거, namespace 변경/손상, 초기화 중 신호, timer/fire-and-forget 지연 쓰기, 신규 외부 진입 차단과 허용된 내부 작업 완료, 실패/오래된 동일 PID receipt, index save 삼킨 오류, Redis/경로 미설정, 원문/이력 보존. 실제 iii/provider 인증은 합성 검증 범위 밖이다.

## 순정 대체
동일 저장/readback·경합·종료 receipt·CLI 보존 회귀를 upstream이 통과하면 대응 커스텀을 대체한다. 저장 형식 migration은 하지 않는다.

## 구현 경계·리뷰 조치

전역 any 선언 대신 소비하는 모듈별 타입 선언을 사용한다. archive의 KV/index 전체를 복사하면 후속 bounded reader/Viewer/provider 계약까지 활성화되므로 현재 mutation/종료 경계만 연결했다. Redis 또는 file path 미설정은 backend를 바꾸거나 경로를 추측하지 않고 인증 불가로 처리한다. 이 중간 브랜치는 운영 전환 대상이 아니다.

독립 리뷰의 Important 3건을 실제 함수 회귀 RED→GREEN으로 보완했다: 동기화 후 동일 내용의 새 inode가 교체되는 경합, 응답 뒤 접근 기록 8개 호출부의 지연 쓰기, 진행 중 health 수집의 drain 누락. 기존 Promise await와 controller drain 및 signature 대조만 추가했다. Minor: snapshot timer callback이 SDK Promise를 return하지 않는 점은 ingress admission이 보호하므로 후속 정리로 남긴다.

실제 iii/provider/OS 신호/재연결/PID 재사용 및 전원 장애 내구성은 합성 파일 시험으로 인증하지 않는다. migration/index publication, 수동 pause/공급자, bounded Viewer는 후속 이식/통합 검증 대상이다. 원문·cursor·segments·retry·Lesson·metrics의 운영 데이터 보존 시험이나 데이터 migration은 실행하지 않았다.

## 검증 실행 사고와 복구

최초 전체 실행에서 baseline과 다르게 threads를 지정하여 2,583 passed / 104 failed / 4 skipped였다. 파일 쓰기 없는 비교 실험은 thread HOME stub이 native homedir에 반영되지 않으며 기본 fork에서는 정상임을 재현했다. 실제 홈에 생성된 adapter 설정 및 백업 14개를 발견했다. 최초 설치/force 백업 순서와 새 디렉터리 생성 시각으로 기존 부재를 확인하고 해시 대조 후 비공개 경로로 가역 이동했다. 기존 Copilot 디렉터리와 다른 설정은 보존했다. 최초 로그/JSON은 홈 설정값이 포함될 수 있어 비공개로 분리하고 공개 검증 묶음에서 제외한다. 최종 실행은 기본 forks 및 실제 임시 부모 HOME을 함께 사용한다. 장기기억은 수동 검토 대기다.

## 최종 검증 결과

전체 단위 테스트 2,690 passed / 0 failed / 4 existing opt-in skipped, exit 0. build·skills:gen·docs:sync·skills:check·docs:check exit 0. 타입 검사 exit 2, 기존 진단 28개 유지, 신규 0. 실제 daemon/model을 실행하지 않았다. 고정 운영 배포 묶음·운영 데이터·기억을 변경하지 않았고 테스트가 생성한 홈 설정 14개는 해시 확인 후 가역 격리하여 원래 부재를 복구했다. 최종 실행 중 재생성 없음. 장기기억 수동 검토 대기.
