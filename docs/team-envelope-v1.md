# 팀 전달 외피 v1

2026-09-28 개발 계약. 구현은 `apps/web/src/lib/team-crypto.ts`, 상위 정책은 [Pro v3 명세](pro-v3-spec.md)다. 기기 등록·소유 증명·상대 지문 확인·서버 권한 검사를 대체하지 않는다. 이 외피의 로컬 검증만으로 팀원 베타를 열지 않는다.

## 암호 구성과 신뢰 입력

기존 [v1 공유 파일](bundle-format-v1.md)을 그대로 생성하고, 그 파일의 32바이트 키를 나타내는 canonical Base64url 코드 43바이트를 **RFC 9180 HPKE Auth**로 감싼다. HPKE는 `@hpke/core` 1.9.0, DHKEM(P-256, HKDF-SHA256) `0x0010`, HKDF-SHA256 `0x0001`, AES-256-GCM `0x0002`로 고정한다. 알고리즘 협상과 Base 모드 대체는 없다. 파일 암호화·키 파생·nonce 계산을 제품 코드에서 새로 구현하지 않는다.

송신은 매번 새 v1 묶음 키·nonce와 새 HPKE 컨텍스트를 만든다. 컨텍스트당 `seal`은 한 번만 호출하며 HPKE의 nonce·임시 키 생성은 라이브러리에 맡긴다. 서버로 반환하는 값은 아래 외피 바이트뿐이다. 공유 코드·파일명·평문 메타데이터는 반환하지 않는다. 코드의 임시 바이트 배열은 사용 후 지우되 JS 문자열이나 런타임 전체 메모리 소거는 보장하지 않는다.

송신자는 별도 경로로 확인한 수신 공개키와 자기 기기 키쌍을, 수신자는 확인한 송신 공개키와 자기 기기 키쌍을 전달해야 한다. 파일 자체나 확인하지 않은 API 응답이 신뢰할 공개키를 선택하게 하지 않는다. 내보낼 수 없는 ECDH 개인키를 지원하기 위해 라이브러리에 공개키를 포함한 `CryptoKeyPair`를 전달한다.

HPKE Auth는 수신자가 발신 키를 인증하는 방식이며 제삼자에게 제시할 전자서명이 아니다. 기기 추가 승인·서버에 대한 소유 증명은 별도의 [기기 신뢰 v1](device-trust-v1.md)을 따른다. 상대 지문에는 계정·기기 ID와 암호화/서명 공개키를 함께 포함한다. 수신 개인키 유출 후의 과거 암호문 보호나 발신 사칭 방지를 보장하지 않는다. 만료·회수·재전송 여부는 서버가 현재 상태로 판단한다.

## 바이트 배치

길이는 모두 바이트다. 객체 JSON/Base64 전송을 추가하지 않고 다음 바이트를 그대로 연결한다.

| 오프셋 | 길이 | 내용 |
| --- | --- | --- |
| 0 | 8 | ASCII `ENVHTEAM` |
| 8 | 2 | unsigned 16-bit big-endian 버전 `00 01` |
| 10 | 65 | HPKE `enc`: 비압축 P-256 임시 공개키 |
| 75 | 59 | HPKE로 암호화한 43바이트 코드와 16바이트 인증 태그 |
| 134 | 가변 | 기존 v1 공유 파일 전체: 헤더·nonce·암호문·태그 |

최대 크기는 **16 MiB + 134바이트**다. Pro 전체 상한 17 MiB보다 작은 이 형식의 상한을 송수신 양쪽에 적용한다. 최소 길이는 174바이트이며 실제 내부 payload의 유효성은 인증 후 v1 파서로 검사한다. 별도 길이 필드·추가 필드·trailing data를 허용하지 않는다. 뒤에 바이트를 붙이면 내부 묶음 해시가 바뀌어 인증이 실패한다.

## 요청과 파일의 결합

`TeamBinding`은 요청에서 확정한 불변 식별자 9개다. 송신과 수신이 같은 값을 제공해야 하며 외피에서 추출하지 않는다. 값은 UUID 문자열만 허용하고 소문자로 정규화한다. 아래 배열을 공백 없는 `JSON.stringify`로 직렬화하고 UTF-8로 인코딩한 뒤 SHA-256으로 해시해 HPKE `info`로 사용한다.

```text
[
  "EnvHandoff team envelope v1",
  organizationId, projectId, environmentId, requestId, transferId,
  senderUserId, senderDeviceId, recipientUserId, recipientDeviceId
]
```

HPKE `aad`는 **외피의 앞 10바이트 + 내부 v1 공유 파일 전체의 SHA-256 32바이트**다. 이로써 버전·요청·기기·암호문과 감싼 키가 함께 인증된다. 별도 정상 전달의 파일을 붙이거나 같은 요청 ID에서 다른 암호문으로 바꿔도 열리지 않는다. 같은 전달의 재다운로드는 허용되므로 암호문 재수신 자체를 거부하지 않는다.

## 열기와 오류

1. 바이트 타입·전체 길이·식별자·버전을 확인한다. 비동기 작업 전에 입력을 복사해 검사 도중 바이트 변경을 막는다.
2. 요청에서 가져온 binding과 확인한 공개키로 HPKE 인증·키 복호화를 수행한다.
3. 복호화한 코드를 기존 `openBundle`에 전달한다. v1 인증·경로·파일 수·크기·원본 바이트 검사를 전부 통과해야 `OpenedBundle`을 반환한다.

외피 오류는 기존 `BundleError`의 `FORMAT`, `VERSION`, `SIZE`, `AUTH`와 요청 식별자용 `BINDING`으로 구분한다. 잘못된 기기 키·정상 형식의 다른 ID·키/암호문 변조는 동일한 `AUTH`로 처리한다. 내부 인증을 통과한 잘못된 경로·내용은 기존 v1 오류를 유지한다. 실패 시 파일 목록이나 부분 평문을 반환하지 않는다.

## 실행 가능한 증거

- `pnpm --filter @envhandoff/web test`: 원본 바이트 왕복, 9개 ID 각각의 변경, 다른 발신·수신 키, 헤더·키·파일 변조, 정상 암호문 혼합, 길이 제한, 비동기 입력 변경, 인증된 위험 경로와 100개·10 MiB 경계.
- `fixtures/bundles/team-v1.json`: 공개 테스트 키·nonce로 고정한 외피. `team-reference.mjs`는 제품 코드나 HPKE 라이브러리를 가져오지 않고 Node `crypto`로 RFC 9180 계산과 AES-GCM을 수행한다. 테스트가 벡터를 다시 생성해 일치 여부와 제품 파서의 복호화를 확인한다. 이 보조 코드는 테스트 전용이며 보안 감사를 대신하지 않는다.
- `apps/web/tests/team-crypto.browser.ts`: 로컬 키 저장 → 실제 페이지 새로고침 → 원본 외피 열기 및 새 외피 생성. 실행 절차와 브라우저별 결과는 [Pro 명세의 진행 기록](pro-v3-spec.md#기술-선행-검증-진행-기록--2026-09-28)에 둔다.

근거: [RFC 9180의 Auth 모드](https://www.rfc-editor.org/rfc/rfc9180.html#section-5.1.3), [애플리케이션 info/AAD](https://www.rfc-editor.org/rfc/rfc9180.html#section-8.1), [보안 한계](https://www.rfc-editor.org/rfc/rfc9180.html#section-9.1), [hpke-js 발신 키 API](https://dajiaji.github.io/hpke-js/docs/interfaces/SenderContextParams.html). 별도 식별자와 바이트 배치는 EnvHandoff의 애플리케이션 형식이며 RFC 자체가 정의한 파일 형식이라고 주장하지 않는다.
