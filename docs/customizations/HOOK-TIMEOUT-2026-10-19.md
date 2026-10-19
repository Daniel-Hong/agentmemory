# 훅 시간초과 조사 및 저장된 관측 재시도 최소 수정

## 상태

2026-10-19, personal 기준 커밋 `443951c7d1f52d2195f52e3d9de1b7f0c638bbdf` 이후의 **로컬 수정·격리 검증**이다. 운영·클라이언트 적용, 서비스 재시작, 설정 변경, 데이터 재처리, 장기기억 저장은 하지 않았다. 기존 배포 후보와 고정 검증 묶음도 변경하지 않았다. 이 변경은 그 후보에 포함되지 않는다.

## 확인한 사실

- 직전 조회에서 livez/health/최신 운영 가이드가 8초 시간초과했다. 이번 조회에서는 각각 약 20~30ms에 응답했다. 따라서 영구적인 접속 불가로 단정하지 않는다.
- 정상 API의 정확한 제목 `AgentMemory 운영 및 유지보수 가이드` 단일 최신본(version 5)을 읽었다. 과거 버전·배포 설명보다 현재 runtime을 우선했다.
- 서비스는 active, PID 5964, 자동 재시작 0회였다. 백그라운드는 paused이지만 원본 수집은 계속된다.
- 10:22:24~10:40:04 UTC를 포함하는 최근 20분 journal 표본 270줄에서 capture retry timeout 193회와 Observation captured 71회를 확인했다. timeout은 `TIMEOUT: invocation timed out after 180000ms`였다. 로그 건수는 서로 다른 제보/기록 수나 데이터 유실 건수가 아니다.
- health의 수집 pending은 1,029, 마지막 완료는 10:10:43 UTC, sweepRunning/stalled=true였다. 10:49:28 UTC 재조회는 HTTP 29ms, pending 1,072, 동일한 마지막 완료와 정체 상태였다. 실제 유실 여부는 확인되지 않았다.
- Worker의 별도 1초 CPU 표본은 한 코어 기준 104.9%였다. 호스트 전체 사용률이나 OOM을 뜻하지 않는다. 운영 관측 namespace 최대 크기는 약 141MB이며, Worker가 해당 크기의 관측 파일을 실제 열고 있었다. 파일 내용은 조회·복사하지 않았다.
- 현재 설치 코드와 소스 모두 `mem::observe`가 세션 잠금 안에서 전체 `kv.list` 후 durable observation ID를 찾았다. file backend의 list는 원문 포함 파일 전체를 파싱한다. 이 구조는 저장 성공 후 ACK 시간초과로 재시도된 기록에도 전체 조회·CPU·잠금 대기를 반복시킨다.
- 합성 2,100개 × 원문 64KiB(약 138MB)의 실제 observation reader 전체 조회 1회는 wall 2,501ms/CPU 2,709ms였다. 비교용 단건 조회는 메모리 fixture이므로 운영 엔진 단건 조회 성능이나 전체 처리량 개선 배율로 해석하지 않는다.

현재 훅 공통 상태 문구는 저장과 리콜을 함께 표시한다. 실제 리콜 호출은 SessionStart/UserPromptSubmit/SubagentStart에 한정된다. 조사한 앱 로그·세션 항목·Codex 로그 DB에서 해당 6초 실패의 정확한 이벤트/마지막 phase는 확보하지 못했다. **전체 조회 증폭은 확인된 결함이지만, 사용자가 본 단일 훅 실패의 유일한 원인으로 인증한 것은 아니다.**

## 최소 수정과 보존 경계

`src/functions/observe.ts`의 동일한 세션 잠금 안에서 durable ID를 먼저 `kv.get`한다. 기존 관측이 있으면 기존 live prompt ledger와 검색/임베딩 색인 복구 경로를 그대로 실행하고 중복 ACK를 반환한다. 기존 관측을 다시 쓰지 않는다. 조회 실패는 absence로 바꾸지 않고 실패로 전달한다.

새 ID 또는 비-durable 이벤트는 기존 전체 조회·세션 상한·source 예산·원문 저장 경로를 유지한다. sourceRaw, summary cursor, retry/quarantine, Lesson, metrics의 삭제/초기화/통합은 없다. 새 namespace, 의존성, 운영 설정은 추가하지 않는다.

## 검증

- TDD: 기존 구현에서 새 회귀 4개 중 3개 실패/1개 통과를 확인했다. 실패는 전체 조회 불가 시 저장된 중복도 실패하는 것과 단건 조회 이전 전체 조회를 실행하는 것이었다.
- 초기 green 실행의 fixture에는 검색 색인이 요구하는 facts/concepts/files가 빠져 2개 실패했다. fixture를 실제 소비 형식에 맞췄다. 제품 코드를 우회하지 않았다.
- 관련 observe/capture/훅 deadline 16파일 **147개 통과/0실패**. 첫 sandbox 실행은 136통과/11실패였으며 실패 기록을 보존했다. 동일 시험을 로컬 HTTP listener가 허용된 임시 HOME 환경에서 다시 실행해 147개 통과했다. 첫 JSON reporter의 오류는 STACK_TRACE_ERROR로 축약돼 있어 실패별 원인을 모두 단정하지 않는다.
- build 성공. `tsc --noEmit`은 기존과 같은 24개 진단으로 exit 2이며 새 진단 0개다. 타입 검사 전체 성공으로 보고하지 않는다.
- 신규 회귀는 tool/prompt의 durable replay, 원문 무변경, 검색 색인 복구, live prompt ledger, 상한에 도달한 기존 기록의 중복 응답, 새 ID의 상한 유지, 단건 조회 오류의 실패 전파를 확인한다.
- 전체 suite 및 실제 운영/Windows 훅은 이번 변경으로 재검증하지 않았다.

증거는 프로젝트 루트 `outputs/hook-timeout-investigation-2026-10-19/`의 REPORT, red/focused/focused-r2, type-comparison, synthetic-scan, health-after 및 해시 표에 있다. 임시 HOME과 합성 데이터만 사용했다.

## 남은 순서

1. 이번 수정은 재시도 경로의 최소 수정으로 리뷰한다. 신규 관측의 전체 조회 비용과 현재 운영 backlog는 해결 완료로 표시하지 않는다.
2. 신규 관측에 필요한 값(기존 ID, 정확한 개수, source 예산)을 원문 전체 로딩 없이 얻을 최소 경로를 설계한다. 기존 observation reader/metadata 재사용부터 검토하며, 원문 삭제·세션 상한 완화·예산 제거로 회피하지 않는다. 설계 명세와 충돌하면 먼저 근거와 최소 대안을 제시한다.
3. 실제 규모 합성 데이터에서 신규 수집과 durable replay가 겹칠 때 latency/동시성/ACK·disk fence/재시작·원문 보존을 검증한다. 기존 훅 deadline과 fsync 전 성공 금지 원칙을 유지한다.
4. 정확한 다음 훅 실패의 이벤트·마지막 phase를 확보한다. 진단 활성화에 운영/클라이언트 설정 변경이 필요하면 구체적 대상·변경을 분리한다. 기존 원문이나 outbox를 진단 로그에 넣지 않는다.
5. 변경이 완성되면 새 배포 후보/해시 표/guard/보존 검증 묶음을 만든다. 고정 v1 후보는 수정하지 않는다. 현재 정상 종료 저장 인증·기존 guard의 preferences 누락·최종 운영 인수 조건을 별도로 해결한 뒤 적용을 판단한다.

장기기억은 별도 수동 검토 대기다. 이 문서와 체인지로그 작성은 remember/evolve 자동 실행을 허용하지 않는다.
