# Pro 웹·앱 배포 경로 조사

조사일: 2026-09-24. 현재 구현은 `envhandoff.mabyko.com`을 Worker Custom Domain으로 쓰고, 정적 SPA를 함께 배포하며, `run_worker_first`는 `/api/*`에만 적용한다. Worker의 실제 동적 경로는 `/api/health`, `/api/relay`다. [현재 배포 설정](../apps/server/wrangler.jsonc), [Worker 구현](../apps/server/src/index.ts). 제품 계획의 Pro Node 서버와 v4.0 네이티브 앱은 아직 구현 전이다. [제품 계획](product-plan.md)

## 결론

**권장: 무료·Pro 화면을 같은 정적 웹 빌드에서 제공하고, Pro 데이터만 별도 API 서버로 호출한다.** 브라우저 주소는 `https://envhandoff.mabyko.com/pro`로 유지된다. 예를 들어 API는 `https://envhandoff-api.mabyko.com`에 두고, 나중에 설치형 앱도 그 API를 호출한다. Cloudflare가 설명하는 SPA 구조도 정적 HTML·JS를 제공한 뒤 브라우저가 API에서 데이터를 가져오는 방식이다. `/pro` 직접 방문 시 SPA의 `index.html`을 돌려주는 설정이 이미 있다. [Cloudflare SPA 문서](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)

```text
브라우저 → envhandoff.mabyko.com/pro → Cloudflare 정적 SPA
브라우저 → envhandoff-api.mabyko.com → Pro Node API·저장소
설치형 앱 → envhandoff-api.mabyko.com → 같은 Pro Node API·저장소
브라우저의 기존 실시간 전송 → envhandoff.mabyko.com/api/relay → Cloudflare Worker
```

이 구성은 **일반적인 정적 SPA + 별도 API 방식**에 해당한다. 한 도메인의 `/pro` 화면과 별도 API 호스트는 모순이 아니다. 주소창의 페이지 URL만 `/pro`로 남고 브라우저의 네트워크 요청은 API 호스트로 간다. Pro 화면의 JS 파일은 공개되므로 구독·팀 권한은 화면 숨김이 아니라 **API에서 검사**해야 한다. [Cloudflare SPA 문서](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/), [OWASP 접근 제어 지침](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)

## 방식 비교

| 방식 | 화면 URL | Pro 요청 경로 | 추가 운영 부담 |
| --- | --- | --- | --- |
| **같은 SPA + 별도 API(권장)** | `/pro` | 브라우저·앱 → Pro API | 웹의 경로 처리, API의 CORS·인증 |
| Worker가 `/pro/*` 전체 프록시 | `/pro` | 브라우저 → Worker → Pro 서버 | 프록시 코드, 경로·리다이렉트·쿠키·정적 자산 처리, Worker 호출량 |
| Pro 전용 서브도메인 | `envhandoff-pro.mabyko.com` | 브라우저·앱 → Pro 서버 | 별도 웹 배포와 사용자 URL |

Worker 프록시도 지원되는 방식이다. Cloudflare는 Worker의 `fetch()`로 외부 origin에 요청을 보낼 수 있다고 문서화한다. 다만 이 프로젝트는 화면을 정적 SPA에 넣으면 해당 프록시가 해결할 문제가 없다. `/pro`를 `run_worker_first`에 넣으면 그 경로는 매번 Worker 스크립트를 호출한다. Cloudflare는 정적 자산 요청은 무료·무제한이지만 Worker 스크립트 호출은 무료 플랜의 **하루 10만 요청**에 합산되고, 한도를 넘긴 `run_worker_first` 요청은 429가 된다고 명시한다. 이미 쓰는 `/api/*` relay 호출도 같은 Worker 무료 한도를 공유한다. [Cloudflare Custom Domain·fetch](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [정적 자산 과금](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [Workers 가격](https://developers.cloudflare.com/workers/platform/pricing/)

## 실제로 맞춰야 할 것

- Pro 웹의 API 호출은 **서로 다른 origin**이므로 API 서버에서 웹 origin만 허용하는 CORS를 설정한다. 쿠키 세션이면 브라우저 요청에 `credentials: 'include'`를 쓰고, API는 정확한 `Access-Control-Allow-Origin`과 `Access-Control-Allow-Credentials: true`를 반환해야 한다. `*`는 쿠키 요청에 쓸 수 없다. API 호스트 전용 `Secure; HttpOnly` 쿠키를 우선 검토한다. [MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS), [MDN 쿠키](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)
- `/pro`는 서버 페이지가 아니라 현재 React 앱의 클라이언트 경로가 된다. 현재 앱은 해시 기반 `home/send/receive` 상태만 다루므로 Pro 시작 시 경로 인식과 새로고침 동작을 구현해야 한다. [현재 App](../apps/web/src/App.tsx), [Cloudflare SPA 문서](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- 데스크톱 앱이 Pro API를 직접 호출하면 **현재 웹/relay Worker를 지나지 않는다**. 다만 `envhandoff-api.mabyko.com`을 Cloudflare 프록시 DNS로 둘지 DNS only로 둘지에 따라 Cloudflare 네트워크 경유 여부는 달라진다. 기존 relay를 데스크톱에서 재사용하려면 relay 요청만 Worker를 거친다. 현재 relay는 모든 생성·연결 요청에 `Origin` 헤더를 요구하므로 데스크톱 연결 방식은 앱 개발 때 별도 확인이 필요하다. [현재 Worker 구현](../apps/server/src/index.ts), [Cloudflare DNS 프록시 상태](https://developers.cloudflare.com/dns/proxy-status/)
- 예시 API 주소를 `envhandoff-api.mabyko.com`으로 둔 이유는 Cloudflare의 일반적인 full DNS 설정에서 무료 Universal SSL 인증서가 루트와 **첫 단계 하위 도메인**을 덮기 때문이다. `api.envhandoff.mabyko.com`처럼 더 깊은 호스트를 Cloudflare 프록시로 쓰려면 별도 인증서 구성을 검토해야 한다. [Cloudflare Universal SSL 범위](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)

**판단:** 지금은 Pro 화면까지 Worker로 프록시할 이유가 없다. Pro API가 브라우저와 설치형 앱의 공통 백엔드가 되도록 설계하고, 한 origin이 반드시 필요해지는 구체적 요구가 생길 때만 경로 프록시를 추가하면 된다.
