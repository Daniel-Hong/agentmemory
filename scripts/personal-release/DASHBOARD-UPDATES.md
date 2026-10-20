# 대시보드 업데이트 권한 경계

이 파일들은 **설치되지 않은 관리자 검토용 템플릿**이다. 브라우저/API는 후보를 등록하거나 프로그램·경로·URL·환경을 전달하지 않는다. 운영 적용·systemd/sudoers 설치는 별도 승인 후 한다. root runner의 성공은 `applied_pending_acceptance`, `verificationComplete:false`이며 운영 인수·다른 클라이언트 적용 완료를 뜻하지 않는다.

## 최초 OS 설치(관리자)

먼저 `dashboard-updates.py`, unit, sudoers를 검토한다. `/usr/local/libexec` 및 모든 상위 디렉터리는 root 소유이며 그룹/다른 사용자 쓰기가 없어야 한다. 실행 파일은 심볼릭 링크가 아닌 root:root 소유 0755의 **실제 복사본**으로 두 개 설치한다.

- `/usr/local/libexec/agentmemory-update-runner`: `dashboard-updates.py` 복사본
- `/usr/local/libexec/agentmemory-update-request`: 같은 파일의 별도 복사본. 이 이름으로 실행하면 UUID 한 개를 받는 요청 모드만 가능하다.
- `/etc/systemd/system/agentmemory-update@.service`: 제공 unit, root:root 0644
- `/etc/systemd/system/agentmemory-update-recovery.service`: 제공 부팅 복구 unit, root:root 0644. 최초 상태 초기화 후 enable하여 다음 부팅에서 주 서비스 시작 전에 중단 작업을 표시한다.
- `/etc/sudoers.d/agentmemory-dashboard-updates`: 제공 sudoers, root:daniel(GID1000) 0440. 서비스의 기존 파일 내용 guard가 읽어야 하므로 비밀 없는 고정 규칙만 그룹 읽기를 허용하며 쓰기는 root만 가능하다. 나머지 자산은 root:root를 유지한다. `visudo -cf` 검증 후 설치한다. 현재 sudo-rs 0.2.13의 root 소유·비root 그룹 쓰기 금지 검사와 호환되며, traditional sudo로 전환할 때는 별도 권한 인수가 필요하다. 실제 root:1000 파일의 sudo/visudo 권한 인수는 운영 설치 전 확인한다.

unit은 주 서비스와 독립이며 새 포트·상주 서버가 없다. `systemctl daemon-reload` 후 `sudo /usr/local/libexec/agentmemory-update-runner --initialize`로 상태 디렉터리를 만든다. 별도 업데이트 controller unit은 `TimeoutStartSec=0`으로 기존 적용 transaction의 정상 종료·백업을 controller timeout으로 중단하지 않는다. 기존 AgentMemory 서비스 timeout이나 검토된 transaction의 단계별 제한은 바꾸지 않으며 강제 종료·데이터 복원 로직을 추가하지 않는다. 실패/중단 상태를 지우거나 같은 job을 다시 실행해 partial apply를 덮지 않는다. 중단된 `running` 작업은 관리자 인수 대상이다. 아래 명시적인 복구 확인 전에는 새 업데이트도 차단한다.

서비스 사용자(현재 UID1000 daniel)가 `/home/daniel/.agentmemory/update-requests`를 0700으로 만들고 `<canonical-lowercase-UUID>.json` 파일을 0600으로 저장한다. 요청은 최대 4096바이트이며 정확히 `{ "jobId": "UUID", "candidateId": "등록된-ID" }`다. 고정 명령 `sudo -n /usr/local/libexec/agentmemory-update-request UUID`가 root 상태를 기록하고 `systemctl start --no-block agentmemory-update@UUID.service`를 요청한다. 전역 flock과 queued/running 검사는 다른 후보·다른 ID의 동시 실행도 막는다. 동일 ID와 다른 후보의 재사용은 거부한다.

## 후보 등록(관리자 신뢰 경계)

**해시는 코드 안전성이나 실행 의존성 폐쇄를 증명하지 않는다.** 관리자는 기존 terminal 도구의 정상 종료/저장 인증/활성 queue 백업/두 해시 표/실제 guard/설치/재시작/코드만 rollback/보존 archive 전체 read-back 흐름을 유지하는 self-contained kit를 별도로 준비하고 전체 코드를 검토해야 한다. 기존 outputs 경로를 그대로 등록하거나 임의 사용자 디렉터리를 해시만 보고 root로 실행하지 않는다.

등록 원본부터 `/`까지 모든 상위 디렉터리, 원본 디렉터리와 모든 파일이 root 소유이며 그룹/다른 사용자 쓰기가 없어야 한다. symlink, 특수파일, `..`, 숨김 경로, `.env`/`*.env`, data/queues/outbox/spool/node_modules/__pycache__ 경로는 거부한다. kit에는 운영 데이터·인증정보·원문·백업을 포함하지 않는다. 검토된 프로그램은 파일·import·subprocess를 통해 **사용자 쓰기 가능한 외부 프로그램을 실행/로드하지 않는다는 관리자 보증**이 필요하다. generic Python의 동적 실행 의존성은 정적 manifest로 증명할 수 없다. 선언을 자동으로 true로 만드는 packager는 제공하지 않는다.

`kit.json` 예(해시·커밋·본문은 실제 검증값으로 작성):

```json
{
  "id": "daniel-release-next",
  "version": "0.9.30-daniel.N",
  "sourceCommit": "40자리 lowercase commit hash",
  "packageSha256": "64자리 lowercase package hash",
  "changeSummary": "실제 변경 전후 동작과 제한",
  "tests": ["실제 수행한 검증 및 결과"],
  "entrypoint": "apply.py",
  "executionClosureReviewed": true,
  "reviewedBy": "검토 관리자와 검토 기록 참조",
  "files": {"apply.py": "64자리 lowercase 파일 sha256"}
}
```

공개 메타데이터 한도는 후보 100개, 공개 catalog JSON 실제 파일 65536바이트, version UTF-8 100바이트, changeSummary UTF-8 8192바이트, tests 50개·항목당 UTF-8 1000바이트이다. 전체 공개 예산 초과는 vault/private catalog 저장 전에 거부한다. Unicode 한도는 브라우저 문자열 한도보다 보수적으로 검사한다.

`files`는 kit.json을 제외한 **모든** 파일의 정확한 상대 경로/sha256 목록이다. entrypoint는 목록의 Python 파일이며 `/usr/bin/python3 -I -B ROOT_VAULT/entrypoint --apply`로만 실행한다. `-I`는 사용자 PYTHONPATH·site·cwd import를 제외하므로 kit 내부 모듈 접근도 명시적으로 검토해 구성한다. 필요한 설치 assets도 manifest에 포함한다. 운영 데이터와 설정은 kit에 복사하지 않고 기존 도구의 보호된 runtime 절차로 처리한다.

관리자가 고정 원본을 준비한 뒤 `sudo /usr/local/libexec/agentmemory-update-runner --enroll /ROOT_OWNED_REVIEWED_KIT`를 실행한다. 등록은 vault에 별도 snapshot을 복사하고 목록을 재검증한 뒤에만 승인 목록을 게시한다. 같은 후보 ID의 다른 내용은 거부한다. 정확히 같은 원본 kit를 다시 등록하면 기존 vault/private catalog를 검증하고 public catalog 게시만 복구한다. private catalog 저장 전 실패한 신규 vault는 제거하며, 원자 교체 뒤 fsync 실패처럼 commit 여부가 불확실하면 보존한다. crash로 vault만 남은 경우도 같은 exact kit 재등록으로 복구한다. 런타임은 브라우저가 전달한 경로를 사용하지 않으며 실행 직전 root 소유·권한·정확한 파일 집합·모든 sha256을 다시 검사한다. 아직 실제 운영 후보 kit를 생성/등록하지 않았다.

## 공개/비공개 상태

`/var/lib/agentmemory-updates`와 public 하위 디렉터리는 root 소유 0755, 공개 JSON은 0644다. root 전용 catalog.json/private/vault는 서비스 사용자가 쓸 수 없고 private/vault는 읽을 수 없다.

- `public/catalog.json`: `{candidates:[{id,version,sourceCommit,packageSha256,changeSummary,tests,approved:true}]}`
- `public/jobs/UUID.json`: `{jobId,candidateId,status,phase,createdAt,updatedAt,verificationComplete:false,errorCode?,bootId,events,recoveryAcknowledged?,recoveryAcknowledgedAt?}`
- status: `queued`, `running`, `applied_pending_acceptance`, `interrupted`, `failed`
- phase: `queued`, `applying`, `awaiting_acceptance`, `inspection_required`, `failed`
- 공개 오류는 고정 코드만 사용한다. 실행 stdout/stderr는 `private/UUID.log`(0600)에만 남긴다. 공개 상태에 원문·설정·백업 경로·예외 본문을 싣지 않는다.

운영 보호 단계별 세부 성공/실패는 검토된 기존 적용 도구의 private 영수증으로 인수한다. runner는 exit 0으로 최종 인수를 인증하지 않으며 실패 시 데이터를 복원하거나 자동으로 재시도하지 않는다.

검증: `python3 -m unittest discover -s scripts/personal-release -p test_dashboard_updates.py` (`source/`에서). 합성 파일·실제 subprocess만 사용하고 운영 서비스·데이터·추론은 건드리지 않는다.

## 부팅·실행 중단 후 관리자 확인

job은 부팅 ID와 안전한 상태 전이 이력 `events:[{status,phase,at,errorCode?}]`를 보존한다. `--recover-incomplete`는 private catalog의 root-owned snapshot을 모두 재검증하고 public 목록을 복구한 뒤, 이전 부팅의 queued/running을 `interrupted/inspection_required`, `UPDATE_INTERRUPTED`로 표시한다. 같은 부팅은 global flock을 획득하고 해당 systemd unit의 ActiveState가 inactive/failed임을 실제 조회한 경우에만 표시한다. queued 생성 후 30초는 요청/비동기 dispatch 사이의 짧은 구간을 보호하여 건너뛴다. 실행 중 worker가 global flock을 보유하거나 unit 상태가 불확실하면 중단을 추측하지 않는다. 이전 부팅의 queued를 직접 실행/재요청해도 자동 재실행하지 않는다.

복구 unit은 프로그램 재실행·rollback·kill·데이터 복원을 하지 않는다. `interrupted` 상태도 새 작업을 차단한다. 관리자는 private 적용 로그/영수증과 현재 guard·데이터 보존·실행 중 process를 확인하고 필요한 기존 복구 절차를 마친 뒤에만 `sudo /usr/local/libexec/agentmemory-update-runner --acknowledge-recovery UUID`를 실행한다. 이 명시 확인은 `recoveryAcknowledged:true`와 시각을 기록하고 failed로 전환하여 새 요청을 허용한다. 기존 오류와 events는 보존하며 같은 UUID를 재실행하지 않는다.

공개 catalog만 게시되지 않았거나 유실된 경우 root-only `--refresh-catalog` 또는 같은 exact kit의 `--enroll`로 private catalog에서 복구할 수 있다. 기존 ID의 다른 코드로 덮어쓰는 복구는 허용하지 않는다.

## 닫힌 릴리스 kit 준비와 등록

`prepare-dashboard-kit.py`는 일반 사용자로 실행하는 준비 도구다. 후보의 두 해시 표와 현재 적용 영수증/보호 파일을 읽고 `package.tgz`, JSON 기준표, `kit-runtime.py`, `kit-queues.py`, `kit-integrity.py`만 새 폴더에 묶는다. 과거 outputs Python을 import하지 않는다. 실행 예의 경로·메타데이터는 검토한 실제 값으로 대체한다.

```sh
python3 scripts/personal-release/prepare-dashboard-kit.py \
  --candidate /ABS/NEW-CANDIDATE \
  --baseline-config /ABS/CURRENT-ISSUED-BUNDLE/deployment.json \
  --baseline-release /ABS/CURRENT-CANDIDATE/release.json \
  --baseline-receipt /home/daniel/.agentmemory/personal-deployment-daniel4/activation.json \
  --metadata /ABS/release-metadata.json --out /ABS/NEW-UNAPPROVED-DRAFT
```

메타데이터에는 `id`, `version`, `sourceCommit`, `packageSha256`, `changeSummary`, 실제 수행한 `tests`를 넣는다. 준비 결과의 `executionClosureReviewed`는 항상 false이며 `reviewedBy`는 빈 값이다. 관리자 검토는 런타임과 두 helper 전체, 고정 명령/경로, 이전 릴리스와 13개 compatibility 파일 동일성, root 자산 5개, 보존 archive, 정확한 후보 패키지/검증 증거까지 포함한다. `review-template.json`의 `draftManifestSha256`는 **검토한 kit.json 바이트**를 고정한다. 관리자가 별도 root-owned 검토 기록에만 `executionClosureReviewed:true`, 관리자/검토 참조를 담은 `reviewedBy`를 명시한다. 생성기는 승인값을 추론하거나 대신 작성하지 않는다.

관리자는 `enroll-reviewed-kit.py` 자체도 먼저 검토하고, root-owned 실제 복사본을 그룹/다른 사용자 쓰기 없는 root 경로에 설치한다. 사용자 쓰기 가능한 source/outputs 파일을 `sudo python3`로 실행하지 않는다. 이 부트스트랩은 stdlib만 사용하며 root-owned 검토 기록과 일치하는 draft 파일 바이트를 root 전용 snapshot으로 동결한 뒤 고정된 기존 runner의 `--enroll`만 호출한다.

```sh
sudo /usr/bin/python3 -I -B /ROOT-OWNED/enroll-reviewed-kit.py \
  --draft /ABS/NEW-UNAPPROVED-DRAFT --review /ROOT-OWNED/explicit-review.json
```

등록 전용 명령은 적용·일시정지·서비스 중지/시작을 하지 않는다. 같은 내용 재시도는 snapshot/public 복사본을 재검증하고 등록 게시를 복구한다. 같은 ID의 다른 바이트는 거부한다. 기존 runner/helper/unit/sudoers의 재설치나 sudo 권한 확장은 필요하지 않다. 등록 후 사용자는 기존 대시보드의 등록 후보를 선택해 업데이트한다. 일반 업데이트마다 terminal `apply.py`를 실행할 필요가 없다.

다음 릴리스부터는 `--baseline-config/--baseline-release` 대신 `--baseline-kit /var/lib/agentmemory-updates/public/release-kits/CURRENT-ID`와 현재 `--baseline-receipt`를 사용한다. 이전 JSON/보호 해시와 모든 보존 archive를 이어받으며 이전 kit 코드를 동적으로 import하지 않는다.

적용 시 root는 검토된 runtime/helper만 로드한다. 패키지 설치·사용자 wrapper 변경·보존 archive/영수증 작성은 fork 후 UID/GID1000, 보조 그룹 제거·환경 초기화·추가 FD 닫기로 수행한다. root는 고정 systemctl, 보호된 drop-in, 최신 private 백업만 담당한다. npm retained-package의 내부 상대 symlink는 링크 자체를 보존하고 외부 링크는 거부한다. data/env/runtime 백업의 symlink 거부는 유지한다. 새 패키지와 retained npm package.json의 dependencies/optionalDependencies/engines가 다르면 일시정지·서비스 중지 전에 거부한다. 13개 클라이언트 파일이 달라져도 적용을 거부하며 기존 Ubuntu hook 명령과 Windows 설치는 그대로 보존한다.

현재 PID의 신선한 verified/synced/mutationFailures0 정상종료 영수증과 모든 기존 process 종료를 증명하기 전에는 backup/stage하지 않는다. 원문/queue/retained dependencies/보호 파일의 최신 백업은 root-private에 저장하고 디스크를 다시 읽어 검증한다. 새 package·guard·runtime·데이터·전체 코드 archive read-back까지 통과해야 새 영수증을 쓴다. 시작 직전에는 root가 게시한 제한된 phase 상태를 guard가 확인하고, 영수증 이후에는 영수증 및 archive를 확인한다. 완료는 계속 `verificationComplete:false`로 운영 인수를 남긴다.

stage 실패는 이전 wrapper를 복구한다. 활성화 후 실패는 새 worker의 **새 정상종료 인증**과 데이터 보존 검사 성공 뒤에만 이전 drop-in/wrapper로 코드 복구한다. 종료 미인증이면 코드 전환과 자동 재시작을 차단한다. 인증된 중지·데이터 보존·기존 guard를 모두 확인한 경우에만 이전 서버를 한 번 재시작하고, 이전 버전·일시정지·저장 상태를 다시 확인한다. 확인하지 못하면 manual_required/restore_failed로 남기며 자동 반복하지 않는다. 실패한 업데이트 자체는 복구 성공이어도 failed다. 최신 데이터/queue를 복원하거나 package를 삭제하지 않고, 프로세스 강제 종료·timeout 연장·인증 우회도 하지 않는다.

격리 검증: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/personal-release -p test_dashboard_kit.py`. 합성 tgz/파일시스템·가짜 서비스·실제 fork를 사용한다. 실제 root UID0→1000 전환 및 실제 OS bootstrap/서비스 적용은 이 시험으로 인증하지 않으며 운영 설치 인수 항목이다.

## daniel.7 실제 권한·진행 표시 보완

기존 root 소유 releases 상위를 그대로 UID1000으로 쓰려던 .6 실패를 보존한다. 신규 버전은 `/home/daniel/.local/share/agentmemory-personal-releases`에 설치하고 기존 root 소유 설치·상위 권한은 바꾸지 않는다. 새 경로는 runtime/data 백업 영역 밖에 둔다. 기존 .4의 guard/보존본/훅은 계속 검사한다.

등록 후 root 소유 공개 kit의 `kit-runtime.py --check-install-access`를 관리자 권한으로 실행하면 실제 UID/GID1000 child가 코드/영수증/보존 상위에 임시 파일을 만들고 즉시 삭제하여 설치 접근을 검사한다. API·일시정지·systemctl·운영 데이터를 건드리지 않는다. 실제 apply도 같은 검사를 **일시정지/중지 전에** 반복한다. 이 출력의 installAccessVerified는 정상종료·설치·운영 데이터 인수와 별개다.

공개 실패 영수증에는 고정 errorCode/failedPhase/recoveryStatus만 기록하고 root-private 로그·백업 경로·원문은 공개하지 않는다. API는 해당 작업 생성 이후의 상태만 결합한다. 최근10개 표시와 별개로 선택 후보의 전체 실패/중단 이력을 검사해 새 요청을 거부한다. 같은 UUID의 상태 조회는 유지한다.

Viewer는 클릭 즉시 요청 ID와 중복 클릭 차단을 표시하고 상태 영역을 상단에 고정한다. 확인한 단계를 한국어로 나열하고 밝은/어두운 테마의 본문 색을 따른다. 네트워크 유실은 미확정으로 표시하며 기존 요청 ID를 유지한다. 기존 요청의 같은-ID 재시도가 인증 오류를 받아도 이전 접수 여부를 추측해 ID를 지우지 않는다. 오래된 .6 kit에는 상세 실패 영수증이 없으므로 복구 여부를 추정하지 않는다.
