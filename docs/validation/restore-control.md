# 복원 제어권 검증

2026-09-29, Windows 11 x64, 0.3.0 개발 빌드(dbede20 이후 작업 트리). 완전 종료 후 자동 복원한 분할 패널 하나가 빈 화면과 **현재 컴퓨터에서 제어 · 가져오기**로 남던 결함의 원인, 수정과 검증 범위를 기록한다. [0.3.0 비공개 테스트 배포본](tester-build-0.3.0.md)의 패키지 실행 검사에서 발견했다.

## 증상

`tests/e2e/full-exit.test.ts`에서 PowerShell 패널 두 개를 좌우 분할한 그룹을 완전 종료한 뒤 다시 실행하면 첫 패널은 **여기서 제어 중**이었다. 두 번째 패널은 프롬프트도 이전 출력도 없이 비어 있었고 하단에 **현재 컴퓨터에서 제어 · 가져오기**가 표시됐다(`full-exit.test.ts:325`). 패키지 0.3.0과 개발 빌드가 같은 위치에서 실패했다. 실패 시점 호스트 상태에서 두 번째 터미널의 제어권은 데스크톱 앱 자신의 연결이 가진 epoch 1, `ready:false`였다.

## 원인

데스크톱 앱에서는 요청 응답과 호스트 이벤트가 서로 다른 Electron IPC 경로로 화면에 도착해 순서가 보장되지 않는다. `control.acquire` 응답은 `ipcMain.handle` 응답으로 오고, 호스트가 응답보다 먼저 보낸 제어자 상태는 `webContents.send`로 온다. 호스트는 최초 구현부터 새 제어권을 상태로 먼저 방송한 뒤 응답하고, 로컬 연결 구성 요소도 순서를 지킨다. 그래도 화면에는 응답이 먼저 도착할 수 있다.

4335fd6(PC·모바일 입력 전환)부터 `TerminalPane`은 획득 응답을 받은 순간 상태 이벤트로 관측한 제어자가 응답과 같은 epoch·연결이 아니면 획득을 포기했다. 상태 이벤트가 늦으면 이 검사가 정상 획득을 거절했고, 이때 응답의 화면 프레임을 적용·ACK하지도 제어권을 반납하지도 않았다.

1. 호스트에는 같은 연결의 제어권이 `ready:false`로 남고, 10초마다 보내는 heartbeat가 15초 lease를 계속 연장한다.
2. 호스트는 연결별 흐름 제어로 ACK되지 않은 프레임 뒤의 새 프레임을 보류한다. 패널은 셸이 프롬프트를 출력하기 전의 attach 프레임에 머물러 빈 화면이 된다.
3. 늦게 온 상태 이벤트는 자기 연결을 제어자로 보여 주지만 패널은 이를 자기 제어권으로 인식하지 못해 다른 기기처럼 표시하고, 배경 획득도 건너뛴다.

복원 직후 두 패널이 연달아 배경 획득하면서 IPC가 몰려 두 번째 패널에서 반복 재현됐다. **가져오기**를 누르면 복구되지만 기본 상태로는 쓸 수 없는 화면이다. 기존 `tests/ui/tap-control-integration.test.ts`는 응답 전에 이벤트를 모두 전달하는 브리지를 사용해 이 순서를 재현하지 못했다. 그 가정은 브라우저 WebSocket 경로에서만 맞다.

## 증거

패널 mount·attach·ACK·획득·detach, 앱 상태의 출처, 호스트 lease와 흐름 제어를 기록하는 임시 진단 코드로 개발 빌드 E2E를 재현했다. 원인 확인 뒤 진단 코드는 모두 제거하고 `dist/`를 다시 빌드했다.

| 화면 시각 | 두 번째 패널 |
|---|---|
| 1167ms | attach 프레임 적용 후 배경 획득 요청(`takeover:false`) |
| 1178ms | 획득 응답 도착: epoch 1, 자기 연결, 프레임 seq 2. 관측한 제어자가 없어 포기, 프레임 미적용 |
| 1181ms | 호스트가 응답 전에 보낸 상태 도착: 제어자 = 자기 연결 epoch 1 |

호스트 로그에서 같은 연결의 두 번째 터미널 획득이 성공(epoch 1, seq 2)한 뒤 seq 2 ACK가 없었고, 이후 출력은 `held {seq:3, sent:2, ack:1}`로 보류됐다. 그 사이 해당 연결의 attach·detach나 패널 재마운트는 없었다. 첫 패널은 같은 상태가 응답보다 3ms 먼저 도착해 정상 획득했다. E2E 하네스의 별도 소유자 연결은 제어권을 가진 적이 없다.

검토 후 제외한 가설은 다음과 같다.

- **재마운트 경쟁:** 패널은 연결 전(attach 없음) 1회, 연결 후 1회만 만들어졌다. 다만 attach 프레임 적용 중 해제된 패널이 detach 뒤에 배경 획득을 보낼 수 있는 잠재 결함은 코드에 있어 함께 막았다. 아래 UI 검사가 수정 전 이 동작을 재현한다.
- **중복 패널, bootId·세대 필터:** 중복 인스턴스와 필터로 버린 프레임이 없었다.
- **복원 세대 변경 순서:** 세대는 연결 전 호스트 초기화에서 확정되어 화면은 새 세대만 받았다.

증거는 Git에서 제외한 `test-results/restore-control/diag-before-fix/`에 있다. `full-exit-result.json`(실패 시점 상태·연결 ID·패널 텍스트), `full-exit-console.json`(화면 진단), `diag-host.log`(호스트 요청·lease·흐름 제어), `full-exit-failure.png`다.

## 수정

동작 변경은 `apps/web/src/TerminalPane.tsx`에 있고 `apps/web/src/App.tsx`는 현재 연결 ID를 패널에 전달한다. 호스트, 프로토콜, 로컬 연결, 인증, Tailscale 설정은 바꾸지 않았다.

1. 획득 응답은 도착 순서가 아니라 lease epoch로 판단한다. epoch는 셸 세대 안에서 단조 증가한다. 관측한 제어자가 응답보다 새 epoch이면 이미 다른 lease로 바뀌었으므로 제어권을 주장하지 않는다. 상태가 아직 없거나 더 오래된 제어자만 보이면 응답의 부여를 받아들여 프레임을 적용하고 epoch를 붙여 ACK한다.
2. 상태 이벤트끼리는 순서가 유지된다. 그 부여나 더 새 lease를 보고하는 첫 상태가 올 때까지, 그보다 앞선 스냅샷(부여 이전 상태)으로 제어권을 해제하지 않는다.
3. 호스트가 돌려준 화면 프레임은 제어권이 없어도 적용하고 ACK한다. 더 새 lease에 밀린 획득 응답과, 제어권이 옮겨진 뒤 도착한 크기 조정 응답이 해당한다. 호스트는 ACK 전까지 다음 프레임을 보내지 않기 때문이다.
4. 획득을 포기하면 epoch를 지우고 해당 epoch만 `control.release`로 반납한다. 다른 기기의 새 lease는 epoch가 달라 영향을 받지 않고, 이후 ACK에도 옛 epoch가 붙지 않는다.
5. 해제된 패널은 제어권을 요청하지 않는다.
6. 같은 창(같은 연결)이 남긴 lease는 다른 기기로 표시하지 않는다. 소유자 데스크톱의 배경 획득은 다른 연결의 lease가 있을 때만 기다린다. 호스트는 원래 같은 연결의 조건부 획득을 허용한다.
7. 앱 전체 상태는 이미 처리한 이벤트보다 오래된 `state.get` 응답으로 덮일 수 있다. 제어권 해제는 패널이 직접 받는 상태 이벤트의 순서만 따른다.

입력 전환 정책은 그대로다. 배경 attach·재연결은 다른 기기의 lease를 가져오지 않고, 터미널당 제어자는 호스트가 하나로 유지하며, 입력은 epoch를 붙인 화면 ACK가 성공한 뒤에만 보낸다. 호스트는 이미 상태를 응답보다 먼저 보내므로 호스트 순서 보장으로는 고칠 수 없다. Electron 브리지에 순번 대기를 넣는 방법은 창 새로고침과 원격 연결까지 다뤄야 해 더 크다. 원격 PC 연결도 같은 IPC를 거치므로 이 패널 수정이 함께 적용된다.

## 검증

| 검사 | 결과 |
|---|---|
| 새 UI 회귀 `tests/ui/restore-control.test.ts` | 수정 전 **6/6 실패**, 수정 후 **6/6 통과**. 실제 호스트 복원 검사는 수정 전 앱과 같은 **현재 컴퓨터에서 제어 · 가져오기**로 실패 |
| 호스트 계약 `tests/host/core.test.ts` 새 검사 | 통과. 부여 상태가 응답 전에 방송되고 그 앞의 상태는 더 오래된 lease만 보고함을 고정한다. 호스트 코드는 바꾸지 않았다 |
| 관련 회귀 10개 파일 | **50/50 통과**, 113.8초. 호스트 core, restore-control, tap-control, tap-control-integration, mobile-keyboard, mobile-display, workspace, layout, pane-drag, client |
| 타입 검사 | `npm.cmd run typecheck` 통과 |
| 개발 빌드 완전 종료 E2E | **3/3 통과** (39.7초, 45.3초, 43.5초). 두 패널 모두 **여기서 제어 중**, 호스트 제어자 `ready:true`, 이전 출력 표시와 새 셸 명령 실행 |

새 UI 회귀 검사는 두 가지다. 실제 HostCore로 PowerShell 분할 두 개를 만들고 `host.shutdown`과 새 부팅으로 복원한 뒤 소스에서 빌드한 앱을 연다. 브리지는 획득 응답을 먼저 돌려주고 그동안 생긴 상태·프레임 이벤트를 200ms 뒤 순서대로 전달해 Electron 순서를 재현한다. 가짜 호스트 검사는 응답 전에 더 새 휴대폰 lease가 온 경우, attach ACK 대기 중 그룹 전환으로 패널이 해제된 경우, 같은 창이 남긴 lease, 제어권 이동 뒤 도착한 크기 조정 응답을 다룬다.

실행 명령:

```powershell
npm.cmd run typecheck
npx.cmd tsx --test tests/ui/restore-control.test.ts
npx.cmd tsx --test --test-concurrency=1 tests/host/core.test.ts tests/ui/restore-control.test.ts tests/ui/tap-control.test.ts tests/ui/tap-control-integration.test.ts tests/ui/mobile-keyboard.test.ts tests/ui/mobile-display.test.ts tests/ui/workspace.test.ts tests/ui/layout.test.ts tests/ui/pane-drag.test.ts tests/ui/client.test.ts
npm.cmd run build
Remove-Item Env:MONGLE_E2E_EXE -ErrorAction SilentlyContinue; $env:MONGLE_E2E_FULL_EXIT='1'; $env:MONGLE_E2E_DATA_ROOT=Join-Path $env:TEMP 'mongle-restore-race'; $env:MONGLE_E2E_REPORT='restore-control-dev'; npx.cmd tsx --test tests/e2e/full-exit.test.ts
```

E2E는 GUI를 띄우고 WMI로 격리 프로세스를 확인하므로 샌드박스 밖에서 실행했다. 데이터는 `%TEMP%` 아래 고유 폴더를 썼다. E 드라이브 작업 폴더에서는 OwnerPipe가 데이터 폴더 소유자를 설정하지 못해 실행부가 시작하지 않는다. 검사한 빌드는 `dist/host/main.cjs` `f08e48ef…`, `dist/desktop/main.cjs` `682244b3…`(실패한 개발 빌드와 같은 파일), 새 웹 번들 `dist/web/assets/index-CQBTL1Kp.js` `2306fdc5…`다.

로그와 결과는 Git에서 제외한 `test-results/restore-control/`(`before-fix-ui.log`, `after-fix-ui.log`, `regression-batch.log`)와 `test-results/e2e/restore-control-dev*/`에 있다. 샌드박스 안에서는 PSReadLine이 `%APPDATA%` 기록 파일에 쓰지 못해 오류 문구를 출력하지만 명령은 실행된다. 그래서 UI 회귀는 프롬프트 문구 대신 입력한 명령의 출력으로 새 프레임 도착을 확인한다. mobile-display·workspace 검사는 Git에 포함된 `artifacts/ui/*.png`를 다시 만든다. 이번에 바뀐 4개는 HEAD 내용으로 되돌렸다.

## 확인하지 않은 범위

- 패키지 재빌드와 패키지 E2E는 이 작업에서 수행하지 않았다. 새 웹 번들이 포함됐는지는 재빌드한 패키지에서 확인해야 한다.
- 실제 사용자 앱(`release/`), 실행 중 호스트, 실제 휴대폰, Tailscale에는 적용·변경하지 않았다. 원격 PC 연결에서 같은 순서 역전이 일어나는지는 실측하지 않았다.
- **추가 발견, 미수정:** 호스트 초기화가 끝난 뒤 gateway 준비 전에 연결한 소유자 연결은 `packages/host/main.ts`의 준비 후 연결 루프에서 `core.connect`가 한 번 더 호출되어, 그 연결의 attach와 lease가 초기화된다. 이번 재현에서도 GUI 연결이 2ms 간격으로 두 번 연결됐지만 첫 요청(92ms 뒤)보다 앞서 영향이 없었다. 준비 파일 쓰기가 GUI의 첫 attach보다 느린 경우에만 같은 계열의 빈 화면이 생길 수 있으며 재현하지는 못했다.
