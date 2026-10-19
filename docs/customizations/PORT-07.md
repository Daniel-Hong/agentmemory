# PORT-07: 백그라운드 제어와 구조화 공급자 소비자

상태: 소스 구현·격리 검증. 운영 미적용.

수동 pause를 디스크 확인 후 확정하고 crash/resume guard와 정상 종료를 연결했다. file durability가 있는 경우에만 영속 pause·host pressure admission을 등록하여 Redis 부팅을 유지한다. Redis의 PORT03 종료 disk 인증 제한은 별개로 남는다. enrichment/graph/feature/snapshot worker의 보류·재시도·stop/drain을 연결했다. native Ollama JSON은 실제 해당 소비자의 prompt/파서와 함께 적용하고 다른 XML 소비자는 유지한다. standalone fallback+native 제한은 유지한다. 프로젝트 슬롯은 명시적 project/scope를 REST/MCP/context까지 전달한다. 소유권 없는 legacy 슬롯은 보존하되 임의 프로젝트에 주입하지 않는다. reflect는 기존 단일 handler에서 conservative lifecycle로 위임한다.

검증 증거는 프로젝트 루트 outputs/deploy-preparation-2026-10-19에 보존한다. 검증 도중의 실패와 수정 이력도 유지하며 최종 판정은 REPORT.md와 최종 실행 결과를 따른다. 순정 v0.9.30 위의 이식이며 최신 upstream 지원 여부는 미검증이다. 대체 판단은 catalog.json의 동일 수락 시험·기존 데이터 읽기 호환성으로 한다. 과거 제보/원문/이력은 커스텀 제거 때도 남긴다.

장기기억: 수동 검토 대기. 저장하지 않았으며 기존 기억을 덮어쓰거나 통합하지 않았다.
