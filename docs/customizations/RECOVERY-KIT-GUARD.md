# v2 복구 빌드와 업데이트 롤백 경계

개발 준비 전용이다. 운영 kit 등록, activation, 서비스·설정·데이터 변경이나 재시작은 수행하지 않는다. 새로운 보안 권한, root 관리 자산, 외부 의존성을 추가하지 않는다.

## 후보 및 이전 코드의 증명

업데이트 runtime은 기존 package SHA와 package.json 파일 해시를 확인한 뒤 `agentmemoryCompatibility`를 읽는다. 필드가 없는 과거 패키지는 legacy v1이다. 필드가 있으면 정확히 `backgroundControlVersion:2`와 boolean `automaticMemoryRecovery` 두 필드여야 한다. null, 잘못된 타입과 미지원 버전은 pause/stop 전에 거절한다.

현재 서버의 인증된 background-control 응답은 명시적 `formatVersion`을 제공한다. 없는 경우만 legacy v1로 본다. 미지원 미래 버전이나 잘못된 타입은 거절하며 v2 서버에서 v1 후보로의 직접 다운그레이드는 시작하지 않는다.

자동 코드 복귀 대상으로 인정하려면 다음 근거가 모두 필요하다.

- 인증된 현재 control의 정수 `formatVersion:2`.
- 기존 baseline guard로 확인한 정확한 drop-in의 단일 node ExecStart 및 예상 data-dir.
- releases 또는 legacy 아래에서 symlink 없이 찾은 package.json, dist/cli.mjs, 실제 worker인 dist/index.mjs가 baseline 보호 해시 표에 포함됨.
- 해시가 확인된 manifest의 version이 현재 health 버전과 같고, 정확한 v2 호환 프로필 및 `automaticMemoryRecovery:false`를 선언함.
- 기존 receiptIdentity에 고정된 installedFileHashes가 실제 이전 receipt와 일치하며, 이전 릴리스의 모든 일반 파일이 이 ledger 및 baseline 해시 표와 정확히 일치함. 공용 legacy/node_modules를 가리키는 기존 의존성 링크만 제외하고, 그 외 symlink나 미기록 chunk를 허용하지 않음.
- 이전 릴리스의 파일 집합과 보호 해시 전체를 preflight, 코드 복원 직전, 서비스 시작 직전에 다시 검증함. 따라서 index 외의 정적·동적 import chunk도 누락하거나 나중에 추가할 수 없음.

버전 문자열, holds 배열 또는 manifest 선언만으로 복귀를 허용하지 않는다. 관리자가 검토·동결한 코드와 해시 표의 신뢰 전제는 기존 kit와 같다.

## 실패 시 보수적 중지

새 worker 시작을 시도한 뒤에는 v2 상태가 쓰였을 가능성을 보수적으로 인정한다. 새 worker 자체의 최신 저장 인증을 포함한 정상 종료와 데이터 검증이 먼저 필요하다. 이 인증이 실패하면 코드나 데이터를 바꾸지 않는다.

인증 종료에 성공해도 이전 코드가 위의 복구 프로필로 증명되지 않으면 wrapper/drop-in을 이전 것으로 바꾸지 않고 이전 서버도 시작하지 않는다. 서비스는 중지 상태로 남고 transaction은 `manual_required`, `codeRollbackVerified:false`, 고정 `rollbackErrorCode`를 기록한다. v2 정지 원인·복구 예산을 포함한 최신 데이터는 그대로 유지한다. 재검사도 호환되지 않는 코드를 시작하지 않는다.

증명된 v2 복구 빌드가 이전 baseline이면 기존 코드 전용 복원 경로를 사용한다. 데이터 백업으로 되감기거나 정지 원인·예산을 지우지 않는다. 새 worker를 시작하기 전 실패한 경우에는 새로운 v2 기록이 발생하지 않았으므로 기존의 인증된 이전 서버 복원 흐름을 유지한다.

## 첫 v2 전환의 한계와 향후 절차

stock `.11`에서 첫 v2 전환이 시작된 후 실패하면 위 조건상 자동으로 `.11`을 시작하지 않는다. 이때 남은 새 drop-in과 실패 transaction은 기존 startup guard가 재시작을 거부할 수 있으며, 정상 applied receipt가 없어 일반 `baseline_from_kit` 경로도 그대로 사용할 수 없다. 준비된 복구 패키지가 있다는 이유만으로 이를 우회하거나 강제 시작해서는 안 된다.

이 실패 상태의 실제 복구는 최신 코드·drop-in·상태·인증 종료 근거를 관리자가 검토하여 동결한 실패 상태 baseline과 별도 승인된 복구 거래가 필요하다. 이번 최소 변경은 새로운 실패 상태 activation 권한이나 무인 fallback 선택기를 도입하지 않는다. 따라서 이번 시험은 안전한 중지와 이미 검증된 복구 baseline으로의 코드 복귀를 입증하며, stock `.11`로부터의 모든 최초 실패를 무인 복구한다고 주장하지 않는다.

합성 검증은 임시 디렉터리, 가짜 systemd/API 및 생성한 상태 파일만 사용한다. v2 여러 hold와 2회 시도 예산의 바이트 보존, 미지원 이전 코드·비보호 manifest/CLI/index, 변경된 이전 CLI/index, 미기록·나중에 추가된 chunk, 고정 receipt ledger 부재의 복귀 차단, 인증 종료 실패, 미래/잘못된 capability 거절, 직접 다운그레이드 거절, 기존 v1 거래를 검사한다. 실제 운영 중단 시간이나 운영 시스템 권한은 이 시험으로 검증하지 않는다.
