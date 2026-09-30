# 0.3.2 파일 탐색기 배포 검증

기준일: 2026-09-30. 파일 탐색기를 포함한 0.3.2를 공개 자동 업데이트 채널에 게시했고, 인증 없는 실제 다운로드와 체크섬 검증을 완료했다.

## 변경과 기존 검사

- 공용 파일 탐색기를 포함하고 버전·잠금 파일·README·사용자 안내·CHANGELOG를 0.3.2로 맞췄다.
- 업데이트 주소·인증·설치 절차는 기존 0.3.1과 같다. 0.3.1 설치본은 새 버전 확인·다운로드 대상이며 0.3.0 이하는 최신 설치 파일을 한 번 수동 설치해야 한다.
- 기능 PR #8의 로컬 및 GitHub Windows 검사: 291개 중 280 통과, 실패 0, 선택 실행 11 생략. [GitHub 검사](https://github.com/bokjk/mongle-terminal/actions/runs/36683205749). 기능별 범위는 [파일 탐색기 검증](file-explorer.md)에 기록했다.

## 배포 검사

- 타입 검사·릴리즈 문서·diff 검사 통과. 버전 준비 [PR #9](https://github.com/bokjk/mongle-terminal/pull/9)와 `dev` → `main` [PR #10](https://github.com/bokjk/mongle-terminal/pull/10)의 Windows checks·PR target branch 통과 후 병합했다. 배포 PR 회귀는 291개 중 280 통과, 실패 0, 선택 실행 11 생략. [배포 PR 검사](https://github.com/bokjk/mongle-terminal/actions/runs/36685704618).
- `release-public-0-3-2`에 NSIS·ZIP·blockmap·latest.yml·SHA256SUMS 생성. 네이티브 모듈·아이콘·ZIP 필수 파일·SHA-512·크기 검사 통과. `test-results/release-032-package.log`.
- 실제 Electron 정상 다운로드·변조 파일 거부 1/1 통과. `test-results/release-032-updater.log`.
- 실제 0.3.2 패키지의 PowerShell 실행·취소·저장 후 정상 종료·재실행 복원 1/1 통과(46.3초). TEMP의 새 프로필 사용. `test-results/e2e/public-release-032/full-exit-result.json`.
- 패키지 업데이트 설정이 공개 배포 저장소를 가리키며, 배포 host/web/docs 텍스트에서 로컬 작업 경로·GitHub 토큰 패턴을 발견하지 않았다. 내부 문서·소스맵·개발용 C# 파일을 포함하지 않는 패키지 허용 목록 검사도 통과했다.

## 공개 게시와 다운로드

- 소스 태그 `v0.3.2`는 `main` 배포 커밋 `7fa3536f93e3810d06c04b60e7dc81a09d4af85c`을 가리킨다. 패키징 기준 커밋 `1637854ff1c5b04052f4f2cd9def2eae7603af87`과 배포 커밋 사이 실행 코드·패키징 구성·사용자 안내·라이선스 파일의 차이가 없음을 확인했다.
- 2026-09-30 16:54 KST에 [0.3.2 Release](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.2)를 안정 latest로 공개했다. 첨부는 설치본·ZIP·blockmap·latest.yml·SHA256SUMS 다섯 개다. 설치본은 148,707,596바이트다.
- 설치 파일 SHA-256: `060ecbd62cb71dab0663bba2cdb04cfa51b98cf065352a16943e68efa24f0d99`.
- 인증 없는 GitHub latest API에서 안정 버전 0.3.2를 확인했다. 작은 첨부 세 개는 실제 바이트, 설치본·ZIP은 HTTP HEAD 크기와 GitHub 서버 SHA-256을 로컬 파일과 비교해 일치했다. `test-results/public-update-032/assets.json`.
- 기존 0.3.1 패키지의 `app-update.yml`과 제품의 GuardedNsisUpdater·UpdateController를 사용해 실제 Electron이 0.3.2 설치본 전체를 다운로드하고 내장 SHA-512 검증을 통과했다. 추가 SHA-256도 위 값과 일치했다. 상태는 `ready`, 진행률 100, 대상 0.3.2였다. 같은 0.3.2는 `idle`·“최신 버전입니다.”로 확인했다. `test-results/public-update-032/result.json`.
- 이 검사는 AppAdapter의 현재 버전을 0.3.1/0.3.2로 지정하고 TEMP의 다운로드 경로를 사용했다. GitHub 인증 환경변수를 제거했으며 설치·종료·재실행 호출을 금지했다. 실사용 설치본을 교체했다는 검증은 아니다.

전용 Actions 게시 secret은 미설정으로 유지했다. 검증한 로컬 산출물을 유지보수자의 gh 인증으로 게시했으며, 사용자 앱은 토큰 없이 다운로드한다. [태그 재빌드](https://github.com/bokjk/mongle-terminal/actions/runs/36686434467)의 별도 artifact로 이미 공개한 바이너리를 덮어쓰지 않는다. 소스 저장소 공개 범위·라이선스·실사용 호스트·인증 데이터·Tailscale 설정은 변경하지 않았다.

## 남은 범위

실제 기존 NSIS 설치본의 신버전 교체·재실행·사용자 기록 복원, 실물 모바일, 다른 PC의 SmartScreen·사용자 확인은 별도다. 0.3.1 설치본은 자동 확인·다운로드 대상이며, 사용자가 **설치 후 다시 시작**을 선택해 작업 저장과 정상 종료를 확인해야 설치된다. ZIP·개발 실행은 수동 교체 대상이다.
