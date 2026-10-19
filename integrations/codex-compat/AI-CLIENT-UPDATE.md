# 클라이언트 AI 실행 프롬프트

아래 프롬프트를 해당 클라이언트의 AI에 전달한다. 현재 PORT-04 후보의 적용 승인은 없다. 준비는 수행할 수 있다. 구현 설계를 바꾸지 말고 충돌 시 근거·최소 대안을 보고한다.

```text
AgentMemory 개인 포크의 Codex 클라이언트 업데이트를 진행해.

MODE: PREPARE
# APPLY는 별도로 받은 사용자 적용 지시와 승인된 release 영수증이 있을 때만 지정.
FORK: https://github.com/Daniel-Hong/agentmemory
RELEASE_COMMIT: <검증·승인된 전체 SHA; branch명/latest 금지>
RELEASE_RECEIPT: <별도로 승인된 클라이언트 release 영수증 경로>
EXPECTED_MANIFEST_SHA256: <승인 영수증에서 얻은 값>

1. 이 커밋의 AGENTS.md, integrations/codex-compat/README.md,
   docs/customizations/PORT-04.md와 release 영수증을 읽어.
   설계를 임의 변경하거나 지금 없는 배포 승인을 생성하지 마.
2. OS/Node/Codex 버전/사용자 프로필/실제 hook 설정·실행 command·plugin root를
   발견하고 같은 이벤트의 AgentMemory 중복 수집 여부를 확인해.
   현재 CODEX_HOME 및 실제 로딩 경로를 확인하고 기본 경로로 단정하지 마.
   token/.env/원문 내용은 출력하지 마. 참여하는 환경 한 곳만 대상으로 해.
3. 고정 커밋 checkout과 승인 manifest 자체 SHA 및 모든 files SHA256을 검증해.
   검증된 Linux/macOS 빌더는 build와 build:codex-compat로 후보를 준비하고,
   Windows는 그 고정 artifact를 받아 검증해. 순정 top-level hook은 보존해.
   실제 HOME이 임시인 별도 프로세스, mock endpoint, 합성 payload로 시험해.
   원격 운영 서버에 합성 제보를 보내거나 모델 추론을 실행하지 마.
4. 9개 지원 이벤트의 AgentMemory command만 versioned compat 폴더로 변경하는
   최소 병합 diff, private 코드/설정 백업, read-back 검사 및 코드 롤백안을 만들어.
   타 훅·MCP·matcher·기존 인증·latest outbox/managed spool을 보존해.
   이벤트 미지원/알 수 없는 설치 구조/중복 제거 불명확성은 근거와 최소 대안을 보고해.
5. PREPARE면 사용자 설정을 바꾸지 않고 결과와 적용할 diff를 보고해.
   APPLY라도 서버 통합 검증·호환성·release 적용 승인 근거가 없거나 해시가 다르면
   적용을 중단해. 서버 재시작/업그레이드/background 재개는 이 작업 범위가 아니야.
6. APPLY의 gate를 모두 충족하면 백업→새 버전 폴더 복사→전체 hash read-back→
   대상 AgentMemory command만 병합→설정 유효성/중복 검사 순서로 진행해.
   실제 Codex shell dispatch·PreCompact 출력·서버 원문 수신은 별도 승인 범위에서
   확인하고 단순 HTTP 성공으로 완료를 단정하지 마.
7. 실패하면 관련 command만 이전 코드로 역병합해. 최신 원문/outbox/spool/서버 DB는
   옛 백업으로 덮어쓰지 마. 신형 spool을 구형 drainer에 맡기지 마.
8. 성공/실패/미검증, before/after 해시, 시각, commit, local 영수증 경로와
   체인지로그 참조를 남겨. 장기기억은 별도 수동 검토 전 저장하지 마.
```

PREPARE 실행 시 RELEASE 값이 아직 없으면 설치 발견·문서/시험 준비까지만 수행하고,
임의의 최신 커밋이나 이 후보의 hash를 승인 값으로 대체하지 않는다.

## Source fork 이후 인수인계

서버 준비 후보의 release.json sourceCommit/sourceTree 및 package SHA256과 검증 영수증을 먼저 대조한다. 이전 PORT-04 단독 ZIP을 최신 서버 전체 배포 묶음으로 오인하지 않는다. 코드 업데이트 뒤에도 최신 outbox/spool/receipt와 토큰·MCP·개인 설정을 보존한다. 서버 측 제보함은 참여 클라이언트마다 설치하는 코드가 아니며 capture/context 훅은 각 OS·사용자·WSL·컨테이너에서 별도 시험한다. 제보·분석 이력을 장기기억에 자동 기록하지 않는다. 변경과 검증/적용 결과는 체인지로그에 남기고 필요한 기억은 영향 검토 후 명시 지시로만 저장한다.
