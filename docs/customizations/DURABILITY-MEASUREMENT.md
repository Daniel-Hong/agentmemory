# 저장 인증 단계별 계측 — 개발 사본, 운영 미적용

사용자가 승인한 2026-10-21 진단용 변경이다. 기준은 `b45645b43aea5855cf2707f6bf3a497955387631`(daniel.10)이며 현재 운영 릴리스와 원본 작업 디렉터리의 미커밋 Viewer 변경은 수정하지 않았다.

## 변경 전후와 목적

기존 `lastVerification` 하나는 다른 인증이 끝나면 덮어써져 최근 실패와 단계별 비용을 분리하기 어렵다. 기존 필드·반환값·오류 판정은 유지하고 `snapshot().measurements`에 인증 완료 순서로 최근 8건만 보관한다. 기존 인증된 `GET /agentmemory/health`의 `storageDurability.measurements`로 읽는다. 새 API·설정·타이머·자동 로그·디스크 파일·의존성은 없다.

- `id`는 fence 인스턴스 내 시작 순번이고 `completedAt`은 완료 시각(ms)이다. 동시 실행은 완료 순서와 시작 순서가 다를 수 있다.
- `elapsedMs`와 `phases`는 단조 시계로 측정한다. capture는 병렬 GET의 합이 아닌 wall time이며, readback은 namespace 검증·파싱·값 비교와 reader 정리를 포함한다. fsync에는 파일 열기/stat 및 디렉터리 sync가 포함된다. verify는 최종 signature 확인이다.
- cleanup(인증 handle 닫기)과 retryWait(기존 재검사 타이머)을 별도 분리한다. 따라서 측정 전체 시간은 cleanup 전에 계산되던 기존 `FenceResult.waitMs`와 다를 수 있다. 외부 `wait()`의 drain 대기나 namespace별 여러 인증 전체는 한 sample의 범위 밖이다.
- `checkAttempts`는 readback 라운드 진입 수, `rechecks`는 첫 라운드 이후 수, `retryCount/retryReasons`는 실패 라운드와 고정 분류다. capture 초기 실패에는 재검사 라운드가 없으며 `failureReason=capture_timeout` 등으로 구분한다. 저장 검증 성공 후 재시도 이력은 실패 결과로 오해하지 않도록 `outcome=verified`로 남긴다.
- namespace detail은 최대 8종류(scope)이며 초과는 `omittedNamespaces`로 센다. `kind`는 고정 분류, `token`은 fence 생성 때 새로 만든 비공개 무작위 키로 HMAC한 16자리 상관 토큰이다. restart/다른 fence 사이 연결은 지원하지 않는다. 원래 scope·키·세션 ID·경로·원문·값·임의 예외 문구는 포함하지 않는다.
- `fileBytes`는 마지막 관측된 파일 크기, `scanBytes`는 reader가 확인한 JSON prefix 바이트 합(반복 스캔 포함), `scans/completeScans`는 관측 수다. 추가 stat/read 없이 reader의 기존 stat와 바이트 카운터를 재사용한다. open 이전 실패는 reader 메타데이터가 없어 기록되지 않으며, 실패 스캔은 completeScans에 포함하지 않는다. 파일 전체 크기와 JSON prefix 크기는 trailer 때문에 다를 수 있다.
- `evicted`는 최근 8건을 넘긴 수, `unavailable`는 계측 자체가 실패하여 보관하지 못한 수다. 상태 조회는 복제본을 반환한다. 시계/암호화/observer 예외는 인증 결과를 변경하지 않으며 async observer rejection도 기다리지 않고 격리한다.

## 비용과 한계

기존 IO 횟수는 유지된다. scope당 HMAC(상세 최대 8개), 단계별 시계 호출, 고정 크기 카운터와 최대 8×8 namespace detail을 추가한다. 자동 로그 빈도는 0이며 새 disk/network IO는 없다. 상한 fixture의 직렬화된 measurement snapshot이 24,000B 미만인지 테스트한다. 과거 이력이 빠르게 밀릴 수 있고 재시작 시 사라진다. 정상 단조 시계의 매우 작은 측정 비용은 기존 timeout 예산 안에서 발생한다.

이 계측은 실패 namespace 내부의 어떤 키가 큰지, 물리 디스크 대기와 JSON 파싱 CPU의 비율, 외부 공급자 대기·추론 시간, 대형 파일의 모든 구간별 진행을 직접 측정하지 않는다. 미완료 인증은 완료까지 recent에 나타나지 않는다. 별도 새 부하/벤치마크나 실제 데이터로 성능 개선을 검증하지 않았다.

최초 독립 리뷰의 minor 두 건은 후속 개발에서 보완했다. pre-abort·중간 abort·inode 교체 거부에서 callback 1회, 기존 오류 유지, 알려진 파일 크기·실제 scan 바이트와 complete:false를 검증한다. 최종 sample 생성·보관 실패는 `unavailable`에 정확히 한 번 반영하고, 새 bounded history를 완성한 뒤 교체하여 이전 기록·eviction 수를 보존한다. 실패 주입 뒤 저장 성공/실패·dirty key 보존과 다음 인증 복구를 함께 검증한다.

## 보존 계약·검증·적용

timeout 15000ms, poll 정책, capture 동시성, namespace별 인증 분할, fsync/signature/revision 및 실패 dirty key 보존, LLM 전역 직렬화, 입력 예산, 스케줄링은 변경하지 않는다. 테스트는 합성 파일·mock IO·임시 HOME만 사용하며 운영 데이터 복사·모델 호출·실제 작업 생성은 하지 않는다.

실제 명령·통과 수·독립 리뷰 결과는 같은 작업의 `docs/superpowers/plans/2026-10-21-durability-measurement-progress.md` 및 최종 보고에 기록한다. 장기기억 자동 저장은 하지 않았으며 별도 수동 검토 대기다. upstream이 동일한 안전한 단계별 계측과 제한·무추가 IO·오류 격리 회귀를 제공하면 이 커스텀을 대체할 수 있다.

향후 운영 적용은 별도 승인 후 기존 배포 guard/정상 종료/보존·백업 절차를 따라 새 후보로 수행해야 한다. 이 작업은 배포 후보나 root 승인 kit를 발행하지 않는다. 롤백은 계측 코드 커밋만 되돌려 재빌드하는 것이며 데이터·커서·retry·통계를 되감지 않는다. 현재는 운영 미적용이므로 서비스 롤백은 필요 없다.

정확한 승인 경계·준비 명령·중단 영향·코드 롤백·실제 관측 방법은 [DURABILITY-MEASUREMENT-OPERATIONS.md](DURABILITY-MEASUREMENT-OPERATIONS.md)에 준비했다. 명령은 실행하지 않았다.
