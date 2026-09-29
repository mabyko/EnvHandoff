# EnvHandoff Pro 배포 가이드

API는 mabyko 서버의 Openship에, 웹과 무료 relay는 기존 Cloudflare에 배포한다. **첫 배포와 QA를 마친 뒤 반복 배포를 자동화**하는 순서로 진행한다.

이 문서는 공식 클라우드의 서버·도메인을 기준으로 한다. 자신의 서버와 계정에 설치하려면 [자체 호스팅 가이드](self-hosting.md)의 Cloudflare 단독·Docker·Openship 경로를 따른다.

기준일: 2026-09-29 · Openship 0.8.0. 개인 워크스페이스의 기존 EnvHandoff 프로젝트에 API·PostgreSQL을, Cloudflare `mabyko` 계정에 웹·relay를 배포했다. HTTPS·CORS·영속 볼륨·공개 relay 검사를 통과했다. 신규 Pro 전달과 자동 배포는 QA가 끝날 때까지 꺼둔다. 상세 결과와 남은 범위는 [QA 기록](qa.md#2026-09-29-운영-배포-검사)에 둔다.

| 지금 하려는 일 | 읽을 부분 |
| --- | --- |
| 처음 서버에 올리기 | [처음 배포하기](#처음-배포하기) |
| 배포된 서비스를 업데이트하기 | [이후 업데이트하기](#이후-업데이트하기) |
| 코드 push만으로 배포하기 | [자동 배포 연결하기](#자동-배포-연결하기) |
| 초기화 명령이나 다른 방식 확인하기 | [참고와 문제 해결](#참고와-문제-해결) |

## 배포 구성

| 대상 | 배포 위치 | 주소·접근 방식 |
| --- | --- | --- |
| 웹·Pro 화면·무료 relay | Cloudflare Worker | `https://envhandoff.mabyko.com`, Pro는 `/pro` |
| Pro API | Openship의 `api` 서비스 | `https://api.envhandoff.mabyko.com` → 컨테이너 포트 `3000` |
| PostgreSQL | Openship의 `postgres` 서비스 | 서버 내부에서만 연결 |
| DB·암호문·삭제대장 | mabyko 서버의 영속 볼륨 | 데이터 종류별로 따로 저장 |

사용할 파일은 세 개다.

- [compose.production.yaml](../compose.production.yaml): 운영 서비스와 볼륨 구성
- [apps/api/Dockerfile](../apps/api/Dockerfile): API 이미지 빌드
- [.env.production.example](../.env.production.example): 입력할 환경변수 예제

루트의 `compose.yaml`은 개발 DB용이다. 운영에서는 `compose.production.yaml`을 선택한다.

## 처음 배포하기

순서는 **코드 준비 → API 설정 → 저장소 초기화 → HTTPS 연결 → 웹 배포 → QA**다. 최초 QA를 마칠 때까지 자동 배포는 꺼둔다.

### 1. 코드를 올리고 Openship 프로젝트 만들기

1. 배포할 커밋을 GitHub `mabyko/EnvHandoff`에 push한다.
2. Openship에서 mabyko 서버를 선택하고 EnvHandoff 프로젝트를 만든다.
3. 저장소와 배포 브랜치를 지정한다. 최초 검증용 브랜치와 이후 운영 브랜치를 구분한다.
4. 아래 값으로 Compose 파일을 불러온다.

| 항목 | 설정값 |
| --- | --- |
| Compose 파일 | `compose.production.yaml` |
| API build context | 저장소 루트 `.` |
| API Dockerfile | `apps/api/Dockerfile` |
| 서비스 | `api`, `postgres` |
| API 인스턴스 | 1개, 자동 절전 끄기 |
| PostgreSQL 공개 범위 | Internal, 호스트 포트 공개하지 않기 |

API는 공용 `packages/protocol`도 사용한다. build context를 `apps/api`로 좁히면 필요한 파일을 가져오지 못한다.

Openship 0.8.0의 소스 필터는 `.dockerignore`의 디렉터리 예외 뒤에 `/`가 있으면 필요한 디렉터리를 제외할 수 있다. 이 저장소는 `!apps/api`, `!packages/protocol`처럼 끝의 `/`를 생략한다. `COPY`에서 파일 없음 오류가 나면 build context와 이 예외를 확인한다.

GitHub API 한도 오류가 나면 `Settings → Git clone credentials`의 PAT와 `Use by default`를 확인한다. 설치된 버전은 기본 clone PAT를 저장소 API 조회에도 사용한다. 최초 스캔 결과가 저장만으로 반영되지 않으면 기존 프로젝트의 `Deploy now`에서 Compose를 다시 읽고 두 서비스·환경변수를 확인해 배포한다.

**확인:** 배포할 브랜치와 두 서비스가 보이고, 운영 Compose 파일이 적용되어 있다.

### 2. GitHub 로그인과 환경변수 설정하기

EnvHandoff 사용자가 로그인할 **운영용 GitHub OAuth 앱**을 준비한다. Openship이 저장소 코드를 가져오는 GitHub 연결과는 별개다.

| OAuth 앱 항목 | 값 |
| --- | --- |
| Homepage URL | `https://envhandoff.mabyko.com` |
| Authorization callback URL | `https://api.envhandoff.mabyko.com/auth/github/callback` |

기존 OAuth 앱에 운영 콜백을 추가하면 Client ID와 Secret은 그대로 쓸 수 있다. 현재 배포는 기존 개발용 콜백도 유지한 같은 앱을 사용한다. 개발·운영 자격 증명을 분리하려면 운영용 앱을 따로 만들고 API의 두 값을 함께 교체한다.

발급받은 값과 새로 생성한 비밀값을 Openship 환경변수에 입력한다.

| 직접 준비할 변수 | 넣을 값 |
| --- | --- |
| `GITHUB_CLIENT_ID` | 운영 OAuth 앱의 Client ID |
| `GITHUB_CLIENT_SECRET` | 운영 OAuth 앱의 Client Secret |
| `POSTGRES_PASSWORD` | URL-safe DB 암호. 32바이트 hex 사용 가능 |
| `TOTP_ENCRYPTION_KEY` | DB 암호와 별도로 생성한 32바이트 소문자 hex |

TOTP 키는 인증 앱 코드를 보호하는 데 사용한다. 재배포할 때 새로 만들지 않고 같은 값을 유지한다. 비밀값은 Git·채팅·웹의 `VITE_*` 변수에 넣지 않는다.

다음 값도 함께 확인한다. 경로와 DB 연결 구성은 Compose에 정의되어 있다.

| 변수 | 운영값 |
| --- | --- |
| `WEB_ORIGIN` | `https://envhandoff.mabyko.com` |
| `API_ORIGIN` | `https://api.envhandoff.mabyko.com` |
| `PRO_ACCEPT_NEW_TRANSFERS` | 최초에는 `false` |
| `DATABASE_URL` | 입력한 암호로 내부 `postgres:5432/envhandoff`에 연결 |
| `FILE_STORAGE_PATH` | `/var/lib/envhandoff/objects` |
| `DELETION_LEDGER_PATH` | `/var/lib/envhandoff/deletions/ledger` |

**확인:** 각 서비스에 실제 값이 전달된다. `${...}` 표현식이 치환되지 않은 채 남아 있으면 환경변수 설정을 수정한다.

### 3. 영구 저장소 연결하고 삭제대장 초기화하기

재배포해도 유지할 데이터는 다음과 같다.

| 볼륨 | 저장하는 데이터 |
| --- | --- |
| `postgres-data` | 계정·권한·전달 상태 등 DB 데이터 |
| `encrypted-objects` | 암호화된 전달 파일 |
| `deletion-ledger` | 이미 삭제한 계정·조직의 기록 |

Openship은 볼륨 이름에 프로젝트 식별자를 붙일 수 있다. 실제 연결된 볼륨을 확인하고, API 실행 계정 `1000:1000`이 객체·삭제대장 볼륨에 파일을 만들고 읽고 삭제할 수 있는지 검사한다.

**삭제대장 초기화는 최초 한 번만 실행한다.** 삭제대장은 과거 DB를 복원했을 때 삭제한 계정·조직이 되살아나는 것을 막는 기록이다. DB 백업과 함께 과거 상태로 되돌리지 않는다.

볼륨 설정을 확인한 뒤 Openship에서 최초 배포를 시작해 API 이미지를 빌드한다. 초기화 전 API가 종료되는 것은 접근 차단을 위한 동작이다. API를 중지한 상태에서 같은 이미지·볼륨으로 [최초 초기화 명령](#삭제대장-최초-초기화-명령)을 실행하고 API를 다시 시작한다. 일반 재시작이나 재배포에서는 반복하지 않는다.

**확인:** API와 DB가 준비 상태 검사를 통과하고, 재시작 후에도 같은 볼륨을 사용한다. 객체 볼륨의 쓰기·삭제도 별도로 확인한다.

### 4. API 도메인과 HTTPS 연결하기

Openship의 API 서비스에 다음 값을 지정한다.

| 항목 | 값 |
| --- | --- |
| 도메인 | `api.envhandoff.mabyko.com` |
| 대상 컨테이너 포트 | `3000` |

Compose의 `expose: 3000`만으로 공개 라우트가 등록되지는 않는다. 도메인과 대상 포트를 명시해야 한다. 설치된 0.8.0은 해당 라우트에 필요한 localhost 포트 바인딩을 추가한다. [설치 버전의 구현](https://github.com/oblien/openship/blob/234d8a9d0bd571aff3fe3ce73a8408f226dcb4a0/packages/platform/src/engine/modules/deployments/compose/deploy.service.ts#L3087)

DNS를 서버로 연결하고 해당 호스트의 HTTPS 인증서를 발급한다. Cloudflare를 사용한다면 DNS 설정에 따라 인증서 구성이 달라진다.

| DNS 연결 방식 | 확인할 내용 |
| --- | --- |
| DNS only | Openship/서버가 해당 호스트의 공개적으로 신뢰되는 인증서를 제공해야 함 |
| Cloudflare 프록시 | `mabyko.com` full DNS zone의 기본 Universal SSL은 이 깊이의 하위 도메인을 덮지 않으므로 적절한 edge 인증서 구성 필요 |

인증서 적용 범위는 [Cloudflare 공식 문서](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)를 따른다.

**확인:** 로그인 쿠키 없이 HTTPS의 `/auth/session`을 호출했을 때 `401`이 반환된다. 이 경로에서는 `401`이 정상 응답이다. 프록시는 공개 API의 `Host`를 그대로 전달해야 한다.

### 5. Cloudflare에 웹 배포하기

API가 준비되면 같은 릴리스의 웹을 배포한다. Cloudflare 배포 권한이 연결된 로컬 환경에서, 저장소 루트를 기준으로 실행한다.

여러 Cloudflare 계정을 쓰면 계정과 인증 프로필을 명시한다. 이번 배포는 Wrangler 4.131.0의 `wrangler auth create mabyko --browser=false`로 `mabyko` 계정만 허용한 프로필을 만들었다. 기존 기본 프로필은 유지했다. [Wrangler 인증 프로필](https://developers.cloudflare.com/workers/wrangler/profiles/)

먼저 웹을 빌드하고 Worker 배포 내용을 점검한다. 이 단계는 실제 배포하지 않는다.

```sh
VITE_PRO_API_ORIGIN=https://api.envhandoff.mabyko.com pnpm --filter @envhandoff/web build
pnpm --filter @envhandoff/server exec wrangler deploy --dry-run
```

빌드와 배포 대상이 맞으면 실행한다.

```sh
CLOUDFLARE_ACCOUNT_ID=5a6f1112ebbc56a66a3de83bdb52ae3f \
  pnpm --filter @envhandoff/server exec wrangler deploy --profile mabyko
```

**확인:** `/pro`, `/pro/requests` 등으로 직접 접속하거나 새로고침해도 화면이 열리고, 웹이 운영 API에 연결된다.

### 6. 실제 흐름을 검사하고 베타 열기

운영 주소에서 다음 순서로 확인한다.

1. GitHub 로그인과 OAuth 복귀, 세션 쿠키·CORS
2. 패스키·TOTP 등록과 재인증
3. 제한된 테스트 계정으로 신규 접수를 열고 합성 파일의 팀 전달·비회원 수신 검사
4. 전달 회수·만료·API 재시작 후 동작
5. 기존 무료 공유·relay와 지원 브라우저·실제 기기 검사

신규 접수는 `PRO_ACCEPT_NEW_TRANSFERS=true`를 적용한 뒤 열린다. 실제 파일 대신 합성 파일로 검사하고, [QA 기록](qa.md)에 결과를 남긴다.

삭제 지연 감시와 API 중단 대응, 백업·복원 절차까지 확인한 뒤 베타 초대를 확대한다. 세부 절차는 [운영 문서](operations.md)를 따른다.

## 이후 업데이트하기

OAuth·도메인·볼륨·삭제대장은 기존 설정을 유지한다. 업데이트마다 새로 만들거나 초기화하지 않는다.

1. 변경한 코드의 검사를 통과시킨 뒤 배포 브랜치에 push한다.
2. Openship 대시보드에서 배포하거나 아래 CLI 명령으로 API를 배포한다.
3. API 배포 성공을 확인하고, 같은 릴리스의 웹을 [웹 배포 단계](#5-cloudflare에-웹-배포하기)에 따라 배포한다.
4. 공개 주소에서 로그인과 주요 전달 흐름을 확인하고 API·웹의 배포 결과를 기록한다.

DB 구조를 바꾸는 업데이트는 기존 데이터와 이전 코드의 호환성을 먼저 검토한다. 데이터 복원이 필요할 때는 [운영 문서의 복원 절차](operations.md#과거-백업에서-복원할-때)를 따른다.

### CLI 연결 — 처음 한 번

CLI를 연결하면 운영자나 코딩 에이전트가 터미널에서 같은 프로젝트를 배포할 수 있다. 공식 Openship CLI를 설치하고 `openship login --help`, `openship deploy --help`로 지원 옵션을 확인한다. 아래 명령은 공식 문서 기준이며 이 서버에서 CLI 인증·배포를 실행해 검증한 상태는 아니다. [CLI 설치](https://openship.io/docs/cli), [연결과 인증](https://openship.io/docs/cli/access)

현재 대시보드의 `localhost:3001` 터널은 유지한다. CLI는 서버의 관리 API 포트 `4000`에 연결하므로, 별도 터미널에서 다음 터널을 연다. 로컬 `14000`은 비어 있어야 한다.

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:14000:127.0.0.1:4000 mabyko-oci
```

Openship `Settings → API tokens`에서 배포 대상 리소스에 필요한 권한을 가진 토큰을 준비한다. 다른 터미널에서 아래 명령을 실행하고 토큰은 CLI의 대화형 입력에 넣는다. 문서나 채팅에는 남기지 않는다.

```sh
openship login \
  --api-url http://127.0.0.1:14000 \
  --dashboard-url http://localhost:3001 \
  --context envhandoff-production
openship context use envhandoff-production
openship project list
```

### CLI 배포 — 업데이트할 때마다

SSH 터널이 연결되어 있어야 한다. 프로젝트 목록에서 확인한 실제 ID를 `ENVHANDOFF_PROJECT_ID`에 지정하고, 대상 서버·브랜치·Compose 경로가 맞는지 확인한다.

```sh
openship deploy --project "${ENVHANDOFF_PROJECT_ID:?Set the verified project ID}" --watch
```

Git 프로젝트는 원격 코드를 사용한다. 로컬 커밋만 만들고 push하지 않은 변경은 배포되지 않는다. `--watch`로 최종 상태까지 확인한 뒤 API 응답을 점검한다. [CLI 배포 동작](https://openship.io/docs/cli/deploy)

## 자동 배포 연결하기

최초 QA를 마친 뒤 다음 세 가지를 설정한다.

| 설정 | 할 일 |
| --- | --- |
| 배포 브랜치 | 검사를 통과한 코드만 반영되도록 필수 검사와 저장소 정책 구성 |
| GitHub 웹훅 | GitHub에서 Openship에 도달할 경로 연결 |
| Auto Deploy | 프로젝트의 `Source → Auto Deploy` 활성화 |

**Auto Deploy는 코드 push로 배포를 시작하는 기능이다.** `pnpm check`나 GitHub Actions 성공을 기다린다고 가정하지 않는다. 검사 성공 후에만 배포하려면 브랜치 반영 조건을 설정하거나 CI에서 CLI/API를 호출한다.

### SSH 터널만으로는 웹훅을 받을 수 없다

GitHub는 개인 컴퓨터의 `localhost:3001`에 접속할 수 없다. 공개 Openship API 또는 프로젝트에서 검증한 도메인으로 웹훅을 받아야 한다.

공식 문서에는 `Source → Webhook Endpoint`에서 검증된 도메인을 선택해 `/_openship/hooks/github`로 받는 방법이 있다. 설치 버전의 지원 여부와 edge 라우팅·서명 검증을 확인하고 GitHub 이벤트가 실제로 도달하는지 검사한다. 관리자 대시보드 전체를 공개할 필요는 없다. [자동 배포와 웹훅](https://openship.io/docs/guides/auto-deploy)

### 웹 배포도 별도로 연결한다

Openship의 자동 배포 대상은 API 스택이다. Cloudflare 웹까지 자동 배포하려면 별도 연결이 필요하다.

CI로 묶을 때의 순서는 **검사 → 호환 가능한 API 배포 → 웹 배포 → 공개 응답 확인**이다. 중간 단계가 실패하면 배포 완료로 처리하지 않는다. CI에는 개인 노트북의 터널 대신 실행기가 접근할 관리 API 경로와 필요한 리소스 권한의 토큰을 제공한다. [CLI 자동화](https://openship.io/docs/cli/automation)

현재 저장소에는 이 자동화 workflow를 추가하지 않았으며, 토큰·웹훅도 아직 연결하지 않았다.

## 참고와 문제 해결

### 응답과 오류 확인

| 상황 | 확인할 내용 |
| --- | --- |
| 쿠키 없는 `/auth/session`이 `401` 반환 | 정상. 로그인하지 않은 상태 |
| API가 `400` 반환 | 공개 API의 Host가 프록시를 거쳐 올바르게 전달되는지 확인 |
| API가 `503` 반환 | DB·삭제대장 접근과 저장소 상태 등을 확인 |
| 최초 API 실행이 삭제대장 오류로 종료 | 아래 초기화 절차 진행 |
| 삭제대장 초기화가 실패하거나 경로가 이미 존재 | 기존 대장 여부·권한·볼륨 확인. 경로를 지워서 재시도하지 않기 |
| push했는데 배포되지 않음 | 배포 브랜치·Auto Deploy·웹훅 전달 상태 확인 |

로그에는 쿠키·공유 토큰·요청/응답 본문을 수집하지 않는다. Openship은 서비스 환경변수를 빌드 인수로 전달할 수 있으므로 Dockerfile에서 비밀값을 `ARG`로 선언하거나 빌드에 사용하지 않는다.

### 삭제대장 최초 초기화 명령

**서버에서, 기존 삭제대장이 없는 최초 설치에만 실행한다.** API를 중지하고 정확한 컨테이너 ID를 `ENVHANDOFF_API_CONTAINER`에 지정한다.

먼저 이미지·실행 계정·마운트를 확인한다.

```sh
docker inspect "${ENVHANDOFF_API_CONTAINER:?Set the exact API container ID}" \
  --format '{{.Image}} {{.Config.User}} {{json .Mounts}}'
```

EnvHandoff API 이미지와 UID `1000:1000`, 객체·삭제대장 볼륨의 경로가 맞으면 같은 이미지·볼륨으로 초기화한다. 이 작업은 DB나 네트워크 연결이 필요 없다.

```sh
ENVHANDOFF_API_IMAGE="$(docker inspect --format '{{.Image}}' "${ENVHANDOFF_API_CONTAINER:?Set the exact API container ID}")"
docker run --rm --network none --user 1000:1000 \
  --volumes-from "$ENVHANDOFF_API_CONTAINER" \
  --env DELETION_LEDGER_PATH=/var/lib/envhandoff/deletions/ledger \
  "${ENVHANDOFF_API_IMAGE:?Could not resolve the API image}" \
  node src/deletions.ts --init
```

성공하면 API를 다시 시작하고 준비 상태를 확인한다. 삭제대장은 마운트 지점 아래의 새 `ledger` 디렉터리에 생성된다.

Openship이 실패한 컨테이너를 이미 제거했다면 위 명령을 사용하지 않는다. 실제 남아 있는 이미지와 프로젝트의 볼륨 ID를 확인해 명시적으로 마운트해야 한다. 대시보드 Terminal은 실행 중 컨테이너만 지원하므로 초기화 전에는 사용할 수 없을 수 있다.

일반 `docker compose run`을 대신 실행하면 Openship과 다른 새 볼륨을 초기화할 수 있다. 초기화 실패를 해결하려고 기존 대장을 삭제하거나 DB 백업과 함께 되돌리지 않는다.

### 다른 배포 방법

| 방법 | 사용하기 좋은 때 | 준비할 것 |
| --- | --- | --- |
| 대시보드 | 최초 설정·수동 배포·장애 확인 | Openship 로그인 |
| CLI | 반복 배포를 터미널이나 에이전트로 실행 | API 연결·인증 토큰 |
| Git push 자동 배포 | 검증된 브랜치를 지속적으로 배포 | 웹훅·브랜치 검사 조건 |
| CI → CLI/API | 검사와 API·웹 배포 순서를 함께 제어 | CI 접근 경로·제한된 권한의 토큰 |
| 폴더 업로드 | GitHub를 거치지 않고 임시 검증 | 올바른 프로젝트와 업로드 범위 확인 |
| SSH + Docker Compose | Openship 없이 직접 운영 | 별도 프록시·TLS·재배포·감시 구성 |

폴더 업로드도 공식 기능이지만 운영은 커밋을 추적하기 쉬운 Git 경로를 권장한다. [폴더 배포 안내](https://openship.io/docs/guides/deploy-local-folder)

### Openship 없이 직접 Compose 실행하기

Openship으로 관리하는 기존 스택과 중복 생성하지 않는다. 새 전용 스택과 `.env.production`을 준비한 서버에서 최초 한 번 실행한다.

```sh
docker compose --env-file .env.production -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.production.yaml build api
docker compose --env-file .env.production -f compose.production.yaml run --rm --no-deps api node src/deletions.ts --init
docker compose --env-file .env.production -f compose.production.yaml up -d --wait
```

이 구성에는 호스트 공개 포트가 없다. 외부 접속을 받으려면 기존 프록시와 충돌하지 않는 네트워크·API 경로·TLS를 별도로 설정해야 한다. 이후 재배포는 초기화를 제외한 build/up 절차를 사용한다. 운영 데이터가 있는 볼륨에 `down -v`를 실행하지 않는다.

### 준비 상태와 관련 문서

2026-09-28 기준 구현 커밋은 `5b771c2`, Docker 배포 구성 커밋은 `ef96af1`이다. 당시 `anglerfish` 브랜치에 로컬 커밋했고 원격 push 전이었다.

`pnpm check`는 API 101개·웹 27개·relay 9개, 총 137개와 타입 검사·lint·빌드가 통과했다. ARM64 이미지 빌드, 볼륨 쓰기, 대장 초기화·재초기화 거부, 재시작, DB·대장 장애 시 접근 차단도 확인했다. 이 결과에 실제 운영 OAuth·HTTPS·지원 기기 QA는 포함되지 않는다.

- [QA 기록](qa.md): 검사 결과와 남은 항목
- [운영과 재해 복원](operations.md): 삭제 감시·백업·복원·긴급 대응
- [v3.0 구현 명세](pro-v3-spec.md): 무료 초대 베타 범위. 제품 내 결제·지속 버전 보관은 v4.0에서 구현
