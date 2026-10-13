# 프로젝트·환경 게시 파일

2026-10-13. 사용자가 승인한 기능 범위이며 Claude의 두 차례 설계 검토와 API 분석을 반영해 아래 계약으로 확정했다. 이 계약에 따라 병렬 구현한다. 기존 v3 임시 전달을 자동으로 지속 보관으로 바꾸거나, 운영 데이터·보관 기한·접수 설정을 변경하지 않는다.

## 사용자 흐름

- 게시자: 프로젝트 → 환경 → 파일 추가 → 저장소 루트 기준 배치 경로 확인 → 팀에 게시.
- 수신자: 같은 프로젝트 → 환경 → 최신 파일 목록 → 원본 다운로드 → 안내된 경로에 직접 배치.
- 외부 공유: 접근 가능한 게시본에서 파일을 명시적으로 선택 → 새 코드로 재암호화 → 기존 비회원 공유 링크와 별도 코드 전달.

프로젝트는 설정 파일의 코드베이스를 구분하고 환경은 설정의 용도를 구분한다. 환경 이름으로 경로·파일명을 추정하지 않는다. 브라우저 파일 선택으로 저장소 루트를 자동 탐지하거나 파일을 로컬에 자동 배치하지 않는다.

## 범위 결정

환경의 최신 게시본 하나를 기존 v1 암호화 묶음으로 보관한다. 파일 추가·교체·삭제는 최신 묶음을 브라우저에서 열어 변경하고, 새로운 키와 불변 게시본을 만들어 확정한다. 서버는 파일명·배치 경로·내용·평문 키·공유 코드를 받지 않는다. 파일 목록은 복호화 후 표시한다.

기존 계획의 지속 보관·공식 최신 파일 중 이 사용자 흐름을 이번 공개 저장소의 별도 기능으로 구현한다. 파일별 암호문 참조·중복 제거·과거 버전 UI·복원·과금·네이티브 자동 적용·CLI는 포함하지 않는다. 기존 요청·임시 공유 형식과 취소·만료·회수 계약은 유지한다.

게시·키 접근 제공에는 현재 받기와 보내기 권한이 모두 필요하다. 다운로드는 현재 받기 권한과 활성 기기·해당 기기용 키 접근이 필요하다. Owner의 권한도 개인키 접근을 대신하지 않는다. 새 기기 공개키는 별도 경로에서 지문을 대조한 뒤 사용한다.

## 보관·경쟁·기기 정책

환경 head의 generation은 숫자가 아니라 암호학적으로 무작위인 소문자 UUID 토큰이다. 최초 head 생성·게시 확정·게시본 제거·복원 차단마다 새 토큰을 만들어 게시·삭제의 경쟁을 차단한다. head는 파일이 비어도 유지하며 복원 때도 새 토큰을 생성하므로 삭제·복원의 ABA를 피한다. 오래된 초안이 새 게시본을 덮어쓰거나 삭제 후 되살리지 않게 한다. 충돌 시 선택한 파일과 변경 작업은 유지하고, 최신 내용을 확인한 뒤 명시적으로 다시 확정한다.

암호문 보관과 기기별 키 전달을 분리한다. 게시자 서명은 프로젝트·환경·게시본·generation·암호문 해시·크기를 인증한다. 키 전달과 작업 증명은 기존 팀 요청의 식별자를 전용으로 바꾸어 쓰지 않고 별도 도메인과 명시적 범위로 정의한다.

일반 탈퇴·권한 상실·기기 회수는 팀의 확정된 게시본을 지우지 않는다. 해당 수신 기기의 키 접근과 진행 중 쓰기만 무효화하고, 다른 유효 팀원에게 이미 제공한 접근과 역사적 공개 identity·서명은 유지한다. 이 정책은 손상된 기기에서 유출된 키를 회수하는 보장이 아니며, 새 키로 재게시하고 실제 서비스 자격증명도 교체해야 한다.

영구 계정 삭제는 기존 공개키 제거 약속을 유지한다. 그 계정이 게시한 게시본은 publisher_erased로 종료하고 최신 head를 비우며 새 generation으로 바꾼다. 공개 identity·서명·그 계정이 발급/수신한 키 전달·도전은 제거하되 암호문 용량은 물리 삭제 성공까지 유지한다. 다른 게시자의 파일에서 제거된 키 전달은 새 접근 준비가 필요하다. 계정 삭제 전에 영향을 받는 최신 환경 수를 안내하고 다른 권한자의 새 키·자기 서명으로 재게시하도록 안내한다. 단순 워크스페이스 탈퇴와 구분한다.

환경·프로젝트·조직 삭제는 게시본 전체를 종료하고 삭제 원장·정리 흐름에 연결한다. 관리자의 DB 복원 적용은 모든 게시본과 키 접근을 차단하고 각 head를 새 UUID generation으로 바꾼다. 기존처럼 복원 후 재게시가 필요하며 암호문·키 전달의 재해 복구를 보장하지 않는다. 이미 내려받은 파일·키의 원격 삭제를 보장하지 않는다. 기기 개인키·평문 파일은 자동 백업하거나 서버 복구키로 우회하지 않는다.

## 공통 형식과 암호 계약

`packages/protocol/src/environment-files.ts`를 공통 기준으로 사용한다. ID와 generation은 canonical 소문자 UUID다. 서명·digest·wrap은 padding 없는 canonical Base64url이다. `PublicationStatement`는 `organizationId, projectId, environmentId, versionId, expectedGeneration, size, digest, publisher: DeviceIdentity, signature`를 가진다.

게시자 ES256 서명 대상 UTF-8 배열은 `["EnvHandoff environment publication v1", organizationId, projectId, environmentId, versionId, expectedGeneration, size, digest, ...identityValues(publisher)]`다. signature는 raw R||S 64바이트다. 서버는 예약 시 활성 게시 기기 키로 이 서명을 검사한다. 불변 게시자 공개 identity와 서명을 함께 보관하고, 영구 계정 삭제 시 제거한다.

키 전달은 HPKE Auth P-256/HKDF-SHA256/AES-256-GCM이며 평문은 v1 묶음 코드의 ASCII 43바이트다. `info`는 `["EnvHandoff environment key v1", statementHash, ...identityValues(wrapper), ...identityValues(recipient)]`의 SHA-256이다. `aad`는 `ENVHENVK` + big-endian u16 1 + statementBytes의 SHA-256 32바이트다. `wrap`은 `enc65 || ciphertext59`의 Base64url 166자다. 묶음 암호문은 변경 없는 v1이며 수신 시 크기·digest·v1 인증·경로 검사를 모두 통과해야 파일을 표시한다.

자기 기기의 wrap은 API의 identity가 로컬 키에서 계산한 identity와 같아야 한다. 다른 wrapper/recipient는 기존 `pinPeerIdentity`의 별도 경로 지문 확인을 거친다. 게시자 서명은 검사하지만 게시자 지문이 직접 고정되지 않은 경우 게시자 신원을 직접 확인했다고 표시하지 않는다. 대신 확인한 wrapper가 제공한 접근이라는 점을 구분한다. 사용자가 승인한 자기 추가 기기의 지문 확인은 그 기기를 같은 계정의 peer로 고정할 수 있다.

기존 기기 증명에 `publication-upload`, `publication-download`, `publication-grant`, `publication-remove`를 추가한다. 기존 v3 직렬화 바이트는 바꾸지 않는다. publication scope는 정확히 `organizationId,projectId,environmentId,versionId,generation,digest,targetDeviceId,payloadDigest`다. 증명 배열은 `EnvHandoff publication proof v1` 도메인과 이 고정 필드 순서를 사용한다. grant의 target은 수신자의 전체 identity이며 나머지 target은 actor 자신이다. HPKE 도전 난수는 항상 actor에게 암호화한다.

payloadDigest는 의도한 동작에서 만든 다음 배열의 SHA-256이다. 서버 응답을 그대로 expected로 복사하지 않는다.

- upload: `["upload", signature, wraps를 recipientDeviceId 순으로 정렬한 [recipientDeviceId,wrap] 배열]`. scope generation은 version.expectedGeneration.
- download: `["download"]`. scope generation은 현재 head 토큰.
- grant: `["grant", targetDeviceId, wrap]`. 한 기기씩 제공하며 scope target identity를 함께 검사한다.
- remove: `["remove"]`. scope generation은 사용자가 삭제를 확인한 현재 head 토큰.

## API와 소유권

경로 기준은 `/organizations/:org/environments/:env/files`다. 새 파일 작업도 유효한 세션·Origin·CSRF, 현재 조직/환경 권한과 활성 기기를 검사한다.

- `GET ?device=<ownDeviceId>`: `{sessionHash,permissions:{receive,send,externalShare},generation,endReason,latest,access,wrap,recipients}`. access는 `empty|available|needs_grant|no_device`. 권한 없는 조회는 기존 403/404 정책을 따른다. latest는 `PublicationStatement` + `{status,createdAt,publishedAt,endedAt,endReason,publisherLogin,publisherActive}`. wrap은 `{recipient:DeviceIdentity,wrapper:DeviceIdentity,wrap,wrapperActive}`이며 자기 기기용만 반환한다. recipients는 `{identity:DeviceIdentity,login,hasWrap}` 배열로 현재 받기 권한의 활성 기기만 포함하며 접근 제공 권한자에게만 반환한다. 서버의 available은 키 고정·복호화 완료를 뜻하지 않는다.
- `POST /versions {operationId,deviceId,expectedGeneration,size,digest,signature,wraps:[{recipientDeviceId,wrap}]}`: idempotent 예약. versionId=operationId. 자기 wrap 필수, 이미 확인한 수신 기기의 wrap을 함께 제공할 수 있다. 응답은 version metadata다. 현재 head 토큰과 다르면 `409 version_conflict`.
- `GET /versions/:v`: 게시자 예약·결과 복구용 `{version,generation,isLatest}`. 새 예약·이미 끝난 시도를 자동 재생성하지 않는다.
- `POST /versions/:v/challenge {action,deviceId,targetDeviceId?,payloadDigest}`: `{challenge,enc,ciphertext}`. upload의 payload hash는 저장된 signature·wraps와 대조한다. grant의 수신 기기·권한을 현재 registry에서 확인한다. 나머지 액션에도 현재 head·권한·기기 조건을 확인한다.
- `POST /versions/:v/content`: octet-stream + 기존 `x-device-challenge/x-device-proof` 헤더. 자기 기기의 upload 증명을 검증하고 스트리밍 밖/확정 거래 안에서 세션·기기·권한·취소·generation을 재검사한다. 확정 응답은 `{version,generation}`. 기존 최신 게시본을 종료하고 새 head 토큰으로 원자적으로 교체한다.
- `POST /versions/:v/download {deviceId,id,proof}`: 최신 게시본·현재 받기·활성 기기·자기 wrap과 download 증명을 확인해 binary 응답. 기존 조직 용량·일일 전송·동시 lease 한도를 공유한다. 다운로드는 로컬 저장·적용 완료가 아니며 새 ACK 의미를 만들지 않는다.
- `POST /versions/:v/grants {deviceId,targetDeviceId,wrap,id,proof}`: 현재 send+receive·자기 wrap·활성 기기·최신 head가 필요하다. grant payload hash와 전체 target identity를 확인한다. 같은 target의 기존 wrap은 바꾸지 않는다. 동일 issuer·wrap 재시도는 멱등 처리하고 다른 wrap은 `409 grant_exists`로 최신 상태 확인을 안내한다.
- `POST /versions/:v/remove {deviceId,expectedGeneration,id,proof}`: send+receive와 remove 증명·head 일치를 검사하고 파일만 비운다. 환경 설정은 유지하고 generation은 새 토큰으로 바꾼다. 마지막 파일 삭제도 이 경로를 사용한다.
- `POST /versions/:v/cancel {operationId}`: 기존 v3처럼 session·CSRF·게시자·취소 fence로 처리한다. 예약 전 취소도 기록하고 뒤늦은 예약을 차단한다.

`acceptNewTransfers=false`는 게시·키 접근 제공·외부 링크 생성을 차단한다. 기존 허용 다운로드·상태 확인·취소·제거는 유지한다. 새 SQL은 012이며 head·불변 version·wrap(snapshot identities 포함)·challenge·download lease를 추가한다. 저장소·attempt·lease views와 기존 정리·삭제 원장·복원 차단·삭제 건강 상태 집계를 모두 확장한다. 별도 키 요청 테이블·알림은 만들지 않고, 권한 있는 활성 기기의 미제공 roster와 지문/안내 복사로 접근 준비를 요청한다.

## 화면 구현 분담

API 구현자는 `apps/api/**`만 소유한다. Claude는 `environment-keys.ts`, `ProEnvironment.tsx`, `ProCatalog.tsx`, `ProSecurity.tsx`, 환경 파일 전용 unit/browser 검사·공개 테스트 벡터와 최소 CSS를 소유한다. 부모는 공통 protocol·증명과 tests, `ProOrganizations.tsx`·`ProShares.tsx`·navigation 연결과 문서를 소유한다. UI/API wire 계약 변경은 부모에게 먼저 알리고 상대 파일을 수정하지 않는다.

외부 링크는 `ProEnvironment`에서 선택 파일의 `SourceFile[]`와 environmentId를 현재 탭의 메모리 callback으로 부모에게 넘긴다. 부모는 해당 환경의 기존 ProShares 생성 화면을 초기화하며 파일을 재선택하지 않도록 한다. 경로·키·파일을 URL/history/localStorage로 넘기지 않고 계정·CSRF·조직 변경/로그아웃에 초안을 버린다. 기존 링크 공유와 일회성 직접 파일 공유 경로의 호환성을 유지하되 프로젝트 시작을 기본 CTA로 한다.

## 완료 기준

- 게시 후 페이지 재방문·API 재시작·게시자 로그아웃에도 허용된 기기가 파일 목록·배치 경로와 원본 바이트를 받는다.
- 여러 파일의 추가·교체·삭제에서 변경하지 않은 파일을 보존하고, 같은 경로·위험 경로·잘못된 형식을 기존 검증으로 차단한다.
- 새 팀원·새 기기에 접근 준비 상태를 표시하고, 확인한 키와 현재 권한을 검사한 뒤 제공한다. 권한·기기 회수 후 재부여해도 과거 접근이 자동으로 살아나지 않는다.
- 동시 게시·게시와 삭제의 경쟁, 취소 선행 도착, 쓰기 중 권한·세션·기기 변경을 검증한다.
- 실제 물리 삭제 성공 전까지 실패·취소·교체된 암호문을 용량에 포함한다. 삭제 원장·복원 차단·다운로드 lease·정리 집계에 새 게시본을 연결한다.
- 외부 공유는 선택한 파일만 새 암호문으로 만들고 원본 게시 키를 공개하지 않는다. 기존 임시 공유의 복구·만료·회수와 별도 코드 전달을 유지한다.
- 파일 게시·수신·키 접근 제공·충돌·기기 설정 왕복을 실제 React 컴포넌트와 합성 파일·격리 기기 키로 검사한다. 기존 전체 검사도 통과한다.
- 새 SQL은 로컬 시험과 검토 대상으로만 추가한다. 운영 마이그레이션·배포·전달 접수 재개는 실행하지 않는다.
