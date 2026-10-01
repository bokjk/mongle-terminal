# 0.3.4 영역별 탭·작업 공간 배포 검증

기준일: 2026-10-01. 영역별 터미널 탭·간결한 제목줄·개별 탭 드래그를 **0.3.4 안정 latest로 공개했고, 인증 없는 실제 업데이트 다운로드와 체크섬 검증을 완료했다.**

- `dev`에서 만든 `codex/terminal-tabs`의 기능 커밋 5개와 배포 준비 커밋 `28dcda66a3f26f7d84c06f3859e6df6966ea1474`를 [PR #16](https://github.com/bokjk/mongle-terminal/pull/16)으로 병합했다. Windows checks·PR target branch가 통과했다. [기능·배포 준비 검사](https://github.com/bokjk/mongle-terminal/actions/runs/36815025209).
- [PR #17](https://github.com/bokjk/mongle-terminal/pull/17)의 필수 검사 통과 후 `dev` → `main`으로 병합했다. `main`에 직접 커밋·push하지 않았다. [배포 PR 검사](https://github.com/bokjk/mongle-terminal/actions/runs/36815714332) · [dev 검사](https://github.com/bokjk/mongle-terminal/actions/runs/36815703453).
- 버전·잠금 파일·README·사용자 안내·CHANGELOG를 0.3.4로 맞췄다. 미배포 사용자 변경은 2026-10-01 항목으로 옮겼다. 공개 배포 저장소와 사용자 확인 후 설치하는 절차를 유지한다.
- 이전 기능 검증은 [탭·상단 공간](terminal-tabs.md)에 기록했다. 관련 검사 16/16과 개발 Electron 조작 9개 통과, 사용자가 테스트한 개발 창에 셸·배치를 유지해 적용했다.

## 배포 전 확인

- 타입·빌드·배포 문서 검사가 통과했다. 전체 회귀는 Windows Job 제한 밖에서 **300개 중 289 통과·실패 0·선택 실행 11 생략**했다. 약 286초. `test-results/release-034/regression.log`.
- `release-public-0-3-4`에 설치본·ZIP·blockmap·latest.yml·SHA256SUMS를 생성했다. 번들 네이티브 모듈·아이콘·ZIP 필수 파일·업데이트 메타데이터·해시 검사가 통과했다. `test-results/release-034/package.log`.
- 패키지 허용 목록과 포함된 텍스트 파일 52개의 개인 작업 경로·토큰 패턴 검사가 통과했다. 내부 검증 문서·소스맵·개발용 C# 파일은 포함하지 않았다. `test-results/release-034/package-content.json`.
- 실제 **0.3.4 패키지**의 네 방향 자기 영역 탭 분리·비활성 탭·다른 영역 병합·취소·영역 전체 이동·760px 창·새로고침·동일 셸 유지 **9개 시나리오가 통과**했다. OwnerPipe와 preload를 사용했으며 시험 창·호스트는 정상 종료했다. `test-results/e2e/public-release-034-tabs/result.json`.
- 실제 패키지의 PowerShell 입력·취소·저장 후 정상 종료·재실행 복원 **1/1 통과**했다(47.2초). `test-results/e2e/public-release-034/full-exit-result.json`.
- README 데스크톱·모바일 이미지를 새 UI로 촬영했다. 실제 격리 HostCore·Windows 셸·Chrome을 사용하고 첫 분할 영역에 탭 두 개를 표시한다. 예시 테스트 결과는 프로젝트 전체 회귀 결과와 구분한다. [촬영 조건](../assets/screenshots.md).

패키지 시험 프로필은 TEMP 아래에 생성했으며 실사용 호스트·인증 정보·Tailscale Serve를 변경하지 않았다. 실제 구버전 NSIS 설치본의 교체·재실행을 수행한 검증은 아니다.

## 공개 게시와 실제 업데이트 다운로드

- 소스 태그 `v0.3.4`는 `main` 병합 커밋 `ee2dd2964faa085fae7599cd779d152b1cee88ce`를 가리킨다. 배포 준비 커밋과 전체 추적 파일의 차이가 없음을 확인했고, 태그·버전·README·CHANGELOG 검사를 통과했다.
- 2026-10-01 **13:44 KST**에 [0.3.4 Release](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.4)를 안정 latest로 공개했다. 첨부는 설치본·ZIP·blockmap·latest.yml·SHA256SUMS 다섯 개다. 초안의 공개 본문과 모든 첨부의 크기·서버 SHA-256을 검증한 로컬 산출물과 대조한 뒤 게시했다. `test-results/release-034/draft-verified.json`.
- 설치본은 **148,711,633바이트**, SHA-256은 `571ddf9c992efcb6c1a45a94276b1b06ae21539d20dc17062d884290c60bf468`이다. ZIP은 **206,149,997바이트**, SHA-256은 `24d4fb36fc5e9388bec4d301fdee487ef5c9c9dd4502582aca37bba7d04360ac`이다.
- 익명 GitHub latest API에서 안정 0.3.4를 확인했다. 작은 첨부 세 개는 실제 바이트, 설치본·ZIP은 HTTP HEAD 크기와 GitHub 서버 SHA-256을 대조해 일치했다. `test-results/public-update-034/assets.json`.
- 기존 **0.3.3 패키지의 `app-update.yml`**과 제품의 GuardedNsisUpdater·UpdateController로 실제 Electron이 공개 0.3.4 설치본 전체를 다운로드했다. 내장 SHA-512와 추가 SHA-256 검증이 통과했고 대상 0.3.4·`ready`·진행률 100을 확인했다. 같은 0.3.4는 `idle`·“최신 버전입니다.”였다. `test-results/public-update-034/result.json`.
- 다운로드 검사는 AppAdapter의 현재 버전을 0.3.3/0.3.4로 지정하고 TEMP 경로를 사용했다. GitHub 인증 환경변수를 제거했으며 설치·호스트 종료·재실행 호출을 금지했다. `autoInstallOnAppQuit`은 두 경우 모두 false였다. 실제 설치된 0.3.3 앱의 NSIS 교체 검사는 아니다.
- 공개 배포 저장소의 README와 검토한 데스크톱 이미지를 커밋 `4ddd56e1f68f0b24b1e62a75774dd38c3e2f99fd`로 갱신했다. 소스·내부 문서·Git 이력을 복사하지 않았다.

전용 Actions 게시 secret은 미설정으로 유지했다. 검증한 로컬 산출물을 로그인된 유지보수자의 `gh`로 게시했으며 사용자 앱은 토큰 없이 받는다. [태그 재빌드](https://github.com/bokjk/mongle-terminal/actions/runs/36816481499)는 별도 artifact를 생성하는 검증 경로이며, 이미 공개한 바이너리를 덮어쓰지 않는다. 소스 공개 범위·라이선스·실사용 호스트·인증 데이터·Tailscale 설정은 변경하지 않았다.

## 남은 범위

사용자의 기존 NSIS 설치본 교체·실물 모바일·다른 PC 사용자 확인은 별도다. 자동 다운로드 후 사용자가 **설치 후 다시 시작**을 선택하고 작업 저장·정상 종료를 확인해야 설치된다. 공개 배포 자체가 실행 중인 모든 사용자 앱을 즉시 교체한다는 의미는 아니다.
