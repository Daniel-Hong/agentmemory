# 첫 v2 전환 실패 후 최소 수동 복구

개발·합성 검증용 준비다. 이 문서는 운영 실행 승인이 아니다. 저장 최적화와 원인별 보호 자동 복구는 함께 유지하고, 실패 때만 알려진 **v2/자동 복구 비활성** 패키지로 사람이 복구한다. 새 관리자 daemon, 자동 선택기, sudoers 권한, 외부 알림은 추가하지 않는다.

## 전제

- 최초 운영 전환 전에 주 후보와 호환 복구 후보를 각각 기존 관리자 execution-closure 검토 및 kit 등록 절차로 준비한다. 두 kit는 같은 진짜 기존 baseline·영수증·보존 archive를 사용한다. 복구 package는 실제 패키지 검증을 통과한 v2/automaticMemoryRecovery:false여야 한다. 이 작업에서 실제 등록은 하지 않았다.
- 관리자 명령은 검토·등록되어 root가 소유하고 쓰기 권한을 통제하는 **복구 kit의** `kit-runtime.py`를 사용한다. 사용자 소유 개발 파일을 sudo로 직접 실행하지 않는다. 정상 dashboard `--apply` 경로는 그대로이며 새 수동 경로를 자동 호출하지 않는다.
- 실패 kit는 새 수동 복구 준비 코드가 포함된 runtime을 사용해야 한다. 이 runtime이 저장 인증 종료 여부와 종료 영수증 해시를 실패 기록에 남긴다. 이 증거가 없는 과거 실패를 임의로 정상 종료로 추정하지 않는다.
- 서비스는 inactive/failed이고 MainPID=0, 저장된 worker/engine PID가 모두 종료돼 있어야 한다. 강제 종료, 종료 영수증·activation 영수증 수정, 오래된 데이터 복원은 하지 않는다.

## 명시적 관리자 절차

아래 `<...>`는 실제 검토된 kit ID와 명령이 출력한 SHA로 바꾼다. 준비·실행 내내 기존 `dispatch.lock`을 사용하므로 진행 중인 dashboard 거래와 겹치면 거절한다.

```sh
sudo /usr/bin/python3 -I -B /var/lib/agentmemory-updates/vault/<RECOVERY_ID>/kit-runtime.py --prepare-stopped-recovery /var/lib/agentmemory-updates/vault/<FAILED_ID> /var/lib/agentmemory-updates/private/release-kits/<RECOVERY_ID>/stopped-recovery-plan.json
sudo /usr/bin/sha256sum /var/lib/agentmemory-updates/private/release-kits/<RECOVERY_ID>/stopped-recovery-plan.json
sudo /usr/bin/python3 -I -B /var/lib/agentmemory-updates/vault/<RECOVERY_ID>/kit-runtime.py --recover-stopped /var/lib/agentmemory-updates/private/release-kits/<RECOVERY_ID>/stopped-recovery-plan.json <PLAN_SHA256>
```

계획은 실패·복구 kit 식별자와 해시, 실패 transaction, 인증 종료 영수증, 현재 코드 및 정지 데이터 해시를 결속한다. 관리자는 목적한 복구 후보와 hash를 확인한다. 계획에 원문 기억·인증 값은 넣지 않으며, private 계획의 데이터 파일 이름·해시 목록을 공개 로그로 복사하지 않는다. 기존 계획을 덮어쓰지 않는다.

실행은 같은 근거를 다시 확인한 뒤 최신 상태를 백업하고 기존 코드 staging·activation·시작·API·데이터 검증을 재사용한다. startup guard에 일반 failed 상태 허용 예외를 추가하지 않고, 실제 검증된 activation이 만드는 `ready_to_start`를 사용한다. 새 backup은 보존 근거이며 live 데이터에 복원하지 않는다. 정상 검증이 끝난 경우에만 진짜 복구 activation 영수증을 만든다. 원래 실패 거래를 성공으로 바꾸지 않고, 최종 live acceptance도 별도로 남긴다.

## 실패와 재실행

- 잘못된 kit·package·baseline·경로·계획 SHA, 데이터/코드 변화, 인증 종료 부족이면 시작 전 거절한다.
- 일부 코드 staging 또는 activation만 끝난 경우 자동 정리·재시도를 하지 않는다. 서비스는 정지 상태로 유지하고 진단 기록과 최신 backup을 보존한다. 관리자가 코드 전용 부분 설치를 점검하고 명시적으로 수리한 뒤 새 계획을 검토해야 한다. 데이터나 v2 정지 원인·예산을 지우면 안 된다.
- 시작 뒤 검증 실패가 발생하면 가능한 경우 fallback 자체를 저장 인증 종료하고 정지·점검 상태로 남긴다. 구 `.11`로 되돌리거나 다른 hold를 해제하지 않는다. 종료 인증도 실패하면 결과를 성공으로 표시하지 않고 자동 후속 작업을 중단한다.
- 이미 완료된 같은 계획의 반복 명령은 실제 영수증·실행 상태 검증만 하고 재시작하지 않는다. 다른 계획/후보나 부분 실패를 같은 성공으로 취급하지 않는다.

복구 후 서비스가 정상이어도 memory/manual/deployment/legacy_unknown/storage_error hold와 복구 예산을 확인한다. 기존 hold를 임의로 해제하지 않으며 복구 빌드는 자동 회복을 수행하지 않는다. 주 후보 재적용과 명시적 수동 재개는 그 시점의 상태를 확인하고 별도 운영 승인 범위에서 수행한다.

## 운영 판단의 한계

필요 도구는 기존 Python3, systemd, 검토된 kit 및 root 관리자다. 새 외부 의존 설치는 없다. 사람의 확인, 최신 백업 크기, 코드 압축 해제, 저장 인증, API 준비 시간에 따라 중단 시간이 달라진다. 합성 시험 시간으로 운영 복구 시간을 보장하지 않는다. 실제 운영 부팅·복구 및 Windows 공급자 연결은 시험하지 않았다. 사용자 데이터와 코드가 추가로 손상됐거나 root 관리 자산이 달라진 경우 이 명령으로 우회하지 않고 수동 수리한다.

이 절차는 검토한 첫 전환 실패 경로를 사람이 실행할 수 있게 하는 최소 수리 수단이다. 모든 장애를 무인 복구하거나 원래 failure를 없애는 기능은 아니다. 장기 기억 기록은 수동 검토 전 보류이며 Investment 중단과 외부 알림 보류를 유지한다.

## 합성 검증 근거

실제 baseline runtime에 수동 명령이 없어서 RED를 재현한 뒤 수동 복구 집중 15건, personal-release Python 전체 118건이 통과했다. 독립 리뷰는 같은 15건 및 CLI 인수·비root 거절 4개 검증을 통과했고 잔여 지적은 없다. 새 CLI 프로세스의 성공 중복은 재시작하지 않으며 전체 데이터 재검증을 새로 수행했다고 주장하지 않는다. 코드·계획·데이터·기존 영수증·종료 증거 불일치, 잠금 경합, 부분 설치, 시작 후 검증 실패와 hold 불일치를 합성 주입했다. 실제 systemd, 사용자 전환 및 운영 데이터 복구는 수행하지 않았다.

최종 build, skills:gen, docs:sync, skills:check, 전체 JS suite, docs:check가 통과했다. 실제 임시 HOME과 기본 fork에서 JS 3,196건 통과, 기존 4건 skip이며 최종 커밋과 단계별 근거는 작업 evidence의 manual-recovery 결과 JSON을 기준으로 한다. 기존 종료 인증 SHA가 없는 과거 실패 상태는 이 명령의 대상이 아니며, 별도 수동 검토가 필요하다. 새로 준비하는 첫 v2 후보는 해당 증거를 기록하는 최신 kit runtime을 사용한다.
