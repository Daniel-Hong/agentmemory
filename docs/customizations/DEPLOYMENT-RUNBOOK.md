# Personal fork 배포 준비·적용 절차

이 묶음은 배포 준비 후보이며 실행 중인 서버/클라이언트에 적용하지 않았다. `release.json`의 `deployable=false`를 임의로 true로 바꾸지 않는다. 적용 전 최신 운영 가이드의 정상 GET, 현재 활성 manifest/activation/preservation, 실제 파일 해시, 현재 서비스·capture/retry 상태를 다시 확인해야 한다. 기존 guard 실패를 무시하고 서비스를 중지하지 않는다.

## 서버 적용 전 확인

통합 후보 v2는 PORT-01..08과 CAPTURE-LATENCY-V2의 신규 수집 메타데이터/재시도/훅 마감 수정을 함께 포함한다. v1 후보는 보존한다. 서버와 참여 클라이언트 코드를 같은 최종 검증 revision으로 준비하며, 클라이언트 미갱신 상태를 전체 적용 완료로 표시하지 않는다. 과거6초실패의 phase는 미확정이며 새 후보의 합성/실제격리시험과 구분한다.

1. source `personal`의 검증된 commit/tree와 npm tarball SHA256을 고정한다. main은 순정 추적용이다. 이전 patch bundle/chunk를 새 source build에 덮어쓰지 않는다.
2. `python3 release_tools.py check --root <후보>`로 동일한 두 해시 표와 전체 후보를 확인한다. `--baseline`은 기존 설치 코드·보호 스킬 해시도 확인하며 불일치하면 중단한다. 실제 설치 경로는 `--installed <설치 경로>`로 검증한다. 이 옵션은 새 코드가 설치된 뒤에만 사용한다.
3. 현행 운영 가이드와 정상 종료 영수증/PID의 일치, admitted 작업 drain 및 디스크 read-back을 먼저 확인한다. 중지·업데이트 명령은 이번 준비 단계에 포함하지 않는다. 배경 작업은 기존 일시정지 상태를 유지한다.
4. 적용 시 비공개 cold backup에 최신 data(KV 디렉터리, stream, cursor, 원문, retry, Lesson, metrics), 제보 루트, capture outbox/spool와 설정을 포함하고 모든 항목을 read-back한다. 이 데이터와 인증값은 코드 archive·Git·공개 증거에 넣지 않는다. 코드 rollback을 위해 최신 데이터를 이 백업으로 되감지 않는다.
5. 고정된 버전 디렉터리에 npm tarball을 설치하고 현재 systemd 실행 경로와 연결한다. 서비스를 임의로 새로 설계하지 않는다. 순정 hook 파일과 compat hook을 동시에 등록하지 않는다. iii-engine 0.22.1은 기존 검증된 binary를 유지하며 교체·upgrade하지 않는다.
6. 서버가 제공하는 기능을 쓰려면 서비스의 기존 환경 파일에 `AGENTMEMORY_FEEDBACK_DIR=/srv/agentmemory/feedback`를 지정한다. 미설정 상태는 새 경로를 만들지 않고 제보 runtime을 등록하지 않는다. 제보 디렉터리는 서버 사용자 전용 0700/파일0600이며 운영 KV·npm 경로와 분리한다. 정기 분석은 최초 OFF다.
7. 적용 영수증을 쓰는 경우 서버 관리 경로 `AGENTMEMORY_RECEIPT_DIR`의 `activation.json`을 사용한다. 허용 receiptId는 `personal-deployment`다. candidateHash는 검증된 배포 후보 SHA256, applied/verificationComplete는 최종 검사 성공 뒤만 true, appliedAt은 실제 적용 UTC다. 이 경로는 UI가 정하지 못한다. 준비 후보 manifest는 적용 영수증이 아니다.
8. 운영 적용 후 livez/health/config flags/인증 실패, includeSummary=false 세션, 제한된 Audit·Observation, Viewer 데스크톱·모바일, capture receipt/recovery, provider readiness와 실제 클라이언트 이벤트를 확인한다. 합성 모델 시험을 실제 모델 품질 검증으로 보고하지 않는다. 재개는 원래 pause 상태와 사용자 지시에 따른다.
9. 코드·Viewer·스킬의 최종 guard와 `release_tools.py preserve`를 실행해 archive 생성·전체 hash read-back을 확인하고 activation과 연결한다. 검증표 불일치·보존 실패는 적용 성공이 아니다. 코드 rollback은 최신 원문/제보/커서/retry/색인을 유지하고 이전 코드 경로만 복구한다.

## 참여 클라이언트

서버 연결만 하는 모든 머신에 서버 코드를 설치할 필요는 없다. 자동 capture/context를 사용하는 각 OS·사용자·WSL·컨테이너에는 해당 클라이언트의 MCP/훅 설정이 필요하다. `clients/AI-CLIENT-UPDATE.md`를 그 환경의 AI에 제공한다. 기본 PREPARE이며 실제 APPLY는 사용자가 지시한 경우에만 한다. Windows용 파일은 검증된 Linux 빌드 산출물을 사용한다. 토큰·outbox·프로필 설정을 옮기거나 저장소에 올리지 않는다. 실제 Windows 이벤트 검증은 별도 필요하다.

## 기록·순정 교체

코드 CHANGELOG와 제보 이벤트는 접수/분석/검증/적용/실패/rollback을 분리해 자동 보존한다. 장기기억은 기존 기억·중복·remember 자동 갱신 영향을 별도 검토한 뒤 구체적인 저장 지시로만 반영한다. 준비 결과는 저장 완료로 표시하지 않는다.

업스트림 검토는 source/docs/customizations와 같은 수락 시험, 기존 데이터 읽기 호환성으로 판정한다. 최신 순정 기능을 조사하지 않은 상태는 미검증이다. 동등한 기능만 순정으로 대체하며 제보 파일과 과거 이력은 남긴다. 고정·전달한 배포 묶음을 수정하지 말고 다음 revision을 새로 만든다.
