# PORT-06: 제한된 조회와 운영 Viewer

상태: 소스 구현·격리 검증. 운영 미적용.

Observation/Audit의 file namespace metadata 색인·선택 키 조회·4MiB 응답 예산과 미반영 쓰기 overlay를 연결했다. Redis는 file reader를 사용하지 않는다. Audit legacy 삭제 전에 복사·canonical read-back·항목별 disk fence를 수행한다. CPU capacity 대비 사용률, 실제 heap 한도, capture stall·readiness·재시도·스냅샷 상태를 표시한다. Viewer는 동일 origin read-only WebSocket, 기존 polling 복구와 단독 장애 분리를 유지한다. synthetic/LLM 결과를 모두 private source 제거 후 publish한다.

검증 증거는 프로젝트 루트 outputs/deploy-preparation-2026-10-19에 보존한다. 검증 도중의 실패와 수정 이력도 유지하며 최종 판정은 REPORT.md와 최종 실행 결과를 따른다. 순정 v0.9.30 위의 이식이며 최신 upstream 지원 여부는 미검증이다. 대체 판단은 catalog.json의 동일 수락 시험·기존 데이터 읽기 호환성으로 한다. 과거 제보/원문/이력은 커스텀 제거 때도 남긴다.

장기기억: 수동 검토 대기. 저장하지 않았으며 기존 기억을 덮어쓰거나 통합하지 않았다.
