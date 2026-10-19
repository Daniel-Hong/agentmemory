# daniel.5 — StateKV 없는 값의 반환 계약

2026-10-20. 실제운영의VECTOR_PUBLICATION_UNVERIFIED는provider unavailable과다르다. indexPersistence는저장성공/pending0인데embeddingRecovery.lastSuccessAt은null이었다. 실제SDK읽기전용검사에서state::get의없는키는undefined였다. StateKV.get의타입은T|null이지만정규화가없었다. saveVerified는pending!==null/clear!==null및삭제row의strict null검사로없는키도남아있다고오판했다. mockKV가null을반환해기존시험에서드러나지않았다.

수정은공유get경계의 `(await sdk.trigger(...)) ?? null` 한곳이다. 검증계층을느슨하게하지않는다. false/0/빈문자열/객체와오류전파는그대로다. 원문/벡터/retry삭제·재등록·DB변환·timeout증가는없다. caller의기존T|null계약을복원한다.

RED는missing계약과실제IndexPersistence publication의2실패였다. GREEN관련6파일68개,독립리뷰중요결함없음. 임시HOME/별도engineport/합성fileKV의실제iii0.22.1에서원래실패를재현하고수정된벡터저장·삭제·디스크인증·정상SIGTERM종료0을확인했다. 운영.4수정이나운영수동추론은하지않았다. 실제queue회복은적용후별도관측하며capture timeout전체해결을주장하지않는다.

.5를별도고정후보로준비하고기존.4묶음은보존한다. compat13/root업데이트5자산은동일해재설치하지않으며클라이언트hook경로는retained .3을유지한다. 현재정상종료인증/최신privatebackup/전체guard와보존read-back을재사용한다. 장기기억에는확정된SDK경계교훈만수동검토후기록하며임시로그는체인지로그에남긴다. 전체검증·최종패키지·후보·운영인수는outputs/vector-publication-investigation-2026-10-20/와vector-publication-daniel5-2026-10-20/에기록한다.
