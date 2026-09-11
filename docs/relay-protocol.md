# 실시간 relay 프로토콜

2026-09-11, EnvHandoff 0.0.1 구현 기준. `packages/protocol/src/index.ts`가 메시지와 공통 제한을 정의하며 `apps/server/src/index.ts`와 웹의 `lib/relay.ts`가 사용한다. relay는 파일 형식 v1의 암호문을 전달한다. 공유 코드는 이 프로토콜에 포함하지 않는다.

## 연결 만들기

웹과 API는 같은 origin에서 제공한다. 로컬 Vite는 `/api`를 Wrangler의 8787 포트로 프록시한다. 실제 배포에서는 동일한 라우팅과 HTTPS/WSS를 구성해야 한다. Worker는 생성과 WebSocket 연결의 `Origin`을 `WEB_ORIGINS`의 정확한 allowlist와 비교한다. Origin 검사는 계정 인증이 아니며 아래 무작위 토큰을 대체하지 않는다.

1. `POST /api/relay`는 본문 없는 연결 생성 요청이다. 응답은 `{ id, senderToken, receiverToken, expiresAt }`이며 `Cache-Control: no-store`를 사용한다.
2. `id`는 Durable Object의 64자리 hex ID다. 역할마다 독립적인 CSPRNG 256비트 토큰을 만들고 padding 없는 Base64url로 표현한다.
3. 링크는 `<웹 origin>/#receive/<id>/<receiverToken>`이다. 공유 코드를 넣지 않는다. 웹은 최초 진입과 이후 fragment 변경을 읽고 URL에서 fragment를 제거한다. 토큰은 현재 수신 작업의 메모리에서만 사용한다.
4. 두 클라이언트가 `GET /api/relay/<id>`로 WebSocket을 연다. URL 쿼리와 URL의 인증 토큰은 허용하지 않는다. 첫 텍스트 메시지는 `{ type: "auth", role: "sender" | "receiver", token }`이다.
5. 인증된 클라이언트에는 `{ type: "ready", role, expiresAt }`를 보낸다. 역할당 연결 하나만 허용한다. 잘못된 토큰이나 이미 차지한 역할의 추가 연결은 해당 소켓만 닫는다.

양쪽이 인증되면 서버가 무작위 `peerId`와 6자리 `verification`을 만들고 `{ type: "peer", peerId, verification }`을 양쪽에 보낸다. 사용자는 기존 개인 대화로 숫자를 비교한다. 이 숫자는 짧은 공유 코드나 이메일·계정·발신자 신원 인증이 아니다.

## 승인, 전송, 수신 확인

송신자는 상대를 확인한 뒤 `{ type: "approve", peerId, total }`을 보낸다. 서버는 현재 연결된 수신자의 peerId, 송신 역할, 중복 승인 여부, 공유 파일 크기를 확인하고 양쪽에 `{ type: "approved", total }`을 보낸다. 승인 전에는 바이너리를 전달하지 않는다.

| 방향 | 메시지 | 의미 |
|---|---|---|
| 송신 → 서버 → 수신 | 바이너리 조각 | 최대 64 KiB, 마지막 조각만 나머지 크기 |
| 수신 → 서버 | `{ type: "chunk-ack", offset }` | 수신 버퍼에 복사한 누적 바이트 수 |
| 서버 → 양쪽 | `{ type: "progress", offset, total }` | 해당 조각의 수신 응답 확인 |
| 서버 → 양쪽 | `{ type: "transferred" }` | 마지막 조각 응답 수신, 파일 열기 확인 대기 |
| 수신 → 서버 | `{ type: "receipt" }` | 웹에서 전체 파일 인증·복호화·유효성 검사를 통과함 |
| 서버 → 양쪽 | `{ type: "complete" }` | 수신 응답을 전달하고 세션 종료 |

한 번에 한 조각만 미확인 상태로 둔다. 송신자는 progress 응답 후 다음 조각을 보낸다. 서버는 조각을 저장하지 않고 바로 전달하며, 누적 offset과 다음 응답의 예상 offset만 유지한다. 잘못된 크기·순서, 미확인 조각이 있는 상태의 추가 전송, 전송 전 receipt는 연결을 중단한다. 수신 클라이언트는 승인된 전체 크기만큼의 제한된 메모리 버퍼를 사용한다.

전송 100%와 수신 완료는 다르다. 웹은 받은 `.envhandoff`를 올바른 코드로 열고 모든 검사를 통과한 뒤에만 receipt를 보낸다. 잘못된 코드는 대기 시간 안에 다시 입력할 수 있다. 서버는 파일 복호화 키가 없으므로 이 응답은 **수신 클라이언트의 보고**이며 악의적으로 수정된 수신 클라이언트의 행동까지 증명하지 않는다. 프로젝트 적용이나 사람의 신원 확인도 뜻하지 않는다.

## 제한과 종료

| 항목 | 제한 |
|---|---|
| 세션 수명 | 생성부터 최대 10분 |
| 인증 대기 | 소켓마다 최대 5초 |
| 방의 열린 소켓 | 인증 대기를 포함해 최대 4개, 인증된 역할은 각 1개 |
| 공유 파일 크기 | 40바이트 이상, 최대 16 MiB |
| 바이너리 조각 | 최대 64 KiB, 미확인 조각 1개 |
| 승인 후 조각·응답 대기 | 진행이 없으면 30초 |
| 전체 전송 후 파일 열기 | 최대 2분, 세션 수명을 연장하지 않음 |
| 제어 메시지 | JSON 텍스트 최대 1,024 UTF-16 code unit |
| 요청 빈도 | 호출 IP별 60초 동안 생성 20회, 연결 요청 120회 |

요청 제한은 SHA-256으로 만든 호출 IP의 키에 따라 별도 Durable Object에서 계산한다. 주소 원문 대신 카운터와 리셋 시각만 저장하고 alarm으로 지운다. 배포 환경에서는 Cloudflare가 제공하는 `CF-Connecting-IP`를 사용한다. 없는 로컬 요청은 공통 local 버킷으로 묶는다. 이는 Cloudflare 계정의 무료 사용량 한도를 대신하지 않는다.

`{ type: "cancel" }`, 인증된 상대의 연결 종료, 오류, 만료, 시간 초과는 세션 전체를 닫는다. 서버는 `{ type: "error", reason }`을 보낼 수 있으면 전달하고 소켓을 닫는다. 토큰과 소켓 참조를 지우고 기존 링크의 재접속은 거부한다. 완료된 세션도 재사용할 수 없다. 연결이 끊긴 클라이언트가 같은 방에 자동으로 재접속하거나 부분부터 재개하지 않는다.

공유 파일·키·연결 토큰·방의 진행 상태는 Durable Object 저장소에 쓰지 않는다. 일반 WebSocket API와 작업 메모리를 사용하므로 방이 재시작되면 기존 연결 정보가 사라지고 새 세션이 필요하다. 서버는 사용자 파일을 나중에 찾아 주는 저장소가 아니다. 송신자는 메모리에 남아 있는 묶음을 일반 공유 파일로 내려받거나 새 연결에서 처음부터 다시 보낸다.

## 로컬 검증과 배포 경계

`pnpm --filter @envhandoff/server test`는 임시 디렉터리와 별도 포트의 실제 Wrangler/workerd에서 Origin, 승인 전 미전송, 역할 토큰, 중복 수신자, 정확한 조각·응답, 수신 완료 응답, 조각 크기·대기량, 끊김과 링크 재사용, 요청 제한을 확인한다. 10분 만료·30초 대기·2분 확인의 전체 실제 시간 경과, 실제 두 기기·네트워크 장애와 Cloudflare 무료 사용량 중단은 배포 전 검증에 포함한다.

Wrangler 설정은 SQLite Durable Objects 마이그레이션을 사용한다. `pnpm build`의 `wrangler deploy --dry-run`은 번들만 만들며 실제 배포하지 않는다. Worker의 공개 origin·라우트·계정 연결 및 무료 플랜 검증은 배포 시 설정한다. 일반 WebSocket 연결은 활성 시간에 대한 사용량이 발생할 수 있으므로 10분 제한을 두었다. 무료 플랜의 한도를 넘어 유료 사용량을 자동 활성화하는 설정은 추가하지 않았다.

근거: [Durable Objects WebSocket 예제](https://developers.cloudflare.com/durable-objects/examples/websocket-server/), [WebSocket 동작과 비용](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [Durable Objects 요금](https://developers.cloudflare.com/durable-objects/platform/pricing/).
