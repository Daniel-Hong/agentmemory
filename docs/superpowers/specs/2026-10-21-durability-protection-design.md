# 저장 readback 비용과 보호 회복 설계

사용자는 두 개선의 개발 사본 구현·테스트·독립 리뷰를 승인했다. 운영 배포/재시작, 운영 데이터 시험, 외부 알림은 제외한다. baseline1a571147의 기존 독립 개발 사본personal을 사용하고 원본b45645b4의 사용자 변경3파일을 보존한다.

## 저장 경로

실측 실패70건 모두readback이며,62건은파일변경,8건은기대값불일치 재검사가 있었다. 기존 parser와성공검증은보존한다. 대안인전체namespace캐시/positive검증캐시는큰메모리비용과신선도위험때문에사용하지않는다. 복잡한다중waiter공유스캔도취소/기대값합치기정책을새로도입하므로이번최소수정에서제외한다.

1. readNamespaceEntries에 선택적인signature check byte간격을추가한다. 기본일반reader는기존동작이며durability reader는1MiB간격으로열린파일과현재경로의full signature(dev/ino/size/mtimeNs/ctimeNs)를확인한다. 교체/수정이면기존state_namespace_changed로일찍실패한다. 최종전체검증·UTF8·JSON·중복키·취소·handle정리는유지한다.
2. waitForKeys 호출안에만불일치정보를유지한다. 전체읽기검증후기대값이불일치했던파일signature와기대값세대를기억한다. 다음poll에서동일signature/동일기대값이면불일치상태만재사용해읽기를생략하고기존wait/deadline으로진행한다. 성공결과캐시는없다. signature변경/기대값recapture시새전체읽기이며성공시기존fsync/file+directory/signature최종검증을모두수행한다. 오류/취소를성공으로바꾸지않는다.
3. 원문없는unchangedMismatchSkips 계측을추가해읽기생략과물리scan 수를구분한다. readback시간은scan+metadata대기, retryWait는기존poll대기다.

## 보호 회복

별도PROTECTION-RECOVERY.md에서정확한인터페이스와고정안전값을명시한다. 사용자·배포·메모리·legacy unknown·저장오류hold를구분하고겹친hold를보존한다. 메모리보호만높은회복경계와연속정상샘플뒤기존저장검증경로로제한복구한다. 반복보호정지backoff/상한을영속보존한다. 수동/배포/legacy/저장오류hold는자동해제하지않는다. restart/crash guard와동시명령도같은직렬전환으로처리한다.

기존root-published kit와관리정책은동결되어있다. 기존{action:pause}는보수적인manual/unknown 의미를유지한다. 명시deployment hold용후보API는인증과whitelist를유지해야하며,기존rootkit의actor를추정하지않는다. 향후kit adapter/rootpolicy변경은별도관리검토·승인대상이다. 외부알림구현/연결은없다.

## 검증과 한계

합성JSON/rkyv-trailer fixture와mock store/fake clock으로TDD한다. unchanged불일치실패의scan회수,추후정상게시,같은파일에서기대값변경,큰파일교체/쓰기,corruption/중복/UTF8/취소/deadline/handle정리를검증한다. 합성비교는byte/scan 수를우선하고시간은기계/파일크기/스케줄링의영향을명시한다. 운영timeout해소나처리량개선으로일반화하지않는다. 전체suite와build/skills/docs,독립리뷰후커밋한다. 운영데이터되감기/migration/설정/직렬화/입력예산/LLM호출은하지않는다.
