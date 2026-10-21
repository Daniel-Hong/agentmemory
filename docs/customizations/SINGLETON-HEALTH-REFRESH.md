# Singleton readback와 HEALTH 정리 — 개발 전용

운영 `.14`는 변경·재시작·조회하지 않았다. 이 변경은 개인 자료 없이 개발 사본·합성 fixture에서만 구현·시험한다. 배포 후보 등록·운영 적용·기존 작업 재개는 이번 범위가 아니다. 외부 알림과 Investment는 보류한다.

## 읽기 경로와 안전 조건

기존 공유 projection 한도4MiB는 참여자 하나인 읽기에도 적용돼 큰 선택값에서 prefix를 읽다 중단하고 원래 reader로 다시 읽었다. 시작 microtask에서 살아 있는 waiter가 하나면 기존 uncapped 단일 reader로 한 번 읽고, 읽기 시작 전에 `joinable=false`로 닫는다. 살아 있는 그 waiter의 선택 키만 사용한다. pending union Set과 각 waiter의 개인 Set을 분리해 먼저 취소된 owner/follower의 큰 키를 보관하지 않는다.

시작 시 여러 waiter가 있으면 기존 공유 job/waiter/key/직렬화 projection 한도와 overflow fallback은 그대로다. 그 공유 scan에는 기존 started-subset 참여도 유지한다. 단일로 시작한 scan의 늦은 subset은 독립 읽기가 된다. 이는 제한 없는 큰 projection이 여러 요청에 공유되는 것을 막는 보수적인 절충이며, 늦은 작은 요청에서는 읽기량·시간이 늘어난다. 전체 성능 개선으로 일반화하지 않는다.

기대값·revision·각 요청의15초 기한·stream abort·file/directory fsync·최종 full signature 및 deadline 검증·negative mismatch reuse·drain은 바꾸지 않는다. 전체 JSON 문법/중복키/UTF8/미선택 값 검증도 원래 reader가 수행한다. 완료 성공 캐시, 새 timeout, 새 병렬 설정, 저장 형식 변경은 없다. 단일 선택값과 capture된 기대값은 원래 baseline처럼 큰 메모리를 사용할 수 있으며 새로운 전체 RSS 한도를 제공하지 않는다.

RED/GREEN: 5MiB 선택값에서 기존 `startedReads:2/projectionFallbacks:1`을 재현한 뒤 `1/0`을 검증했다. pending 취소의 두 방향에서 취소된 키가 남는 RED를 확인하고 Set 소유권을 분리했다. 독립 리뷰에서 후자 비대칭을 추가 지적해 해결했다. 큰 singleton의 fsync2회, 기대값 불일치 거절, fsync 중 inode 교체 후 재검증과 기존 공유/취소/기한/drain 회귀를 검사한다.

## HEALTH 화면

전체 판정을 위로 올리고 처리 상태·주의할 문제·진행량·조작을 하나의 운영 영역으로 묶는다. 수동/보호/배포/원인불명 정지, 저장 오류, 복구 상태 및 격리 경고는 접힌 전문 지표 안에만 두지 않는다. 엔진/색인/공급자/프로세스 등 누적 전문 카드는 기술 진단 상세로 접는다. 기존 action ID·권한·pause/resume 뜻은 유지하며 새 관리 기능은 추가하지 않는다. 펼침·포커스·기존 route 이동과 모바일 overflow를 합성 실제 Chromium 화면으로 확인한다.

## 웹 업데이트 범위

기존 Viewer의 업데이트 메뉴는 이미 승인 후보 목록 조회→선택→적용→상태/이력을 지원한다. API는 catalog/job 생성/job 조회이며 임의 shell이나 후보 등록 명령을 제공하지 않는다. 서버 관리자 최초 helper/systemd/sudoers 설정과 새 아티팩트 검토·등록은 별도 경계다. 현재 고정 enrollment 정책에서 인정하지 않는 baseline을 UI로 우회할 수 없다. 이번 변경은 이 권한·인증·네트워크·정책을 확장하지 않는다.

최소 후속 UX는 기존 메뉴를 쉽게 찾게 하고, 웹에서 가능한 적용과 관리자 검토가 필요한 등록을 명확히 구분하는 것이다. 목록 재조회는 root `refresh-catalog` 실행과 다르다. 복구 버튼을 일반 downgrade로 만들면 안 된다. v2 hold/복구 예산 보존 및 알려진 recovery-disabled 호환 패키지의 수동 stopped-state 절차를 유지해야 한다. 자세한 공개 코드 조사서는 저장소 밖 `health-refresh-evidence/WEB-UPDATE-SCOPE.md`에 있다.

## 검증 기록

최종 소스 고정 합성 비교와 필수 build/generated/full-suite 검증 결과를 아래에 기록한다. 합성220MB와60MiB 선택값은 실제 운영 구조/부하와 다르며, parser bytes는 물리 장치 IO가 아니다. 실제 timeout 해소·보호 동작·운영 처리량 개선은 이번 개발 시험으로 검증하지 않는다.

### 최종 고정 소스 합성 비교

`node benchmark/durability-singleton.mjs <bee7e99-.14-core> 2 <output.json> <fixed-candidate-root>`로 별도 Node 프로세스·회차별 순서 교대로 실행했다. 최종 후보 core3파일 SHA가 모든 결과 및 현재 소스와 일치함을 검증했다. fixture220,005,004B, 선택값60MiB, 두 회차, 새 LLM/운영 자료0건이다. 시간은 두 회차 평균이며 별도 열에 정확한 논리 읽기량을 둔다.

| 경우 | .14 → 개발 시간 | scan 수 | parser bytes | timeout |
|---|---:|---:|---:|---:|
| 큰 단일1요청 | 2.885 → 2.571초 | 2 → 1 | 282,985,100 → 220,005,004 | 모두0 |
| 큰 비중첩2요청 | 5.704 → 5.953초 | 4 → 2 | 565,970,200 → 440,010,008 | 모두0 |
| 작은 단일1요청 | 2.722 → 2.536초 | 1 → 1 | 220,005,004 → 동일 | 모두0 |
| 큰 동시2요청 | 5.284 → 5.315초 | 3 → 3 | 502,990,104 → 동일 | 모두0 |
| 작은 늦은 subset2요청 | 2.643 → 5.288초 | 1 → 2 | 220,005,004 → 440,010,008 | 모두0 |

큰 단일 평균 user CPU2789.9→2532.5ms, peakRSS415.7→344.9MB였다. 이는 프로세스 전체 최고 RSS로 원래 capture 기대값·런타임 overhead도 포함한다. 두 회차 모두 큰 단일의 불필요한 prefix 읽기는 제거됐으나 비중첩 시간은5.07~6.83초로 변동했고 평균 개선이 없었다. 공유 호스트의 다른 개발 검증과 겹친 시점이 있으며 시간/RSS의 인과 추정을 제한한다. 작은 단일은 같은 논리 work라 시간 차이를 기능 이득으로 해석하지 않는다. 큰 동시 overflow fallback은 의도대로 그대로다. 늦은 작은 subset은 CPU·읽기량이 약2배로 늘어나는 명확한 회귀다. 운영의 낮았던 공유율만으로 모든 향후 부하에서 더 낫다고 보장하지 않는다.

초기 실행에는 작업 중 source hash가 섞여 최종 결과로 사용하지 않았다. 보고 수치는 취소키 수정까지 반영한 고정 사본의 결과이며 `health-refresh-evidence/singleton-synthetic-final.json`, `singleton-comparison.json`에 CPU/RSS/각 회차/한도/소스 해시를 보존했다. raw evidence는 저장소 밖 합성 자료다.

### 배포 판단과 복구

이 커밋은 운영 패키지·kit을 만들거나 등록하지 않는다. 향후 적용 승인 시 현재 .14 및 사용자 변경을 다시 확인하고 최종 소스를 새 버전/깨끗한 패키지로 검증한 뒤 기존 관리자 검토·후보 등록과 승인된 웹 적용 경로를 사용한다. 재시작 시 일시 중단이 있고, 새 릴리스가 시작한 뒤 이전 자동복구 활성 버전으로 무조건 rollback할 수 있다고 보장하지 않는다. 현재 v2 hold/예산·최신 데이터를 보존하는 검토된 recovery-disabled 패키지와 stopped-state 수동 복구 경로를 새 baseline에 맞춰 준비해야 한다. 데이터 되감기·삭제나 수동/배포 hold 해제는 하지 않는다.

실제 비교는 새 부하 없이 기존 작업의 저장 인증 실패·단계 시간·scanBytes/projectionFallbacks/sharedRequests·처리량·메모리 보호 상태를 관측해야 한다. late-subset 증가와 전체 읽기량 악화가 있는지 함께 비교한다. 이번 개발 결과는 운영 timeout 해결이나 데이터 보존의 새 운영 증명이 아니다.

### 최종 검증 및 독립 검토

최종 소스에서 AGENTS 순서대로 `npm run build` → `npm run skills:gen` → `npm run docs:sync` → `npm run skills:check` → `npm test` → `npm run docs:check`가 모두 exit0이었다. 전체315파일 통과·기존2파일 skip, 3245시험 통과·기존4시험 skip이며 새 실패는 없다. 임시 HOME/USERPROFILE과 기본 fork pool로 실행했다. 실제 Chromium을 쓴 HEALTH/operations/security/capture-review 집중검증74시험도 통과했다. 데스크톱1280·모바일390의7상태별 전후28PNG/JSON proof를 보존했다. critical+빈 문제 목록에서 정상 문구를 금지하는 RED/GREEN과 깊은 상세 route/focus/펼침 복원도 확인했다. 새 browser fixture/profile은 finally에서 정리한다.

백엔드와 UI의 독립 읽기 전용 리뷰를 받았고, 취소 key Set alias 문제 및 상태 문구 보완 후 최종 재검토에서 중요 미해결 문제가 없었다. root도 전후 정상 데스크톱·수동/위험 모바일 화면을 직접 확인했다. 최종 검증 로그/JSON은 저장소 밖 `health-refresh-evidence/final-*`, `browser.log`, `independent-ui-review.log`에 있다. 전체 검증에 LLM 호출·운영 조회·부하 생성·설정 변경은 사용하지 않았다. 원본 작업 공간의 기존3개 변경 파일에는 쓰지 않았다. 새 패키지/배포 후보는 아직 없고 운영 .14는 건드리지 않았다.
