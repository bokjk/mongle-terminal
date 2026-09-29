# 몽글 캐릭터 아이콘 적용 검증

2026-09-29. `on_desk`의 대표 캐릭터 보영(Boyo, 살구색 푸들)을 참조해 큰 얼굴·두 발·민트색 `>_` 터미널을 결합했다. 원본, 출처와 최종 프롬프트는 [브랜딩 문서](../branding/README.md)에 보존한다. `on_desk` 파일은 변경하지 않았다.

## 적용 범위

- 공통 원본: `apps/web/public/mongle-terminal-icon.png`, 1254×1254 RGBA, 투명 배경.
- Windows: 16·24·32·48·64·128·256px ICO, EXE 내장 리소스, Electron 창 아이콘, 설치·제거 프로그램 아이콘.
- 작업 표시줄: Electron과 NSIS 바로가기의 AppUserModelID `dev.mongle.terminal` 일치.
- 웹: 앱 사이드바, 32px favicon, 192·512px PWA 아이콘, 192px Apple touch icon.
- 현재 사용자: 바탕화면과 시작 메뉴에 `몽글터미널.lnk` 생성. 실제 `release/win-unpacked/MongleTerminal.exe`를 가리키며 EXE 아이콘 0과 같은 AppUserModelID를 저장한다.

## 실제 검증

| 검증 | 결과 | 증거 |
|---|---|---|
| EXE 내장 아이콘 | 새 ICO와 7개 크기 이미지 바이트 일치. 기존 아이콘 불일치 검출 포함 9/9 검사 통과 | `test-results/branding/windows-icon.json`, [플랫폼 검증](platform.md) |
| 실행 중인 창 | 새 GUI PID 44424의 `WM_GETICON ICON_BIG`에서 40×40 아이콘 추출. 이미지에서 캐릭터와 터미널 확인 | `test-results/branding/running-window.json`, `running-window-icon.png` |
| 로컬 바로가기 | 실제 생성 후 target, cwd, icon, iconIndex, appUserModelId를 다시 읽어 일치 확인 | `test-results/branding/shortcuts.json` |
| Windows 셸 표시 아이콘 | 실제 바탕화면·시작 메뉴 바로가기와 EXE의 `SHGetFileInfo` 결과 32px PNG를 직접 확인. 모두 새 캐릭터 | `test-results/branding/shell-icons.json`, `shell-desktop.png`, `shell-start-menu.png`, `shell-exe.png` |
| 실제 원격 웹 | Tailscale HTTPS의 HTML, JS, CSS, PNG 3종, manifest가 로컬 빌드와 바이트 일치 | `test-results/branding-live.json` |
| 기존 세션 보존 | 호스트 PID 6400·bootId·기존 PowerShell PID 14060 유지. 핵심 실행부 4파일 해시 유지 | `test-results/branding/live-update.json`, `test-results/branding-live.json` |
| 배포 | NSIS·ZIP 생성, native 7파일과 모듈 로드, 최종 배포 파일 4개 체크섬 검증 통과 | `release/SHA256SUMS.txt`, [플랫폼 검증](platform.md) |
| 새 배포본 전체 E2E | **20.63초 통과**. 사이드바 아이콘 로드·Windows EXE 아이콘 추출, 실제 PowerShell·분할·앱 재시작 후 동일 PID/변수 유지, 모바일 제어·새로고침 확인. 시험 프로세스 정리 완료 | `test-results/e2e/branding/result.json`, [E2E](e2e.md) |

새 패키지는 먼저 `release-branding`에 생성했다. 현재 앱 창만 정상 종료한 뒤 기존 `release/win-unpacked`의 EXE·`resources/app.asar`·ICO·웹 자산만 교체하고 다시 열었다. 호스트의 node.exe, OwnerPipe.exe, HostLauncher.exe, host main과 native 모듈은 교체하지 않았다. 이전 GUI 파일과 HTML은 `test-results/branding/pre-update-20260929-095843/`에 백업했다. 원격에서 이미 열린 페이지를 지원하기 위해 이전 해시의 JS·CSS도 유지했다.

현재 바로가기는 압축 배포 폴더를 실행한다. NSIS 설치를 수행한 상태로 표시하지 않는다. 설치·제거 마법사 실행, 실제 삼성 인터넷의 홈 화면 설치 아이콘, Windows의 기존 사용자 고정 아이콘 캐시 갱신은 별도 검증 대상이다.

E2E 첫 시도의 E 드라이브 시험 폴더는 ACL 보호에 필요한 사용자 권한이 없어 초기화에 실패했다. 사용자 TEMP 아래 고유 시험 폴더로 옮겼으며 제품 보안이나 드라이브 권한은 완화하지 않았다. 또한 이전 시험의 모바일 패널 표시 공백 기대값을 현재 UI에 맞췄다. 두 중간 시험 결과는 보존하고, 위 최종 통과는 같은 새 EXE를 처음부터 끝까지 재실행한 결과다.

Electron `app.getFileIcon()` 결과는 일반 Windows 아이콘이어서 캐릭터 표시의 증거로 사용하지 않았다. 별도로 Windows `ExtractIconEx`에서 두 배포 경로의 EXE와 ICO 모두 새 캐릭터가 추출되는 것을 확인했다. 변경한 EXE와 바로가기 2개만 `SHChangeNotify`로 갱신 통지한 뒤, `SHGetFileInfo`에서 실제 셸 표시 아이콘도 새 캐릭터임을 확인했다. 탐색기를 종료하거나 아이콘 캐시 파일을 삭제하지 않았다.
