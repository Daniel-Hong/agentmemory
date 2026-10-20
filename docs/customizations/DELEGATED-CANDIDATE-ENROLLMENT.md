# 제한된 후보 자동 등록

2026-10-20. 최초 관리자 검토·설치 후 AI가 UUID 한 개로 후보를 등록하는 부가 기능이다. 제품 버전·API·Viewer·서비스 제어 동작은 바꾸지 않는다. 등록과 운영 적용을 구별하며 일반 root shell이나 root 코드 자동 업그레이드는 제공하지 않는다.

## 코드와 신뢰 경계

`scripts/personal-release/candidate-enrollment.py`는 정책/실행 자산의 root 소유·권한·hash, 요청 UID/GID1000, 입력 예산과 경로를 검사한다. 입력의 root runtime3개는 최초 정책과 동일해야 한다. `enroll-reviewed-kit.py`가 root-private snapshot/public kit를 만들고 기존 runner --enroll을 호출한다. 사용자 Python/설치기를 root에서 import하지 않는다.

현재 기준은 root 소유 drop-in과 root catalog/정확한 public kit를 대조해 선정한다. 사용자 activation 단독으로 기준을 선정하지 않는다. 기존 root kit의 guard와 보존 검증을 통과한 뒤 JSON baseline을 계승한다. 최초 legacy 기준은 관리자 정책에 고정한 baseline의 drop-in/파일/영수증/보존본이 모두 맞는 경우에만 허용한다.

`scripts/personal-release/install-candidate-enrollment.py`는 검토된 root 소유 묶음에서만 실행한다. 기존 updater 자산5개를 보존하고 새 helper/라이브러리/정책/sudoers만 설치한다. 정확한 재설치는 허용하고 다른 바이트/권한은 거부한다. 새 sudoers는 개별/전체 visudo 검사 후 마지막에 배치하며 설치 예외에서 새 권한만 철회한다. 강제 중단으로 규칙이 남더라도 정확한 root 설치 완료 marker가 없으면 helper는 등록을 거부한다. root 코드 변경은 새 정책·관리자 검토가 필요하다.

## 검증과 현재 상태

작성 시 운영 읽기 전용 API는 daniel.7/healthy/background running/mutationFailures0이었다. 과거 인수인계 .4 상태와 구별한다. 본 기능의 구현/격리 검증, 고정 설치 묶음, 최초 관리자 설치, 실제 sudo-n 등록, 운영 적용은 별도 단계다. 실제 최신 결과는 workspace `outputs/delegated-candidate-enrollment-2026-10-20/REPORT.md`를 확인한다.

합성 시험은 원문 sentinel, 입력 중 변경/링크/FIFO/예산/JSON·metadata/실행 코드 변경/baseline 위조/tar 경로·중복/의존성·클라이언트/등록 재시도/게시 실패/lock/설치 충돌·visudo 실패를 검사한다. Python 전체 회귀는 source에서 임시 HOME으로 `python3 -B -m unittest discover -s scripts/personal-release -p 'test_*.py' -v`. 합성 owner 주입은 실제 UID0→1000/OS 정책 인수를 인증하지 않는다.

장기기억 저장은 별도 수동 검토 및 명시 지시 대기다. 운영 데이터·기존 실패·기억 삭제/통합은 수행하지 않는다. upstream이 동일한 위임 경계·제한·재개·보존을 제공하면 같은 시험으로 동등성을 입증하고 변경 이력 후 대체한다.
