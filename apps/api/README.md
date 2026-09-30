# Pro API 개발 실행

Node 24, `pnpm install`, Docker가 필요하다. API DB는 개발·테스트·운영 모두 PostgreSQL을 사용하며 드라이버는 `pg`다.

1. [GitHub OAuth 앱 등록](https://github.com/settings/applications/new): 이름 `EnvHandoff Local`, Homepage `http://localhost:5173`, callback `http://localhost:3001/auth/github/callback`. Device Flow는 사용하지 않는다. 로그인 전용 앱으로 다른 연동의 앱을 재사용하지 않는다.
2. `.env.example`을 `apps/api/.env.local`로 복사하고 `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`을 채운다. 기존 파일은 덮어쓰지 않는다. `.env`·`.env.local`과 `.data/`는 Git에서 제외된다. 비밀값은 웹의 `VITE_*` 변수에 넣지 않는다.
3. 저장소 루트에서 로컬 PostgreSQL을 실행한다. Compose는 `127.0.0.1:55432`에만 포트를 열고 개발 DB `envhandoff`와 테스트 DB `envhandoff_test`를 만든다. 예제의 계정·암호는 이 로컬 컨테이너 전용이다.

   ```sh
   docker compose up -d --wait postgres
   pnpm --filter @envhandoff/api db:migrate
   ```

   `apps/api/.env.local`의 `DATABASE_URL`과 `TEST_DATABASE_URL`을 `.env.example`과 맞춘다. API 시작 시에도 버전별 SQL 마이그레이션을 확인한다. `docker compose stop postgres`로 중지해도 named volume의 데이터는 유지된다. `down -v`는 개발·테스트 DB를 삭제하므로 초기화하려는 경우에만 사용한다.

4. 저장소 루트에서 터미널 두 개로 각각 실행한다.

   ```sh
   pnpm --filter @envhandoff/api dev
   ```

   ```sh
   pnpm --filter @envhandoff/web dev --host localhost
   ```

5. `http://localhost:5173/pro`에서 GitHub 로그인 → 계정 이름 표시 → 새로고침 후 유지 → 로그아웃을 확인한다. 두 탭을 열고 한쪽에서 로그아웃했을 때 다른 탭도 로그아웃되는지 확인한다. 이 검사에서는 `127.0.0.1`과 `localhost`를 섞지 않는다. 서버 재시작 후에도 세션이 유지되어야 한다.

### 개발·운영 설정 분리

- `dev`, 테스트, DB 마이그레이션과 관리 명령은 `apps/api/.env.local`만 읽는다.
- `start`는 `apps/api/.env`를 읽는다. 이 파일은 운영 컨테이너의 설정 사본이며, 내부 DB 호스트·볼륨 경로를 그대로 포함하므로 로컬 개발에 사용하지 않는다. Docker 배포는 파일 대신 컨테이너 환경변수를 전달한다.
- 웹의 `apps/web/.env`에는 공개 운영 API 주소만 둔다. `apps/web/.env.local`은 개발 API 주소를 지정하고, `.env.production`을 `.env`에 연결하면 운영 빌드가 로컬 주소로 바뀌지 않는다.
- 폐기할 수 있는 작업 폴더 밖에 API 설정과 로컬 객체·삭제대장을 보관하고, `.env`와 `.env.local`을 해당 설정 파일에 연결하면 작업 폴더를 지워도 설정과 데이터가 남는다. 설정 파일은 소유자만 읽고 쓸 수 있도록 보관한다.

GitHub callback은 위 주소와 정확히 맞춘다. 무료 relay 서버는 이 로그인 검사에 필요하지 않다. 설정을 바꾼 뒤 API를 재시작한다. 자동 검사:

```sh
pnpm --filter @envhandoff/api test
pnpm check
```

## 베타 활성화와 워크스페이스 개설

서버 환경 변수 `PRO_OPERATOR_GITHUB_ID`에 운영자의 GitHub 숫자 ID를 지정한다. 로그인 이름이 아닌 불변 ID이며 빈 값이면 운영자 권한을 부여하지 않는다.

1. 운영자로 로그인하고 내 설정에서 패스키 또는 인증 앱으로 본인 확인한다.
2. **베타 참여 관리**(`/pro/beta`)에서 코드 이름·참여 인원(1~1,000명)·유효 일수(1~365일)를 입력한다.
3. 발급 직후 코드를 복사한다. 원문은 다시 조회할 수 없으며 분실하면 취소 후 재발급한다.
4. 참여자는 로그인 → **Pro Beta 참여하기**에서 코드를 입력한다. 활성화 후 워크스페이스 메뉴의 **새 워크스페이스 만들기**로 최대 2개를 소유할 수 있다.

코드 유효 기간·취소·인원 마감은 신규 활성화만 제한한다. 팀 초대는 별도이며 Owner 승격도 베타 자격을 부여하지 않는다. 일반 회원의 `/beta/codes` 호출은 403으로 거부한다. 발급·취소는 Origin·CSRF·최근 15분 이내 본인 확인을 요구한다. `/beta/redeem`은 실패도 포함해 계정별 10분 20회로 제한한다.

`POST /organizations`는 `{name}`을 받아 현재 베타 자격과 소유 한도를 트랜잭션 안에서 검사한다. 동시 개설·기존 개설 초대·Owner 승격/이전·운영자 복구에도 2개 한도를 적용한다. `/organizations`는 기존 배열 응답을 유지하고 `/beta`에서 활성화 여부·운영자 여부·소유 수·한도를 반환한다.

## 워크스페이스 개설과 멤버 초대

아래 CLI는 자체 호스팅 호환 경로다. 클라우드 신규 온보딩은 위 베타 코드 화면을 사용한다. 기존 운영자 개설 초대 수락자는 베타 자격을 보존한다.

API와 웹 개발 서버를 켜둔 상태에서, 같은 워크트리 루트의 별도 터미널에서 운영자 명령을 실행한다. `YOUR_GITHUB_LOGIN`을 최초 Owner의 GitHub 계정 이름으로 바꾼다. CLI와 API는 같은 `apps/api/.env.local`와 `DATABASE_URL`를 사용해야 한다.

```sh
pnpm --filter @envhandoff/api invite-owner YOUR_GITHUB_LOGIN
```

명령은 공개 GitHub 프로필에서 계정 ID를 확인하고 7일짜리 개설 초대를 발급한다. 출력된 대상 계정을 확인한 뒤 링크를 연다. `/pro`에서 초대 확인 → 워크스페이스 이름 입력 → 초대 수락을 진행하면 조직·Owner 소속·기본 팀·기본 팀 소속이 한 번만 생성된다. 재시도해도 조직이 중복 생성되지 않는다. 개설 초대 발급 HTTP 경로는 없다. 잘못 발급한 개설 초대는 출력된 초대 ID로 취소한다.

```sh
pnpm --filter @envhandoff/api invite-owner --cancel INVITATION_ID
```

Owner는 화면에서 상대 GitHub 계정 이름으로 멤버 초대를 만들고 링크를 복사해 직접 전달한다. 같은 계정의 새 창은 Member 권한 검증을 대신하지 못한다. 추가 GitHub 계정이 없어 이번 단계의 Member 검증은 아래 모의 계정 API 테스트와 화면 코드 검토로 수행했다. 실제 두 계정의 OAuth·브라우저 검증과 구분한다.

수동 검사: 개설 초대 수락 후 Owner 표시, 새로고침 후 조직 유지, 같은 링크 재수락 시 중복 조직 없음, 다른 계정의 수락 거부와 원래 계정의 후속 수락 성공, Member에게 관리 버튼 없음, 초대 취소 후 수락 거부, 멤버 제외 후 조직 접근 거부를 확인한다. 개발 서버의 watch가 멈췄다면 API를 다시 실행한다. 에이전트는 실제 계정용 초대를 자동 발급하거나 다른 사람에게 보내지 않았다.

## 구현 범위와 운영 전 남은 일

운영 DB는 PostgreSQL로 확정했다. 호스팅 업체와 운영 접속 정보는 아직 정하지 않았다. 로컬 개발은 Compose의 `envhandoff`, 자동 테스트는 `envhandoff_test` 안에서 테스트마다 새 스키마를 만들고 종료 시 해당 스키마만 정리한다. 테스트 DB 이름은 `_test`로 끝나야 하며 DB가 없으면 테스트를 건너뛰거나 SQLite로 대체하지 않고 실패한다. 원격 운영 DB에는 별도의 계정·접속 주소와 검증된 TLS 설정을 사용한다.

이전 SQLite 파일 `apps/api/.data/api.sqlite`는 그대로 보존하고 현재 API는 더 이상 읽지 않는다. PostgreSQL에는 새로 로그인해야 한다. SQLite 계정·세션·워크스페이스 자동 복사는 제공하지 않는다. 전환 전 사용자 요청으로 `test` 워크스페이스와 연결된 팀·소속·초대는 삭제했고, 그때의 SQLite 계정·세션과 최소 감사 기록은 원본 파일에 남아 있다. 현재 워크스페이스 삭제는 재인증한 Owner가 `POST /organizations/:id/remove`와 팀 설정 화면에서 수행한다.

`/pro`에서 Owner는 팀 생성·이름 변경·소속 편집·삭제, 프로젝트 생성·팀 연결·이름 변경·삭제, 환경 생성·이름 변경·삭제와 멤버별 파일 권한 설정을 할 수 있다. 워크스페이스 개설 시 기본 팀을 함께 만든다. 기본 팀은 이름·소속을 변경할 수 있지만 삭제할 수 없다. 프로젝트 생성 시 별도 팀을 지정하지 않으면 기본 팀에 연결한다. 새 팀에는 소속이나 프로젝트 연결을 자동으로 추가하지 않는다.

Member는 소속 팀에 연결된 프로젝트만 조회한다. 파일 권한은 현재 조직 가입·활성 상태, 연결된 팀 소속, 환경의 명시적 권한이 모두 있어야 유효하다. 받기·보내기·외부 공유는 독립적이며 처음에는 모두 꺼져 있다. Owner도 파일 권한을 자동으로 얻지 않는다. 팀 경로 하나가 없어져도 다른 유효 경로가 있으면 접근은 유지되고, 마지막 경로가 사라지면 차단된다. 팀 연결이 복구되면 기존 명시적 권한이 다시 적용되지만 조직에서 제외된 멤버의 권한은 삭제하여 재가입만으로 복구되지 않는다. 프로젝트·환경 삭제는 하위 권한을 함께 삭제하고, 팀 삭제는 소속·프로젝트 연결을 제거하며 해당 팀 초대를 취소한다.

- `POST /auth/github/start`: 정확한 웹 Origin 검사, 로그인 거래에 묶인 HttpOnly 쿠키, 10분 일회성 state와 S256 PKCE. 기존 세션이 있으면 CSRF도 검사한다. 웹은 응답 URL로 직접 이동한다.
- `GET /auth/github/callback`: state·브라우저 쿠키·기존 세션 결합 검사 후 원자적으로 거래를 소비한다. `/user`의 숫자 ID를 내부 UUID에 연결한다. login 이름은 표시용이며 바뀌어도 계정이 유지된다. 성공/실패 복귀 주소는 `/pro` 또는 `/pro?auth=failed`로 고정한다.
- 공급자 access/refresh token은 DB·로그·웹에 저장하지 않는다. 빈 scope만 허용하며 계정 조회 후 이번 로그인에 사용한 access token만 삭제하고 앱 authorization grant는 유지한다. scope/프로필 검증 실패 시에도 토큰 삭제를 시도하고, 공급자 삭제 실패 시 서비스 세션을 발급하지 않는다. 실패한 외부 요청의 실제 삭제까지 보장하는 것은 아니다. 계정 선택을 강제하지 않으며, GitHub 로그인과 기존 앱 승인이 유효하면 반복 승인 화면을 생략할 수 있다. 여러 GitHub 계정이 로그인돼 있으면 계정 선택 화면이 나올 수 있다.
- `GET /auth/session`: 현재 계정 활성 상태와 세션 만료를 확인한다. 비활성 12시간·절대 7일. DB에는 세션 토큰의 SHA-256만 저장하고 CSRF 토큰은 세션에 묶는다. 로그인 성공 시 이전 세션을 교체한다.
- `POST /auth/logout`: 정확한 Origin + 세션 CSRF 검사, 서버 세션과 연관 로그인 거래 폐기, 쿠키 삭제. 진행 중인 OAuth 교환도 폐기된 세션을 되살리지 못한다. 운영자용 `disable-account` CLI와 내부 `disableUser`는 계정과 모든 세션을 비활성화한다. 공개 운영자 HTTP 경로는 제공하지 않는다.
- 운영 쿠키는 `__Host-` 접두어, `Secure; HttpOnly; SameSite=Lax; Path=/`, Domain 속성 없음. 웹과 API는 HTTPS의 같은 site 하위 도메인으로 운영해야 한다. 정확한 `WEB_ORIGIN`, `API_ORIGIN`을 명시한다. HTTP 예외는 `NODE_ENV=development`의 `localhost`에만 허용한다. 개발 쿠키는 운영 쿠키와 이름도 다르다.
- Node 서버는 로그인 시작과 조직·보안 변경 POST를 합쳐 접속 주소당 10분 20회로 제한하며 전체 대기 로그인 거래는 1,000개로 제한한다. 현재 단일 프로세스용이며 프록시 IP 헤더는 신뢰하지 않는다. 운영 프록시에서는 별도 edge 제한과 정확한 Host 전달 설정을 검증해야 한다. HTTPS 종료·실제 영속 디스크·호스팅 구성은 아직 미검증이다.
- 로그인·세션 종료·계정 중지 사건은 ID/사건/시각만 기록하고 30일 후 정리한다. 매분 만료 거래·세션·기록을 정리한다. PostgreSQL 접근 계정과 비밀 설정 파일은 운영 환경에서 별도로 보호한다.
- `/pro`에 조직 목록·전환, 초대 확인/수락, Owner의 멤버 초대·취소·제외, Member의 본인 탈퇴를 연결했다. 모든 조직 작업에서 현재 세션·소속·역할·베타 활성 상태를 다시 검사한다. 마지막 Owner의 탈퇴를 거부하고 Owner 승격·강등·이전에는 현재 세션의 최근 재인증을 요구한다.
- 초대는 고정된 GitHub 숫자 ID·조직·팀에 묶고 토큰 해시만 DB에 보관한다. 다른 계정의 시도는 소비하지 않는다. 수락한 초대 재시도는 현재 가입 결과를 반환하며, 멤버 제외 시 이전 초대와 팀 소속을 함께 무효화해 오래된 링크로 다시 가입할 수 없다. 초대자의 Owner 자격 상실·계정 중지 시 미수락 초대도 거부한다. 멤버는 최대 20명, 발급자는 10분 20개, 조직별 대기 초대는 100개로 제한한다. 개설 초대 대기는 전체 100개다.
- 조직 변경은 Origin·세션 CSRF와 최대 8 KiB JSON 검사를 거친다. GitHub 계정 조회처럼 비동기 처리를 마친 후에도 세션과 Owner 자격을 재검사한다. 조직 생성·가입·탈퇴·초대 소비는 PostgreSQL 트랜잭션으로 처리한다. 사건 기록은 30일, 초대 기록은 만료 시각부터 30일 후 정리한다. 장기 만료·삭제된 초대는 재수락할 수 없다.
- 브라우저 계정·CSRF·조회 결과는 메모리에만 보관한다. 계정에 묶인 초대 토큰만 OAuth 왕복을 위해 해당 탭의 `sessionStorage`에 임시 보관하고 수락 시 삭제한다. 링크의 fragment는 URL에서 제거한다. 저장소 사용이 거부되면 로그인 후 링크를 다시 붙여넣을 수 있다. 다른 탭의 인증 변경, 포커스 복귀 확인, 만료 시 표시 제거를 유지한다.
- 조직 가입은 환경 파일 권한이나 기기 신뢰를 부여하지 않는다. 팀·프로젝트·환경 관리, 환경별 파일 권한·기기 관리와 팀원 파일 전달 API·화면을 구현했다. 요청 취소와 전달 회수는 멤버 제외·유효 권한 상실·프로젝트/환경 삭제·기기 회수와 같은 거래에 연결했다. 권한을 다시 부여해도 회수된 전달은 부활하지 않는다. 운영 저장소와 출시 검증 전에는 베타를 공개하지 않는다.
- **최근 재인증은 패스키와 선택형 인증 앱으로 구현했다.** GitHub OAuth callback 시각을 최근 재인증으로 인정하지 않는다. 성공한 재인증은 현재 세션에서 15분간 유효하며 기기 승인/회수/분실 복구에 연결했다. Owner 변경·이전·Owner 탈퇴·조직 삭제에도 같은 최근 재인증을 적용한다.

근거: [OAuth 앱 등록](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app), [OAuth state·PKCE·계정 조회·prompt](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [최소 scope](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps), [사용한 OAuth 토큰 삭제](https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token).

전환 전 검증 기록: 실제 SQLite 재열기와 모의 GitHub 응답으로 OAuth/세션 테스트 5개, 기존 기기 테스트 4개가 통과했다. 외부 GitHub 로그인 성공이나 브라우저 쿠키 동작은 이 테스트의 범위가 아니다. 현재 에이전트 환경은 포트 listen이 EPERM으로 거부되고 브라우저 새 페이지도 승인 정책상 차단되어 실제 로그인은 위 수동 절차로 확인해야 한다.

2026-09-28 사용자 확인: 개발용 OAuth 설정 저장 후 로컬 `/pro`에서 실제 GitHub 로그인과 계정 이름 표시가 성공했다. 이어서 새로고침 후 로그인 유지와 한 탭의 로그아웃이 다른 탭에도 반영되는 것을 확인했다. 서버 재시작 후 세션 유지는 아직 사용자 확인 전이며, 운영 HTTPS 쿠키 동작의 검증으로 간주하지 않는다.

후속 사용자 화면에서 개설 초대 수락 후 워크스페이스와 Owner 표시, 멤버 초대 폼을 확인했다. 추가 계정 없이 코드로 검증하자는 사용자 요청에 따라 모의 Owner/Member/다른 멤버의 서로 다른 세션으로 HTTP 처리 함수를 호출하는 테스트를 추가했다. 초대 발급→잘못된 계정 거부→대상 Member의 확인/수락/재수락→조회→관리 요청 거부→Owner의 취소/제외→제외된 멤버 접근 및 과거 초대 재사용 거부→Member 본인 탈퇴가 통과했다. 권한 없는 발급은 GitHub 조회도 호출하지 않고, 거부된 요청이 소속·초대 상태를 바꾸지 않는 것을 확인했다. API 테스트 15개·타입 검사·lint가 통과했다. `ProOrganizations.tsx` 코드에서 초대 발급/취소는 Owner 조건, 다른 멤버 제외는 Owner 조건, 본인 탈퇴는 Member 조건으로 표시됨을 검토했다. 이는 Member 화면을 실제 브라우저에서 실행한 결과는 아니다.

조직·초대 추가 후 API 14개(조직 5개 포함), 웹 19개(링크 파싱 1개 포함), 합계 33개 테스트와 전체 타입 검사·lint·웹 빌드가 통과했다. 조직 테스트는 두 DB 연결과 재시작 후 멱등 처리, 다른 계정/조직/팀 차단, 만료·취소·탈퇴 후 재사용 거부, 20명 한도, 계정 중지와 조회 중 권한 상실, Origin/CSRF/JSON 경계를 검사한다. 브라우저 새 페이지는 도구 승인 정책상 차단되어 새 조직 화면은 실제 브라우저 미검증이다. 공개 계정 조회 근거: [GitHub Get a user](https://docs.github.com/en/enterprise-cloud%40latest/rest/users/users#get-a-user).

팀·프로젝트·환경 단계에서는 Owner의 파일 권한 기본 거부, 독립된 세 권한, 복수 팀 경로, 다른 조직 ID 혼합 차단, Member의 관리 요청 거부, 조직/계정 중지, 입력 검증, 재가입 시 권한 제거, 삭제 시 하위 데이터 정리와 기존 DB 이관을 모의 계정으로 검사했다. 추가 GitHub 계정은 필요하지 않다. 새 관리 화면은 코드로 검토했으며 실제 브라우저 검증은 별도로 남아 있다.


## PostgreSQL 전환과 검증

`sql/001-initial.sql`에 인증·조직·권한·기기 테이블, `002-security.sql`에 패스키·인증 앱·재인증 테이블, `003-requests.sql`에 유효 파일 권한 뷰·요청·작업 재시도 기록을 정의하고 `schema_migrations`로 적용 버전을 기록한다. 쿼리는 `$1` 형태의 매개변수를 사용한다. 각 트랜잭션은 전용 pool client를 사용하며 실패 시 rollback하고 반환한다. 작은 베타의 기존 직렬 처리 규칙을 유지하려고 DB·스키마 단위 트랜잭션 advisory lock을 사용한다. 이 방식은 여러 API 인스턴스 사이에도 적용되지만 처리량이 커지면 조직/계정 단위 행 잠금으로 좁혀야 한다. GitHub 조회와 기기 암호 검증은 잠금 밖에서 수행하고, 변경 직전에 세션·자격·일회성 소비 조건을 다시 확인한다.

기존 OAuth·조직·기기 테스트를 실제 PostgreSQL로 전환했고, rollback·같은 pool의 동시 호출·서로 다른 pool의 경쟁·마이그레이션 재실행을 검사한다. 위 SQLite 시절 통과 기록은 이 전환의 검증 결과를 대신하지 않는다.

근거: [node-postgres 트랜잭션](https://node-postgres.com/features/transactions), [pool 연결과 반환](https://node-postgres.com/apis/pool), [PostgreSQL advisory lock](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS), [공식 Docker 이미지와 PostgreSQL 18 볼륨 경로](https://hub.docker.com/_/postgres). Context7 조회는 DNS 제한으로 실패해 공식 문서를 확인했다.

2026-09-28 후속 세션 검증: OrbStack에서 `docker compose up -d --wait postgres`로 PostgreSQL을 기동하고 `pnpm --filter @envhandoff/api db:migrate`를 완료했다. 이전 세션의 Docker 소켓·DB 연결 `EPERM`은 재현되지 않았다. `pnpm check`의 API 21개·웹 19개·relay 9개, 총 49개 테스트와 전체 타입 검사·lint·빌드가 통과했다. 테스트 종료 후 전용 DB에 남은 테스트 스키마는 0개였다. 기존 API 개발 서버를 재시작해 준비 로그와 비로그인 `/auth/session`의 401 응답을 확인했다. PostgreSQL 전환 후 실제 GitHub 로그인·브라우저 화면 검증과 운영 배포 검증은 별도로 남아 있다.


## 패스키·인증 앱과 기기 관리

`/pro`의 **본인 확인과 내 기기**에서 패스키(최대 5개)와 인증 앱(TOTP, 계정당 1개)을 등록할 수 있다. 첫 수단은 GitHub 로그인 후 15분 이내에 등록한다. 이것은 최초 설정이며 OAuth나 등록 완료를 최근 재인증으로 간주하지 않는다. 이후 수단 추가·삭제에는 기존 수단으로 확인한 최근 재인증이 필요하다. 마지막 수단은 삭제하지 못하며, 수단 삭제는 모든 세션의 최근 재인증과 미완료 수단 도전을 폐기한다. 등록 수단을 모두 분실한 경우 사용자용 우회·초기화·복구 코드는 제공하지 않는다. 다른 기기에 동기화된 패스키나 별도 인증 앱을 미리 준비한다.

패스키는 `@simplewebauthn/server`와 `@simplewebauthn/browser`를 사용한다. RP ID는 정확한 `WEB_ORIGIN`의 hostname이며 운영과 localhost의 패스키는 별개다. 등록·확인 모두 사용자 검증(UV)을 필수로 요구하고, 정확한 origin·RP ID·계정·세션·작업·5분 만료·서명·카운터를 검사한다. 교차 출처 iframe 의식은 거부한다. DB에는 공개키·카운터·표시 이름만 저장한다. 각 도전의 소비와 상태 변경은 같은 거래에서 처리하고 로그아웃·계정 중지·기존 수단 삭제를 확정 직전에 다시 검사한다.

인증 앱은 RFC 6238 SHA-1, 6자리, 30초 방식이다. 앱 QR은 브라우저에서만 생성하고 설정 키는 탭 메모리에서 최대 5분 제공한다. 코드를 확인해야 등록되며, 등록 확인에 쓴 코드는 재인증에 재사용할 수 없다. 한 단계의 시계 오차(±30초)를 허용하고 이미 소비한 단계는 다른 세션·API에서도 다시 쓰지 못한다. 코드 검증은 계정당 10분 5회, 보안 변경은 계정당 10분 60회로 제한하며 실패해도 횟수는 DB에 남는다. 서버의 기존 IP 제한도 함께 적용된다. 이 기능은 민감 작업 재인증이며 GitHub 로그인 자체를 2단계 로그인으로 바꾼 것은 아니다.

인증 앱 비밀키는 `TOTP_ENCRYPTION_KEY`로 AES-256-GCM 암호화하고 사용자 ID를 AAD에 결합한다. 이 값은 32바이트 난수의 소문자 hex 64자리이며 OAuth secret과 별개로 DB 밖에 보관한다. 키가 없으면 패스키는 동작하고 인증 앱 등록·검증은 거부한다. 키를 잃거나 바꾸면 기존 인증 앱 검증을 할 수 없으므로 기존 키를 유지하고 운영에서는 별도 비밀 저장소에 보관해야 한다. 이번 로컬 환경에는 기존 OAuth 설정을 유지한 채 키를 생성했다. 새로운 환경에서는 안전한 터미널에서 아래 명령으로 키를 만들어 `.env`에 직접 저장한다. 채팅·저장소에 올리지 않는다.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

주요 경로는 `GET /security`, `POST /security/passkeys/{options,verify,remove}`, `POST /security/reauth/{options,verify}`, `POST /security/totp/{options,confirm,verify,remove}`, `POST /security/devices/{challenge,complete}`다. POST는 정확한 Origin·세션 CSRF·8 KiB JSON을 검사하고 클라이언트가 보낸 사용자 ID나 재인증 시각을 신뢰하지 않는다. 기기 등록·승인·복구에는 현재 활성 조직 소속이 필요하다. 본인 기기 회수와 인증 수단 관리는 조직에서 나간 뒤에도 가능하다. 새 기기 승인은 새 기기에서 확인한 지문을 입력받고 브라우저에서 공개키와 대조한다. 패스키나 인증 앱으로 파일 키를 복구하거나 이전 파일을 새 기기에 자동 배포하지 않는다.

검증: 실제 PostgreSQL과 합성 인증기의 실제 P-256 서명으로 등록·UV·origin·RP·세션·재사용·만료, RFC TOTP 공개 벡터·암호화·코드 재사용·횟수 제한, 수단 추가/마지막 삭제 차단과 기기 등록·승인·분실 복구·로그아웃/소속 상실 후 완료 거부를 검사했다. 전체 `pnpm check`는 API 26개·웹 19개·relay 9개, 총 54개와 타입 검사·lint·빌드가 통과했다. 격리된 Chrome과 테스트 DB에서 인증 앱 QR/등록·코드 재사용 거부·재인증·기기 등록/회수, 390px 가로 넘침 없음을 확인했다. 실제 Touch ID/보안키·외부 인증 앱 스캔·두 물리 기기·Safari/Firefox는 아직 수동 검증 전이다. API 테스트나 합성 인증기를 실제 패스키 창의 검증으로 간주하지 않는다.

근거: [SimpleWebAuthn 서버](https://simplewebauthn.dev/docs/packages/server), [브라우저](https://simplewebauthn.dev/docs/packages/browser), [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238), [인증 앱 URI](https://github.com/google/google-authenticator/wiki/Key-Uri-Format). Context7으로 현재 라이브러리 문서를 조회하고 설치된 v14의 타입·검증 구현을 확인했다.

## 팀원 파일 요청

`/pro`의 요청함에서 받기 권한이 있는 환경과 보내기 권한이 있는 다른 멤버를 선택한다. 수신 기기는 현재 브라우저에 저장된 등록 기기로 고정한다. 지정 송신자는 승인·거절할 수 있고, 양 당사자와 현재 Owner는 미이행 요청을 취소할 수 있다. 승인해도 생성 후 7일 기한은 늘어나지 않는다. 승인된 요청에서는 아래의 암호화 업로드·수신·ACK 흐름을 사용할 수 있다.

- `GET /organizations/:orgId/requests`: 진행 중인 요청 우선, 최근 100개. 당사자·현재 Owner만 조회한다.
- `GET /organizations/:orgId/requests/options?environmentId=:id`: 현재 받기 권한을 확인한 뒤 요청 가능한 송신자 목록.
- `GET /organizations/:orgId/requests/:id`: 단일 요청. 종료 시 ID·상태·방향·시각만 반환한다.
- `POST /organizations/:orgId/requests`: `operationId`, `environmentId`, `senderId`, `deviceId`.
- `POST /organizations/:orgId/requests/:id/{approve,reject,cancel}`: `operationId`.

모든 변경은 Origin·세션 CSRF·8 KiB 입력 제한을 적용하고, 입력 수신 후 거래 안에서 세션을 다시 검사한다. 사용자별 작업 ID를 DB에 저장해 같은 내용의 재시도는 최초 작업 결과를 반환하고, 다른 내용은 409로 거부한다. 재시도도 현재 접근 권한을 검사한다. 작업 결과는 과거 처리 영수증이므로 현재 상태는 GET으로 다시 확인하며, 재시도로 종료 상태를 되돌리지 않는다. 조직의 미이행 요청은 100개, 사용자별 요청·업로드 시도 생성 합계는 10분에 20개까지다. 외부 공유 생성도 같은 집계에 포함한다.

`effective_file_permissions` 뷰를 카탈로그·파일 권한 판정·요청 종료에서 함께 사용한다. 팀 소속·프로젝트 연결·환경 권한·멤버 제외·프로젝트/환경 삭제, 수신 기기 회수·분실 복구, 계정 중지는 해당 변경 거래 안에서 미이행 요청을 취소한다. 다른 팀 경로로 권한이 유지되면 취소하지 않는다. API 밖의 운영자 작업도 권한 변경과 `invalidateRequests`를 같은 거래로 처리해야 한다. 이 함수는 관련 업로드 종료·전달 회수도 수행한다. 조회와 분 단위 정리에서도 만료·유효 권한을 검사하고 종료 기록은 30일 뒤 정리한다.

## 팀원 파일 업로드·수신·ACK

승인된 요청에서 송신자는 상대 기기 지문을 별도 대화로 확인한 뒤 파일과 배치 경로, 보관 기간(24시간·3일·7일)을 선택한다. 브라우저가 팀 외피를 암호화하고 서버에는 암호문만 올린다. 수신자는 요청 당시의 브라우저 기기에서 송신자 지문을 확인하고 파일을 연다. 전체 인증·형식 검사를 통과한 뒤 ACK를 남기며, ACK는 프로젝트 적용이나 로컬 저장 완료를 뜻하지 않는다. 송신자가 로그아웃해도 수신할 수 있고 ACK 뒤에도 같은 만료 시각까지 다시 받을 수 있다.

`sql/004-transfers.sql`에 업로드·전달 도전·다운로드 예약을 저장한다. 개발 저장소는 `apps/api` 기준 `.data/objects`이며, 운영은 `FILE_STORAGE_PATH`로 비공개 영속 경로를 지정해야 한다. 파일 서버·CDN으로 이 경로를 공개하지 않는다. 운영 다중 인스턴스에서는 모든 인스턴스가 같은 객체를 읽고 삭제할 수 있는 저장소가 필요하며, 이번 로컬 검증은 그 구성을 검증하지 않는다.

요청 경로 `/organizations/:orgId/requests/:requestId` 아래에서 다음 API를 제공한다.

| 경로 | 동작 |
| --- | --- |
| `GET /transfer` | 송신 준비 정보 또는 전달 상태·기기·binding 조회 |
| `POST /uploads`, `GET /uploads/:id` | 암호문 크기·해시·기간 예약 및 업로드 상태 확인 |
| `POST /uploads/:id/challenge`, `/content`, `/cancel` | 송신 기기 증명, 바이너리 업로드, 시도 취소 |
| `POST /transfer/challenge`, `/content`, `/ack` | 지정 수신 기기 증명, 암호문 수신, 최초 ACK 기록 |
| `POST /transfer/revoke` | 당사자 또는 현재 Owner의 전달 회수 |

JSON은 8 KiB로 제한하고 바이너리 업로드는 선언 크기·실제 크기·해시를 검사한다. 증명은 세션·기기·작업·요청·전달·암호문 해시에 묶으며 한 번만 소비한다. 객체 저장 후 DB 확정 직전에 세션·권한·기기를 다시 검사한다. 업로드 확정 응답을 잃으면 상태를 조회하며, 같은 작업 ID로 내용을 바꾸면 충돌로 거부한다. 부분 이어 올리기는 제공하지 않는다.

암호문은 최대 16 MiB + 134바이트, 조직 저장 예약·삭제 대기를 포함한 용량은 512 MiB, 동시 업로드는 3개다. 다운로드는 조직별 UTC 하루 1 GiB와 전달별 동시 3개를 제한하고 예약 후 실제 읽힌 바이트로 정산한다. 팀·외부 다운로드 모두 시작 후 120초에 종료해 5분짜리 예약 기한을 넘기지 않는다. 전달 POST의 접속 주소 제한은 다른 변경과 별도로 10분 120회다. 회수·만료 즉시 새 다운로드를 차단하고 매분 객체 삭제를 시도한다. 삭제 실패는 재시도하며 실제 삭제 전에는 용량을 반환하지 않는다. 복원 차단 명령과 로컬 장애 검사는 구현했으며, 24시간 삭제 목표의 운영 감시와 실제 백업 복원 훈련은 남아 있다. 이미 받은 사본은 회수할 수 없다.

2026-09-28 세션 복구 후 검증: `pnpm check` API 37개·웹 19개·relay 9개, 총 65개와 타입 검사·lint·빌드 PASS. 실제 PostgreSQL과 암호문으로 재시작·송신자 로그아웃·고정 수신 기기·ACK·재다운로드·업로드 중 취소·권한 재부여 후 차단·기한·객체 정리·다운로드 한도를 검사했다. 격리된 Chrome 두 컨텍스트에서는 실제 React 화면과 테스트 계정으로 요청·승인·기기 지문 확인·업로드·송신자 로그아웃·수신·ACK·재다운로드·회수를 확인했다. 합성 `.env`의 다운로드 Blob 34바이트에서 BOM·CRLF 보존을 확인했고, 송신 화면 390px에서 가로 넘침이 없었다. OS 파일 선택 창·두 물리 기기·실제 OAuth를 이 브라우저 검사로 검증했다고 보지 않는다. 세부 결과와 남은 항목은 [QA 기록](../../docs/qa.md)에 둔다.

## 비회원 외부 공유와 운영 복원

`sql/005-shares.sql`에 외부 공유와 팀 전달 합산 한도를 추가했다. 환경의 `external_share` 권한은 보내기·받기·기기 등록과 독립적이다. 브라우저는 기존 v1 묶음을 별도 코드로 암호화하고, 256비트 접근 토큰은 링크 fragment로만 전달한다. 서버에는 토큰 해시만 저장하고 코드·파일 키는 보내지 않는다.

- `/organizations/:orgId/shares`: GET 목록, POST 예약. `/:id` GET 상세, `/:id/content` POST 암호문, `/:id/reissue` POST 토큰 교체, `/:id/revoke` POST 회수.
- `/shares/:id`: 비회원 GET 미리보기, `/content` POST 다운로드, `/ack` POST 수신 확인. `x-share-token` 헤더를 사용하며 미리보기로 소비하지 않는다. POST는 웹 Origin을 검사한다.
- 생성자만 링크를 재발급한다. 기존 토큰은 즉시 무효화하며 암호문·코드·최초 기한·ACK는 유지한다. 현재 Owner는 조회·회수할 수 있지만 다른 사람의 코드를 읽거나 링크를 재발급할 수 없다.
- 외부 암호문은 최대 16 MiB다. 저장 512 MiB·동시 업로드 3개·일일 다운로드 1 GiB는 팀 전달과 합산한다. 공개 경로는 접속 주소별 분당 60회와 공유별 분당 30회를 제한한다. 접속 제한은 단일 프로세스 범위다.

브라우저는 fragment를 즉시 제거하고 링크·코드·파일을 메모리에 둔다. 전체 복호화·형식 검증 뒤에 ACK를 전송한다. 새로고침으로 코드가 복원되지 않으며, 분실하면 원본으로 새 공유를 만든다. 내부 관리 링크 `/pro?org=<UUID>&share=<UUID>`와 요청의 `request=<UUID>`는 로그인 후 상세로 돌아오되 현재 소속·권한을 다시 검사한다.

[운영과 재해 복원](../../docs/operations.md)에 영속 저장소·로그·백업 제외·삭제 감시와 `restore-safe`의 조회/적용 절차를 기록했다. 오래된 DB를 복원할 때는 API를 중지하고 전달 차단 및 전용 객체 볼륨 폐기를 마친 뒤 재개한다. 이 명령은 일반 재시작에 자동 실행하지 않는다. 실제 운영 배포·백업 설정은 아직 미검증이다.

병렬 구현 최종 `pnpm check`: API 69개·웹 22개·relay 9개, 총 100개 및 전체 타입 검사·lint·빌드 PASS. 운영 배포와 실제 장치 검증은 이 결과에 포함하지 않는다.

## Pro 페이지와 조직 수명 관리

`/pro/requests`, `/pro/shares`, `/pro/projects`는 목록과 `/:id` 상세를 분리한다. `/pro/team`은 멤버·팀·역할 관리, `/pro/settings`는 재인증·내 기기 설정이다. 프로젝트에서 환경을 선택해 요청·공유 생성으로 이동한다. 로그인 복귀에는 검증한 상대 경로만 저장하고 공유 토큰·코드는 포함하지 않는다. 일시적인 세션 조회 실패는 기존 파일·코드를 유지한 채 서버 작업을 잠그며, 실제 401·로그아웃·세션 만료에는 민감 상태를 지운다.

Owner 승격·강등·원자적 이전과 조직 삭제를 연결했다. 현재 Owner와 최근 15분의 세션 재인증을 확인하고 마지막 활성 Owner를 보호한다. 역할 변경은 환경별 파일 권한을 바꾸지 않으며, Owner 자격을 잃으면 미수락 초대를 무효화한다. 조직 삭제는 비활성 식별자를 남기고 조직 이름·소속·프로젝트·환경·초대를 제거하며 요청·전달·외부 공유 접근을 같은 거래에서 종료한다. 계정·전역 기기·다른 조직은 유지한다. 물리 암호문 삭제는 기존 정리 절차를 따른다.

이번 제품 화면 작업 후 `pnpm check`: API 73개·웹 24개·relay 9개, 총 106개와 타입 검사·lint·빌드 PASS. 세부 브라우저 범위는 [QA 기록](../../docs/qa.md)을 따른다.

## 계정 삭제·삭제 우선 복원·관리 역할 복구

`POST /auth/account/remove`는 현재 세션·CSRF·정확한 Origin과 15분 이내 재인증을 요구한다. 마지막 활성 Owner이면 `409 last_owner`, 독립 삭제대장 오류이면 `503 deletion_ledger_unavailable`을 반환한다. 성공은 `204`이며 계정의 인증 수단·세션·기기·소속·초대를 제거하고 연관 전달을 종료한다. `/pro/settings`에서 실행하며 브라우저 키·신뢰 기록도 정리한다.

`DELETION_LEDGER_PATH`에는 객체·DB 스냅샷과 분리한 전용 영속 디렉터리를 지정한다. 최초 한 번 `pnpm --filter @envhandoff/api deletion-ledger --init`으로 초기화한다. API 시작·요청·복원 도구는 이 대장의 삭제를 먼저 적용한다. 디렉터리 초기화·운영 경로 설정은 이 구현 작업에서 실행하지 않았다.

운영자 도구 `pnpm --filter @envhandoff/api management-recovery --help`는 연락 검증 참조의 최초 등록과 관리 역할 복구 계약을 보여준다. 사용자용 인증 수단 초기화나 파일 키 복구 API는 제공하지 않는다. 신규 접수 종료는 `PRO_ACCEPT_NEW_TRANSFERS=false`로 제어한다. [운영 절차](../../docs/operations.md)에 명령과 복원 순서를 기록했다.

## 감사·삭제 지연 진단·긴급 중지

`pnpm --filter @envhandoff/api deletion-health`는 DB를 변경하지 않고 방치 업로드와 24시간 삭제 지연을 집계한다. 정상/지연/실패 종료 코드는 각각 `0/1/2`다. API 분 단위 정리에도 같은 점검과 JSON 경보를 연결했다. 외부 감시 일정과 알림 수신처는 실제 운영 환경에서 연결한다.

`pnpm --filter @envhandoff/api disable-account <user-UUID> <numeric-GitHub-ID>`는 기본적으로 대상 조회와 열람 감사만 수행하며 `--apply`에서 중지한다. 복원 도구도 미리보기·적용·재실행 열람을 기록한다. 다운로드 거부 감사는 대상별 최소 기록과 반복 제한을 적용한다. 정확한 기록 범위와 실행 계약은 [운영 절차](../../docs/operations.md)를 따른다.
