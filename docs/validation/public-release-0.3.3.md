# 0.3.3 컴퓨터 선택 메뉴 배포 검증

기준일: 2026-09-30. 개선된 컴퓨터 선택 메뉴를 0.3.3 자동 업데이트로 공개했고, 인증 없는 실제 다운로드와 체크섬 검증을 완료했다.

- 디자인 PR #12의 Windows checks·PR target branch 통과 후 dev에 병합했다. [GitHub 검사](https://github.com/bokjk/mongle-terminal/actions/runs/36688645887). 기능별 검사 범위는 [메뉴 검증](host-picker.md)에 기록했다.
- 버전·잠금 파일·README·사용자 안내·CHANGELOG를 0.3.3으로 맞췄다. 업데이트 주소와 사용자 확인 후 설치하는 절차는 그대로 유지한다.
- 배포 준비 PR #13과 `dev` → `main` PR #14의 필수 검사 통과 후 병합했다. 배포 PR 회귀는 292개 중 281 통과, 실패 0, 조건부 11 생략. [배포 PR 검사](https://github.com/bokjk/mongle-terminal/actions/runs/36692213997).

## 패키지 검증

- 타입·빌드·배포 문서·diff 검사 통과. `release-public-0-3-3`에 NSIS·ZIP·blockmap·latest.yml·SHA256SUMS 생성. 네이티브 모듈·아이콘·ZIP 필수 파일·SHA-512·크기 검사 통과. `test-results/release-033-package.log`.
- 실제 0.3.3 패키지의 PowerShell 실행·취소·저장 후 정상 종료·재실행 복원 1/1 통과(46.7초). TEMP의 새 프로필을 사용했다. `test-results/e2e/public-release-033/full-exit-result.json`.
- 패키지 허용 목록 검사 통과. 배포 host/web/docs 텍스트에서 로컬 작업 경로·GitHub 토큰 패턴을 발견하지 않았다. 내부 검증 문서·소스맵·개발용 C# 파일은 제외했다.

## 공개 게시와 실제 다운로드

- 소스 태그 `v0.3.3`은 `main` 배포 커밋 `98ba8fffec8b9dd18babeb607c206fd83616826e`을 가리킨다. 패키징 기준 `a827bbe8dade725f51d3a4a793bceaaec4b2deac`과 실행 코드·패키징 구성·사용자 안내·라이선스 파일이 동일함을 확인했다.
- 2026-09-30 17:58 KST에 [0.3.3 Release](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.3)를 안정 latest로 공개했다. 첨부는 설치본·ZIP·blockmap·latest.yml·SHA256SUMS 다섯 개, 설치본 크기는 148,708,770바이트다.
- 설치 파일 SHA-256: `b81ff1cef9b52aff37050881ada7be5d99af13ea5e0617f007487fd831d18a7e`.
- 인증 없는 GitHub latest API에서 안정 0.3.3을 확인했다. 작은 첨부 세 개는 실제 바이트, 설치본·ZIP은 HTTP HEAD 크기와 GitHub 서버 SHA-256을 로컬 파일과 대조해 일치했다. `test-results/public-update-033/assets.json`.
- 기존 0.3.2 패키지의 `app-update.yml`과 제품의 GuardedNsisUpdater·UpdateController로 실제 Electron이 공개 0.3.3 설치본 전체를 다운로드하고 내장 SHA-512 및 추가 SHA-256 검증을 통과했다. 상태는 `ready`, 진행률 100, 대상 0.3.3이었다. 같은 0.3.3은 `idle`·“최신 버전입니다.”로 확인했다. `test-results/public-update-033/result.json`.
- 이 다운로드 검사는 AppAdapter의 현재 버전을 0.3.2/0.3.3으로 지정하고 TEMP 경로를 사용했다. GitHub 인증 환경변수를 제거하고 설치·종료·재실행 호출을 금지했다. 실사용 설치본 교체 검사는 아니다.

전용 Actions 게시 secret은 미설정으로 유지했다. 검증한 로컬 산출물을 gh 인증으로 게시했으며 사용자 앱은 토큰 없이 받는다. [태그 재빌드](https://github.com/bokjk/mongle-terminal/actions/runs/36693037526)의 별도 artifact로 이미 공개한 바이너리를 덮어쓰지 않는다. 소스 공개 범위·라이선스·실사용 호스트·인증 데이터·Tailscale 설정은 변경하지 않았다.

태그 재빌드의 최초 시도는 292개 중 281 통과·1 실패·10 생략이었다. 실패는 기존 분할 크기 검사의 `Home equalize: timed out`이며, 메뉴 검사와 실제 업데이트 다운로드 검사는 통과했다. 같은 분할 검사는 디자인·버전 준비·배포·완료 기록 PR에서 통과했다. 동일 커밋의 실패 작업 재실행을 요청했으며 최종 상태와 각 시도는 위 CI 이력으로 구분한다. 이 추가 재빌드 실패를 공개 설치본 다운로드 실패로 해석하지 않는다.

## 남은 범위

실제 사용자 NSIS 설치본 교체·재실행·기록 복원, 실물 모바일·스크린리더·다른 PC 사용자 확인은 별도다. 자동 다운로드 후 사용자가 **설치 후 다시 시작**을 선택하고 작업 저장·정상 종료를 확인해야 설치된다. ZIP·개발 실행은 수동 교체 대상이다.
