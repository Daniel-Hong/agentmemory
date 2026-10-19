# 순정 대체와 포크 전환

현행 기준은 설치 0.9.30이며 최신 릴리스 기능 동등성은 미검증이다. customizations.json의 요구사항·파일·회귀 검사를 순정 후보에서 동일 조건으로 확인한다. 기능·데이터·회귀가 모두 동등하면 replace, 일부 기능만 동등하면 partial, 데이터 비호환/회귀 실패는 retain, 근거 부족은 unverified다. 순정 이름/릴리스 노트만으로 대체하지 않는다.

대체 시 원문·분석·이벤트 파일을 보존하고 조회 경로 또는 검증된 내보내기/호환 reader를 유지한다. 커스텀 제거는 해당 변경만 별도 커밋으로 만들고 운영 확인·영수증을 남긴다. 자동 삭제 도구는 없다.

사용자는 이번 구현·검증 후 저장소 포크 전환을 검토할 예정이다(2026-10-19 후속 지시). 지금 포크/clone/운영 이전은 수행하지 않는다. 전환 시 feedback-*.mjs의 독립 기능과 tests를 TypeScript 소스의 인접 모듈로 옮기며, build_candidate.py의 해시 chunk 패치는 폐기하고 upstream의 등록/Viewer 연결 지점에 최소 변경을 적용한다. 인증·요약·KV 코드는 포크 전환 이유만으로 재작성하지 않는다.

권장 브랜치 구성: 순정 추적 브랜치 + 개인용 최소 변경 브랜치. 기능별 커밋과 동등성 검사를 유지하며 upstream 동기화 후 대체된 커밋을 제거한다. GitHub의 fork upstream 연결/동기화 절차: https://docs.github.com/en/pull-requests/how-tos/work-with-forks/configuring-a-remote-repository-for-a-fork 및 https://docs.github.com/en/pull-requests/how-tos/work-with-forks/syncing-a-fork . 포크는 소스 유지보수를 개선하지만 자동 운영 배포나 데이터 호환성을 보장하지 않는다.

## 소스 포크 적용

실제 파일·시험 목록은 catalog.json, PORT-01..08 문서를 따른다. 최신 upstream 조회를 하지 않았다면 미검증 상태를 유지한다. 동일 이름의 기능만으로 교체하지 않는다. 과거 제보 schemaVersion=1/이벤트/장기기억 검토 표시를 유지한 fixture에서 같은 API/원문/경합·재시작·예산 시험을 통과해야 한다. 제거는 별도 검증된 소스 변경이며 운영 데이터 삭제·이력 migration 권한을 포함하지 않는다.
