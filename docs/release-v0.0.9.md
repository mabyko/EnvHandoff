# v0.0.9 배포 절차

현재 정상 운영 버전은 v0.0.8, SHA는 `e26ef92a6c9f7386a3f8a2e8df26326e3e22cf23`이고 스키마 버전은 11이다. v0.0.9는 프로젝트 환경별 암호화 파일 게시·키 접근 제공·게시 파일의 외부 공유와 Pro 워크스페이스 화면 재구성을 포함한다.

## 검토한 DB 변경

- 012: 환경 게시 테이블 5개(`environment_publication_heads`, `environment_versions`, `environment_key_wraps`, `environment_file_challenges`, `environment_download_leases`)를 추가한다. 기존 행을 바꾸거나 옮기지 않는다.
- `upload_cancellations`의 kind 제약을 `share`·`team`·`publication`으로 넓히고, `stored_objects`·`creation_attempts`·`all_download_leases` 뷰에 게시본을 포함한다. 저장 한도·생성 한도·다운로드 한도에 게시본이 합산된다.
- API 시작 시 기존 마이그레이션의 한 거래·자문 잠금 아래 적용된다. Compose·볼륨·접수 설정·인증 비밀값은 바꾸지 않는다.

## 적용 순서

1. 이 절차의 PR이 main에 병합된 뒤 정확한 main SHA의 전체 CI를 확인하고 `release/v0.0.9`를 생성한다. gate와 manifest는 배포 대상 SHA에 포함돼 있어야 한다. 이전 정상 API 이미지·배포 ID, Worker 버전, PostgreSQL 컨테이너·볼륨을 비공개 작업 기록에 보존한다.
2. 운영 API가 v0.0.8 SHA·스키마 버전 11인지, 삭제대장 health가 정상인지 확인한다.
3. 메타데이터와 스키마를 암호화해 비공개로 백업한다. 공유 토큰·세션·도전·재시도 자료, `environment_key_wraps`, `environment_file_challenges`와 암호문 객체는 백업하지 않는다. 백업 보존은 최대 7일이며 독립 삭제대장은 그대로 둔다.
4. 운영자 SSH로 **이 API 도메인만** 외부 변경·전달 요청을 점검 상태로 전환한다. 무쿠키 GET `/auth/session`의 상태 검사와 컨테이너 내부 health는 유지한다. 기존 API 프로세스를 정상 종료하고 종료를 확인한다.
5. `Deploy production`을 `release/v0.0.9`에서 실행한다. `migration_preflight_sha`에는 위 준비를 실제 완료한 정확한 배포 SHA만 입력하고, `Verify release` 통과 후 `production` 환경에서 같은 SHA를 승인한다.
6. `.github/scripts/migration-gate.mjs`는 정확한 이전 SHA·버전·ref, 추가된 012의 고정 해시, 변경 없는 Compose, 정확한 사전 준비 SHA를 모두 검사한다. 그 외 DB/Compose 변경은 계속 거절한다.
7. 시작 마이그레이션 완료, 스키마 버전 12, 게시 테이블 5개와 `publication` 취소 종류, 기존 PostgreSQL 컨테이너·볼륨, 삭제대장·API health를 확인한다. 기존 API를 다시 시작하지 않는다.
8. 같은 SHA의 웹·relay 배포와 공개 assets·health를 확인하고, 구형 화면은 새로고침하도록 안내한다. 모든 확인 후 해당 API의 점검 설정만 복구한다. 무쿠키 세션 401, 실제 API/Worker SHA를 재확인하고 백업 삭제 기한을 설정한 뒤 성공한 SHA에 서명 태그를 만든다.

## 실패 처리

API 배포·웹 확인이 실패하면 외부 요청 차단을 유지한다. SQL 거래 자체의 실패는 롤백되지만, **012 적용 후 구형 API로 자동 복구하지 않는다.** 구형 API는 게시본의 삭제·한도·키 접근 정리를 모르므로 안전한 호환 버전으로 간주하지 않는다. 수정 배포를 우선하며 메타데이터 복원이 필요하면 [복원 절차](operations.md#과거-백업에서-복원할-때)를 따른다. 환경 게시본은 재해 복구를 보장하지 않으므로 복원 후 다시 게시해야 한다. 삭제대장·DB·객체 볼륨을 초기화하지 않는다.
