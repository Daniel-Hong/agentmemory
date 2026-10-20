# 저장 인증 계측 운영 적용안 — 준비만, 실행 승인 없음

현재 계측은 별도 개발 사본에만 있다. 이 문서는 적용 권한·root 검토 기록·발행 후보·서비스 변경을 대신하지 않는다. 과거 서비스 작업 권한은 재사용하지 않는다. 현재 서버 상태나 과거 activation을 최신 상태로 추정하지 않는다.

## 1. 별도 승인과 입력이 필요한 항목

실제 진행 전 승인 대상은 (a) 원본 personal에 코드 통합 및 새 배포 버전 발행, (b) 검토된 후보의 root 등록, (c) 지정 시간대의 업데이트/정상 종료·재시작, (d) 기존 일시정지 상태를 바꾸는 경우 그 재개이다. 현재는 모두 실행하지 않는다.

적용 시점의 실제 버전·MainPID·ExecStart·현재 kit ID/경로·현재 activation/preservation 및 그 해시를 읽기 전용으로 재확인한다. 마지막 조사에서 daniel.10이었지만 새 후보 버전/ID나 현재 baseline은 여기서 확정하지 않는다. 원본에는 CHANGELOG.md와 Viewer/test 사용자 변경이 있으므로 통합 시 덮어쓰지 말고 검토·충돌 해결 후 clean personal commit을 만든다.

필요한 확정 입력은 새 버전/후보 ID, clean source commit/tree, tgz 및 SHA256, 새 후보/초안의 절대 경로, 현재 root-published kit 경로와 activation 경로, 관리자 검토 경로, 중단 시간대, 기존 background pause 상태다. 이 값이 없으면 아래 명령의 변수를 추정하여 실행하지 않는다.

## 2. 승인 후 준비·등록 절차

아래는 확인한 기존 도구 인수다. 명령은 이 작업에서 실행하지 않았다. 변수는 검토한 실제 절대 경로/값으로 채워야 한다.

1. 승인된 통합 커밋에서 package.json 버전을 사용하지 않은 다음 개인 배포 버전으로 정하고 공식 build/skills:gen/docs:sync/skills:check/npm test/docs:check를 임시 HOME으로 수행한다. 원래 .env·모델·timeout·batch·root helper·의존성을 변경하지 않는다. 13개 compatibility 파일이 현 baseline과 같은지 확인한다. 달라지면 이번 계측 범위로 자동 업데이트하지 않는다.
2. 검증한 clean source에서 `npm pack --ignore-scripts --pack-destination "$ARTIFACT_DIR"`로 새 tgz를 만든다. `PACKAGE`는 출력된 실제 tgz 경로다. source commit/tree와 package SHA256을 고정하고 발행한 파일을 이후 수정하지 않는다.
3. 일반 사용자로 새 후보와 기존 해시 표/코드 보존 archive를 준비한다. 도구가 생성한 deployable:false/blockers를 임의로 지우지 않는다.

```sh
python3 scripts/personal-release/prepare.py \
  --package "$PACKAGE" --out "$NEW_CANDIDATE" \
  --baseline-activation "$CURRENT_ACTIVATION"
python3 scripts/personal-release/release_tools.py check --root "$NEW_CANDIDATE" --baseline
python3 scripts/personal-release/prepare-dashboard-kit.py \
  --candidate "$NEW_CANDIDATE" --baseline-kit "$CURRENT_PUBLISHED_KIT" \
  --baseline-receipt "$CURRENT_ACTIVATION" \
  --metadata "$REVIEWED_RELEASE_METADATA" --out "$NEW_UNAPPROVED_DRAFT"
```

메타데이터 필수 항목은 id/version/sourceCommit/packageSha256/changeSummary/실제 tests다. 후보와 metadata의 version/commit/hash가 일치해야 한다. 준비 도구의 source root는 스크립트가 속한 checkout이므로 다른 디렉터리의 tarball을 무심코 연결하지 않는다.

4. 관리자는 새 runtime·kit-queues·kit-integrity 전체와 package, 두 해시 표, baseline guard/preservation 및 client 동일성을 검토한다. root-owned 검토 기록이 정확한 draftManifestSha256을 고정해야 한다. 사용자 소유 source/outputs Python을 sudo로 실행하지 않는다. 설치된 검토 bootstrap을 사용할 때의 인수는 다음과 같다.

```sh
sudo /usr/bin/python3 -I -B "$ROOT_OWNED_REVIEWED_BOOTSTRAP" \
  --draft "$NEW_UNAPPROVED_DRAFT" --review "$ROOT_OWNED_EXPLICIT_REVIEW"
```

등록은 서비스 변경과 별개다. 현재 제한된 후보 등록 helper가 이미 올바르게 설치되어 있고 이번 등록까지 별도 승인받은 경우에만 기존 `candidate-enrollment` 경로를 사용할 수 있다. 과거 sudo/설치 권한을 새 승인으로 해석하거나 권한을 넓히지 않는다. 현재 root 자산/정책이 다르면 중단하고 다시 검토한다.

5. 게시된 kit의 `--check-install-access`는 임시 쓰기를 하는 검사이므로 읽기 전용 진단으로 실행하지 않는다. 승인된 적용 거래에서 helper가 pause/stop 전에 검사하도록 한다. 승인 목록·영수증·guard와 후보 ID를 확인한 뒤 기존 대시보드에서 **그 후보 한 번만** 적용한다. 임의 `systemctl restart`, 직접 chunk 교체, kit-runtime --apply 우회 호출은 하지 않는다. 응답 유실 시 기존 작업 UUID의 `GET /agentmemory/updates/jobs/:id`를 조회하고 새 작업을 만들지 않는다. `failed/interrupted`의 같은 후보를 alias로 재등록해 우회하지 않는다.

## 3. 중단 영향과 적용 판정

기존 kit의 순서는 preflight/영속 pause → 정상 stop 및 최신 PID의 종료 영수증 확인 → 비공개 최신 cold backup/read-back → 버전 경로 stage → 보호 drop-in 전환/guard → start → runtime/data/code archive 인증이다. 종료 영수증은 verified:true, durability.synced:true, mutationFailures:0이며 이전 Worker/engine/MainPID가 모두 종료되어야 한다. 이 조건 전에는 backup/stage나 강제 종료를 하지 않는다.

업데이트 동안 AgentMemory API/Viewer·중앙 검색·수집 ACK가 잠시 중단된다. 정상 참여 클라이언트는 검증된 로컬 outbox/spool에 보관하고 재시도하지만 미검증 클라이언트의 보존을 약속하지 않는다. Windows Ollama나 Windows 클라이언트는 변경·재시작하지 않는다. 계측 자체에 데이터 migration은 없다. 중단 시간은 drain·저장 인증·백업 크기에 좌우되어 아직 측정하지 않았고, 인증 호출당 15초를 전체 중단 시간으로 해석하면 안 된다.

현재 kit는 시작 후 pausedRequested:true/status:paused/activeOperations:0 유지 여부를 검증한다. 업데이트가 끝났다고 자동 재개하지 않는다. 기존 상태와 사용자의 별도 재개 승인에 따라야 정상 background 인증 표본이 생긴다. applied:true도 최종 운영 인수와 다르며 kit는 verificationComplete:false로 남긴다. 정상 호출, 데이터 보존, 신규 지표와 실제 처리 진행 확인 후에만 기존 절차로 최종 인수를 기록한다.

## 4. 실제 관측 방법 — GET만, 새 부하 없음

별도 적용 승인 후 먼저 `livez`, `health`, `config/flags`, `sessions?includeSummary=false`, `background/control`을 확인한다. health version/source receipt/guard가 새 후보와 일치하고 mutationFailures 증가가 없는지 확인한다. 계측을 만들기 위해 추론·재처리·capture 복구 작업을 시작하지 않는다. 기존 정상 작업이 진행될 때 관측한다.

아래는 설치된 읽기 전용 inspector의 인증 로딩과 허용 GET을 재사용해 새 지표만 출력하는 한 번의 조회 예다. 비밀·원문·worker/session ID는 출력하지 않는다. `.env`나 Authorization을 명령 인자에 넣거나 shell tracing을 켜지 않는다.

```python
import datetime, importlib.util, json
from pathlib import Path
path = Path.home() / '.codex/skills/agentmemory-inspect/scripts/inspect.py'
spec = importlib.util.spec_from_file_location('am_inspector', path)
am = importlib.util.module_from_spec(spec)
spec.loader.exec_module(am)
values = am.environment()
h = am.get('health', values['AGENTMEMORY_URL'] or 'http://127.0.0.1:3111', values['AGENTMEMORY_SECRET'])
storage = h.get('storageDurability') or {}
print(json.dumps({
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'measurements': storage.get('measurements'),
    'mutationFailures': storage.get('mutationFailures'),
    'capturePending': (h.get('captureProgress') or {}).get('pending'),
    'embeddingPending': (h.get('embeddingRecovery') or {}).get('pendingCount'),
}, ensure_ascii=False))
```

처음에는 10~15초 간격, 5분 정도의 작은 읽기 전용 표본을 수동으로 모은다. API 지연/부하가 늘면 조회 빈도를 줄인다. 출력 저장 시 개인 디렉터리0700/파일0600을 사용하고 원문 로그를 함께 수집하지 않는다. 완료된 sample의 id와 completedAt으로 중복을 제거하고, 재시작 시 token/id가 달라지므로 다른 프로세스와 합치지 않는다. recent는 8건뿐이므로 evicted 증가나 표본 누락을 검사한다. **놓친 표본이 있으면 정확한 실패율/분포/최대 지연이라고 보고하지 않는다.**

판독 기준:

- captureMs/capture_timeout/capture_error: SDK 값 확보·재확보 쪽 대기/실패이며 디스크 sync 오류로 단정하지 않는다.
- readbackMs·scanBytes·scans/completeScans와 namespace_changed/not_committed 반복: 대형 namespace 검사·동시 교체·아직 미게시된 값의 비용 후보. 스캔이 완료됐어도 인증 전체 성공은 outcome으로 구분한다.
- fsyncMs/verifyMs와 해당 failedStage: sync·파일 signature 확인 구간의 비용. 디스크 장치 자체 장애라는 단정은 별도 근거가 필요하다.
- retryWaitMs는 의도된 재검사 대기이며 디스크 지연에 더해 보고하지 않는다. cleanupMs도 분리한다. 재검사가 있었어도 outcome:verified면 최종 실패가 아니다.
- unavailable 증가는 계측 누락이며 저장 실패 수가 아니다. failed sample과 기존 저장 오류/큐 증감을 같은 시간대에서 비교한다.

관측 중 새 지표 누락, 예상 밖 인증 실패·mutationFailures 증가·데이터 보존 검사 실패·guard 불일치가 있으면 성공 표시/작업 반복을 중단하고 해당 UUID와 읽기 전용 근거를 보존한다. 이 계측만으로 물리 디스크 대기/파싱 CPU/Windows 추론 시간을 완전히 분해할 수는 없다.

## 5. 롤백 대상과 중단 조건

개발 단계 롤백은 계측 도입 커밋과 이 후속 보완만 대상으로 revert해 재검증하는 것이다. 운영에 적용한 뒤에는 이전 **검증된 전체 버전 패키지·drop-in·기존 wrapper**로 코드만 복구한다. 번들 chunk를 부분 복사하거나 최신 KV/원문/summary offset·segments/retry/Lesson/metrics/색인/제보/outbox/spool을 이전 백업으로 되감지 않는다. 새 버전·실패 영수증·보존 archive도 삭제하지 않는다. RAM에만 있던 measurement 이력은 사라진다.

기존 kit는 stage/activation 실패 시 코드 복구를 시도하지만, 새 Worker가 시작됐으면 그 Worker의 새 정상 종료 인증과 데이터 보존 확인을 먼저 요구한다. 종료 인증이 없으면 코드 전환/자동 재시작을 막고 manual_required로 남긴다. 인증·이전 guard·데이터 조건이 모두 맞을 때만 기존 서버를 한 번 복구 시작하며, 이전 버전과 pause·저장 상태를 재검증한다. 복구 성공도 실패한 업데이트 자체를 성공으로 바꾸지 않는다. 사람의 새 승인 없는 강제 kill·timeout 연장·reset·재처리·재개는 하지 않는다.

근거 코드: scripts/personal-release/{prepare.py,prepare-dashboard-kit.py,enroll-reviewed-kit.py,kit-runtime.py,release_tools.py}, 기존 DEPLOYMENT-RUNBOOK.md/DASHBOARD-UPDATES.md, src/ops/dashboard-updates.mjs. 이 적용안 작성 중 운영 명령·등록·설정 변경은 실행하지 않았다.
