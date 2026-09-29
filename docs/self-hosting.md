# EnvHandoff v3 자체 호스팅

자신의 서버와 Cloudflare 계정으로 EnvHandoff를 운영하는 설치 가이드다. 공식 클라우드의 계정·DB·파일 저장소와 분리되며, 설치자가 OAuth 앱·도메인·업데이트·백업·장애 대응을 관리한다. v3는 공개 저장소에서 제공하고, v4의 추가 기능과 유료 클라우드는 별도 비공개 저장소에서 개발할 계획이다.

현재는 **Draft PR의 베타 설치 경로**다. 자체 호스팅을 제공하는 방향은 정했지만 LICENSE와 재배포·경쟁 호스팅 허용 범위는 아직 확정하지 않았다. 이 문서를 정식 오픈소스 라이선스나 운영 검증 완료의 표시로 해석하지 않는다.

## 설치 방식 고르기

| 구성 | 쓸 수 있는 기능 | 준비할 것 |
| --- | --- | --- |
| A. Cloudflare만 사용 | 계정 없는 암호화 파일 공유·실시간 relay | 자신의 Cloudflare 계정과 웹 도메인 |
| B. Docker 서버 + Cloudflare | A + GitHub 로그인·팀 권한·요청/승인·임시 보관·비회원 공유 | Linux 서버, Docker Compose, API 도메인·HTTPS, GitHub OAuth 앱 |
| C. Openship + Cloudflare | B와 같은 기능, API 스택을 Openship에서 관리 | 자신의 Openship 서버·프로젝트와 B의 외부 설정 |

웹과 무료 relay는 세 구성 모두 설치자 소유의 Cloudflare Workers와 Durable Objects를 사용한다. Docker가 제공하는 것은 Pro API와 PostgreSQL이다. Cloudflare 없이 서버 한 대에서 모든 기능을 실행하거나 망 분리 환경에서 사용하는 구성은 제공하지 않는다. GitHub 로그인도 외부 GitHub 연결이 필요하다.

서버 사양별 수용 인원·처리량은 아직 측정하지 않았다. Pro API는 1개 인스턴스로 시작하고, [베타 한도](../apps/api/src/limits.ts)와 디스크 사용량을 기준으로 자원을 정한다. 설치자 계정에서 발생하는 서버·도메인·Cloudflare 비용은 별도다.

## 공통 준비

웹을 빌드할 컴퓨터에 Git, Node.js **24.21.0**, pnpm **12.3.4**가 필요하다. Pro 서버에는 Docker Engine과 `docker compose`가 필요하며 Node·pnpm은 API 이미지에 포함돼 있다.

아래 예제의 `app.example.com`, `api.example.com`은 자신이 소유한 도메인으로 바꾼다. Pro는 웹과 API가 **HTTPS의 같은 site 하위 도메인**이어야 한다. 예를 들어 `app.your-domain.com`과 `api.your-domain.com`을 사용한다. 서로 다른 도메인이나 `workers.dev` 웹 주소와 별도 API 도메인을 섞으면 세션 쿠키가 동작하지 않을 수 있다.

```sh
git clone --branch feature/pro-web-beta https://github.com/mabyko/EnvHandoff.git
cd EnvHandoff
pnpm install --frozen-lockfile
git rev-parse HEAD
```

지금은 Draft PR 브랜치를 사용한다. 설치에 사용한 커밋을 기록하고, 검증한 버전만 업데이트한다. API와 웹을 다른 컴퓨터에서 준비한다면 같은 커밋을 사용한다.

## A. 자신의 Cloudflare에 웹과 relay 설치

### 배포 설정 복사

저장소 루트에서 실행한다. 기존 자체 호스팅 설정이 있으면 복사하지 않고 그 파일을 편집한다.

```sh
cp -n apps/server/wrangler.jsonc apps/server/wrangler.self-hosted.jsonc
```

새 파일은 Git에서 제외된다. 공식 서비스용 `wrangler.jsonc`는 수정하지 않고, 복사본의 다음 항목을 바꾼다.

| 항목 | 예시 |
| --- | --- |
| `name` | `my-team-envhandoff` — 자신의 계정에서 사용할 고유 Worker 이름 |
| `account_id` | 배포할 Cloudflare Account ID를 최상위 항목으로 추가 |
| `routes` | `[{ "pattern": "app.example.com", "custom_domain": true }]` |
| `vars.WEB_ORIGINS` | `https://app.example.com` — 경로·마지막 `/` 없이 정확한 Origin |

`main`, `assets`, `durable_objects`, `migrations`는 유지한다. `workers_dev`, `preview_urls`, `observability.enabled`는 기존처럼 `false`로 둔다. `assets.directory`는 복사본과 같은 디렉터리 기준의 `../web/dist`이며, `/api/*`는 relay Worker로, 그 외 경로는 웹으로 연결한다. 도메인의 DNS zone은 해당 Cloudflare 계정에 있어야 한다. [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

### 웹 빌드와 배포

Pro를 설치할 경우 아래 API 주소를 B 또는 C의 `API_ORIGIN`과 맞춘다. **A만 설치해도 주소는 자신의 도메인으로 지정한다.** 값을 생략하면 웹 빌드가 공식 Pro API 주소를 기본값으로 사용한다. A만 설치한 사이트에서는 `/pro`와 비회원 Pro 공유 링크가 동작하지 않으며, 계정 없는 공유 화면만 사용한다.

```sh
VITE_PRO_API_ORIGIN=https://api.example.com pnpm --filter @envhandoff/web build
pnpm --filter @envhandoff/server exec wrangler deploy --config wrangler.self-hosted.jsonc --dry-run
```

대상 Worker 이름·계정·도메인과 웹 빌드를 확인한다. OAuth secret, DB 암호, TOTP 키는 웹이나 Wrangler 설정에 넣지 않는다. 준비되면 자신의 Cloudflare 계정으로 로그인한 뒤 배포한다.

```sh
pnpm --filter @envhandoff/server exec wrangler login
pnpm --filter @envhandoff/server exec wrangler whoami
pnpm --filter @envhandoff/server exec wrangler deploy --config wrangler.self-hosted.jsonc
```

`https://app.example.com/api/health`의 `{"ok":true}`와 홈 화면을 확인한다. 합성 파일로 파일 공유·열기, 별도 브라우저 두 개의 실시간 전달을 검사한다. 이 health 응답은 relay 확인이며 Pro API·DB 확인을 대신하지 않는다.

## B. Docker로 Pro API 설치

아래 명령은 서버에 복제한 저장소 루트에서 실행한다. 같은 서버에 Openship 스택이 있다면 C를 따르고 이 스택을 중복 생성하지 않는다.

### 1. 운영 설정과 OAuth 앱

```sh
umask 077
cp -n .env.production.example .env.production
chmod 600 .env.production
```

`.env.production`을 편집한다. 개발용 `apps/api/.env`와 `.env.local`은 이 설치에 사용하지 않는다. 복사본에 남은 공식 서비스 주소를 반드시 교체한다.

| 변수 | 넣을 값 |
| --- | --- |
| `WEB_ORIGIN` | `https://app.example.com` |
| `API_ORIGIN` | `https://api.example.com` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | 설치자 소유 GitHub OAuth 앱의 값 |
| `POSTGRES_PASSWORD` | 독립적으로 생성한 32바이트 hex 암호 |
| `TOTP_ENCRYPTION_KEY` | DB 암호와 다른 32바이트 소문자 hex 키, 재배포 때 유지 |
| `PRO_ACCEPT_NEW_TRANSFERS` | 처음에는 `false` |
| `API_BIND_PORT` | 선택 사항. 호스트의 `3000`이 사용 중이면 다른 빈 포트 |

비밀값은 안전한 터미널에서 다음 명령을 두 번 실행해 각각 생성하고, 채팅·Git·명령 기록에 붙여 넣지 않는다. 서버에 Node가 없으면 같은 Node 이미지로 생성할 수 있다.

```sh
docker run --rm --network none node:24.21.0-bookworm-slim node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

[GitHub OAuth 앱](https://github.com/settings/applications/new)의 Homepage URL은 `https://app.example.com`, callback은 `https://api.example.com/auth/github/callback`으로 등록한다. 운영과 개발 OAuth 앱은 분리한다.

`DATABASE_URL`, `NODE_ENV=production`, 저장소 경로는 Compose가 설정한다. DB는 Docker 내부의 `postgres:5432/envhandoff`에 연결하며 호스트에 DB 포트를 열지 않는다. 공식 서비스의 DB·OAuth·TOTP 키를 재사용하지 않는다.

### 2. 이미지 빌드와 최초 초기화

매번 같은 환경 파일·Compose 파일·프로젝트 이름을 사용하도록 현재 셸에 함수를 정의한다. 새 터미널에서는 다시 정의한다.

```sh
dc() {
  docker compose --project-name envhandoff-self-hosted --env-file .env.production \
    -f compose.production.yaml -f compose.self-hosted.yaml "$@"
}
dc config --quiet
dc build api
dc run --rm --no-deps api node src/deletions.ts --init
dc up -d --wait
dc ps
```

`--init`은 **기존 삭제대장이 없는 최초 설치에서 한 번만** 실행한다. 이미 존재한다는 오류가 나면 경로를 삭제하지 말고 프로젝트 이름·볼륨과 이전 설치 상태를 확인한다. 정상 재배포나 재시작에는 초기화 명령을 넣지 않는다.

`postgres-data`, `encrypted-objects`, `deletion-ledger` 세 named volume을 사용한다. API는 UID `1000:1000`으로 실행하며 객체·삭제대장을 쓸 수 있어야 한다. 프로젝트 이름을 바꾸면 다른 볼륨이 만들어지므로 설치 후 이름을 유지한다. `down -v`는 운영 데이터를 삭제하므로 실행하지 않는다.

API는 호스트의 `127.0.0.1:3000`에만 열린다. 다음 결과는 `401`이어야 한다. 포트를 바꿨다면 명령에도 반영한다.

```sh
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Host: api.example.com' http://127.0.0.1:3000/auth/session
```

### 3. HTTPS 프록시

API DNS를 서버로 연결하고, 호스트에서 실행하는 HTTPS 프록시가 `127.0.0.1:3000`으로 전달하도록 설정한다. 공개 요청의 `Host: api.example.com`을 그대로 전달해야 한다. 예를 들어 호스트에 [Caddy를 설치](https://caddyserver.com/docs/install)했다면 기존 Caddyfile에 다음 사이트를 추가하고 설정 검증 후 서비스를 reload한다.

```caddyfile
api.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

이 예제는 프록시가 Docker 컨테이너 밖, API와 같은 호스트에서 실행되는 경우다. Caddy의 인증서 데이터는 영속 보관하고 DNS와 외부 80·443 포트를 연결한다. API DNS는 우선 DNS only로 연결해 서버 인증서를 확인한다. 다른 프록시를 쓰면 동일한 HTTPS·Host 조건을 적용한다. [Caddy reverse proxy](https://caddyserver.com/docs/quick-starts/reverse-proxy), [자동 HTTPS 조건](https://caddyserver.com/docs/automatic-https)

요청/응답 본문·쿠키·토큰을 로그에 수집하지 않는다. API 응답을 캐시하지 않고, 업로드 크기 제한은 암호문 최대 크기(16 MiB + 134바이트) 이상, 프록시 제한 시간은 API의 120초 전송을 허용하도록 정한다. 현재 API는 forwarded IP 헤더를 신뢰하지 않아 프록시 뒤 요청이 같은 접속 주소 한도를 공유할 수 있다. edge 제한과 실제 동시 사용을 검증하고 API 인스턴스를 임의로 늘리지 않는다.

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://api.example.com/auth/session
```

쿠키 없는 요청의 `401`은 정상이다. `400`은 Host 설정, `503`은 DB·삭제대장·저장소 상태부터 확인한다. HTTPS가 준비되면 A의 웹 빌드·배포를 같은 API 주소로 완료한다.

### 4. 최초 Owner와 팀 설정

`https://app.example.com/pro`에서 실제 GitHub 로그인을 확인한다. 서버에서 최초 Owner의 GitHub 계정 이름으로 초대를 발급한다. 다음 명령의 결과에는 초대 비밀값이 있으므로 공개 로그나 이슈에 붙이지 않는다.

```sh
dc exec api node src/invite-owner.ts YOUR_GITHUB_LOGIN
```

출력된 대상 계정·만료 시각을 확인하고 초대 링크를 해당 계정으로 연다. 워크스페이스를 만든 뒤 패스키 또는 인증 앱을 등록하고, 팀·프로젝트·환경을 만든다. Owner도 파일 권한을 자동으로 얻지 않으므로 필요한 보내기·받기·외부 공유 권한을 명시적으로 설정한다. 팀원은 별도의 GitHub 계정으로 초대한다.

초대를 잘못 발급했다면 출력된 초대 ID로 취소한다.

```sh
dc exec api node src/invite-owner.ts --cancel INVITATION_ID
```

### 5. 전달을 열고 검사

로그인과 저장소를 확인한 뒤 `.env.production`의 `PRO_ACCEPT_NEW_TRANSFERS=true`를 저장하고 API를 재생성한다. 환경변수 변경에는 `restart`만으로 충분하지 않다.

```sh
dc up -d --wait api
```

실제 비밀값 대신 합성 `.env`로 다음을 확인한다.

- 두 계정의 요청 → 승인 → 기기 지문 대조 → 업로드 → 수신 → ACK·재다운로드
- 비회원 공유 링크와 별도 코드, 회수·만료 후 접근 차단
- API 재시작 후 세션·미만료 전달 유지, `/pro/requests` 직접 접속·새로고침
- 사용하는 Safari·Firefox·모바일·실제 기기의 파일 다운로드와 패스키

설치마다 OAuth·HTTPS·브라우저 검사를 수행한다. 저장소의 자동 검사 통과가 개별 서버의 운영 검증을 대신하지 않는다.

## C. Openship으로 Pro API 설치

Cloudflare로 API도 프록시한다면 [Cloudflare 전용 접근 설정](deployment.md)을 적용할 수 있다. `CLOUDFLARE_PROXY_IP`에는 자신의 로컬 프록시 주소를 넣고 프록시의 `X-Real-IP` 덮어쓰기를 확인한다. Cloudflare 없이 직접 Docker로 운영할 때는 이 값을 비워 둔다.

자신의 워크스페이스에 서버를 연결하고 공개 저장소·검증한 커밋의 브랜치·`compose.production.yaml`을 선택한다. 자동 탐지가 개발용 `compose.yaml`을 고르면 운영 파일로 다시 지정한다. `api`와 `postgres` 두 서비스가 보여야 한다. 빌드 context는 저장소 루트 `.`, Dockerfile은 `apps/api/Dockerfile`이다.

B의 환경변수를 Openship 런타임 설정에 입력한다. `postgres`는 내부 전용으로 두고 API 도메인은 **컨테이너 포트 3000**으로 연결한다. `expose`가 자동으로 공개 라우트를 만든다고 가정하지 않는다. Openship에서는 `compose.self-hosted.yaml`을 추가하지 않는다.

[Openship 배포 가이드](deployment.md)의 저장소 초기화 → HTTPS → 웹 배포 → QA 순서로 진행하되, 공식 도메인·서버 이름·계정은 자신의 것으로 바꾼다. 웹은 A의 별도 `wrangler.self-hosted.jsonc`로 배포한다. 최초 Owner는 실행 중 API 컨테이너의 Terminal에서 `node src/invite-owner.ts YOUR_GITHUB_LOGIN`으로 발급한다. 직접 Compose의 `dc` 명령으로 Openship과 다른 볼륨을 만들지 않는다.

## 업데이트와 운영

Docker 설치는 API와 웹에서 같은 새 커밋을 선택하고, 기존 `.env.production`·프로젝트 이름·볼륨·TOTP 키를 유지한다. DB 마이그레이션은 API 시작 시 실행된다. 이전 이미지로 돌리는 것만으로 DB가 되돌아가지는 않으므로 스키마 호환성과 복원 계획을 먼저 확인한다.

```sh
dc build api
dc up -d --wait
dc exec -T api node src/deletion-health.ts
```

API 확인 후 A의 웹 build·dry-run·deploy를 같은 API 주소로 실행하고 로그인과 전달을 다시 검사한다. 새 버전의 `wrangler.jsonc`에 binding·migration 변경이 있다면 자신의 설정 복사본에도 반영하되 계정·도메인은 유지한다. 신규 전달을 잠시 막으려면 `PRO_ACCEPT_NEW_TRANSFERS=false`로 바꾸고 `dc up -d --wait api`를 실행한다. 기존 다운로드는 원래 기한까지 유지된다.

설치자는 [운영·백업·복원 절차](operations.md)를 적용한다. 특히 객체 백업은 끄고, DB 백업에는 토큰 관련 제외 정책을 적용하며, 삭제대장을 DB와 함께 과거 시점으로 되돌리지 않는다. 삭제 지연 감시·API 중단 대응·복원 훈련을 완료한 뒤 사용 범위를 넓힌다. 공식 클라우드 운영자가 자체 호스팅 설치의 백업이나 장애 대응을 대신하지 않는다.
