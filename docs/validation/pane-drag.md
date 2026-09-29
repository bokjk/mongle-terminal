# 실제 드래그 분할 검증

**PASS — 23.99초.** 2026-09-29 10:46:39–10:47:03 KST에 실제 Chrome의 HTML5 마우스 드래그와 두 개의 격리 HostCore, 실제 PowerShell/ConPTY를 사용해 검증했다. 진단 수집 모드를 끈 엄격 실행에서 입력 누락·중복 0건, renderer 오류 0건, 테스트 셸 정리 성공을 확인했다.

검증 소스는 `tests/ui/pane-drag.test.ts`, 웹 빌드는 `index-DTeer5uC.js` / `index-C9zduDWH.css`다. `dist/web/index.html` SHA-256은 `ccc2513a85a47dd69b750c2f946773169d2d7d0eb6af8e01a001fca3ebada2d3`이다. 결과와 RPC 기록은 `test-results/ui/pane-drag/result.json`, `rpc.json`에 보관한다.

## 배포 앱 전체 회귀

`release-pane-drag/win-unpacked/MongleTerminal.exe`에서도 실제 Electron top-dock을 포함한 전체 E2E가 **23.19초에 통과**했다. 드래그 직후 같은 셸의 변수를 읽고 GUI를 완전히 종료·재실행한 뒤 같은 호스트와 두 셸에 재연결했다. 모바일 viewport의 페어링·제어 이전·재접속도 통과했다. Renderer 오류 0개 및 테스트 호스트·셸 정리 완료를 확인했다. 결과는 `test-results/e2e/pane-drag-full/`, 실행 방법과 PID 증거는 [e2e.md](e2e.md)에 있다.

## 검증 범위

| 범위 | 실제 확인 |
|---|---|
| 기존 패널 배치 | 그립을 잡아 왼쪽·오른쪽·위·아래로 이동하고 제목을 잡아 가운데 교환. 드롭 전 해당 위치와 한국어 동작 미리보기 확인. 각 동작은 layout 요청 한 번이며 기존 ID가 각각 한 번만 존재 |
| 세션·입력·제어권 | 셸 PID·generation·상태 유지. 이동 과정의 attach/detach/control.acquire 요청 0회. 재취득 버튼 없이 2ms 간격으로 입력한 모든 바이트가 정확히 한 번 호스트에 도착하고 기존 메모리 변수를 새 명령으로 출력. 다른 기기의 lease도 탈취하거나 교체하지 않고 그 기기의 입력 계속 성공 |
| 취소·경쟁·외부 입력 | 네이티브 Escape, 새 터미널 Escape, 외부 영역 놓기, revision·그룹·컴퓨터 변경, 연결 끊김에서 변경 RPC와 실제 입력 없음. 뒤늦은 CAS 충돌에서는 다른 작성자의 배치 보존 및 드래그/대기 중인 분할선 경로 재적용 없음. 외부 텍스트·파일·위조 토큰이 레이아웃이나 셸 입력에 도달하지 않음 |
| 새 터미널·기존 조작 | 단일 패널에서 상단 터미널 버튼을 왼쪽·위쪽으로 끌면 기본 셸 하나만 생성. 원래 셸 변수 유지, 편집창 오동작 없음. 일반 클릭은 기존 대화상자 표시. 모바일·최대화·오프라인 드래그 비활성, 모바일 패널 전환 유지. 키보드·Home·포인터·더블 클릭 분할선 크기 조절도 정상 |
| 배치·저장·복귀 | 패널 사각형이 겹치거나 viewport를 벗어나지 않음. 인접 분할선 간격 약 9px. read-only SQLite 조회로 저장된 layout/revision을 직접 확인하고 새 화면·연결에서 같은 배치·PID·generation·메모리 변수 복귀 |

정상 터미널 포커스 알림 `ESC[I` / `ESC[O`는 사용자 입력과 구분한다. 취소 검사에서 독립 Escape 바이트, 문자 또는 명령이 전달되면 실패한다.

## 발견한 오류와 재검증

첫 실제 드래그 후 즉시 `Write-Output`을 입력했을 때 크기 동기화 구간의 일부 글자가 사라져 `Write-put`으로 전달됐다. 셸·DOM·제어권은 유지된 상태였으므로 재시작 문제와 구분된다. 원본 실패는 `resize-input-loss/`에, 나머지 범위를 끝까지 검사하면서 입력 실패를 수집한 진단 결과는 `diagnostic/`에 보존했다. 진단 실행도 입력 실패가 있으면 마지막에 반드시 실패하므로 승인 근거로 사용하지 않는다.

구현 담당자가 알려진 resize 동기화 동안 같은 lease의 입력을 보존하도록 수정했다. 최종 실행은 입력 지연을 늘리거나 제어권을 수동 재취득하지 않고 기존 엄격 조건으로 모두 통과했다. 입력 응답 불확실 상태의 자동 재전송을 허용하는 수정과는 구분한다.

테스트 초기의 포커스 알림을 문자 입력으로 계산한 실패는 제품 오류로 분류하지 않았다. 실제 입력 손실은 RPC 바이트와 PowerShell 오류 출력으로 확인했다.

## 증거와 정리

- `preview-left.png`, `preview-center.png`: 드롭 전 반투명 영역과 동작 라벨. 직접 화면 확인 완료.
- `desktop-final.png`: 재연결 뒤 세 패널과 새 `RELOADED:` 변수 출력. 반복 크기 변경에 따른 PowerShell 과거 출력 줄바꿈은 화면에 남는다.
- `result.json`: `passed: true`, `diagnostic: false`, `inputFailures: []`, `errors: []`, `cleanedUp: true` 및 전후 PID·세대·배치.
- `rpc.json`: 실제 시도한 요청과 수락·거부 결과. 취소가 단순히 백엔드에서 거절된 것이 아니라 변경 요청 자체를 보내지 않았음을 확인하는 데 사용했다.

테스트 데이터는 사용자 TEMP의 고유 `mongle-pane-drag-*` 아래에 만들었다. 테스트에서 만든 PowerShell PID 3124, 50408, 7624, 50368, 19368, 8284, 50604가 모두 종료됐음을 확인했다. 실제 사용자 호스트·셸·GUI나 Tailscale 설정은 조작하지 않았다.

## 재실행

Windows에서 웹 빌드가 준비된 상태로 프로젝트 루트에서 실행한다.

```powershell
$env:MONGLE_DRAG_COLLECT='0'
node --import tsx --test tests/ui/pane-drag.test.ts
```

추가 원인 수집이 필요할 때만 `MONGLE_DRAG_COLLECT=1`을 사용한다. 이 모드는 입력 손실을 모은 뒤 실패하며, 산출물을 `diagnostic/`에 분리한다. 통과 판정은 기본 엄격 실행 결과로 한다.

## 검증 한계

기본 드래그는 브라우저가 생성한 DataTransfer와 실제 mouse down/move/up 경로다. 외부의 신뢰할 수 없는 데이터만 의도적으로 합성한 DragEvent로 시험했다. 브라우저와 실제 HostCore 사이의 데스크톱 bridge 및 연결 전환은 테스트 fixture이며 Electron/Tailscale 전송 경로 검증과는 구분한다. 화면 복귀 검사는 페이지를 비운 뒤 테스트 bridge를 재연결하여 실제 새 브라우저 연결의 lease 수명주기를 재현했다. 실물 모바일 터치·IME·OS 로그오프·재부팅은 포함하지 않았다.

새 터미널 생성에는 서버 측 원자적 revision 조건이 없다. 이번 검증은 드롭 전 문맥 검증과 뒤이은 배치 CAS가 현재 시나리오에서 올바르게 동작함을 확인한다. 이미 전송된 생성 요청과 동시에 다른 작성자가 그룹을 수정하는 모든 순서를 원자적으로 보장한다고 해석하지 않는다.

## 현재 사용 환경 반영

`release-pane-drag`의 NSIS·ZIP 생성, 내부 native 모듈 로드, ZIP 필수 파일 7개와 EXE 아이콘 리소스 검사를 통과했다. 실제 배포 앱 E2E는 `test-results/e2e/pane-drag-full/result.json`에 23.19초 통과로 기록됐다. 실제 Electron의 위쪽 드래그와 즉시 변수 입력, 앱 재실행·모바일 승인·제어·재접속까지 포함한다. `release/`의 설치·ZIP·blockmap·체크섬을 같은 결과물로 갱신했다.

현재 호스트의 `dist/web`에 새 자산을 복사하고 이전 index를 백업한 뒤 index를 원자적으로 교체했다. 열려 있는 다른 화면을 위해 기존 해시 자산은 보존했다. 호스트·helper·실행 파일·ASAR는 수정하지 않았다. 적용 스크립트는 파일·프로세스 검사 완료 후 정수 키의 JSON 직렬화에서 오류가 났으며, 기록 형식을 수정하고 읽기 전용 파일 대조로 증거를 복구했다. 재복사나 호스트 재시작은 하지 않았다.

`test-results/pane-drag-after.json`에서 실제 Tailscale HTTPS의 JS·CSS·아이콘·manifest가 로컬 빌드와 같은 바이트임을 확인했다. JS는 `index-DTeer5uC.js`, CSS는 `index-C9zduDWH.css`다. `test-results/pane-drag/live-before.json`과 `live-after.json` 비교로 호스트 PID 6400, boot ID, 셸 PID 14060·45092·34256 및 generation, 분할 배치가 동일함을 확인했다. 그 사이 그룹 revision은 8에서 10으로 증가했으므로 revision 불변이라고 주장하지 않는다. 실행한 적용·상태 조회 스크립트는 배치 변경 RPC를 보내지 않으며, 별도 클라이언트에서 발생한 변경인지 원인을 확정하지 않았다.

실사용 GUI PID 45288의 정상 종료 메뉴를 통한 화면 재실행은 완료하지 못했다. 첫 UI Automation 메뉴 확장은 COM 오류, 다음 시도는 Windows 창 활성화 실패로 실제 종료 메뉴를 호출하기 전에 중단했다. 두 결과는 `desktop-reopen-first-attempt.json`, `desktop-reopen.json`에 보존했고, 전후 호스트·셸 시작 시각은 동일했다. 현재 열린 창은 기존 UI를 유지하므로 **앱 메뉴 → 앱 종료 · 터미널 유지 → 다시 실행**이 필요하다. 새 배포본 실행 검증 성공을 기존 창의 화면 갱신 성공으로 해석하지 않는다.
