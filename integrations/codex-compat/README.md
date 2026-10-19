# Codex custom hook compatibility

This first-party port preserves the approved long-session client identified in
`provenance.json`. The canonical artifact is a reviewed project output, not an
installed npm package. PreCompact still captures without unsupported context
output; supported context events still emit their JSON markers.

Run `node scripts/build-codex-compat.mjs` after the official hook build. It creates
explicit `plugin/scripts/codex-compat/` and `dist/hooks/codex-compat/` artifacts,
hash manifests and deployment mappings without changing stock top-level hooks.
Deployment must preserve the current nine custom wrapper mappings explicitly,
including the shared official `_capture.mjs`; enabling both custom and official
hooks for the same host event is not a deduplication strategy.

Observe records leave the legacy outbox only after the official helper validates
and retains a server durability mark, or fsyncs a managed pending spool record.
Missing/malformed acknowledgements and failed retention leave legacy ownership
unchanged. Event IDs survive handoff and replay. Large images that cannot fit the
official spool limits stay in the legacy outbox instead of being silently dropped.
Managed compatibility records do not expire or undergo sent eviction before a
durable receipt settles ownership; ordinary upstream spool policies are unchanged.
Server privacy scrubbing applies to managed spool records as upstream intends.
Session lifecycle and cached context requests retain the canonical behavior.

No installer changes Windows configuration, credentials or existing outbox files.
Actual Windows dispatch remains an independent deployment check.

## 개인 포크 클라이언트 업데이트

현재 PORT-04는 **격리 검증용 후보이며 운영 적용 불가**다. 서버의 embedding/publication, pause/pressure, Viewer 및 전체 통합 검증이 남아 있다. 빌드 성공이나 이 폴더의 manifest는 운영 승인서가 아니다.

서버 코드·Ollama 모델/준비 상태는 중앙 서버에서 한 번 관리한다. 이 훅은 수집에 참여하는 Codex의 각 OS 사용자 환경에 적용한다. Windows와 WSL, 원격 SSH/컨테이너는 별도 환경이며, 모든 Codex 설치에 배포할 필요는 없다. 클라이언트에는 LLM 공급자 키나 서버 DB가 필요 없다.

AI에게 맡길 때 [준비/적용 프롬프트](AI-CLIENT-UPDATE.md)를 사용한다. 기본은 준비 모드다. 실제 적용은 서버 검증이 끝난 **고정 커밋과 별도 승인된 클라이언트 release 영수증**을 받아 적용 모드로 명시하여 실행한다. 이 후보만으로 그 승인을 만들어 내면 안 된다.

### 1. 적용 전 발견

`node --version`, Codex 버전, 실행 OS/사용자, 실제 plugin root 및 `/hooks` 활성 상태를 확인한다. 순정 adapter 기본값은 Linux/macOS `~/.codex/hooks.json`, `~/.codex/config.toml`, Windows `%USERPROFILE%\.codex\hooks.json`/`config.toml`이다. 이것은 탐색 출발점일 뿐이다. `CODEX_HOME`이나 다른 프로필, 플러그인 캐시, 호스트 버전 때문에 실제 파일이 다르면 실제 경로를 따른다. 본 후보는 Codex 설정을 자동 수정하지 않는다.

현재 활성 command에서 plugin root와 custom legacy wrapper 위치를 추적한다. MCP 연결과 수집 훅은 구분한다. 같은 이벤트에 native plugin/global/custom AgentMemory 수집이 겹치면 해당 AgentMemory 항목만 하나로 정리할 병합 diff를 만든다. 타 도구의 훅·matcher·timeout·순서는 보존한다. 9개 이벤트가 해당 Codex 버전에서 지원되는지 확인하고 미지원 이벤트를 임의로 다른 이벤트에 매핑하지 않는다. 기존 공통 `_capture.mjs`를 바꾸면 타 훅도 영향을 받으므로, compat 전용 폴더의 파일을 함께 사용한다.

### 2. 고정 소스에서 후보 생성

출처는 `https://github.com/Daniel-Hong/agentmemory`의 검증된 personal 커밋이다. `main`은 upstream 추적용이다. 실제 release 영수증의 전체 commit SHA를 detached checkout한 별도 폴더에서 빌드한다. `personal` 최신, npm latest, marketplace 자동 업데이트를 검증 버전 대신 쓰지 않는다.

```sh
# 소스 checkout 및 기존 의존성 준비 후, 저장소 루트에서
npm run build
npm run build:codex-compat
```

위 build는 기존 Unix shell 명령을 쓰므로 검증된 Linux/macOS 빌더에서 수행한다. Windows 클라이언트에는 그 빌더에서 만든 고정 artifact를 전달하고 manifest/read-back 검사를 수행한다. Windows에서 별도 검증 없이 npm build 명령을 그대로 실행하지 않는다.

두 번째 명령은 `plugin/scripts/codex-compat/`와 `dist/hooks/codex-compat/`를 만든다. `manifest.json`의 전체 `files` SHA256을 실제 파일과 비교하고, 승인 영수증의 **manifest 자체 SHA256** 및 전체 커밋 SHA와도 비교한다. 파일 목록의 해시만 스스로 일치하는 것은 출처 인증이 아니다. `canonicalSha256`은 과거 원본의 출처이며 현재 배포 파일 전체의 해시가 아니다.

Linux/macOS: `sha256sum <manifest-or-file>` (macOS는 `shasum -a 256`). Windows: `Get-FileHash -Algorithm SHA256 -LiteralPath '<manifest-or-file>'`. 경로에 공백이 있는 경우에도 실제 파일을 읽어 비교한다. 로그에 `.env`/토큰/원문은 출력하지 않는다.

### 3. 승인 후 적용

서버 버전·capture receipt 호환·인증·보류/재개·재시작 복구 통합 검증이 통과한 release 영수증과 사용자 적용 지시가 모두 있어야 한다. 하나라도 없으면 적용하지 않고 준비 결과를 보고한다. 서버를 시작/재시작하거나 background 작업을 재개하지 않는다.

1. 사용자 설정과 기존 실행 코드의 private 백업/해시를 남긴다. outbox·managed spool은 최신 상태 그대로 둔다. 동시 실행 훅이 없는 안전한 시점을 확보하고 재확인한다. 인증 파일을 백업해야 한다면 private 저장소만 사용하고 경로 외 내용을 보고하지 않는다.
2. 승인된 compat 폴더 전체를 새 버전 경로에 복사하고 모든 파일을 read-back hash 검증한다. npm 설치 위치나 순정 플러그인 캐시에 임의로 덮어쓰지 않는다. manifest `deploymentMapping`은 참조 매핑이며 top-level 순정 파일 교체 명령이 아니다.
3. 기존 AgentMemory 9개 이벤트의 command만 새 폴더의 wrapper를 가리키도록 병합한다. 새 wrapper·공통 client·`_capture.mjs`·provenance·manifest를 함께 유지한다. 이벤트 목록은 provenance.json을 기준으로 한다. 정상적으로 이미 적용되어 있으면 중복 추가하지 않는다.
4. 원격 endpoint/인증은 기존 안전한 클라이언트 환경에 보존한다. compat client는 `AGENTMEMORY_HOME/.env`(기본 `~/.agentmemory/.env`)를 unset 변수에 한해 읽는다. secret 값이나 `.env`를 릴리즈/프롬프트에 넣지 않는다. 공식 MCP bridge와 compat client의 자격증명 탐색이 동일하다고 가정하지 않는다. 실제 환경에 endpoint와 secret이 있는지만 비밀값 없이 확인한다. HTTPS 또는 승인된 보안 터널을 사용한다.
5. private 최신 코드 백업과 설정 diff, revision, 적용 시각, 파일 해시, 검증 결과를 local 영수증에 기록한다. 공개 git에는 비밀 없는 요약만 남긴다.

명령 예시 (현재는 실행 지시가 아닌 대상 경로 형식):

```sh
node "/absolute/versioned/codex-compat/session-start.mjs"
```

PowerShell 외부 command를 구성해야 한다면 호출 연산자와 LiteralPath를 사용한다. 호스트가 실제로 어떤 shell을 쓰는지 먼저 확인한다.

```powershell
& 'C:\Program Files\nodejs\node.exe' 'C:\AgentMemory Client\<revision>\codex-compat\session-start.mjs'
```

프롬프트 문자열·토큰을 shell command로 보간하지 않는다. JSON command 필드가 직접 Node를 실행하는 호스트에서 불필요하게 PowerShell로 감싸지 않는다. Windows의 실제 dispatch는 Linux 합성 테스트로 인증할 수 없다.

### 4. 시험과 롤백

먼저 실제 `HOME`/`USERPROFILE`/`AGENTMEMORY_HOME`/spool을 모두 임시 경로로 둔 별도 프로세스에서 합성 payload·mock endpoint로 검증한다. 서버/인증 설정은 운영 값과 분리한다. POSIX file+directory fsync와 Windows file fsync의 보장 범위가 다르다. 원격 연결, 다음 실제 Codex 이벤트의 stdout/오류/서버 원문 수신은 사용자 승인 후 별도 확인한다. PreCompact에는 additionalContext를 출력하지 않아야 한다.

실패하면 command를 직전 코드 경로로 되돌리고 관련 설정 항목만 역병합한다. 적용 이후 바뀐 타 설정을 전체 백업으로 덮어쓰지 않는다. **최신 legacy outbox·managed spool·서버 데이터는 백업본으로 복원/삭제하지 않는다.** 새 코드가 만든 receipt-managed 레코드는 이전 코드가 이해하지 못할 수 있으므로 신버전 폴더/수집 대기 데이터도 보존하고 호환되는 drainer가 준비될 때까지 남긴다. 실패 영수증은 성공으로 처리하지 않는다.

업데이트 후 custom 필요성·upstream 대체 가능성 및 체인지로그 참조를 기록한다. 장기기억은 별도 수동 검토 후 저장하며 기존 기억을 자동 덮어쓰지 않는다.

### 이번 후보의 공급자 제한
`AGENTMEMORY_OLLAMA_NATIVE_CHAT=true`는 명시한 OpenAI-compatible base URL의 로컬/원격 Ollama native chat 용도다. native=true와 fallback 체인을 동시에 설정하면 `ollama_native_fallback_unsupported`로 시작을 거부한다. native=false의 기존 OpenAI/Azure/fallback 동작은 유지한다. native 모드의 base URL 누락도 명시 오류다. 다른 XML 소비자는 그대로 두며 요약만 현재 JSON grammar를 사용한다.

관리 spool은 400/401에도 자동 삭제하지 않으며 인증/입력 오류를 고친 뒤 재전송해야 한다. 그동안 pending이 쌓일 수 있다. compat 원격 retry worker는 마지막 이벤트가 managed pending에 남아 있으면 backoff하며 재시도한다. 프로세스/클라이언트가 종료되면 디스크 대기 자료는 보존되지만 재시도 worker의 상시 서비스 등록까지 제공하지는 않는다. 다음 훅 또는 승인된 수동 drainer 실행으로 재개한다.

canonicalSha256은 승인된 원본 출처를 가리킨다. PORT-04의 retry worker 보완 후 현재 client 해시는 manifest.files에 따로 기록된다. 원본과 동일하다고 해석하지 않는다.
