# 저장 readback 비용 최소화 — 개발 구현, 운영 미적용

운영 관측의 실패 70건은 모두 readback 단계였다. 62건에는 namespace 변경 재검사가, 8건에는 기대값 불일치 재검사가 있었다. 이번 변경은 15초 deadline, 100ms poll, SDK capture 동시성 4, dirty revision 정리, 파일·디렉터리 fsync 및 최종 signature 검사를 유지한다. 전역 LLM 직렬화와 입력 예산도 그대로다.

## 선택한 변경

- `readNamespaceEntries`의 선택 인자 `checkIntervalBytes`를 추가했다. 기본값 0은 기존 최종 검사만 수행한다. fence에서는 1MiB마다 열린 handle과 현재 path의 dev/ino/size/mtimeNs/ctimeNs를 대조한다. 변경·삭제·교체를 발견하면 `state_namespace_changed`로 중단해 낡은 파일을 더 파싱하지 않는다. 전체 JSON 문법, UTF8, 중복 key, trailer 및 성공 직전 검증은 유지한다.
- 스트림의 `autoClose:false`, `autoDestroy:false`, iterator의 `destroyOnReturn:false`를 사용하고 finally에서 destroy/close한다. 비동기 metadata 검사 중 EOF가 먼저 도착해 최종 검사 전에 handle이 닫히는 회귀를 합성 시험으로 발견해 수정했다. 성공·오류·취소 후 정리도 검증한다.
- 각 `waitForKeys` 호출 안에서만 전체 읽기 후 불일치였던 파일 signature를 기억한다. signature와 기대값이 같으면 기존 불일치 오류를 재사용하면서 poll/deadline을 계속 적용한다. 파일 변경·삭제 또는 기대값 revision recapture 시 다시 읽는다. 없는 파일, 불완전한 파일, corrupt 읽기에서는 이 정보를 만들지 않으며 호출 간에 공유하지 않는다.
- 성공 캐시는 없다. 성공은 항상 fresh validated scan, 파일 fsync, 디렉터리 fsync, 최종 full signature 및 deadline 확인을 통과해야 한다. 기대값 불일치가 게시 지연 때문인지 더 최신 쓰기 때문인지는 이 변경으로 판정하지 않는다.
- `unchangedMismatchSkips`는 원문 없는 정수 계측이다. metadata-only 재검사도 checkAttempts/retryReasons에 기록한다. scans/scanBytes는 실제 parser 순회만 집계한다. 바이트 수는 JSON parser에 전달한 prefix이며 OS prefetch나 물리 장치 읽기량이 아니다.

## 합성 비교와 비용

명령: `node benchmark/durability-readback.mjs <baseline-source-root>`. baseline은 `1a571147`의 코드 세 파일만 격리 추출했다. 임시 경로의 합성 16MiB JSON을 사용했으며 운영 데이터·설정·기억·추론은 사용하지 않았다.

한 번의 최종 실행 결과:

| 사례 | 이전 | 변경 후 |
|---|---|---|
| 교체된 파일 거절 | 16,777,239 parser bytes / 85.05ms | 1,048,576 bytes / 6.48ms |
| 변하지 않는 불일치, 200ms 예산 | 31스캔 / 2,032,298 bytes / 201.46ms 실패 | 1스캔 / 65,558 bytes / 201.25ms 실패 |
| 안정된 16MiB 파일 | 95.30ms, verified | 87.51ms, verified |

단회 로컬 실행이며 반복 통계나 운영 처리량이 아니다. 안정 파일의 성능 개선은 확정하지 않는다. 새 검사는 1MiB마다 최대 두 번의 stat을 추가하므로 특정 파일시스템에서는 비용이 증가할 수 있다. 지속 writer가 파일을 계속 변경하면 여전히 15초에 실패할 수 있다. 이 변경은 낡거나 중복된 스캔을 줄이며 게시되지 않은 값을 성공 처리하지 않는다. 진행 중 스캔 공유, positive cache, 입력 한도 확대, 병렬 및 timeout 조정은 도입하지 않았다.

## 검증과 운영 조건

RED에서 변하지 않는 잘못된 값을 120ms에 19회 스캔하고 교체 파일을 끝까지 읽는 현상을 재현했다. 새 성공·교체·삭제·in-place 수정·recapture·deadline·파서·취소 시험과 기존 fsync/inode 시험을 유지한다. 스트림 iterator 변경으로 기존 active-namespace mock 두 개의 hook 위치를 `iterator(options)`로 옮겼으며 원래 deadline·교체 assertion은 그대로다.

독립 리뷰는 8파일 91시험 통과와, 20회 abort 및 안정 4MiB 파일 5회 처리 후 fd 개수 19 유지를 확인했다. Node 22.23.3에서 검증했으며 최소 Node 20 및 다른 OS는 미검증이다. 실제 지연 게시 파일과 control/guard를 연결한 통합 시험 두 건은 최종 activation 게시 gate 전 admission이 닫혀 있는지 검사한다. 최종 인증을 제거한 합성 mutant에서 두 건 모두 실패함도 독립 확인했다. 최종 전체 검증은 [검증 및 적용 조건](DURABILITY-PROTECTION-VERIFICATION.md)을 참조한다.

운영 설치·패키지 발행·재시작·설정 변경은 이번 승인 범위가 아니다. 기존 `.11`은 그대로다. 향후 새 릴리스는 최신 baseline, 보존 archive, 사용자 변경과 관리 kit 정책을 다시 확인하고 별도 승인 후 공식 업데이트 경로로 적용해야 한다. 데이터는 되감지 않는다. 새 hold 상태의 롤백 호환은 [보호 회복 문서](PROTECTION-RECOVERY.md)와 함께 검토해야 한다. upstream 대체 시 동일한 stale-file, 불일치, dirty revision, fsync, 취소 및 deadline 수락 시험과 상태 호환을 먼저 증명한다. 장기 기억 저장은 별도 수동 검토 대기다.
