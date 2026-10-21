# 동시 readback 공유 — 개발 사본

이 문서는 최초 공유 구현의 기록이다. 운영 .14 후속 singleton 최적화와 변경된 late-join 조건은 [SINGLETON-HEALTH-REFRESH.md](SINGLETON-HEALTH-REFRESH.md)를 참조한다.

현재 운영 .13은 변경하지 않는다. 사용자가 승인한 동시 readback 공유 수정·합성 비교에 한정한다. 기존 .13의 whole-file parser/negative mismatch reuse 및 backfill enqueueBatch를 유지하며, 전역 LLM 직렬화·입력 예산·poll100ms·capture동시성4·요청별15초 기한·스케줄링·저장 형식을 바꾸지 않는다. 개인 기억이나 원문·운영 설정을 시험에 사용하지 않는다.

## 구현

fence마다 `createSharedNamespaceReader`를 하나 둔다. 같은 경로의 pending 요청은 다음 microtask에서 읽기 시작 전에 선택 키를 합친다. timed batching은 없다. 시작 후 키집합은 고정이며 그 부분집합 요청만 참여한다. scanner의 chunk/check 옵션이 다르거나 entry callback이 있는 요청은 공유하지 않는다. 새 선택 키가 필요한 늦은 요청은 독립 읽기를 한다.

전체 JSON prefix의 문법·중복 키·UTF8·미선택 값·시작/주기/최종 opened-handle 및 현재 path signature를 검증한 한 결과를 동시에 기다린 요청들에 전달한다. 완료 메타데이터가 들어오면 참여를 즉시 닫고 완료 결과를 이후 인증에 캐시하지 않는다. 각 인증은 기존 expected 비교·recapture/revision 조건부 정리·file fsync·directory fsync·최종 full signature/deadline 검사를 각각 수행한다. 공유 결과만으로 성공하지 않는다.

요청별 기존 abort 타이머는 그대로다. 먼저 만료한 요청만 중단하며, 다른 live waiter가 있으면 실제 읽기는 계속한다. 마지막 waiter가 떠나면 실제 scan을 abort하고 새 요청의 참여를 막는다. 작업은 실제 reader close까지 추적하며 fence.drain이 잔여 실제 읽기도 기다린다. 계측 콜백의 동기 throw/비동기 rejection은 읽기 결과를 바꾸지 않는다.

## 한도와 메모리

공유 작업8개, 작업당 live waiter8개·선택 키200개·선택값 JSON과 키의 UTF8 직렬화 합4MiB다. reader가 이미 가지고 있는 엔트리 JSON에서 byte 수를 집계하고 선택값을 JSON.parse/보관하기 전에 한도를 검사한다. 넘으면 공유 시도를 종료하고 각 요청이 원래 남은 기한 안에서 baseline reader로 다시 읽는다. 이로 인한 추가 prefix 순회가 있을 수 있다. active shared job 한도는 abort 후 실제 정리 중인 작업도 포함한다.

이 수치는 공유 projection/metadata의 한도이며 전체 heap/RSS나 baseline fallback의 동시성 상한이 아니다. JS 객체 overhead, 엔트리 텍스트·decoder buffer·중복 key Set·이미 capture한 기대값 및 원래 reader의 transient 메모리는 별개다. 전체 파일 Map을 새로 보관하거나 성공 캐시를 만들지 않는다. 큰 선택값·비호환·비중첩 요청은 이득이 작거나 fallback 비용이 있다.

## 지표

health의 기존 storageDurability snapshot에 원문 없는 readSharing 카운터가 추가된다. requests/sharedRequests/startedReads/completeReads/scanBytes/directFallbacks/projectionFallbacks 및 active/peak/고정 limits만 노출한다. 경로·scope·key·값·사용자 ID는 노출하지 않는다.

각 인증 sample의 sharedReads는 공유에 참여한 횟수다. 실제 onRead는 최초 요청에 한 번만 귀속한다. 그 요청이 먼저 끝났다면 해당 sample의 scans/bytes에는 후발 실제 완료 비용이 들어가지 않을 수 있다. 따라서 실제 parser work는 fence aggregate readSharing 카운터를 기준으로 보고, per-request 합계를 비용의 완전한 총계로 사용하지 않는다. bytes는 물리 장치 IO가 아닌 JSON prefix parser bytes다.

## 시험 및 운영 판단

RED: 같은 namespace의 동시 두 인증에서 기존 reader 호출2회가 관측되어1회 기대가 실패했다. 추가 RED에서 서로 다른 scanner 옵션·완료 직후 참여·비동기 observer 실패·잔여 reader drain을 검출한 뒤 최소 수정했다. 합성 테스트는 pending union/started subset/miss·완료 후 재읽기·owner/follower abort·전원 취소·job/waiter/key/projection 한도·잘못된 값·corrupt fallback·per-request fsync·final replacement·revision 보존·서로 다른 deadline을 다룬다.

합성 비교 실행: `node benchmark/durability-sharing.mjs <baseline-source-root> 2 <output.json>`. baseline은 운영 .13에 포함된 bc6133c의 reader/fence/measurement 세 파일을 격리 추출한 것이다(.13 릴리스 커밋은 버전/docs 동기화이며 해당 세 파일은 같다). 약220MB 임시 JSON은 스트리밍 생성하고 자동 정리한다. 두 구현을 별도 Node 자식 프로세스에서 실행하고 회차별 순서를 바꾼다. 중첩2/5요청·비중첩3요청·시작 후 비호환 키·파일 교체·기대값 불일치의 parse bytes/scans/wall/CPU/peak RSS/timeout/share hit를 기록한다. 기본 실행 환경에서 Node 자식이 출력 없이0으로 종료해 유효한 결과가 없었고, 승인된 호스트 합성 실행에서만 결과를 수집했다.

완료된 비교 수치와 전체 검증 근거는 후속 결과 기록을 참조한다. 합성 fixture·page cache·다른 운영 부하가 실제 220MB namespace의 데이터 구조와 같지 않다. 단회/소수 회차 결과로 운영 timeout 해결이나 속도 향상을 보장하지 않는다. 이 구현의 운영 배포·재시작은 별도 승인 대상이다.

적용 전에는 최신 .13 baseline 및 사용자 변경, kit/activation·데이터 보존·호환 복구 경로를 다시 확인하고 깨끗한 릴리스로 검증한다. rollback은 호환 상태를 보존하는 코드 전환이며 데이터 되감기/삭제가 아니다. upstream에 같은 정확성·기한·취소·메모리/호환 공유 시험을 통과하는 대체가 생기면 이 커스텀을 제거한다. 장기 기억 저장은 별도 수동 검토 대기다.

## 최종 합성 비교 (2026-10-21)

고정 최종 소스와 .13에 동일한 baseline 세 파일의 SHA256을 대조했다. fixture220,021,379B, SHA256 `4ee5daf29d5559a9d4fba519ca300d2c5609fa169a98c4d5ee08954a6501c61c`. 최종 고정본1회/시나리오이며, 종료 정리 보완 전의 별도2회 비교도 중첩/비중첩 경향이 같았다. 최종 수치를 통계적 성능 보장으로 취급하지 않는다.

| 합성 사례 | .13→공유 wall초 | 실제 scan 수 | parser MB | timeout 수 | 공유 참여/요청 |
|---|---:|---:|---:|---:|---:|
| 동시2 |5.027→2.588|2→1|440.04→220.02|0→0|1/2|
| 동시5 |12.673→2.650|5→1|1100.11→220.02|0→0|4/5|
| 동시8 stress |15.007→2.609|8→1|1297.35→220.02|8→0|7/8|
| 순차3 |7.718→7.641|3→3|660.06→660.06|0→0|0/3|
| 시작 후 다른 키 |5.128→5.175|2→2|440.04→440.04|0→0|0/2|
| 읽기 중 파일 교체 |0.228→0.205|4→3|8.39→6.29|0→0|1/2|
| 변하지 않는 기대값 불일치2 |15.001→15.001|2→1|440.04→220.02|2→2|1/2|

8요청 stress는 운영 관측의 최대5개 인증 구간 겹침보다 높은 합성 부하다. 운영 동시 parser 수나 timeout 해결을 입증하지 않는다. 파일 교체는100ms 후 작은 합성 파일로 교체하므로 무효 파일 거절·재읽기 시험이며220MB 지속 writer 모형이 아니다. 변경 시점에 따라 조기 중단 바이트가 달라질 수 있고, 파서 바이트 감소를 보장하지 않는다. 공유 참여율은 admission 비율이며 실제 운영 적중률을 알 수 없다. 시작 뒤 서로 다른 키가 도착하면 이득이 없고 소폭 overhead가 있을 수 있다.

이 fixture의 최종 peakRSS는 중첩2/5/8에서 .13약97.0/103.7/104.9MiB, 공유93.0/91.6/94.3MiB였다. 순차에서는97.4→98.2MiB로 조금 늘었다. 선택값은 작은 합성 정수이므로 큰 관측 값·고카디널리티·최대 projection의 메모리 한도를 검증한 수치가 아니다. 해당 한도/overflow 정확성은 별도 작은 fixture와 mock으로 검증했다. 모든 최종 공유 사례의 activeReads/activeWaiters/sharedJobs는 drain 후0이고 기타 오류는 없었다. 불일치를 성공 처리하거나 deadline을 늘리지 않았다.

작업 폴더 `combined-release/sharing-synthetic-final-results.json`, `sharing-final-comparison.json`, `sharing-baseline-source-match.json`에 재현 입력·소스해시·CPU/RSS·cleanup 및 수치 근거를 보존한다. 이 경로의 증거는 개발 기록이며 운영 후보 등록/승인을 대신하지 않는다.

## 최종 검증과 검토

2026-10-21, Node22.23.3/Ubuntu. 실제 임시 HOME과 기본 fork pool에서 build → skills:gen → docs:sync → skills:check → 전체 npm test → docs:check를 순서대로 실행해 모두 exit0이었다. 전체314파일/3224시험 통과, 기존2파일/4시험 skip이며 새28시험을 포함한다. 별도 reader/fence 관련13파일123시험도 통과했다. 정확한 단계와 로그는 작업 폴더 `combined-release/sharing-final-checks.json`, `sharing-final-*.log`에 있다. Node20 및 다른 OS의 실행 검증은 하지 않았다.

독립 리뷰에서 projection overflow 후 fallback을 시작하는 microtask 사이에 drain이 일찍 끝날 수 있음을 지적했다. 실패 시험으로 재현한 뒤 전체 pending read 요청과 실제 read·job 수명을 함께 추적해 수정했다. observer의 async rejection 격리와 종료 후 late 비용 계측도 추가 검증했다. 최종 읽기 전용 재검토에서 잔여 중요 문제가 없었다. 초기 독립 실행17시험도 통과했으며, 최종 전체시험의 fresh 실행 결과는 위 기록이다.

원본 source의 기존 사용자 변경3파일은 그대로이며 개발 사본만 커밋한다. 운영 .13·후보 등록·activation·서비스 재시작·메모리 데이터 및 Investment 상태는 이번 구현에서 건드리지 않았다. 앞으로 운영 적용하려면 이 코드와 생성 문서를 최신 운영 기준에 통합해 새 버전/깨끗한 후보로 검증하고, 해당 적용·재시작을 별도 승인받아야 한다. 지금 합성 결과로 운영 인수 완료 또는 실운영 성능 개선을 주장하지 않는다.
