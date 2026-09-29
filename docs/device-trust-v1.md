# 기기 소유·승인·회수 v1

2026-09-28. [Pro v3 명세](pro-v3-spec.md)의 기기 정책을 위한 프로토콜·PostgreSQL 저장소와 HTTP·브라우저 구현이다. GitHub 서버 세션, 패스키·인증 앱 재인증, `/pro`의 기기 관리 화면을 연결했다. 파일 전달 HTTP 경로와 연쇄 회수는 아직 남아 있다.

## 두 키와 상대 지문

각 기기는 독립적인 P-256 ECDH 암호화 키쌍과 P-256 ECDSA 서명 키쌍을 가진다. Web Crypto로 생성하고 두 개인키 모두 `extractable: false`다. 암호화 키를 서명 키로 다시 가져오거나 내보내지 않는다. 기존 팀 외피는 ECDH 키를 그대로 사용한다.

공개 기기 정보는 `userId`, `deviceId`, `encryptionKey`, `signingKey` 네 필드만 허용한다. ID는 소문자 UUID, 공개키는 비압축 P-256 65바이트의 canonical padding 없는 Base64url이다. 등록 때 실제 곡선의 점인지도 가져오기 연산으로 확인한다.

별도 대화 경로에서 확인할 지문은 다음 배열의 공백 없는 JSON을 UTF-8 → SHA-256 → padding 없는 Base64url로 변환한 43문자다.

```text
["EnvHandoff device identity v1", userId, deviceId, encryptionKey, signingKey]
```

이 지문은 계정·기기·두 공개키를 함께 묶는다. 이전 실험의 ECDH 공개키 단독 16진수 지문과 다르며, 제품의 상대 신뢰 표시는 이 결합 지문을 사용한다. `pinPeerIdentity`는 사용자가 별도 경로에서 확인한 값과 일치해야 저장하고, 같은 계정·기기 ID의 다른 지문으로 덮어쓰지 않는다. `trustedPeerEncryptionKey`는 로그인 계정별로 고정한 지문과 현재 기기 정보가 같을 때만 키를 반환한다. 새 기기 승인이 상대의 지문 확인을 대신하지 않는다.

IndexedDB v2는 기존 `devices` 레코드를 보존하고 계정별 `peers` 저장소를 추가한다. 서명 키가 없는 예전 실험 레코드는 조용히 키를 덧붙이지 않고 새 기기 ID 등록을 요구한다. 로컬 기기 삭제는 해당 계정의 상대 지문도 같은 거래에서 삭제한다. 서버 회수와 로컬 삭제는 별개다.

## 소유 확인과 서명

서버가 32바이트 CSPRNG 난수를 만들고 요청자 기기의 ECDH 공개키에 HPKE Base로 암호화한다. P-256/HKDF-SHA256/AES-256-GCM 조합은 팀 외피와 같지만, 이 도전에서는 서버 발신 키 인증이 필요하지 않아 Base를 사용한다. 전달 외피를 Base로 대체하지 않는다.

도전은 최대 5분 동안 유효하며 작업은 `register`, `approve`, `revoke`, `recover` 중 하나다. HPKE `info`는 아래 배열을 UTF-8 JSON으로 직렬화한 SHA-256이다. actor·target은 앞 절의 네 필드를 같은 순서로 담은 배열이다.

```text
["EnvHandoff device proof v1", challengeId, action, sessionHash,
 actor, target, issuedAt, expiresAt]
```

시각은 정수 Unix 밀리초이며 `expiresAt - issuedAt`은 정확히 300000이다. `sessionHash`는 서버 세션 ID의 SHA-256을 Base64url로 표현한 값이다. 원문 세션 ID는 도전에 넣지 않는다. 서버는 난수의 해시와 도전 내용을 보관하고 암호화한 난수와 `enc`만 반환한다.

클라이언트는 의도한 작업·상대 기기·유효 시각과 수신한 도전이 같은지 확인한 뒤 난수를 복호화하고 다음 payload를 **JWS Compact ES256**으로 서명한다.

```text
protected header: {"alg":"ES256","typ":"envhandoff-device-proof+jws"}
payload: ["EnvHandoff device proof v1", base64url(도전 직렬화 바이트), base64url(복호화한 난수)]
signature: ECDSA P-256/SHA-256의 64바이트 R || S
```

`answerDeviceChallenge`의 `expected`는 사용자가 확인한 작업에서 만들어야 한다. API가 준 도전을 그대로 복사해 자동 승인하지 않는다. 서명과 복호화에 서로 다른 키가 필요하므로 서명 키만 가진 사람이 임의 난수를 서명해 등록할 수 없다.

서버는 저장된 도전과 동일한 canonical payload, 고정 protected header, 서명, 난수 해시, 현재 계정·세션·시각·기기 상태를 모두 검사한다. 토큰의 `alg`, `jwk`, `kid`로 알고리즘이나 검증 키를 선택하지 않는다. 서명 검증만으로 도전을 사용 처리했다고 간주하지 않는다.

## 영속 상태와 경쟁 처리

`apps/api/src/devices.ts`는 공통 PostgreSQL `Database`를 사용한다. 거래에서 현재 권한 조건 재검사·도전 소비·기기 상태 변경·증명 보관·최소 사건 기록을 함께 확정한다. HTTP 연결은 검증 콜백을 전달해 암호 검증 후 확정 직전에도 세션·계정·재인증·활성 조직 소속을 DB에서 다시 확인한다. 자신의 기기 회수는 조직에서 나간 뒤에도 허용한다. 암호 검증 중에는 DB 쓰기 잠금을 잡지 않고, 완료 후 거래에서 다시 확인한다. 별도 서비스나 큐는 추가하지 않았다.

| 작업 | 조건과 결과 |
| --- | --- |
| 최초 등록 | 현재 서버 세션의 계정과 기기 계정 일치, 두 키 소유 증명. 이전 기기 기록이 없는 계정만 즉시 active |
| 추가 등록 | 소유 증명 후 pending. 기존 기기의 별도 승인 필요 |
| 추가 승인 | 같은 계정의 active 기기가 pending 기기를 승인. 서버가 확인한 최근 15분 재인증 필요 |
| 회수 | 같은 계정의 active 기기가 대상 기기를 revoked로 전환. 최근 재인증 필요 |
| 모든 기기 분실 | 최근 재인증과 새 기기의 두 키 소유 증명으로 기존 기기 전부 회수·미완료 도전 삭제·새 기기 활성화를 한 거래에서 수행 |

같은 기기 ID의 키 변경이나 revoked 기기의 재등록은 거부한다. 모든 기기를 회수했어도 일반 등록을 최초 등록으로 취급하지 않는다. 활성·승인 대기 기기는 계정당 5개, 미사용 도전은 계정당 10개다. 기기를 5개 모두 잃은 경우에도 분실 복구는 가능하다. 미완료 승인은 승인 기기가 회수되면 실행되지 않는다.

도전은 ID 기준으로 한 번만 소비한다. 서명 바이트의 해시로 중복 여부를 판단하지 않는다. 정상 증명의 동시 제출·프로세스 재시작·완료 후 재시도에도 두 번 실행되지 않는다. 재시도 UI는 현재 기기 상태를 다시 조회해야 한다.

완료한 JWS는 별도 `device_proofs` 테이블에 보관한다. 그 안의 난수는 이미 소비된 도전 응답이며 파일 키·공유 코드·세션 원문이 아니다. 일반 사건 기록에는 사용자/기기 ID·사건·시각만 남긴다. `prune()`은 만료 도전과 30일 지난 증명·사건을 정리하며, 회수된 기기 ID는 부활 방지를 위해 유지한다. API의 매분 정리 작업에 연결했다. 계정 삭제 시 공개키/관계 제거는 후속 API 작업이다.

## 검증과 다음 연결

`pnpm --filter @envhandoff/api test`는 실제 PostgreSQL의 연결 종료·재연결, 동시 증명 소비, 잘못된 키·난수·계정·세션·작업·기기·서명 알고리즘, 만료·회수 경쟁, 기기 한도에서의 분실 복구, 기록 정리를 검사한다. JWS 서명은 Node의 별도 `crypto.verify` 경로에서도 검증한다. 브라우저 검사는 `apps/web/tests/team-crypto.browser.ts`에 서명 키 재방문·지문 고정·계정 분리·키 바꿔치기·로컬 삭제 검사를 추가했다.

다음 연결에서 반드시 함께 구현할 사항:

- 연결 완료: `DeviceSession`은 HTTP body에서 받지 않고 유효한 서버 세션·계정 상태·실제 재인증 기록에서 생성한다. GitHub 로그인, 세션 만료·종료, Origin/CSRF, 조직 참여 자격과 빈도 제한을 연결했다.
- 연결 완료: 승인 화면은 새 기기 화면에서 확인한 지문을 입력받고 대상 공개키에서 클라이언트가 계산한 지문과 비교한다. 현재 기기의 지문도 로컬 공개키에서 계산한다. 팀원 전달 화면에서도 상대 지문을 대조하고 브라우저에 고정한다.
- 연결 완료: 요청 생성·업로드·다운로드에서 현재 기기 상태를 검사한다. 업로드·다운로드·ACK의 기기 소유 증명은 해당 세션·요청·전달·암호문 해시·작업에 묶인 별도 도전이며 관리용 증명을 재사용하지 않는다.
- 연결 완료: 회수·분실 복구와 관련 요청/업로드 종료·전달 회수를 같은 DB 거래에 넣는다. 기기 재등록이나 권한 재부여로 과거 전달을 복원하지 않는다. 운영 백업 복원으로 상태가 되살아나지 않게 하는 절차는 별도 검증이 남아 있다.
- API 배포·영속 디스크·백업/복원 차단·계정 삭제와 정리 스케줄은 별도 검증한다. 로컬 PostgreSQL 시험을 운영 호스팅 구성의 검증으로 간주하지 않는다.

근거: [RFC 7515 JWS](https://www.rfc-editor.org/rfc/rfc7515.html#section-7.1), [RFC 7518 ES256](https://www.rfc-editor.org/rfc/rfc7518.html#section-3.4), [JWS 재사용 방지](https://www.rfc-editor.org/rfc/rfc7515.html#section-10.10), [PostgreSQL 트랜잭션](https://node-postgres.com/features/transactions). 이 애플리케이션 도전 형식은 표준 서명·암호 연산 위에 정의한 EnvHandoff 규격이며 외부 보안 감사 완료를 뜻하지 않는다.

## 전달 작업 증명 확장

파일 작업은 기존 HPKE 도전 복호화·ES256 응답을 재사용한다. `upload`·`download`·`ack` 작업에만 `scope: { organizationId, requestId, transferId, digest }`를 추가하고, 정규 도전 배열 뒤에 이 순서의 네 값을 붙인다. digest는 업로드 예약에 고정한 암호문 SHA-256의 canonical Base64url 43자리다. actor와 target은 모두 현재 작업 기기의 동일한 identity이며, 세션·작업·요청·전달·암호문에 묶인 5분 일회성 증명이다. 브라우저는 scope와 actor를 의도한 요청 및 로컬 키에서 구성해 도전과 대조한다. 등록/승인/회수/복구의 기존 바이트 형식은 변경하지 않는다. 파일 작업 증명은 별도 테이블에 보관하며 등록/승인 증명으로 사용할 수 없다.
