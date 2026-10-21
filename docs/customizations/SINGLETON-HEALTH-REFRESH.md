# Singleton readback와 HEALTH 정리 — 개발 전용

운영 `.14`는 변경·재시작·조회하지 않았다. 이 변경은 개인 자료 없이 개발 사본·합성 fixture에서만 구현·시험한다. 배포 후보 등록·운영 적용·기존 작업 재개는 이번 범위가 아니다. 외부 알림과 Investment는 보류한다.

## 읽기 경로와 안전 조건

기존 공유 projection 한도4MiB는 참여자 하나인 읽기에도 적용돼 큰 선택값에서 prefix를 읽다 중단하고 원래 reader로 다시 읽었다. 최초 초안ee33743은 시작 시 단일이면 공유를 닫아 이 비용을 없앴으나 늦은 작은 subset의 scan이1→2로 늘었다. 이 초안을 그대로 권장하지 않고 다음 최소 수정으로 보완했다.

시작 시 단일 waiter의 개인 키만 선택하되 scan은 공유 한도 안에서 계속 joinable이다. `readNamespaceEntries`가 선택 JSON+키 직렬화 합4MiB를 넘는 엔트리를 보관하기 전에 선택적 `allowProjectionOverflow` 정책을 호출한다. coordinator는 **live waiter가 정확히 하나이며 전체 job 키가 그 waiter의 개인 키에 포함될 때만**, 먼저 `joinable=false`로 동기적으로 닫고 true를 반환한다. reader는 같은 FD/stream에서 그 단일 요청의 원래 baseline projection을 이어간다. false/정책 실패/취소는 성공으로 바꾸지 않으며, 정책 반환 뒤 abort를 확인한다. 추가 장기 캐시나 파일 재열기는 없다.

따라서 작은 projection의 늦은 subset은 기존처럼 한 scan을 공유한다. 이미 큰 단일 projection으로 전환한 뒤 도착한 요청은 독립 읽기를 한다. 여러 waiter가 있거나 시작 후 취소된 참여자의 추가 키가 job에 남았다면 초과를 허용하지 않고 기존 overflow fallback을 수행한다. 공유 job/waiter/key/projection 한도를 올리지 않는다. pending union Set과 각 waiter의 개인 Set은 분리한다. 완료 결과는 새 인증에 캐시하지 않는다.

기대값·revision·각 요청의15초 기한·stream abort·file/directory fsync·최종 full signature 및 deadline 검증·negative mismatch reuse·drain은 바꾸지 않는다. 전체 JSON 문법/중복키/UTF8/미선택 값 검증도 유지한다. 단일 projection과 capture 기대값의 메모리는 원래 baseline과 같고 새 전체 RSS 한도를 제공하지 않는다. 정책 콜백은 키/값/본문을 받지 않고 기존 내부 읽기 옵션에만 있으며 REST/관리자 권한과 무관하다.

RED/GREEN: 큰 singleton2→1회 scan, 시작한 singleton의 늦은 subset2→1회 scan, 정책 반환/실패와 취소를 실패 시험으로 확인한 뒤 최소 수정했다. pending 취소양방향, 실제 oversized 경계 뒤 late follower 분리, 취소된 추가 키가 남은 경우 제한 유지, corrupt 미선택 값, invalid정책, 큰 값의 fsync/기대값 불일치/교체 재검증 및 기존 공유·기한·drain 회귀를 검사했다.

## HEALTH 화면

전체 판정을 위로 올리고 처리 상태·주의할 문제·진행량·조작을 하나의 운영 영역으로 묶는다. 수동/보호/배포/원인불명 정지, 저장 오류, 복구 상태 및 격리 경고는 접힌 전문 지표 안에만 두지 않는다. 엔진/색인/공급자/프로세스 등 누적 전문 카드는 기술 진단 상세로 접는다. 기존 action ID·권한·pause/resume 뜻은 유지하며 새 관리 기능은 추가하지 않는다. 펼침·포커스·기존 route 이동과 모바일 overflow를 합성 실제 Chromium 화면으로 확인한다.

## 웹 업데이트 범위 — 새 후보 등록 제외

사용자 최신 지시로 웹 후보 등록의 설계·조사·구현을 중단했다. 기존 SSH 관리자 검토·등록 방식과 권한 경계를 유지한다. 이미 등록된 승인 후보를 적용하는 기존 Viewer 메뉴/API는 삭제하거나 의미를 바꾸지 않는다. 이번 소스 변경에는 업데이트·등록·인증·네트워크·root 정책 변경이 없다.

## 검증 기록

최종 소스 고정 합성 비교와 필수 build/generated/full-suite 검증 결과를 아래에 기록한다. 합성220MB와60MiB 선택값은 실제 운영 구조/부하와 다르며, parser bytes는 물리 장치 IO가 아니다. 실제 timeout 해소·보호 동작·운영 처리량 개선은 이번 개발 시험으로 검증하지 않는다.

### 폐기한 시작 시 차단 초안의 합성 비교 (ee33743)

`node benchmark/durability-singleton.mjs <bee7e99-.14-core> 2 <output.json> <fixed-candidate-root>`로 별도 Node 프로세스·회차별 순서 교대로 실행했다. 당시 초안 core3파일 SHA가 각 결과와 당시 소스에 일치함을 검증했다. fixture220,005,004B, 선택값60MiB, 두 회차, 새 LLM/운영 자료0건이다. 시간은 두 회차 평균이며 별도 열에 정확한 논리 읽기량을 둔다.

| 경우 | .14 → 개발 시간 | scan 수 | parser bytes | timeout |
|---|---:|---:|---:|---:|
| 큰 단일1요청 | 2.885 → 2.571초 | 2 → 1 | 282,985,100 → 220,005,004 | 모두0 |
| 큰 비중첩2요청 | 5.704 → 5.953초 | 4 → 2 | 565,970,200 → 440,010,008 | 모두0 |
| 작은 단일1요청 | 2.722 → 2.536초 | 1 → 1 | 220,005,004 → 동일 | 모두0 |
| 큰 동시2요청 | 5.284 → 5.315초 | 3 → 3 | 502,990,104 → 동일 | 모두0 |
| 작은 늦은 subset2요청 | 2.643 → 5.288초 | 1 → 2 | 220,005,004 → 440,010,008 | 모두0 |

큰 단일 평균 user CPU2789.9→2532.5ms, peakRSS415.7→344.9MB였다. 이는 프로세스 전체 최고 RSS로 원래 capture 기대값·런타임 overhead도 포함한다. 두 회차 모두 큰 단일의 불필요한 prefix 읽기는 제거됐으나 비중첩 시간은5.07~6.83초로 변동했고 평균 개선이 없었다. 공유 호스트의 다른 개발 검증과 겹친 시점이 있으며 시간/RSS의 인과 추정을 제한한다. 작은 단일은 같은 논리 work라 시간 차이를 기능 이득으로 해석하지 않는다. 큰 동시 overflow fallback은 의도대로 그대로다. 늦은 작은 subset은 CPU·읽기량이 약2배로 늘어나는 명확한 회귀다. 운영의 낮았던 공유율만으로 모든 향후 부하에서 더 낫다고 보장하지 않는다.

초기 실행에는 작업 중 source hash가 섞여 최종 결과로 사용하지 않았다. 이 절의 과거 수치는 취소키 수정까지 반영한 당시 초안 고정 사본의 결과이며 `health-refresh-evidence/singleton-synthetic-final.json`, `singleton-comparison.json`에 CPU/RSS/각 회차/한도/소스 해시를 보존했다. raw evidence는 저장소 밖 합성 자료다.

### 배포 판단과 복구

이 커밋은 운영 패키지·kit을 만들거나 등록하지 않는다. 향후 적용 승인 시 현재 .14 및 사용자 변경을 다시 확인하고 최종 소스를 새 버전/깨끗한 패키지로 검증한 뒤 기존 관리자 검토·후보 등록과 승인된 웹 적용 경로를 사용한다. 재시작 시 일시 중단이 있고, 새 릴리스가 시작한 뒤 이전 자동복구 활성 버전으로 무조건 rollback할 수 있다고 보장하지 않는다. 현재 v2 hold/예산·최신 데이터를 보존하는 검토된 recovery-disabled 패키지와 stopped-state 수동 복구 경로를 새 baseline에 맞춰 준비해야 한다. 데이터 되감기·삭제나 수동/배포 hold 해제는 하지 않는다.

실제 비교는 새 부하 없이 기존 작업의 저장 인증 실패·단계 시간·scanBytes/projectionFallbacks/sharedRequests·처리량·메모리 보호 상태를 관측해야 한다. late-subset 증가와 전체 읽기량 악화가 있는지 함께 비교한다. 이번 개발 결과는 운영 timeout 해결이나 데이터 보존의 새 운영 증명이 아니다.

### 초안 검증 및 독립 검토 (ee33743)

초안ee33743 소스에서 AGENTS 순서대로 `npm run build` → `npm run skills:gen` → `npm run docs:sync` → `npm run skills:check` → `npm test` → `npm run docs:check`가 모두 exit0이었다. 전체315파일 통과·기존2파일 skip, 3245시험 통과·기존4시험 skip이며 새 실패는 없다. 임시 HOME/USERPROFILE과 기본 fork pool로 실행했다. 실제 Chromium을 쓴 HEALTH/operations/security/capture-review 집중검증74시험도 통과했다. 데스크톱1280·모바일390의7상태별 전후28PNG/JSON proof를 보존했다. critical+빈 문제 목록에서 정상 문구를 금지하는 RED/GREEN과 깊은 상세 route/focus/펼침 복원도 확인했다. 새 browser fixture/profile은 finally에서 정리한다.

백엔드와 UI의 독립 읽기 전용 리뷰를 받았고, 취소 key Set alias 문제 및 상태 문구 보완 후 최종 재검토에서 중요 미해결 문제가 없었다. root도 전후 정상 데스크톱·수동/위험 모바일 화면을 직접 확인했다. 최종 검증 로그/JSON은 저장소 밖 `health-refresh-evidence/final-*`, `browser.log`, `independent-ui-review.log`에 있다. 전체 검증에 LLM 호출·운영 조회·부하 생성·설정 변경은 사용하지 않았다. 원본 작업 공간의 기존3개 변경 파일에는 쓰지 않았다. 새 패키지/배포 후보는 아직 없고 운영 .14는 건드리지 않았다.

### 한도 경계 전환 보완 — 최종 합성 비교

동일220,005,004B fixture/60MiB선택값을 최종 고정 후보와 bee7e99(.14 core)에서 두 회차·실행순서 교대로 비교했다. 모든 후보 source hash가 현재 core와 일치한다. benchmark 중 별도 build/full-suite는 실행하지 않았다. 값과 시간은 합성 자료이며 물리 IO·운영 속도를 의미하지 않는다.

| 경우 | .14 → 최종 개발 평균 시간 | scan 수 | parser bytes | timeout |
|---|---:|---:|---:|---:|
| 큰 단일1요청 | 2.899 → 2.659초 | 2 → 1 | 282,985,100 → 220,005,004 | 모두0 |
| 큰 비중첩2요청 | 5.717 → 5.219초 | 4 → 2 | 565,970,200 → 440,010,008 | 모두0 |
| 작은 단일1요청 | 2.560 → 2.570초 | 1 → 1 | 220,005,004 → 220,005,004 | 모두0 |
| 큰 동시2요청 | 5.302 → 5.227초 | 3 → 3 | 502,990,104 → 502,990,104 | 모두0 |
| 작은 늦은 subset2요청 | 2.544 → 2.519초 | 1 → 1 | 220,005,004 → 220,005,004 | 모두0 |

초안의 늦은 subset1→2 scan 회귀는 두 회차 모두1scan으로 해소했다. 큰 singleton2→1, 비중첩4→2의 불필요한 읽기 제거와 양립한다. 공유되는 큰 projection은 기존3scan fallback을 유지한다. 두 회차 모든32개 인증이 성공했고 timeout/기타오류0건이었다. 이는 timeout 상황을 재현하거나 운영 문제를 해결했다는 증거가 아니다. 한도 초과 뒤에 도착한 follower는 여전히 독립 읽기다. 작은 단일/늦은 subset은 기존과 논리 work가 같으므로 작은 시간 차이를 기능 이득으로 해석하지 않는다. sourceHashes·CPU·peakRSS·각 회차 근거는 저장소 밖 `refined-singleton-synthetic.json`/`refined-singleton-comparison.json`에 있다.

독립 읽기 전용 재리뷰는 동기 admission닫기와 callback await 사이 경합, livewaiter/키소유권, multiwaiter/취소추가키 한도, abort·signature·fsync·drain 유지 여부를 검토하고 중요 미해결 문제를 찾지 못했다. HEALTH 소스는 ee33743 이후 바꾸지 않았다. 데스크톱·모바일 전후4PNG를 합성 화면임을 명시한 Library 이미지로 준비했고 영수증/다운로드 주소는 저장소 밖 `health-refresh-evidence/delivery/attachments.json`에 보존했다. 웹 후보 등록은 최신 지시로 제외했으며 기존 SSH 등록과 승인후보 웹 적용을 유지했다.

### 보완 후 최종 검증

최종 고정 소스 합성 비교 후 별도로 AGENTS 필수 순서 build → skills:gen → docs:sync → skills:check → npm test → docs:check를 모두 exit0으로 완료했다. 임시 HOME/USERPROFILE·기본 fork pool에서315파일 통과/기존2파일 skip, **3252시험 통과/기존4시험 skip**이며 실패0건이다. 관련 reader/fence 집중42시험도 통과했다. 로그와 각 단계 exit/시간은 저장소 밖 `health-refresh-evidence/refined-final-*`에 있다. HEALTH·등록·관리자 경계는 변경하지 않았고 운영 .14/API/서비스/데이터를 사용하지 않았다. 별도 운영 검증·배포 승인은 여전히 필요하다.
