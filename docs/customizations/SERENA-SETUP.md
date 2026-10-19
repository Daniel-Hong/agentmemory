# Serena 분석 설정 및 다음 capture 적용 범위

2026-10-19. 제품 동작·운영 설정·운영 데이터·AgentMemory 장기기억을 변경하지 않는다.

## 분석 설정

공식 Serena 프로젝트 루트는 상위 AgentMemory 디렉터리다. 로컬 .serena/project.yml의 LSP workspace를 source로 한정하고 outputs/upgrades를 제외한다. 프로젝트 기억 7개는 source 체크아웃, 검증 명령, 실제 TypeScript LSP와 역할 분담을 반영한다. 이 로컬 프로젝트 설정/기억은 포크 clone만으로 다른 머신에 자동 설치되지 않는다.

source/src/ops/jsconfig.json은 allowJs=true, checkJs=false, noEmit=true로 기존 .mjs 모듈의 편집기 분석 프로젝트를 제공한다. parent tsconfig나 제품 소스/타입 검사 범위를 바꾸지 않는다. 도입 전 readNamespaceEntries 구현의 참조 결과가 비었지만 도입 후 state-durability.mjs의 import/호출을 조회했다. TypeScript 소비자는 기존 .d.mts 선언으로 연결하므로 타입 선언을 기준으로 조회한다. 구현 심벌의 빈 참조를 미사용 판정으로 사용하지 않는다.

새 프로세스에서 591개 파일 색인 및 health-check 통과, 전역 verifiedShutdown 검색에 과거 upgrades 구현이 제외됨을 확인했다. 현재 장기 실행 MCP 연결은 시작 시 읽은 프로젝트 설정을 캐시하므로 재연결 전 전역 검색은 이전 범위를 쓸 수 있다. 현재 연결의 live JS 참조는 이미 복구됐지만 workspace 완전 적용과 구별한다. 재연결 전에는 relative_path=source/...를 명시한다. 사용 가능한 도구에는 MCP 연결 재시작 기능이 없어 파일 저장만으로 현재 세션 재설정을 완료했다고 주장하지 않는다.

Serena는 심벌/참조/편집, Superpowers는 계획/TDD/리뷰/검증을 담당한다. Serena rename 성공이나 검증 생략 안내가 프로젝트의 테스트/빌드 의무를 대체하지 않는다. AgentMemory 운영 기억 본문을 Serena로 복제하지 않는다.

검증: 실제 MCP .mjs 참조 조회, 독립 fresh-session 전역 검색/참조, index 591파일, health-check, memories check 모두 성공. 제품 build exit 0, tsc exit 2/기존28/신규0. 편집기 설정만 변경하여 전체 제품 테스트는 재실행하지 않았다. 이전 PORT-03 전체 시험 결과를 이번 실행 결과로 재기재하지 않는다.

## capture/훅·공급자의 적용 위치 (구현/배포 전 확인)

- 중앙 AgentMemory 서버: capture inbox/중복 방지/보존/재시도, observe, events, 요약/저장, 공급자 준비·보류·복구. 공통 서버 하나를 사용하면 서버 변경은 그 서버에 한 번 적용한다. 각 머신이 자체 AgentMemory 서버를 돌리면 각 서버가 대상이다.
- 기록을 보내는 Codex 클라이언트 환경: plugin 또는 codex-compat hook scripts, 이벤트 정규화, 로컬 spool/outbox와 재전송, endpoint/인증 전달. 해당 기능 변경이 필요한 수집 대상 환경마다 검증된 클라이언트 배포가 필요하다. OS뿐 아니라 사용자 프로필/WSL/container가 별도 설정·저장 경로를 쓰는지 구분한다. 모든 Codex 설치 머신을 무조건 변경하는 것은 아니다.
- MCP-only 연결: memory 조회/수동 도구 연결이며 자동 hook capture 설치를 보장하지 않는다. 자동 수집이 필요하면 실제 이벤트 훅 경로를 확인한다. 서버 전용 변경과 호환되는 기존 MCP bridge는 불필요하게 교체하지 않는다.
- 모델 호스트(Ollama 등): 모델/API 제공 역할이다. 서버에서 모델 endpoint로 연결한다. 각 Codex 클라이언트에 모델/API key 또는 provider 코드를 복제할 필요는 없다. AgentMemory 서버와 모델 호스트가 다른 경우를 구분한다.

근거: src/hooks/_capture.ts는 AGENTMEMORY_URL의 /agentmemory/observe로 전송하고 로컬 capture/spool.ts에 장애 기록을 보존한다. src/cli/connect/codex.ts는 사용자 홈의 Codex MCP/hook 경로를 설정한다. src/functions/capture.ts 및 observe.ts는 서버 처리, src/providers/index.ts 및 src/ops/provider-readiness.mjs는 Worker의 공급자 처리다. 고정 inventory는 integrations/codex-compat/* 및 scripts/build-codex-compat.mjs를 클라이언트 이식 대상으로 포함한다. 기존 Windows PreCompact 수정도 서버 수정만으로 배포되지 않았다.

다음 구현은 서버/클라이언트 산출물과 호환 계약을 분리한다. 적용 전 수집 대상별 OS·사용자·실행 형태·실제 hook/plugin 경로·버전/hash·endpoint 설정 여부(비밀값 제외)를 정리한다. 코드 구현, 클라이언트 로컬 적용, 실제 이벤트 수신 검증을 별도 상태로 기록한다. 포크 생성만으로 순정 plugin/npx의 업데이트 출처가 개인 포크로 바뀌지 않는다. 검증된 client artifact의 버전/hash와 설치 경로를 명시해야 한다. 현재는 원격 환경 목록/접속 상태를 확인하지 않았고 배포하지 않았다.
