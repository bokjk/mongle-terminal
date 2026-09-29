# GJC 화면 깜박임 수정 (2026-09-29)

## 확인한 원인과 수정

- `gjc v0.18.1`의 실제 ConPTY 출력을 12초 수집했다. AI 요청은 전송하지 않았고 임시 실행만 종료했다. 186개 출력 조각에서 DEC 2026 시작·종료 신호가 각각 76회 관찰됐다. 수집 원본은 개인정보가 포함될 수 있어 Git에서 제외된 `test-results/gjc/capture.json`에만 보관한다.
- 호스트가 동기화 출력 중간에 스냅샷을 만들던 동작을 수정했다. 파서 큐 밖에서 완료 신호를 기다려 후속 출력 처리를 막지 않는다. 종료 신호가 누락되면 최대 1초 후 화면을 제공한다.
- 브라우저는 전체 스냅샷마다 reset 후 비동기 write를 수행했다. 실제 Chrome에서 느린 쓰기를 재현하자 `빈 화면 → 일부 글자 → 완성된 화면`이 각각 그려졌다. 이제 xterm 6의 synchronizedOutput 상태로 이전 화면을 유지하고 파싱·스크롤·선택 복원 후 새 화면을 표시한다. 내부 API 사용은 pinned-xterm.ts에 한정한다.

## 검증

- 타입 검사 및 프로덕션 빌드 통과. 기존 웹 번들 크기 안내 외 오류 없음.
- 터미널 회귀 30/30 통과: 실제 Chrome 렌더링, 한글 IME, 입력 모드, 대체 화면, 모바일 키보드·스크롤, 기록 복원 포함.
- 호스트 회귀 34/34 통과: 실제 PowerShell, 세션 재연결, 제어권, 종료·복원 및 저장 실패 처리 포함.
- 실제 GJC 출력 조각을 원래 타이밍으로 호스트 엔진과 Chrome 화면에 재생하는 별도 검사 통과. 60ms 화면 전송, 초기 표시 이후 빈 화면 0회, 입력한 `flicker-check` 표시 확인.
- GJC 재생 검사는 로컬 수집 자료가 있을 때만 실행한다: `MONGLE_GJC_CAPTURE=test-results/gjc/capture.json`을 설정하고 `node --import tsx --test --test-name-pattern="replay captured" tests/terminal/browser.test.ts` 실행. 실물 모바일·사용자의 실행 중 GJC에서 최종 확인한 것은 아니다.

## 적용 제한

`release-gjc-flicker`의 NSIS·ZIP 빌드와 네이티브 의존성·아이콘 검사를 통과했다. 해당 실행 파일로 격리 Electron/PowerShell 시작 폴더 E2E도 1/1 통과했다. 기존 `release` 경로에 호스트 JS·웹·배포 파일을 반영하고 8개 파일의 해시 일치를 확인했다. 적용 전후 호스트 PID 35160과 bootId가 동일하며 실행 중인 앱·셸을 종료하지 않았다. 기록: `test-results/gjc/deployment.json`.

현재 실사용 호스트의 소유자 IPC 연결에서는 기존 `Owner IPC server authentication failed.` 오류가 여전히 발생한다. 이번 화면 수정은 인증 오류 수정이 아니다. 실행 중인 사용자 호스트와 셸을 강제로 종료하지 않는다. 디스크의 수정본은 호스트까지 완전히 종료한 후 재실행해야 모두 적용된다.
