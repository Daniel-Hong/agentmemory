# 두 번째 이식 단위: 증분 요약·실패 복구

기준은 PORT-01 커밋 02b005c6551dad7113d0d877bc83241cbbbef554 및 기존 reviewed-source archive SHA256 72c827fa1d6772b6993c324a9385e06a33e8e9d7c0da81de6fd06c0469e8ac21이다. 승인된 이식 순서를 변경하지 않는다.

## Global Constraints

- 완료 ID, sourceOffsets, projection snapshots, 기존 segments, 격리/재시도 이력과 sourceRaw를 보존한다. 실패한 호출은 커서를 전진시키지 않는다.
- 같은 입력을 재요약하지 않으며 긴 원문을 좌표로 나눠 처리한다. 재시작 후 같은 좌표에서 이어 간다. 한 기록의 반복 실패가 다른 기록을 영구 정체시키지 않도록 한다.
- 기존 long-session 모듈과 필요한 background-control/provider-readiness 의존성을 이식한다. 의존성 모듈을 가져오는 것과 운영 control/provider API를 활성화하는 것을 구별한다. 새 프레임워크·DB·서비스를 도입하지 않는다.
- 순정 XML 헬퍼를 유지하고 기존 동작의 회귀를 보존한다. 기본 registered 요약 경로는 승인된 증분 JSON 계약으로 전환하되 기존 테스트를 지우거나 skip해서 통과시키지 않는다. 변경된 테스트 계약의 대응 관계를 기록한다.
- 포크 personal에서만 작업한다. 운영 적용·Ollama/백그라운드 재개·데이터 migration·장기기억 자동 저장은 하지 않는다. 테스트는 임시 저장소와 합성 provider를 사용한다.

### Task 1: 증분 요약 계약과 최소 연결

1. 고정 archive 해시를 확인하고 기존 복구 회귀를 먼저 추가한다. 체크포인트 재시작/실패 backoff/완료 범위 연속성/격리 후 다른 기록 진행이 포크에서 실패하는 것을 확인한다.
2. long-session과 두 전이 의존성을 그대로 이식하고 summarize registration을 연결한다. 타입 선언은 필요한 모듈로 한정하며 전역 any 허용을 추가하지 않는다.
3. 기존 XML 헬퍼의 chunk/retry/concurrency 회귀를 유지하고 변경된 registered 경로는 증분 완료/실패/재시도/무공급자 계약으로 검증한다.
4. 원문/구간/완료 ID 불변, 중복 모델 호출 방지, Unicode/escaping 범위, 새 수집과 격리/중단 경계를 검증한다.
5. 공식 build/skills generation/docs sync/skills check/전체 단위 테스트와 기존 타입 진단 비교를 실행한다. 독립 리뷰 발견은 회귀 RED→GREEN으로 보완한다.
6. 변경 이력·순정 대체 조건·미검증 범위를 기록하고 검증한 tree와 동일한 커밋만 personal에 반영한다.

## Review Focus

완료 여부를 observationCount로 추측하지 않는지, 실패와 재시작에서 sourceOffsets/segments/history가 유지되는지, 새 수집·동시 요약에서 체크포인트가 되감기지 않는지, 격리 기록이 다른 기록을 막지 않는지, 모델에 전달되는 범위에 빠짐/중복/Unicode 절단이 없는지, 정지·pause 의존성이 운영 활성화로 오인되지 않는지 확인한다.

## 후속 경계와 순정 대체

실제 대규모 KV 조회·디스크 flush/정상 종료·전체 provider 및 pause 연결은 뒤따르는 단계다. 실제 모델/데몬 검증 전 이 중간 브랜치를 배포하지 않는다. upstream이 같은 완료 ID/원문 좌표/원자적 체크포인트/부분 실패 복구 회귀를 통과하면 대응 커스텀을 순정으로 대체한다. 장기기억 기록은 별도 수동 검토 대기다.

## 구현 판단과 검증 경계

- long-session, background-control, provider-readiness는 고정 archive에서 해시를 확인해 이식했다. control/provider API나 watcher를 등록/시작하지 않았다. 요약 경로의 진단·pause helper 의존성만 연결한다.
- 전역 `declare module '*.mjs'` 대신 long-session의 TypeScript 소비 경계만 선언했다. 이후 TypeScript에서 다른 export를 사용할 때 그 선언도 유지해야 한다. summary의 기존 메타데이터는 optional/unknown으로 보존하고 저장 형식을 재작성하지 않는다.
- 순정의 XML 헬퍼를 유지하며 chunk 크기·동시성·재시도·부분 실패·실패 범위 회귀는 헬퍼를 직접 검증한다. registered 경로의 전체 세션 XML 재생성/즉시 재시도는 승인된 증분 JSON/영속 backoff 계약으로 대체했으며 별도 runtime legacy mode를 만들지 않았다.
- 기존 커스텀의 재격리 갱신이 history 및 최초 metadata를 지우는 문제를 두 경로(출력 오류/입력 metadata 초과)에서 재현해 최소 보완했다. 기존 필드는 유지하고 입력 오류 attempt도 누적한다.
- 독립 리뷰의 Important: 신규 timer handle을 index가 버려 종료 중 작업이 재개될 수 있었다. 반환 handle을 보존하고 종료 초기에 stop/drain하는 최소 연결을 추가했다. 전체 디스크 shutdown 인증을 끝냈다는 의미가 아니다.
- 독립 리뷰의 Minor 보류: 공식 docs:sync는 `.ts`만 세므로 `.mjs`로 이동한 등록을 누락한다. 생성된 iii 함수 수 310은 이 정적 집계의 한계이며 mem::summarize가 사라진 것이 아니다. 카운터 범위 수정은 후속 유지보수에서 처리한다. 숫자를 수작업으로 되돌리지 않았다.
- 타입 검사는 기존 28개 진단을 기준으로 비교한다. summarize 감사 operation 추가 때문에 기존 lease_renew 오류에 출력되는 허용 union 문자열만 달라지며, 해당 오류 자체는 이전과 같다. 다른 진단은 변경하지 않는다.

## 실제 검증 결과

2026-10-19, 운영 미적용. 최초 복구 회귀 2개를 미이식 코드에서 실패 확인한 뒤 통과시켰다. 격리 metadata/history 손실은 입력/출력 두 경로에서 RED→GREEN을 확인했다. 집중 회귀는 25개이며 중복 요청, 동일 입력 재요약 방지, 실패 저장, 공급자 보류, Unicode 범위 연속성, 구형 projection pin, 새 관측 유입 경합, timer/admission 중단과 진행 체크포인트 drain을 포함한다.

최종 전체 단위 테스트는 **2,613 passed / 0 failed / 4 existing opt-in skipped**, exit 0이다. build·skills:gen·docs:sync·skills:check·docs:check 모두 exit 0. TypeScript는 기존 진단 28개 유지, 신규 0개다. 전체 타입 검사 통과로 표현하지 않는다. 기존 13개 요약 테스트의 경계를 XML 헬퍼 호환 11개와 새 등록 검증 2개로 대응시키고, 증분 복구/경합/종료 회귀 12개를 추가했다. 검증을 통과시키기 위한 skip이나 임의 legacy runtime mode는 추가하지 않았다.

독립 읽기 전용 리뷰의 종료 연결 Important는 보완했다. Minor인 `.mjs` 문서 집계 한계는 위와 같이 보류했다. 실제 provider 응답, daemon 재시작·정상 종료 전체 경로, 실제 규모 KV/디스크 원자성은 이 합성 시험으로 증명하지 않는다. 체인지로그는 이 커밋에 포함하며 장기기억은 별도 수동 검토 대기다.
