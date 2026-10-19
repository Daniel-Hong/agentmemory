# PORT-08: 개인 제보함과 안전한 관계 검토

상태: 소스 구현·격리 검증. 운영 미적용.

기존 feedback-v1 파일 저장/API/분석·스케줄/증거 이력/Viewer를 source-native 등록으로 옮겼다. 번들 문자열 패치는 사용하지 않는다. AGENTMEMORY_FEEDBACK_DIR 설정 시 활성화하며 배포 경로는 /srv/agentmemory/feedback, 최초 정기 분석은 OFF·기본24시간이다. 원문과 이전 이벤트는 불변이고 장기기억 자동 쓰기는 없다. 실제 제공한 batch/candidate ID·revision만 관계 대상으로 허용하고, 자기 참조/없는 ID/실행 메타데이터/AI의 verified 주장/오래된 revision을 거부한다. batch 밖 후보는 metadata 선별 후 최대10건 상세를 전체100000-byte 입력 예산 안에서만 제공한다. 관계·판단은 append-only이며 마지막 결정으로 예외 목록을 판정한다. 일반 관계는 이력, 충돌/정정 후보는 예외 검토에서 유지/기각/추가근거/보류한다. 자동 연결은 상태 종료나 기억 교체가 아니다. 실제 적용은 고정된 서버 관리 activation 영수증과 같은 candidateHash에 한해 기록한다.

검증 증거는 프로젝트 루트 outputs/deploy-preparation-2026-10-19에 보존한다. 검증 도중의 실패와 수정 이력도 유지하며 최종 판정은 REPORT.md와 최종 실행 결과를 따른다. 순정 v0.9.30 위의 이식이며 최신 upstream 지원 여부는 미검증이다. 대체 판단은 catalog.json의 동일 수락 시험·기존 데이터 읽기 호환성으로 한다. 과거 제보/원문/이력은 커스텀 제거 때도 남긴다.

장기기억: 수동 검토 대기. 저장하지 않았으며 기존 기억을 덮어쓰거나 통합하지 않았다.
