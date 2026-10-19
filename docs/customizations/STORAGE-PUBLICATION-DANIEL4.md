# daniel.4 저장 인증 증폭 제거

2026-10-20. 순정0.9.30 기반 개인 배포의 최소 후속 수정이다. daniel.3 운영 적용과 데이터 보존은 확인했으나 저장 read-back timeout으로 최종 인수는 실패했다. 최신 데이터·Audit·retry·제보를 삭제하거나 과거 백업으로 되감지 않는다. 발행한 묶음은 보존한다.

기존 boot backfill의5동시 enqueue는 같은 대형 observation 파일을5회 검증했다. backfill 전용 enqueueBatch는 canonical namespace별50개 이하로 intent를 준비(동시 SDK작업5개 이하)하고 모든 source/retry키를 한 번 인증한다. scalar enqueue와 foreground capture ACK는 그대로다. 기존 retry의 attempt/fingerprint/phase를 변경하지 않으며 실패(undefined rejection 포함)는 성공으로 바꾸지 않는다. 중단 시 남은 원본과 marker에서 다음 부팅에 복구한다.

누적 dirty wait/flushStable만 namespace별200키 이하로 분할한다. 각 publication의 기존15초 제한과 엄격한 전체 JSON 검증·fsync·파일 signature·revision 조건은 유지한다. 실패 namespace 뒤의 다른 namespace도 진행하고 첫 실패를 보고한다. stable200키 선택은 이전에 시도한 namespace를 뒤로 보내 독점을 방지한다. background persist는 full wait를 한 번 호출하고 synced=true/mutationFailures=0일 때만 성공한다. 직접 waitForKeys 계약은 바뀌지 않는다.

한 전환의 총 시간은 namespace 수에 따라 HTTP 응답 제한보다 길어질 수 있다. 기존 Viewer의 resuming 상태 재조회가 최종 판정을 담당한다. 응답 timeout만 보고 재개를 반복하거나 저장 검사를 우회하지 않는다.

실제 worker를 사용한 합성167,802,641B 시험: singleton5동시12,257ms(각 scope5scan), batch5는2,066ms(각 scope1scan). 원본/retry파일 및 선택 데이터 해시 불변, mutation/추론0. 5동시만으로 운영15초 실패의 인과 전체를 입증한 것은 아니다. 별도26키/10namespace/가상2초시험은 기존 전체15초예산 실패와 분할 성공을 입증했다.

검증: source 전체3,016 pass/4기존skip, build/compat/docs/skills/feedback40 통과, TS기존24진단 동일. 독립 리뷰 P1/P2 없음. 테스트·벤치마크·패키지/후보/배포 영수증은 outputs/daniel4-storage-acceptance 및 outputs/operations-dashboard-daniel4-2026-10-20에 기록한다. 운영 복구 판정은 적용 후 capture 완료 증가, 임베딩 lastSuccess/잔여 감소, 저장 인증과 index 상태 관측으로 한다. 실모델 추론이나 운영 강제종료로 시험하지 않는다.

클라이언트 호환13파일과 root updater5자산은 해시가 같으면 그대로 보존한다. 대시보드는 관리자 사전 등록 후보만 적용하며 등록 자동화는 추가하지 않는다. 장기기억 저장은 별도 수동 검토 전 보류다. 순정에 동등 구현이 들어오면 같은 보존·ACK·실패회귀 시험으로 교체를 판정한다.
