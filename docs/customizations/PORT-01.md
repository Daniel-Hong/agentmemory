# 첫 이식 단위: 수집 원문 보존

승인된 전체 이식 순서는 원문·증분 처리 → 저장·종료 → 수집 훅 → 공급자·보류·복구 → 조회·Viewer → 제보함이다. 이 문서는 첫 단계 안의 원문 보존 단위다. 증분 커서와 작업 스케줄러는 뒤따르는 단위이며 여기서 완료로 표시하지 않는다.

근거는 순정 v0.9.30(8bf0c827aaaada297896b2b6efe2a64651ae9389)과 기존 reviewed-source archive(SHA256 72c827fa1d6772b6993c324a9385e06a33e8e9d7c0da81de6fd06c0469e8ac21)다. 설치된 배포 코드를 복사하지 않는다.

## Global Constraints

- 설계를 임의 변경하지 않는다. 원문·기존 판단·기억·제보 이력을 보존한다.
- 운영 적용·운영 데이터 접근·기억 자동 저장·Ollama 및 백그라운드 재개를 하지 않는다.
- 순정의 기본 수집/압축/색인 흐름을 재사용한다. 배경 압축으로의 전환은 worker 이식 때 수행한다. 현 단계에서 스케줄러·공급자·Viewer·전역 잠금을 끌어오지 않는다.
- 일반 목록·검색·stream 응답에는 sourceRaw와 syntheticCompression을 넣지 않는다. 명시적 export/replay는 원문을 보존한다.
- 신규 저장소/의존성/DB를 추가하지 않는다. 원래의 source 길이/전송 예산을 유지하고 source 축약이 원문 삭제로 이어지지 않도록 한다.
- 실제 build·전체 단위 테스트·기존 28개 타입 진단 비교를 수행한다. 운영/대규모 복구 검증은 후속 단계다.

### Task 1: 원문 보존 계약 이식

1. 기존 source, observe, compress, replay, export/import, privacy 호출부를 확인한다.
2. 기존 테스트 fixture로 원문 길이 초과·압축 성공/실패·재압축·조회 제외·export/import/replay·전송 예산 소진 회귀를 추가하고 순정에서 실패를 확인한다.
3. CompressedObservation의 sourceRaw/syntheticCompression 필드와 필요한 수집·압축·projection/budget 변경만 이식한다. syntheticCompression은 기존 참조를 그대로 보존한다.
4. 새 회귀 통과 및 전체 테스트/빌드/스킬/타입 기준선 비교를 확인한다. 필요한 생성물은 공식 빌드/문서 생성 명령으로 갱신한다.
5. 변경 이력·순정 대체 조건·미검증 경계를 기록하고 독립 리뷰를 받는다. 검증된 변경만 기능 단위로 커밋한다.

## Review Focus

보존 원문이 요약/stream 응답으로 새는지, 기존 원문이 다른 raw 입력으로 교체되는지, source 예산 소진 시 원문이 삭제되는지, 압축 실패 전에 원문을 잃는지, import/replay가 실제 원문 꼬리를 보존하는지 확인한다. 큰 세션의 KV frame 한계는 후속 bounded reader/durability 이식 전 남아 있음을 명시한다.

## 순정 대체 조건

후속 upstream이 같은 수집 원문 보존·재압축 불변·일반 응답 제외·export/import/replay 회귀를 통과하면 대응 커스텀을 순정으로 대체한다. 버전 번호나 유사 필드 존재만으로 대체하지 않는다.

## 구현 및 검증 기록

2026-10-19, 운영 미적용. 기존 승인 이식 순서를 변경하지 않고 첫 단계 안의 원문 보존을 독립 단위로 구성했다. 비용/한계: 이 중간 브랜치는 배포 후보가 아니며 증분 커서·작업 스케줄러·대규모 KV 조회·실제 디스크 durability가 뒤따라야 한다.

- 제품 변경: types, observe, compress, observation-source, observation-source-budget, replay. 기존 함수와 projection을 재사용했고 의존성·DB·background timer를 추가하지 않았다.
- TDD: 최초 보존 회귀 4개를 순정에서 실패 확인 후 통과시켰다. 기존 이미지 fixture는 sourceRaw를 읽도록 수정했고, 원문 중복 개수 assertion은 실제 보존 assertion으로 바꿨다.
- 독립 읽기 전용 리뷰: JSONL 입력의 원문 꼬리 손실, 구형 root RawObservation 재압축 시 교체, replay 보존 상태 오표시를 발견했다. 마지막 항목도 데이터 보존 판단에 영향을 주므로 중요 보완으로 취급했다. 세 문제를 4개 회귀 사례로 재현 후 한 번의 보완으로 통과시켰다. 구형 source-only import의 truncation 표시는 별도 fixture로 계속 검증한다.
- 최종 build exit 0. 공식 skills:gen/docs:sync/skills:check 사용. TypeScript 진단은 기존 28개와 파일·진단 코드·메시지 기준으로 동일하며 신규 진단은 없다. 타입 검사 전체 통과를 뜻하지 않는다.
- 운영 데이터·실제 모델·실제 데몬의 integration은 실행하지 않았다. 기존 관측/기억 삭제·덮어쓰기·자동 장기기억 저장은 수행하지 않았다. 장기기억 기록은 별도 수동 검토 대기다.

최종 전체 단위 테스트는 2,601 passed / 0 failed / 4 skipped, exit 0이다. 4개 skip은 기존의 opt-in 실제 데몬/모델 시험이며 새 skip을 추가하지 않았다. 스킬 생성·문서 동기화·스킬 검사도 모두 exit 0이다. 문서/배지의 테스트 수 갱신은 공식 docs:sync가 생성했다. 커밋과 상세 산출물 해시는 프로젝트 검증 영수증에 기록한다.

후속 작업은 증분 완료 ID/sourceOffsets/segments와 실패 복구 계약의 이식이며, 이 단위를 전체 커스텀 이식 완료로 취급하지 않는다.
