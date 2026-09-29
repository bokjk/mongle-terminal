# 트레이에 숨기기와 다시 열기

2026-09-29. Windows에서 창의 X·Alt+F4·닫기 메뉴는 창을 숨기고 몽글 캐릭터 트레이 아이콘을 유지한다. 트레이 클릭·더블클릭·`몽글터미널 열기` 또는 바로가기 재실행은 같은 창을 복원하고 포커스한다. `앱 종료 · 터미널 유지`는 GUI·트레이·클라이언트 연결만 끝내며 호스트 종료 RPC는 보내지 않는다.

## 구현과 종료 경계

`apps/desktop/main.ts`에서 Tray 객체를 보존하고 창의 close 이벤트를 hide로 바꾼다. 명시적 종료 시 먼저 quitting 상태를 설정해 종료를 막지 않는다. Windows `query-session-end`에서는 상태를 바꾸거나 종료를 차단하지 않는다. 실제 `session-end`에서만 정리하므로 Windows 종료가 취소된 뒤에도 일반 닫기는 트레이 숨기기로 동작한다.

예상치 못하게 창이 파괴됐더라도 트레이에서 다시 열면 새 창을 만든다. 연속 열기 요청은 생성 중인 창 하나를 기다리고, 로드 실패 시 잘못된 창을 정리한다. 창을 숨길 때 터미널 입력을 전송하거나 새로운 셸을 생성하지 않는다.

## 배포 검증

- 전체 타입 검사 통과, 독립 읽기 전용 수명주기 검토에서 결함 없음.
- `node --import tsx scripts/package.ts --output release-tray` 종료 코드 0. 실행 중인 앱과 분리해 패키징.
- EXE 내장 아이콘 7개 이미지 바이트 일치, 동봉 Node의 native 모듈 로드와 ZIP의 필수 native 7파일 포함 확인.
- 최종 파일 체크섬: `release-tray/SHA256SUMS.txt`.

| 배포물 | SHA-256 |
|---|---|
| `MongleTerminal-Setup-0.1.0-x64.exe` | `95dea233a0256d102b14f4eea4acbf6541a455a32a8876c72e319778cbe93681` |
| `MongleTerminal-0.1.0-x64.zip` | `2028fe6ad2325c9f10d457bf4d9412b0873262129e5cd7f2c6c42c4619b7ba1e` |
| `win-unpacked/MongleTerminal.exe` | `688bec4405c492367f27ac0f814680793c1b4846c3b542f7ed9a9746a974c31e` |
| `resources/app.asar` | `45e04278e2043a4119984db739db20ff185b95275defc22610ecafe81a80b906` |

실제 로그아웃·OS 종료와 NSIS 설치 마법사는 실행하지 않는다. 로그인 자동 시작과 Windows에서의 트레이 아이콘 고정 설정은 이번 변경 범위에 포함하지 않는다.

## 실제 실행 결과

| 검사 | 결과 | 증거 |
|---|---|---|
| 트레이 전용 E2E | **11.67초 통과**. 실제 Tray와 메뉴 객체에서 등록 상태·클릭·더블클릭·열기 메뉴·앱 종료를 확인. 숨김·최소화 복원·포커스·실제 두 번째 EXE 실행·같은 셸 변수 복원 통과 | `test-results/e2e/tray/tray-result.json` |
| 기존 전체 E2E | **23.51초 통과**. 실제 PowerShell·분할·그룹·앱 종료/재실행·모바일 제어·새로고침 통과 | `test-results/e2e/tray-full/result.json`, [E2E](e2e.md) |
| 현재 사용자 앱 | GUI 45288에 실제 `WM_CLOSE` 요청 → 창 숨김·프로세스 유지 → 두 번째 실행으로 동일 윈도우 5638806 복원 | `test-results/tray/live-close-reopen.json` |
| Windows 트레이 등록 | `Shell_NotifyIconGetRect`로 해당 GUI의 트레이 아이콘 확인. 소유 창 2953404/아이콘 ID 3, 사각형 40×60px. 창을 숨긴 후에도 동일하게 등록 | `test-results/tray/live-close-reopen.json` |
| 사용자 세션 유지 | 호스트 6400·bootId와 기존 셸 14060·45092·34256 모두 유지. HTTPS 웹 자산 그대로 | `test-results/tray-before.json`, `test-results/tray-after.json` |
| 최종 배포 폴더 | 실제 EXE와 `resources/app.asar`만 선별 교체. 실행부·native helper·웹 파일은 보존. 설치/ZIP/EXE/blockmap 4개 체크섬 일치 | `test-results/tray/live-update.json`, `release/SHA256SUMS.txt` |

E2E는 고유 TEMP 데이터 폴더에서 수행했고 시험 호스트·셸을 정리했다. 최초 중간 실패는 평가 함수 직렬화 시 tsx의 이름 보존 보조함수가 포함된 시험 코드 문제였으며 평가 함수를 고친 뒤 같은 제품 배포본에서 다시 통과했다. 트레이 클릭·메뉴 시험은 디버거를 통해 실제 등록 콜백을 호출했으며 물리적인 마우스 클릭으로 표시하지 않는다. 사용 중인 앱의 창 닫기·트레이 등록·다시 열기는 별도 Win32 API로 확인했다.
