# 저장 비용·보호 회복 검증 및 적용 조건

baseline `1a571147`의 격리된 개발 사본 `personal`에서 구현했다. 운영 `.11`, 실행 작업, 설정, 원문 데이터와 기억은 변경하지 않았다. 외부 알림은 보류했다. 원본 `b45645b4`의 기존 사용자 수정 세 파일도 보존했다.

## 검증 근거

- 저장 RED: 변하지 않는 불일치에 120ms 동안 19회 스캔, 교체된 큰 파일의 끝까지 읽기를 재현했다. 안정된 큰 파일의 EBADF도 별도 RED 후 수정했다. 저장 집중 시험 76건이 통과했다.
- 보호 RED: hold 구분 및 회복 부재, 같은 turn의 수동·배포 pause 경쟁 네 사례를 재현해 수정했다. 마지막 검토에서는 재개 인증 대기 중 메모리 샘플링이 멈추는 문제도 발견했다. 샘플링과 하나의 재개 작업을 분리하고 critical API 거절 및 stop/drain 회귀 시험을 추가했다. 순서가 역전된 표본과 안정 구간 재확인까지 수정한 집중 시험 50건이 통과했다. 최종 결과는 아래에 기록한다.
- 통합 RED: baseline에서 보호 회복 부재로 두 사례가 실패했다. 실제 임시 파일의 지연 게시와 최종 activation gate를 연결했다. 최종 인증만 제거한 합성 mutant에서는 두 사례 모두 실패함을 독립 확인했다.
- 독립 저장 리뷰: 8파일 91시험 통과. 20회 취소와 안정 파일 5회 처리 후 fd 개수 19로 유지됐다. 남은 runtime 문제는 없었다.
- 독립 보호 리뷰: 앞선 75시험과 request-time revision 경쟁 수정 재검토가 끝났다. 마지막 샘플링 수정도 별도 독립 리뷰 및 4파일 50시험을 통과했고 잔여 Critical/Important/Minor는 없었다.
- 독립 통합 리뷰: 게시 완료를 먼저 기다려 조기 재개를 숨기던 테스트 빈틈을 지적했다. gated 검사와 mutant RED로 해결했다.
- 최종 전체 검증: build, skills:gen, docs:sync, skills:check, 전체 suite, docs:check가 모두 통과했다. suite는 309파일 3,181건 통과 / 기존 4건 skip이다. 전체 시험은 77.83초였고 기본 fork 및 실제 임시 HOME으로 실행했다. 근거는 작업 폴더의 evidence/improvement-complete-checks.json 및 단계별 로그다.
- TypeScript noEmit은 기존 24오류와 출력이 byte-identical이며 신규 오류는 0이었다. Node 22.23.3에서 검증했고 최소 Node 20 및 다른 OS 실행은 미검증이다.
- 일부 Chromium 시험은 기본 sandbox의 socket 권한으로 실행되지 않았다. 호스트의 임시 HOME 및 기본 fork 전체 시험에서는 해당 브라우저 시험도 통과했다. 브라우저 보호 설정은 바꾸지 않았다.

합성 성능 비교는 [저장 비용 문서](DURABILITY-READBACK-COST.md)와 `benchmark/durability-readback.mjs`를 참조한다. 단회 로컬 실행이며 고정 실행 순서, JIT, filesystem cache의 영향을 받으므로 wall time을 운영 성능으로 일반화하지 않는다. 바이트 및 스캔 횟수 절약이 주 근거다. 안정된 파일에는 추가 stat 비용이 있으며 오류와 deadline은 그대로다.

## 향후 운영 적용 조건 — 실행하지 않음

1. 최신 운영 baseline, kit, activation, 보존 archive와 사용자 변경을 다시 확인한다. 개발 커밋을 원본에 통합할 때 기존 변경을 보존한다. 사용하지 않은 릴리스 버전과 clean commit을 선정하고 공식 전체 검증을 다시 수행한다.
2. 테스트의 ignored dist/plugin 생성물이 섞이지 않도록 git archive 기반 빈 build에서 패키징한다. package hash, client 13파일, 의존성, 관리 runtime 3파일을 대조한다. 동결된 후보·kit·관리 정책을 직접 수정하지 않는다. 현재 kit의 action-only pause는 보수적 manual/legacy로 남으며 배포 원인이라고 추정하지 않는다. 명시적 deployment adapter 변경은 root runtime 정책의 별도 관리 검토가 필요하다.
3. 별도 운영 적용·서비스 재시작 승인을 받은 뒤 공식 등록/업데이트 거래를 한 번 수행한다. 정상 종료 인증, 최신 데이터 보존, 새 버전/health/code guard, 실제 작업 진전과 readback 계측을 확인한다. 데이터나 기억을 이전 백업으로 되감지 않는다. 중단 시간은 drain/저장/backup 크기에 좌우되며 개발 시험으로 예측하지 않는다.
4. 새 hold 형식은 version 2다. **stock daniel.11로 단순 코드 다운그레이드하면 원인과 회복 예산이 덮어써질 수 있다.** 적용 전에 version 2를 그대로 읽고 보존하면서 자동 회복을 끄는 검토된 복구 build/bridge를 별도로 준비·검증해야 한다. 기존 kit의 automatic rollback 경로도 이 조건과 대조해야 한다. 현재 호환 복구 릴리스를 발행하지 않았으므로 즉시 운영 적용 가능한 후보로 취급하지 않는다. 원문 데이터 rollback은 금지한다.
5. 적용이 별도로 승인되면 제한된 구간에서 작업 중복, 메모리 재악화, 수동 hold 동시성, 큰 파일 비용을 관측한다. 합성 비교만으로 timeout 해소나 운영 처리량 개선을 선언하지 않는다. 기존 `applied_pending_acceptance`를 개발 결과로 완료 표시하지 않는다.

장기 기억 저장은 별도 수동 검토 전 보류다. 체인지로그와 개발 문서만 기록했다. Investment는 중단 유지다.
