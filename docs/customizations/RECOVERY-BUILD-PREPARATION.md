# v2 호환 복구 빌드 및 롤백 경계 — 개발 준비 전용

기준 개발 커밋은 `499e7f14`다. 운영 `.11`, 사용자 수정, 운영 kit/등록/activation/설정/서비스/데이터는 변경하지 않는다. 외부 의존 설치와 LLM 호출도 없다.

## 복구 프로필

정상 개발 빌드의 package.json은 `agentmemoryCompatibility:{backgroundControlVersion:2,automaticMemoryRecovery:true}`를 선언하고, control snapshot은 `formatVersion:2`를 표시한다. `prepare-recovery-build.mjs SOURCE OUTPUT VERSION`은 깨끗한 git HEAD의 SHA를 한 번 고정하여 격리 archive를 만든다. 입력이 더럽거나 출력이 이미 존재하면 거부한다.

복구 사본에서는 동일한 v2 제어·저장 코드를 유지하고 `MEMORY_RECOVERY_ENABLED` 상수만 false로 바꾼다. 별도 버전과 manifest의 automaticMemoryRecovery:false를 기록하고, 기존 node_modules를 재사용해 offline npm build/pack을 수행한다. 의존 설치, daemon 시작, 실제 kit 등록과 activation은 하지 않는다. 결과 JSON은 고정 source commit, 프로필 전후 hash, 패키지 hash를 기록한다. 버전 번호는 개발 artifact용이며 운영 후보 등록이나 전역 예약을 의미하지 않는다.

복구 프로필은 memory/manual/deployment/legacy_unknown/storage_error hold와 누적 attempts/nextAttemptAt을 읽고 보존한다. 메모리가 정상이어도 자동 재개를 호출하지 않는다. 메모리 감시, critical API 거절, 저장 인증 및 정상 종료 보장은 유지한다. 사용자 명시적 manual resume의 기존 해제·예산 초기화 의미는 유지하며, 복구 과정에서 이를 자동 실행하지 않는다. Viewer는 자동 회복 비활성을 명시한다.

## kit가 허용하는 롤백 대상

후보 package.json은 기존 tarball/packageFiles hash 검증을 통과해야 한다. 선언한 profile은 고정 두 필드와 엄격한 v2/boolean 타입만 허용한다. 현재 control의 formatVersion은 absent legacy 1 또는 명시적 1/2만 허용하며, v2에서 v1 후보로의 거래는 pause/stop 전에 거부한다. 알 수 없는 미래 형식과 잘못된 타입도 거부한다.

새 v2 worker 시작 후 이전 코드로 복귀하려면 이전 control이 명시적 v2여야 한다. 기존 hash 보호 drop-in의 정확한 ExecStart가 releases/legacy 내부의 package/CLI를 가리켜야 하며, package와 CLI, 실제 worker인 index가 모두 baseline hash 보호 대상이어야 한다. 재사용 node_modules를 제외한 실제 이전 release 전체 파일 집합은 영수증에 결속된 installedFileHashes와 일치해야 하며, 각 해시는 baseline에도 포함돼야 한다. 추가된 공유 코드나 누락된 worker도 거부한다. package는 실행 health 버전과 일치하고 v2 및 자동 회복 비활성을 선언해야 한다. 해당 이전 release의 보호 파일을 코드 복원 전과 서비스 시작 전에 다시 검증한다. 버전 문자열, holds 필드 또는 오래된 installed 경로만으로 호환성을 추정하지 않는다.

이 증거가 없으면 새 worker를 먼저 저장 인증과 함께 종료하고 최신 데이터 무결성을 확인한 후, 이전 wrapper/drop-in 복원과 이전 서비스 시작을 모두 거부한다. 새 코드가 선택된 채 stopped/manual_required 및 inspectionRequired 상태를 남긴다. 인증 종료 자체가 실패해도 구 코드를 선택하거나 시작하지 않는다. 데이터 백업을 복원하거나 정지 원인·복구 예산을 삭제하지 않는다. 호환 복구 버전이 이미 검증된 이전 baseline인 경우에만 기존 코드 전용 복원 경로를 사용한다.

## 아직 준비되지 않은 첫 적용 실패 후 활성화 경로

**이 작업은 실패 상태에서 복구 빌드를 자동 선택·등록·활성화하는 새 관리자 경로를 만들지 않는다.** stock `.11`에서 첫 v2 worker 실행 후 실패하면 안전한 결과는 정지/수동 점검이다. 기존 일반 업데이트는 실행 중인 서비스와 정상 applied 영수증을 요구하고 startup guard도 failed phase의 무조건 재시작을 허용하지 않는다. 따라서 현재 복구 artifact가 있다는 이유로 일반 kit를 재실행하거나 drop-in/영수증을 수동 수정해서는 안 된다.

운영 적용 전에 별도 관리자 검토를 거친 failed-state baseline/복구 activation 거래가 필요하거나, 이미 검증된 호환 복구 버전을 이전 baseline으로 확립해야 한다. 후자는 최초 전환 실패 경계까지 해결했다는 뜻이 아니다. 해당 경로의 권한·신뢰 경계 검토와 별도 승인이 끝나기 전에는 전체 운영 롤백 준비가 완료됐다고 판단하지 않는다. 이번 소스 보강은 새 보안 권한이나 동결 root policy 변경을 요구하지 않지만 실제 새 kit의 관리자 execution-closure 검토는 여전히 필수다.

## 검증 및 대체 기준

합성 git fixture, fake clock, mock control 및 임시 경로의 kit transaction만 사용한다. v2 복구 프로필의 장시간 정상 메모리·겹친 hold·소진 예산·clean restart·critical503, 동시 HEAD 변경, 출력 덮어쓰기 거부를 검사한다. kit 시험은 v2 데이터 기록 후 실패, 인증 종료 실패, 반복 롤백, 보호 파일 변조, 알 수 없는 capability, 호환 복구 대상 복원을 검사한다. 실제 패키지 검사는 부트스트랩을 import하지 않고 패키지 manifest와 컴파일된 guard의 제한된 함수·상수만 검증한다.

최종 실행 수치와 artifact 경로/hash는 작업 evidence의 결과 JSON을 기준으로 한다. 검증 도구는 검토한 로컬 artifact 전용이며 Node vm을 악성 JS 보안 sandbox로 취급하지 않는다. 함수·상수 이름이나 bundler 형태가 달라지면 shape 오류로 거부한다. 실제 서비스 부팅이나 공급자 연결은 시험하지 않는다. 운영 중단 시간과 실제 복구 성공률은 측정하지 않았다. upstream 대체 시 동일한 v2 상태 보존·인증 종료·호환 대상 증명·실패 시 정지 수락 시험이 필요하다. 장기 기억 기록은 별도 수동 검토 대기다.

## 이번 개발 검증 결과

기본 fork 및 실제 임시 HOME의 최종 전체 JS suite는 3,196건 통과, 기존 4건 skip이다. 311파일이 통과했고 suite는 77.11초였다. build, skills:gen, docs:sync, skills:check, docs:check를 같은 순서로 실행했다. TypeScript는 기존 baseline과 동일한 24오류이며 신규 오류는 없다. personal-release Python 전체 103건과 kit 집중 37건이 통과했다. 독립 리뷰는 pinning, capability 및 이전 entrypoint 변조 경계를 재검토했고 잔여 지적은 없다. Artifact 검증 도구는 별도 RED 후 6건 GREEN을 확인했으며, 실제 패키지 검증 결과는 커밋 후 작업 evidence에 기록한다.
