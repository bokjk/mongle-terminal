# 복사·붙여넣기 (2026-09-29)

사용자가 요청한 Windows 콘솔 방식으로 동작한다. 마우스로 블록/단어를 선택하고 놓으면 자동 복사하고, 일반 우클릭은 즉시 붙여넣는다. Ctrl+C는 선택이 있으면 복사하고 없으면 ETX를 셸에 전달한다. Ctrl+V 및 Ctrl+Shift+C/V도 지원하며 Shift+우클릭은 명시적 메뉴를 연다. 마우스 보고를 켠 TUI의 일반 우클릭은 해당 프로그램에 전달한다.

## 원인과 변경

데스크톱은 브라우저 권한을 모두 거부하면서 클립보드 버튼에서 navigator.clipboard를 사용했다. 이제 신뢰한 앱의 main frame만 사용할 수 있는 텍스트 전용 IPC를 통해 Electron 44의 비동기 clipboard API를 사용한다. 브라우저 권한 정책 및 터미널 OSC 52 차단은 유지한다. 선택 복사는 mouseup에서만 실행하여 화면 스냅샷이 선택을 복원할 때 클립보드를 덮어쓰지 않는다.

앱 메뉴의 복사 accelerator를 Ctrl+Shift+C로 옮겨 Ctrl+C가 셸 중단과 충돌하지 않게 했다. 붙여넣기는 기존 제어권·입력 차단과 여러 줄 확인을 통과해야 한다. 비동기 확인 도중 터미널이 교체되면 이전 붙여넣기를 새 터미널에 보내지 않는다.

## 검증

- 타입 검사와 빌드 통과. 기존 웹 번들 크기 안내만 발생.
- 실제 Electron/Windows 클립보드 E2E 통과: 선택 자동 복사, Ctrl+C/Shift+C, 선택 없는 Ctrl+C 전달, Ctrl+V 1회 입력, Ctrl+Shift+V, 우클릭 즉시 붙여넣기, Shift+우클릭 메뉴, 여러 줄 취소.
- 테스트는 실제 raw-mode 자식 프로세스가 받은 바이트로 복사 시 중단 신호가 전송되지 않는 것과 붙여넣기 중복이 없는 것을 확인한다. 임시 데이터와 앱/호스트/셸은 정리하고, 클립보드는 테스트 값이 남은 경우에만 원래 내용으로 복원한다.
- `release-clipboard/win-unpacked/MongleTerminal.exe` 최종 배포 앱에서도 동일 E2E 통과 (17.39초). 증거: `test-results/e2e/clipboard/result.json`, `desktop.png`.
- 실제 HostCore UI와 Chrome 입력/IME/모바일 포커스 회귀 4개 통과. GJC 수집 파일을 요구하는 선택적 재생 검사는 이번 실행에서 생략.
- 브라우저 클립보드 접근은 해당 브라우저 권한에 따르며 실물 모바일 클립보드는 검증하지 않았다.

## 현재 앱 적용

`release/win-unpacked`의 EXE·ASAR·웹과 NSIS·ZIP을 교체하고 해시를 확인했다. GUI 34004를 종료하고 33348로 다시 열었으며 호스트 39240과 bootId는 그대로 유지했다. 기존 호스트·터미널 프로세스를 종료하지 않았다. 증거: `test-results/clipboard-rollout/deployment.json`.
