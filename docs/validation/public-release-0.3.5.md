# 0.3.5 새 터미널 버튼 이름 배포 검증

기준일: 2026-10-01. 왼쪽 아래 버튼의 **새 분할 → 새 터미널** 수정을 **0.3.5 안정 latest로 공개했고, 인증 없는 실제 업데이트 다운로드와 체크섬 검증을 완료했다.** 기존 0.3.4 파일은 덮어쓰지 않았다.

- 기능 [PR #19](https://github.com/bokjk/mongle-terminal/pull/19)의 필수 검사 통과 후 dev에 병합했다. 관련 UI 회귀 3/3과 실제 격리 개발 Electron의 표시·접근성 이름·클릭·취소·셸 유지 확인은 [버튼 이름 검증](terminal-tabs.md#새-터미널-버튼-이름-후속-변경)에 기록했다.
- 버전·잠금 파일·README·사용 안내·CHANGELOG를 0.3.5로 맞췄다. 변경은 버튼 이름과 접근성 이름이며 생성·드래그·업데이트 설치 절차는 유지한다.
- `codex/release-0.3.5`의 준비 커밋 `ef8e789b51c3f3b5c8d72741d9082779433560ec`를 [PR #20](https://github.com/bokjk/mongle-terminal/pull/20)으로 dev에 병합했다. Windows checks·PR target branch가 통과했다. [준비 PR 검사](https://github.com/bokjk/mongle-terminal/actions/runs/36820795961).
- [PR #21](https://github.com/bokjk/mongle-terminal/pull/21)의 필수 검사 통과 후 dev → main으로 병합했다. main에 직접 커밋·push하지 않았다. [배포 PR 검사](https://github.com/bokjk/mongle-terminal/actions/runs/36821496490) · [dev 검사](https://github.com/bokjk/mongle-terminal/actions/runs/36821487814).

## 배포 전 확인

- 타입·빌드·배포 문서와 패키지 검사가 통과했다. `release-public-0-3-5`에 설치본·ZIP·blockmap·latest.yml·SHA256SUMS를 생성했고 네이티브 모듈·아이콘·ZIP 필수 파일·메타데이터·체크섬을 확인했다. `test-results/release-035/package.log`.
- 실제 **0.3.5 패키지**에서 버튼의 표시·접근성 이름·클릭으로 새 터미널 화면 열기·취소를 확인했다. 취소 후 같은 셸 PID·generation·상태·배치를 유지했고 시험 호스트를 정상 종료했다. `test-results/e2e/public-release-035-label/result.json`.
- 실제 패키지의 PowerShell 입력·취소·저장 후 정상 종료·재실행 복원 **1/1 통과**했다(56.0초). `test-results/e2e/public-release-035/full-exit-result.json`.
- 패키지 포함 텍스트 파일 52개의 개인 경로·토큰 패턴과 허용 목록 검사가 통과했다. 내부 검증 문서·소스맵·개발용 C# 파일은 제외했다. `test-results/release-035/package-content.json`.
- README 데스크톱·모바일 화면을 새로 촬영해 직접 확인했다. 데스크톱에 **새 터미널**과 **v0.3.5**가 표시된다. 실제 격리 HostCore·Windows 셸·Chrome을 사용했으며 예시 테스트 2개를 제품 전체 회귀와 구분한다. [촬영 조건](../assets/screenshots.md).

시험 프로필은 TEMP 또는 촬영 전용 폴더에 격리했으며 실사용 호스트·셸·인증 정보·Tailscale 설정을 변경하지 않았다. 기능 PR #19의 관련 회귀 3/3과 GitHub 필수 검사가 통과했고, 이 버전 준비에서 로컬 전체 회귀를 반복 실행하지 않았다. 준비·배포 PR의 GitHub 전체 회귀는 각각 **300개 중 289 통과·실패 0·선택 실행 11 생략**했다. 배포 PR 회귀 시간은 약 276초다. `test-results/release-035/preparation-ci-complete.log`, `deployment-ci-complete.log`.

## 공개 게시와 실제 업데이트 다운로드

- 소스 태그 `v0.3.5`는 main 병합 커밋 `6111734557460bc8777b7bbc9c897d4caa75ff1b`를 가리킨다. 준비 커밋과 전체 추적 파일의 차이가 없음을 확인했고 태그·버전·README·CHANGELOG 검사가 통과했다.
- 2026-10-01 **14:57 KST**에 [0.3.5 Release](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.5)를 안정 latest로 공개했다. 첨부는 설치본·ZIP·blockmap·latest.yml·SHA256SUMS 다섯 개다. 초안의 본문과 모든 파일의 크기·서버 SHA-256을 검증한 로컬 산출물과 대조한 뒤 게시했다. `test-results/release-035/draft-verified.json`.
- 설치본은 **148,711,629바이트**, SHA-256은 `d72d832d02d7aefc0ef706631b519d438122fcb4d0ab0732764205e7aff6b6e9`이다. ZIP은 **206,149,998바이트**, SHA-256은 `f9d499b0cf375e879f11df9694ae9d2bda37fe44415cddde7c85847ac04bf61b`이다.
- 익명 GitHub latest API에서 안정 0.3.5를 확인했다. 작은 첨부 세 개는 실제 바이트, 설치본·ZIP은 HTTP HEAD 크기와 GitHub 서버 SHA-256을 대조해 일치했다. `test-results/public-update-035/assets.json`.
- 기존 **0.3.4 패키지의 `app-update.yml`**과 제품의 GuardedNsisUpdater·UpdateController로 실제 Electron이 공개 0.3.5 설치본 전체를 다운로드했다. 내장 SHA-512와 추가 SHA-256 검증이 통과했고 대상 0.3.5·`ready`·진행률 100을 확인했다. 같은 0.3.5는 `idle`·“최신 버전입니다.”였다. `test-results/public-update-035/result.json`.
- 다운로드 검사는 AppAdapter의 현재 버전을 0.3.4/0.3.5로 지정하고 TEMP 경로를 사용했다. GitHub 인증 환경변수를 제거했으며 설치·호스트 종료·재실행 호출을 금지했다. `autoInstallOnAppQuit`은 두 경우 모두 false였다. 실제 설치된 0.3.4 앱의 NSIS 교체 검사는 아니다.
- 공개 배포 저장소의 README와 검토한 데스크톱 이미지를 커밋 `73772fa44e7178776696976c2c814b4a8f62577c`로 갱신했다. 공개 태그는 이 안내 커밋을 가리킨다. 소스·내부 문서·Git 이력은 복사하지 않았다.

전용 Actions 게시 secret은 미설정으로 유지했다. 검증한 로컬 산출물을 로그인된 유지보수자의 `gh`로 게시했으며 사용자 앱은 토큰 없이 받는다. [태그 재빌드](https://github.com/bokjk/mongle-terminal/actions/runs/36822163996)는 별도 artifact를 생성하는 검증 경로이며 이미 공개한 바이너리를 덮어쓰지 않는다. 소스 공개 범위·라이선스·실사용 호스트·인증 데이터·Tailscale 설정은 변경하지 않았다.

## 남은 범위

실사용 NSIS 설치본 교체·재실행·실물 모바일·다른 PC 사용자 확인은 별도다. 다운로드 후 사용자가 **설치 후 다시 시작**을 선택하고 작업 저장·정상 종료를 확인해야 설치된다.
