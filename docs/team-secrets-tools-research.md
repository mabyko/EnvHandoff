# 팀 환경변수 도구 비교와 EnvHandoff 개선 검토

조사일: 2026-10-12. 공식 문서와 EnvHandoff의 현재 구현을 확인했다. 가격·플랜별 제공 범위, 실제 설치·운영 성능, 보안 구현의 독립 검증은 조사하지 않았다. 경쟁 제품에서 확인한 기능과 EnvHandoff에 제안하는 개선을 구분한다.

## 1. 경쟁 제품의 중심 흐름

### Doppler: 중앙 설정을 로컬과 배포 환경으로 전달

- 개발자는 로그인한 뒤 프로젝트 폴더를 특정 project/config에 연결하고, `doppler run -- <command>`로 최신 값을 프로세스 환경변수에 주입한다. 저장소의 `doppler.yaml`에는 프로젝트·config·하위 경로를 기록할 수 있어 모노레포 초기 설정을 공유할 수 있다. [CLI Guide](https://docs.doppler.com/docs/cli)
- 기본 `dev`·`stg`·`prd` config에서 branch config를 만든다. Personal Config는 환경 쓰기 권한이 있는 사용자의 전용 branch이며, 개인 변경이 동료의 config에 영향을 주지 않는다. 공유 기본값에서 개인 설정을 분리하는 기능이다. [Branch Configs](https://docs.doppler.com/docs/branch-configs)
- Compare 화면은 여러 config의 같은 키를 나란히 보여주고, 기준 config 대비 다른 값·누락·상속 상태를 표시한다. 마스킹한 값은 명시적으로 펼칠 때만 보인다. 단순한 환경 목록보다 실제 차이를 파악하는 기능이 중요하다. [Comparing Secrets](https://docs.doppler.com/docs/comparing-secrets)
- 변경 로그에서 비밀값의 추가·수정·삭제 등을 되돌릴 수 있다. 되돌리기도 새 로그로 기록한다. 공식 문서는 secret이 유지되는 동안 버전을 보관하며, 특정 버전을 redact해도 서버에서 값 자체가 삭제되는 것은 아니라고 설명한다. [Versioning](https://docs.doppler.com/docs/versioning)
- 외부 플랫폼의 비밀값 저장소로 자동 동기화한다. CLI에는 API에 접속하지 못할 때 사용하는 암호화 fallback 파일도 있다. [Automated Syncs](https://docs.doppler.com/docs/integrations), [Security Fact Sheet](https://docs.doppler.com/docs/security-fact-sheet)

**보안 구조 구분:** 공식 문서의 토큰화 서비스가 비밀값을 암호화하고 workplace key를 다룬다. 서버가 파일 복호화 키를 전혀 받지 않는 전달 모델과 같은 의미의 E2EE로 간주하면 안 된다. CLI 소스가 공개되어 있다는 사실도 서버 전체의 자체 호스팅 가능성을 뜻하지 않는다. [Security Fact Sheet](https://docs.doppler.com/docs/security-fact-sheet), [CLI Guide](https://docs.doppler.com/docs/cli)

### Infisical: 개발 설정에서 조직의 비밀값 운영까지

- 로컬 개발은 로그인 → `infisical init` → `infisical run` 순서다. `.infisical.json`에는 비밀값 없이 프로젝트 연결 정보를 기록해 Git에 공유한다. 개발 환경과 폴더를 지정해 필요한 범위의 값을 가져올 수 있다. [Local Development](https://infisical.com/docs/documentation/guides/local-development)
- Personal override는 공유 키의 값을 개인별로 덮어쓴다. 예를 들어 개인 로컬 DB 주소를 쓰면서 동료에게는 공유값을 유지할 수 있다. 이것은 멤버의 접근 권한 예외와 다른 기능이다. [Local Development](https://infisical.com/docs/documentation/guides/local-development)
- 파일이 필요한 도구에는 dotenv로 export할 수 있지만, 공식 가이드는 export 파일이 평문이며 중앙값이 변경되는 순간 오래된 사본이 된다고 설명한다. 가능하면 프로세스 주입을 권한다. pre-commit secret scanning도 소개한다. [Local Development](https://infisical.com/docs/documentation/guides/local-development)
- secret 변경마다 버전을 만들며, 이전 버전 복원은 현재 값을 바꾸고 새 버전을 추가한다. 감사 이벤트에는 주체·자원·시간·IP·클라이언트 같은 메타데이터를 기록하고 외부 로그 시스템으로 전달할 수 있다. [Secret Versioning](https://infisical.com/docs/documentation/platform/secret-versioning), [Audit Logs](https://infisical.com/docs/documentation/getting-started/concepts/audit-logs)
- 관리형 클라우드와 자체 호스팅을 지원한다. 자체 호스팅은 저장·배포를 통제하는 대신 패치·가용성·모니터링 책임도 가진다. 공식 문서는 오픈소스 코어와 별도의 상용 enterprise 기능을 구분한다. [Cloud vs. Self-hosting](https://infisical.com/docs/documentation/getting-started/concepts/deployment-models)

**범위 구분:** 비밀값 관리 외에 rotation·dynamic credentials·인증서·인프라 접근까지 제공하는 플랫폼이다. 이 범위를 일회성 파일 전달 도구의 필수 기능으로 삼을 근거는 없다. [What Is Infisical?](https://infisical.com/docs/documentation/getting-started/introduction)

### dotenvx: 암호화한 설정과 코드의 Git 관리

- `.env` 값 자체를 암호화한 뒤 코드와 함께 Git에 보관한다. 실행할 때 private key로 복호화해 환경변수로 주입한다. 예시 파일에서는 변수명과 공개키가 보이고 값만 암호문이므로 파일 전체를 숨기는 방식과 다르다. [Quickstart](https://dotenvx.com/docs/quickstart/)
- 로컬 custody에서는 암호화 `.env`와 별도로 `.env.keys`에 private key를 보관한다. `.env.keys`는 Git에서 제외하고 별도로 백업한다. 환경별 파일과 키 이름도 구분한다. [Local Key File](https://dotenvx.com/docs/custody/env-keys/)
- 기본 실행에서는 이미 존재하는 프로세스 환경변수가 `.env` 값보다 우선한다. 파일을 받아 적용하는 것과 실행 시 어떤 값이 실제 선택되는지는 다른 문제다. [Environment Variable Precedence](https://dotenvx.com/docs/cli/run-environment-variable-precedence/)
- 현재 공식 문서의 **Envfile**은 값 없이 변수명과 규칙을 기록한다. required·port/URL 등의 타입을 검사할 수 있고, strict 규칙에서 검증 실패 시 실행을 중단한다. 타입은 문자열을 검증하며 값을 다른 타입으로 변환하지 않는다. [Envfile Quickstart](https://dotenvx.com/docs/quickstart/envfile/), [Required](https://dotenvx.com/docs/envfile/required/), [Types](https://dotenvx.com/docs/envfile/type/), [Strictness](https://dotenvx.com/docs/envfile/strict/)
- **Armor**는 암호화 `.env`를 프로젝트에 남겨두고 private key 접근을 관리한다. 각 기기에서 로그인하며, 실행 전에 키를 요청하고 필요하면 승인한다. 따라서 현재 dotenvx 전체를 단순한 로컬 암호화 CLI로만 설명하면 기능을 놓친다. [Armor Key Custody](https://dotenvx.com/docs/custody/armor/)

**키 배포 구분:** 암호화 파일을 Git에 넣는 것으로 팀원 온보딩이 끝나지는 않는다. 별도 private key 파일 또는 Armor 같은 키 접근 경로가 필요하다. Armor 문서의 접근 승인만으로 이미 전달된 키·평문 사본까지 회수한다고 해석할 수 없다. [Local Key File](https://dotenvx.com/docs/custody/env-keys/), [Armor Key Custody](https://dotenvx.com/docs/custody/armor/)

## 2. 비교에서 구분해야 할 개념

- **파일 전달과 최신 설정 조회:** 파일 전달은 특정 시점의 사본이다. Doppler·Infisical의 실행 주입은 중앙값 조회가 중심이고, dotenvx는 저장소에 있는 암호화 설정과 별도 키를 사용한다. [Doppler CLI](https://docs.doppler.com/docs/cli), [Infisical Local Development](https://infisical.com/docs/documentation/guides/local-development), [dotenvx Quickstart](https://dotenvx.com/docs/quickstart/)
- **개인 값과 권한 예외:** Doppler Personal Config·Infisical personal override는 개인의 값 분리다. 멤버의 접근 권한 예외를 같은 기능으로 부르면 비교가 틀어진다. [Branch Configs](https://docs.doppler.com/docs/branch-configs), [Local Development](https://infisical.com/docs/documentation/guides/local-development)
- **차이와 오류:** 두 환경의 값이 다른 것은 정상일 수 있다. Doppler Compare의 차이 표시와 dotenvx Envfile의 선언된 규칙 검증은 목적이 다르다. [Comparing Secrets](https://docs.doppler.com/docs/comparing-secrets), [Envfile Quickstart](https://dotenvx.com/docs/quickstart/envfile/)
- **이력과 적용 확인:** 중앙 secret 변경 이력·접근 로그는 해당 도구가 관찰한 동작의 기록이다. 로컬 파일 배치나 이후 애플리케이션에서의 모든 사용까지 증명한다는 뜻으로 확대하면 안 된다. [Versioning](https://docs.doppler.com/docs/versioning), [Audit Logs](https://infisical.com/docs/documentation/getting-started/concepts/audit-logs)

## 3. 확인 방법과 제한

Infisical personal override는 Context7에서 library를 먼저 resolve한 뒤 `/infisical/infisical`의 해당 기능을 조회했다. 반환된 공식 저장소 문서와 현재 공식 웹 문서의 설명을 함께 확인했다. 나머지 기능은 기존에 확인한 제품 문서에서 연결된 공식 페이지로 보완했다. 가격과 플랜별 권한은 판단에 사용하지 않았다.

세 제품을 설치하거나 실제 비밀값을 입력하지 않았다. 명령은 공식 문서의 제품 흐름 설명이며 실행 검증 결과가 아니다. 전체 schema 지원 여부·키 custody 구현·철회 보장을 서로 같다고 가정하지 않았다. 특정 버전의 CLI 지원이나 연동 채택을 결정할 때는 해당 버전과 대상 환경을 별도로 확인해야 한다.

## EnvHandoff의 현재 위치

아래는 경쟁 제품 기능과 구분한 제안이다. 기존 출시 범위와 제품 결정을 변경한 명세가 아니다.

EnvHandoff의 중심은 Git에 없는 개발 설정 파일의 안전한 전달이다. 파일 단위로 원본 바이트와 상대 경로를 보존하며, 웹은 수신·내용 확인·다운로드까지 제공한다. 폴더 비교·적용·복구는 네이티브 앱의 후속 범위다. [README](../README.ko.md), [공통 용어](../CONTEXT.md)

Pro v3는 조직·팀·프로젝트·환경 권한, 요청과 승인, 특정 수신 기기에 결합한 암호화 전달, 임시 보관·회수·감사를 이미 갖추고 있다. 환경 권한의 상속은 설정값의 상속이나 개인 override와 다르다. 환경의 공식 최신 파일·지속 버전은 v4 계획이므로 현재 전달을 최신 구성이라고 표시할 수 없다. [Pro v3 명세](pro-v3-spec.md), [팀 전달 외피](team-envelope-v1.md), [제품 계획](product-plan.md)

수신 화면의 공통 `OpenedFiles`는 내용 확인과 개별 다운로드를 제공한다. 무료 파일·relay, Pro 팀 전달, 외부 공유가 이 컴포넌트를 사용한다. 개선을 한 번 구현해 여러 수신 경로에 적용할 수 있다. [수신 화면](../apps/web/src/components/ReceiveFlow.tsx), [Pro 전달](../apps/web/src/components/ProTransfer.tsx), [외부 수신](../apps/web/src/components/ExternalReceive.tsx)

## 추천하는 개선 순서

후속 [사용자 흐름 검토](user-flow-review.md)에서 기존 작업의 다음 행동·설정 복귀·수신 복구를 먼저 개선하고, 아래 파일 비교는 그다음 기능 후보로 정리했다. 이 문서는 경쟁 제품의 근거와 기능 후보를 보존하며 현재 구현·검증 상태는 [Pro 웹 설계](pro-web-design.md)와 [QA 기록](qa.md)을 따른다.

### 1. 수신 후 읽기 전용 비교

가장 먼저 검증할 기능이다. 사용자가 기존 로컬 파일을 직접 선택하고 받은 파일과 비교한다. 전체 바이트가 같은지 먼저 확인하고, 지원하는 `.env` 문법에서는 추가·누락·변경된 키를 보여준다. 비밀값은 기본적으로 표시하지 않는다. 폴더를 직접 읽거나 파일을 덮어쓰지 않아도 웹에서 수신 이후의 판단을 도울 수 있다.

사용자가 비교 대상을 받은 파일의 배치 경로와 명시적으로 연결하도록 한다. 파일명만 같다는 이유로 같은 프로젝트·경로라고 판단하지 않는다. 로컬 파일을 고르지 않은 상태는 “비교 안 함”이며 “새 파일”이나 “로컬에 없음”이 아니다.

옵션으로 `.env.example`을 고르면 예시에 있는데 수신 파일에 없는 키와 빈 값을 따로 보여준다. 예시 파일만으로 필수·선택 여부는 알 수 없으므로 누락 후보 안내로 한정한다. 타입·접속 성공·앱 실행 가능 여부를 검증한 것으로 표시하지 않는다. dotenvx의 Envfile 스키마는 이후 필수·선택 규칙이 실제로 필요할 때 참고한다.

현재 `parseEditableEnv`는 안전한 값 편집을 위한 제한된 파서다. BOM·중복 키·export·일부 주석·다중 줄 등은 지원하지 않는다. 비교에 재사용할 경우 지원하지 않는 입력을 “키 없음”으로 처리하지 않고 “키 비교 불가”로 표시한다. 원본 파일은 계속 내려받을 수 있어야 한다. [파서](../apps/web/src/lib/env.ts), [기존 동작 검사](../apps/web/tests/env.test.ts)

### 2. 신규 팀원의 첫 설정 수신 동선

Doppler의 프로젝트·config 선택과 Infisical의 프로젝트 연결에서 가져올 점은 작업 맥락을 한 번 정한 뒤 유지하는 흐름이다. EnvHandoff에서는 프로젝트·환경 선택 → 기기 준비 → 요청 가능한 멤버 지정 → 수신으로 이어지는 첫 작업 안내를 기존 화면 위에서 개선한다.

요청 가능한 멤버를 실제 파일 보유자로 단정하지 않는다. 첫 기기와 상대 공개키의 별도 경로 확인을 안내하면서 진행 상태를 보여준다. 이미 있는 팀·프로젝트·환경 권한 관리 화면과 중복되는 관리 기능을 만들 필요는 없다. [현재 요청·기기 정책](pro-v3-spec.md)

### 3. 로컬 사용과 지속 보관의 후속 연결

Doppler·Infisical의 실행 시 주입과 dotenvx의 Git 워크플로는 장기적으로 참고할 가치가 있다. EnvHandoff의 CLI는 먼저 기존 공유 파일을 로컬에서 여는 사용 사례로 범위를 정할 수 있다. Pro 연동에는 브라우저의 내보낼 수 없는 개인키, 별도 CLI 기기 등록·신뢰와 인증 정책을 풀어야 한다. 웹 로그인이나 다운로드 토큰만으로 복호화되도록 설계를 바꾸지 않는다.

네이티브 직접 적용은 이미 설계된 비교·적용 직전 재검사·암호화 백업·복구를 함께 구현해야 한다. 지속 보관은 v4의 게시 버전·동시 변경 충돌·키 배포·신규 기기·퇴사자 접근 정책을 따로 설계한다. 공유 코드와 키를 Git에 함께 두거나, 수신된 평문을 서비스가 회수할 수 있다고 약속하지 않는다. [데스크톱 설계](app-design.md), [v4 보관 계획](product-plan.md), [현재 기기 신뢰](device-trust-v1.md)

## 첫 구현의 완료 기준

첫 구현 후보는 위 1번이며, 현재 분석에서 앱 코드는 변경하지 않았다.

- 인증·복호화·경로 검증을 통과한 묶음에만 비교를 제공하고, 받은 원본과 다운로드 바이트를 변경하지 않는다.
- 비교용 로컬 파일·예시 파일·값·비교 결과를 서버·로그·영구 브라우저 저장소로 보내거나 저장하지 않는다.
- 바이트 일치, 키 추가·누락·변경, 빈 값, 지원하지 않는 문법, 잘못 연결한 경로를 구분한다. 내용 공개는 사용자가 선택한 경우에만 제공한다.
- 공통 수신 화면을 통해 무료 파일·relay, Pro 전달, 외부 공유에 같은 동작을 제공한다. 기존 인증·기기 신뢰·수신 ACK의 의미를 유지한다.
- 지원 문법의 행동 검사와 원본 바이트 보존 검사를 추가한다. 브라우저에서는 파일 선택 취소·비교 대상 교체·키보드 사용·값 숨김과 다운로드를 확인한다.

실제 우선순위는 파일럿 팀에서 “첫 설정을 받은 뒤 개발 시작까지 걸리는 시간”, “누락 설정 때문에 다시 요청하는 횟수”, “비교를 사용해 덮어쓰기를 피한 사례”로 검증한다. 이는 제안하는 측정 항목이며 현재 수집되는 지표가 아니다. 파일 경로·키·값을 분석 이벤트에 넣지 않는다.

## 조사 한계

공식 문서와 로컬 구현을 확인했다. 세 경쟁 제품의 계정 생성·실사용 비교, 가격·플랜 제한, EnvHandoff의 운영 OAuth·실기기·지원 브라우저 QA는 이번 조사에 포함하지 않았다. 보안 경계 변경과 제품 범위 변경은 이 분석의 제안을 채택한 뒤 해당 명세에 반영해야 한다.
