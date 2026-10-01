# 0.3.6 Git 변경 보기 배포 검증

기준일: 2026-10-01. 파일/Git 전환·변경 목록·트리 상태 표시를 **0.3.6 안정 latest로 공개했고, 인증 없는 실제 업데이트 다운로드와 체크섬 검증을 완료했다.** 기존 0.3.5 공개 파일은 덮어쓰지 않았다. 실사용 앱의 NSIS 교체는 별도다.

기능 [PR #23](https://github.com/bokjk/mongle-terminal/pull/23)의 최신 커밋 `774d55fa84d5aee507d7fb2d2ed5a5dfe653079f`에서 Windows checks·PR target branch가 통과했고 dev에 병합했다. [기능 CI](https://github.com/bokjk/mongle-terminal/actions/runs/36827058113)의 기본 회귀는 **307개 중 296 통과·실패 0·선택 실행 11 생략**했다. 실제 Git·HostCore·Chrome·WebSocket 관련 검사 26/26 및 격리 개발·패키지 Electron의 조작 범위는 [Git 탐색기 검증](git-file-explorer.md)에 기록했다.

버전·잠금 파일·README·USER-GUIDE·CHANGELOG·RELEASING을 0.3.6으로 맞추고 미배포 변경을 실제 날짜가 있는 0.3.6 항목으로 옮겼다. 준비 커밋 `f356fc7d3b0b059f86796f774cf93b8fc3c500de`를 [PR #24](https://github.com/bokjk/mongle-terminal/pull/24)로 dev에 병합했다. [준비 CI](https://github.com/bokjk/mongle-terminal/actions/runs/36829694418)와 [dev → main PR #25](https://github.com/bokjk/mongle-terminal/pull/25)의 [최종 CI](https://github.com/bokjk/mongle-terminal/actions/runs/36830857317)는 각각 **307개 중 296 통과·실패 0·선택 실행 11 생략**했다. PR target branch도 통과했고 main에 직접 커밋·push하지 않았다. 배포 PR의 먼저 실행된 중복 검사는 GitHub의 동시 실행 정책으로 취소됐으며 최종 검사의 통과를 확인한 뒤 병합했다.

## 배포 전 확인

- 타입 검사와 공통 웹·호스트·Electron 빌드 통과. 별도 `release-public-0-3-6`에 NSIS·ZIP·blockmap·latest.yml·SHA256SUMS를 생성했고 동봉 Node/네이티브 모듈·아이콘·ZIP 필수 파일·메타데이터·체크섬을 확인했다. `test-results/release-036-package.log`.
- 실제 **0.3.6 패키지 + OwnerPipe + cmd + Git**에서 파일/Git 전환·색/문자/폴더 점·그룹·삭제 스테이징 후 재생성 미리보기·자동 갱신·명령 입력을 통과했다. 같은 호스트·셸 PID/generation·분할 배치·인덱스를 유지했고 시험 호스트는 정상 종료했다. `test-results/e2e/public-release-036-git/result.json`.
- 실제 패키지의 취소·저장 후 정상 종료·재실행 복원 **1/1 통과**(45.0초). `test-results/e2e/public-release-036/full-exit-result.json`.
- 패키지 포함 텍스트 52개의 개인 경로·토큰 패턴과 허용 목록 검사가 통과했다. 내부 검증 문서·소스맵·개발용 C# 파일을 제외했고 패키지 호스트가 빌드와 일치했다. `test-results/release-036/package-content.json`.
- README의 데스크톱·모바일 화면을 0.3.6으로 촬영했고 실제 패키지의 파일/Git 패널 캡처도 추가했다. 다섯 이미지를 직접 확인했다. 예시 테스트 2개·모바일 에뮬레이션·실제 OwnerPipe 앱을 구분한다. [촬영 조건](../assets/screenshots.md).

실사용 호스트·셸·인증 데이터·Tailscale 설정을 유지했다. 사용자에게 연 Git 미리보기는 별도 샘플 프로필과 개발 검증 패키지이며 0.3.6 설치로 교체하지 않았다. 패키지에 들어간 웹·호스트·사용 안내 등 52개 파일이 현재 소스와 일치함도 확인했다. 로그는 `test-results/release-036/preparation-ci-complete.log`, `deployment-ci-complete.log`에 남겼다.

## 공개 게시와 실제 업데이트 다운로드

- 소스 태그 `v0.3.6`은 main 병합 커밋 `dc7350c0cf4a446da714e79054b97035ac96a18a`를 가리킨다. 준비 커밋과 전체 추적 파일의 차이가 없음을 확인했고 태그·버전·README·CHANGELOG 검사도 통과했다.
- 2026-10-01 **16:45 KST**(`07:45:18 UTC`)에 [0.3.6 Release](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.6)를 안정 latest로 공개했다. 초안의 본문과 첨부 다섯 개의 크기·서버 SHA-256을 검증한 로컬 산출물과 대조한 뒤 게시했다. `test-results/release-036/draft-verified.json`.
- 익명 GitHub latest API에서 안정 0.3.6을 확인했다. 작은 첨부 세 개는 실제 바이트, 설치본·ZIP은 HTTP HEAD 크기와 GitHub 서버 SHA-256을 대조해 일치했다. `test-results/public-update-036/assets.json`.
- 기존 **0.3.5 패키지의 `app-update.yml`**과 제품의 GuardedNsisUpdater·UpdateController로 실제 Electron이 공개 0.3.6 설치본 전체를 다운로드했다. 내장 SHA-512와 추가 SHA-256 검증이 통과했고 대상 0.3.6·`ready`·진행률 100을 확인했다. 같은 0.3.6은 `idle`·“최신 버전입니다.”였다. `test-results/public-update-036/result.json`.
- 다운로드 검사는 AppAdapter의 현재 버전을 0.3.5/0.3.6으로 지정하고 TEMP 경로를 사용했다. GitHub 인증 환경변수를 제거했으며 설치·호스트 종료·재실행 호출을 금지했다. `autoInstallOnAppQuit`은 두 경우 모두 false였다. 실제 설치된 0.3.5 앱의 NSIS 교체 검사는 아니다.

| 공개 첨부 | 바이트 | SHA-256 |
|---|---:|---|
| `MongleTerminal-Setup-0.3.6-x64.exe` | 148,716,679 | `2d40bde5cb2a837c9fd5bba7fbf280525d4425dabad0a7887ee1e40501b682bb` |
| `MongleTerminal-0.3.6-x64.zip` | 206,156,029 | `57235976738162d4b0ba94286f351761ea1688ec4af76aa9f872bc95b3b24404` |
| `MongleTerminal-Setup-0.3.6-x64.exe.blockmap` | 154,863 | `1b7c6e9ee0a73a27faf560a4d10d68148e636de7420b571b2e62573227d9a170` |
| `latest.yml` | 365 | `21f7a2c6c36227f4ac856fc806d749ed8adb752ed5c4eed532de1738d6434beb` |
| `SHA256SUMS.txt` | 383 | `3f76bc948c0893ea949bda27b665b5dfbdc0685a272d022e983ba6e50602d570` |

공개 배포 저장소의 README와 검토한 데스크톱·Git 화면 네 개를 커밋 `84845d2fe9e324d1def71a3e7d3256450096464f`로 갱신했다. 공개 태그는 이 안내 커밋을 가리킨다. 소스·내부 문서·소스 Git 이력은 복사하지 않았다.

전용 Actions 게시 secret은 미설정으로 유지했다. 검증한 로컬 산출물을 로그인된 유지보수자의 `gh`로 게시했으며 사용자 앱은 토큰 없이 받는다. [태그 워크플로](https://github.com/bokjk/mongle-terminal/actions/runs/36831869243)는 별도 Windows 재빌드·artifact 검증 경로이며 이미 공개한 바이너리를 덮어쓰지 않는다. 소스 공개 범위와 라이선스도 변경하지 않았다.

## 남은 범위

실사용 NSIS 설치본 교체·재실행·실물 모바일·다른 PC 사용자 확인은 별도다. 다운로드 후 사용자가 **설치 후 다시 시작**을 선택하고 작업 저장·정상 종료를 확인해야 설치된다.
