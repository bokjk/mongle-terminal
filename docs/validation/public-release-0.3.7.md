# 0.3.7 워크트리·입력·탭 개선 배포 검증

기준일: 2026-10-02. **0.3.7을 공개 latest로 게시했고 인증 없는 실제 설치 파일 다운로드와 체크섬 검증을 완료했다.** 실사용 앱의 NSIS 교체는 별도다.

## 반영 내용과 경로

터미널 폴더 기준 워크트리, 선택적 터미널 열기, 기본 배지·두 줄 목록, 일반 터미널 선택·이름 변경, 탭 앞뒤 이동, 왼쪽 탭 기준 새 터미널, Windows Codex CLI와 한글 조합 후 Shift+Enter를 포함한다. Windows의 짧은 경로·폴더 별칭을 통한 워크트리 연결도 실제 위치로 대조한다.

[기능·준비 PR #27](https://github.com/bokjk/mongle-terminal/pull/27)의 최종 커밋 `169d81f75ccdd6c59edd2a43e5c65b7518af9026`에서 [Windows checks](https://github.com/bokjk/mongle-terminal/actions/runs/36973259120)와 PR target branch가 통과해 dev에 병합했다. [dev → main 배포 PR #28](https://github.com/bokjk/mongle-terminal/pull/28)의 [최종 검사](https://github.com/bokjk/mongle-terminal/actions/runs/36974091640)를 확인한 뒤 병합했다. 두 PR의 전체 회귀는 각각 **321개 중 308 통과·실패 0·선택 실행 13 생략**이다. main에 직접 커밋·push하지 않았다.

소스 태그 `v0.3.7`은 main 병합 커밋 `b8f65d2103126fbb7ffe351e345b95bcc8921b3c`를 가리킨다. 검증한 소스와 main의 추적 파일이 같고 태그·버전·README·CHANGELOG 검사도 통과했다. 소스는 비공개이고 라이선스는 유지한다.

## 로컬·실제 패키지 검증

- 타입 검사, 웹·호스트·Electron 빌드, release-check, git diff --check 통과. 기존 웹 번들 500 kB 안내가 남는다.
- 초기 전체 회귀 321개 중 308 통과·13 선택 생략. CI의 TEMP 짧은 경로 차이를 보완한 뒤 실제 Git·HostCore·Chrome 관련 검사 7/7, TEMP·TMP를 폴더 별칭으로 연결한 재현 환경에서도 7/7 통과했다.
- 최종 `release-public-0-3-7`의 NSIS·ZIP·blockmap·latest.yml·SHA256SUMS 생성 및 검증 통과. 동봉 Node v24.18.0, 네이티브 모듈, 아이콘, ZIP 필수 파일, 설치 파일 SHA-512와 첨부 SHA-256을 확인했다. 웹·호스트·안내 12개 파일, Electron main/preload와 앱 버전도 현재 소스와 일치한다.
- 최종 **0.3.7 패키지·OwnerPipe·Git·ConPTY**: 워크트리 생성·선택·메뉴·GUI 재연결·승인된 모바일 웹·탭 분리→재병합→순서 변경, PID/generation 보존 통과.
- **PowerShell 7 및 CMD + Codex CLI 0.160.0**: 영문 Shift+Enter, Chromium IME 한글 조합 확정 직후 줄바꿈, Codex 종료 후 일반 Enter 통과. 프롬프트 전송이나 외부 모델 호출은 하지 않았다.
- 같은 패키지의 정상 종료 취소·저장·종료·자동 복원 통과. 워크트리·PowerShell 입력·수명주기 **3/3**, CMD 입력 **1/1** 통과.
- README를 다운로드·실제 화면·기능·빠른 시작으로 개편했다. [Ghostty·Tabby·Zed 참고 판단](../assets/README.md)을 기록하고 격리 예제에서 최신 화면을 촬영했다. 로컬 링크·이미지 49개, GitHub GFM 렌더링의 PC 1280px·모바일 390px에서 이미지 6개 로딩·페이지 가로 넘침 없음 확인.

로그: `.test-data/release-037-ci-complete.log`, `release-037-main-ci.log`, `release-037-ci-alias.log`, `release-037-package-final.log`, `release-037-packaged-final-e2e.log`, `release-037-cmd-final-e2e.log`. 실제 앱 증거는 `test-results/e2e/worktrees-packaged`, `codex-keyboard-powershell-default-packaged`, `codex-keyboard-cmd-direct-packaged`, `release-037-full-exit`에 남겼다. 개인 경로가 포함된 시험 로그·캡처는 커밋하지 않았다.

첫 CI는 2개, 두 번째 CI는 1개가 실패했다. Windows TEMP의 짧은 경로와 긴 경로 차이로 드러난 연결 문제와 세 곳의 UI 기대값을 수정했으며, 위의 최종 통과는 그 이후 결과다.

## 공개 게시·업데이트

- 공개 시각: **2026-10-02T06:48:38Z (UTC)**. [0.3.7 Release](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.7)를 안정 latest로 게시했다. 기존 0.3.6 파일은 변경하지 않았다.
- 공개 전 초안의 첨부 5개 이름·크기·서버 SHA-256을 검증한 로컬 산출물과 대조했다. 공개 뒤 익명 latest API, 작은 첨부 3개의 실제 바이트, 설치 파일·ZIP의 HEAD 크기와 서버 SHA-256 일치를 확인했다.
- 기존 **0.3.6 패키지의 app-update.yml**과 제품의 GuardedNsisUpdater·UpdateController로 실제 Electron이 공개 0.3.7 설치 파일 전체를 다운로드했다. 내장 SHA-512와 추가 SHA-256 검증 통과, 대상 0.3.7·ready·진행률 100을 확인했다. 같은 0.3.7은 idle·최신 버전 상태였다.
- 게시 직후 첫 업데이트 조회는 idle로 끝나 다운로드 검사에 실패했다. 재조회에서는 2026-10-02T06:50:25Z에 위 전체 다운로드·버전·해시 검증을 통과했다. 첫 조회의 원인은 확정하지 않았다.
- 다운로드 시험은 현재 버전만 AppAdapter에서 지정하고 격리 TEMP 캐시를 사용했다. GitHub 인증 환경변수를 제거했고 설치·호스트 종료·재실행 호출을 금지했다. autoInstallOnAppQuit은 false였다. 실사용 NSIS 교체 검사가 아니다.
- [공개 README PR #1](https://github.com/bokjk/mongle-terminal-releases/pull/1)을 병합했다. 공개 안내 커밋은 `2540e2c8ad7976b9497f17946f6f3d2c097d6b93`이며 해당 저장소에는 사용자 안내와 검토한 이미지·배포 파일만 게시했다. 소스·내부 문서·소스 Git 이력은 복사하지 않았다.

| 공개 첨부 | 바이트 | SHA-256 |
|---|---:|---|
| `MongleTerminal-Setup-0.3.7-x64.exe` | 148,732,649 | `4b59c98aa7d1737207f5227d49a455a0e40067a6aa5a5dcf1539ec0af7ca590f` |
| `MongleTerminal-Setup-0.3.7-x64.exe.blockmap` | 154,932 | `a2d9d616de8297be508aae701a13a3927fd2545655520853a2c8ce982415877b` |
| `MongleTerminal-0.3.7-x64.zip` | 206,174,922 | `7eab003d005e4e2d82f9c8415760bad0462afd2654a1cd6a1c0b4602cdf66341` |
| `latest.yml` | 365 | `1649b3fa9714c7c7f7c9133d5262ab322477fd9e562f8a31e41df2077d55c0ef` |
| `SHA256SUMS.txt` | 383 | `b197500770496da15e4a5784026cb543d66d8434c2d89422a149d54e99de7205` |

공개 증거: `test-results/release-037/draft-verified.json`, `public-verified.json`, `test-results/public-update-037/result.json`. 전용 Actions 게시 secret은 등록하지 않았다. 검증한 로컬 산출물을 유지보수자의 gh 인증으로 게시했고, 사용자 앱은 토큰 없이 받는다. 동일 소스를 별도 Windows 환경에서 재빌드해 artifact로 보존하는 [태그 워크플로](https://github.com/bokjk/mongle-terminal/actions/runs/36975209004)의 상태는 해당 실행에서 확인한다. 이 재빌드는 이미 공개한 바이너리를 덮어쓰지 않는다.

## 남은 범위

실사용 NSIS 설치본 교체·OS 재부팅·실물 모바일·Windows 물리 IME의 모든 조합은 별도다. 실사용 호스트·셸·인증 데이터·Tailscale 설정을 변경하지 않았다. 모바일은 승인된 루프백 웹 연결과 Chrome 터치 에뮬레이션이며 실물 휴대폰 검증으로 표현하지 않는다.
