# 실제 데스크톱·모바일 브라우저 통합 검증

2026-09-29 Windows x64에서 Playwright가 실제 Electron, 독립 Node 호스트, 설치된 PowerShell/ConPTY, 실제 Chrome 브라우저를 실행했다. UI와 호스트를 대체하는 mock은 사용하지 않았다.

## 현재 결과: 드래그 분할 패키지

**PASS — 23.19초.** 2026-09-29 10:51:10–10:51:32 KST에 `E:\other_dev\mongle-terminal\release-pane-drag\win-unpacked\MongleTerminal.exe`로 전체 시나리오를 실행했다. `MONGLE_E2E_PANE_DRAG=1` 옵션으로 실제 Electron의 마우스 드래그 → 위쪽 미리보기 → 세로 분할 → 즉시 셸 변수 출력까지 추가 검증했다. 배포 웹 `index.html` SHA-256은 `ccc2513a85a47dd69b750c2f946773169d2d7d0eb6af8e01a001fca3ebada2d3`이며, EXE·app.asar·호스트·native·웹 자산 해시는 `test-results/e2e/pane-drag-full/result.json`에 있다.

기존 그룹·분할선 조작, GUI 종료·재실행, 동일 셸 변수 유지, 모바일 viewport 페어링·제어권 이전·패널 전환·인증된 재접속이 통과했다. 테스트 호스트 **49532**, PowerShell **34744 / 49296**의 PID·세대가 드래그와 GUI 재실행 전후 유지됐다. Renderer 오류 **0개**, `passed: true`, `cleanedUp: true`다. 테스트 프로세스 정리 후 실사용 호스트 **6400**, 셸 **14060 / 45092 / 34256**, GUI **45288** 생존을 읽기 전용으로 확인했다.

산출물은 `test-results/e2e/pane-drag-full/`의 결과·콘솔·프로세스 확인 JSON과 `desktop-drag.png`, `desktop-resumed.png`, 모바일 캡처다. `desktop-drag.png`에서 새 캐릭터, 상하 두 셸과 `PACKAGED_DRAG:` 변수를 직접 확인했다. 네 방향·중앙 배치 및 입력 바이트 보존을 포함한 별도 실제 Chrome/HostCore 검증은 [pane-drag.md](pane-drag.md)에 기록했다. 물리 휴대폰 키보드·WAN 검증과는 구분한다.

## 이전 결과: 트레이 패키지

**트레이 전용 PASS 11.67초, 기존 전체 통합 PASS 23.51초.** 2026-09-29 10:17:38–10:18:30 KST에 `E:\other_dev\mongle-terminal\release-tray\win-unpacked\MongleTerminal.exe`를 고유 TEMP 데이터 폴더로 실행했다. EXE SHA-256은 `688bec4405c492367f27ac0f814680793c1b4846c3b542f7ed9a9746a974c31e`, `resources/app.asar`는 `45e04278e2043a4119984db739db20ff185b95275defc22610ecafe81a80b906`이다. 추가한 테스트를 포함한 `tsc --noEmit`도 통과했다.

- 실제 Tray 객체가 하나이며 Windows가 33×48의 화면 영역을 반환했다. 배포 아이콘 파일은 비어 있지 않은 256×256 이미지로 해석됐다.
- 실제 창 close 핸들러를 호출하면 같은 창 ID와 GUI 프로세스가 유지된 채 숨겨졌다. Tray 클릭·더블 클릭 이벤트와 열기 메뉴 콜백은 창을 표시·최소화 해제·포커스했고 살아 있는 셸 변수를 그대로 읽었다.
- 숨긴 상태에서 두 번째 실제 EXE를 실행하면 새 프로세스는 종료 코드 0으로 끝나고 원래 창이 복귀했다. 원래 GUI·호스트·셸과 그룹 구조는 유지됐다.
- Tray의 `앱 종료 · 터미널 유지`와 앱 메뉴의 종료 동작은 GUI만 끝냈다. 다시 실행한 GUI에서 호스트 **42664**, 셸 **50208**, boot ID·세대·메모리 변수 유지가 확인됐다. 검사 도구 연결도 닫아 클라이언트가 없는 구간을 포함했다.
- 동일 배포본에서 기존 분할·그룹 전환·앱 재실행·모바일 viewport 페어링·제어 이전·브라우저 재접속 전체 시나리오도 통과했다. 이 실행의 호스트 **47084**, 셸 **40764 / 37596**도 재실행 전후 동일했다. 두 테스트의 `cleanedUp`은 모두 `true`이며 종료 뒤 소유 프로세스가 남지 않았다. 실사용 호스트 **6400**, 셸 **14060**은 같은 시작 시각으로 생존했다.

증거는 `test-results/e2e/tray/tray-result.json`, `tray-console.json`, `process-check.json`, `tray-restored.png`, `tray-restarted.png`와 `test-results/e2e/tray-full/result.json`, `console.json` 및 기존 네 화면 캡처다. 두 실행 모두 renderer JavaScript 오류가 없었다. `tray-restarted.png`에서 새 캐릭터와 `RESTARTED:` 변수 출력을 직접 확인했다.

검증은 제품에 테스트 IPC나 export를 추가하지 않고 main-process debugger로 실제 Tray·Menu 객체를 조회하여 수행했다. **알림 영역에서 사람이 물리적으로 누른 클릭을 자동화한 것은 아니다.** 이벤트·메뉴 콜백과 후속 실제 창·프로세스 상태를 확인했으며, Electron에는 Tray 이미지나 연결된 메뉴를 읽는 getter가 없어 네이티브 팝업 표시·픽셀 자체는 이 테스트로 단정하지 않는다. 최초 실행에서 테스트 평가 함수의 tsx 보조 함수 `__name` 직렬화 오류가 있었고, inspector Promise API로 테스트만 수정한 뒤 통과했다. 제품 오류로 분류하지 않는다. OS 로그오프·재부팅과 실물 휴대폰 키보드는 이번 실행에 포함하지 않았다.

## 이전 결과: 새 캐릭터 패키지

**PASS — 20.63초.** 2026-09-29 10:02:31–10:02:52 KST에 `E:\other_dev\mongle-terminal\release-branding\win-unpacked\MongleTerminal.exe`로 아래 전체 통합 시나리오를 실행했다. 실행 파일 SHA-256은 `88abac444d3ee00eb93e9298521306f0363fb2f9adcd295249aaa6630ea02bf3`이며, 실제 배포 파일 12개의 해시와 `passed: true`, `cleanedUp: true`는 `test-results/e2e/branding/result.json`에 있다.

- 앱을 완전히 닫고 다시 켠 뒤 테스트 호스트 **31652**, PowerShell **50600 / 47588**, boot ID, 터미널 세대, 분할 구조와 셸 변수가 유지됐다. 검사 도구 연결도 닫아 클라이언트가 없는 구간을 포함했다.
- 그룹 생성·전환, 분할·크기 조절·균등화·최대화, 모바일 viewport의 페어링·제어권 이전·동일 셸 변수 읽기·인증된 새로 고침이 통과했다. JavaScript 오류는 **0개**이며 콘솔에는 정상 디버거 종료 메시지만 있다.
- `desktop-branding.png`에서 새 캐릭터의 사이드바 표시를 직접 확인했다. 배포 경로의 `icon-192.png`가 192×192로 로드됐다. Electron `app.getFileIcon()`으로 저장한 `executable-icon.png`는 일반 Windows 앱 아이콘을 반환했으므로, 이 파일은 새 캐릭터나 실제 작업 표시줄 아이콘의 증거로 쓰지 않는다. 실제 창 아이콘·리소스 검증은 `branding.md`의 별도 결과를 참조한다.
- 테스트 프로세스는 종료됐고 실사용 호스트 **6400**, 셸 **14060**, GUI **44424**가 계속 실행 중임을 읽기 전용 조회로 확인했다. 실물 휴대폰의 소프트 키보드·OS IME와 외부망 연결은 이 실행에서 검증하지 않았다.

첫 실행은 E 드라이브 `.test-data`의 상속 ACL에서 격리 호스트의 소유자 보호 설정이 실패했다. 실패 증거는 `test-results/e2e/branding/environment-failure/`에 보존했다. 저장소 ACL이나 제품 보안을 바꾸지 않고, 사용자 TEMP 아래 새 고유 디렉터리 `mongle-branding-e2e/desktop-e2e-FUebAB`로 재실행하여 통과했다. 지정한 데이터 부모 폴더를 직접 사용하지 않으며 매 실행 `mkdtemp`로 새 하위 폴더를 만들고 부모 일치를 확인한다. 테스트의 모바일 패널 표시 검사는 공백 유무가 다른 `2/2`도 허용하도록 조정했다.

## 이전 release 경로 검증

- 개발 빌드 통합 시나리오 **PASS**, 19.6초. 결과: `test-results/e2e/result.json`의 `passed: true`, `cleanedUp: true`.
- 작업 공간 내부의 배포 실행 파일 `release/win-unpacked/MongleTerminal.exe`에서 UI·세션 시나리오는 **PASS**, 32.8초였으나, 아래 이동 검증에서 필수 의존성 누락을 발견했다. 이 결과는 **독립 배포 성공의 근거로 사용할 수 없다**. 기존 기록은 `test-results/e2e/packaged/original-packaged-pass.json`에 보존했다.
- **이전 release 경로 판정: PASS.** 모바일 키보드 웹 수정 후 **`E:\other_dev\mongle-terminal\release\win-unpacked\MongleTerminal.exe`**에서 전체 시나리오를 다시 실행하여 **30.72초에 통과**했다. 실행 위치, native 파일 포함 검사, 14개 파일 SHA-256 및 `passed: true`, `cleanedUp: true`를 `test-results/e2e/packaged/result.json`에 기록했다. 최초 패키징 수정 후 E 이동 검증도 23.75초에 통과했다. 첫 이동 실패 증거는 `test-results/e2e/packaged/relocation-failed/`에 보존했다.
- Electron 및 모바일 브라우저 JavaScript 오류 **0개**. 마지막 실행의 `console.json`에는 정상 디버거 종료 메시지만 있다.
- 배포본 실행은 Electron **44.4.5**, Chromium **152.0.7977.130**, Electron Node **24.21.0**에서 수행했다. NSIS 설치 마법사를 실제로 설치·제거한 검증과는 구분한다.

이전 release 경로 실행 시각은 **2026-09-29 08:58:58–08:59:29 KST**다. 검사 도구 연결까지 모두 닫은 상태에서 테스트 호스트 PID **42428**, PowerShell PID **46892 / 45952**, boot ID 및 터미널 세대가 앱 재실행 뒤 동일했다. 살아 있는 셸의 변수도 다시 읽었다.

모바일 키보드 수정 뒤 데스크톱 입력·제어권 이전·셸 변수 유지·모바일 viewport 입력·브라우저 재접속에 회귀가 없음을 확인했다. **실제 휴대폰의 소프트 키보드 표시·OS IME 입력 성공을 의미하지 않는다. 실물 기기 재검증은 별도다.** 테스트는 `.test-data/desktop-e2e-pf7UFx`를 사용했으며 끝난 뒤 해당 테스트 프로세스가 없음을 확인했다. 실사용 호스트 **6400**과 셸 **14060**은 읽기 전용 프로세스 조회로 계속 실행 중임을 확인했다.

## 이전 release 경로에서 실행한 배포 파일 SHA-256

아래 파일은 실제 테스트 시작 시 읽어 해시를 계산했다. 같은 값은 `test-results/e2e/packaged/result.json`에도 남겼다. UI 자산은 현재 `index.html`이 참조하는 파일을 표에 기재했다. 결과 JSON에는 웹 갱신 후 폴더에 남아 있는 이전 JS·CSS 두 개의 해시도 포함되어 총 14개다.

| 파일 | SHA-256 |
|---|---|
| `MongleTerminal.exe` | `9e25539bc128370109fe9e9672acc7c12802ffd857122a7b36a9b48eef6f549b` |
| `resources/app.asar` | `b30f5cbb8b1b802b00e8551f470de5471f1999c40b749f0d87644719158bc106` |
| `resources/hostbundle/dist/host/main.cjs` | `58ffec7726abeb8069efdbb8ea241ab6f7c72901edb4afecdae2ca789efb08ee` |
| `resources/hostbundle/dist/web/index.html` | `d203bf9c945c5622481e202beeec8d37431b4ac315703b6f73ab3d62284ad02d` |
| `resources/hostbundle/dist/web/assets/index-C7YUgsao.js` | `1351edef71baa769b22a7f5819ac5dd9133d0db5da54b27e66823e2707653b77` |
| `resources/hostbundle/dist/web/assets/index-BRR_1aDN.css` | `3be81828a04e668d4e5f34ea120077ebb25abb36e01669a02763a1deed06e2aa` |
| `resources/hostbundle/platform/windows/OwnerPipe.exe` | `7858e6557310a124f4c35ae971cc4e12a39a785e7c14213a7061a5bdc61f4b27` |
| `resources/hostbundle/node_modules/node-pty/package.json` | `f8b6a14f7022c14f1cd5d109486f5dacd32bffb63a9a63e38eced37dacb47439` |
| `resources/hostbundle/node_modules/node-pty/lib/index.js` | `c1b82c92c4c63aaa8e8441fc5a291c4727cd3f3550666d2fec7250e0f6d4b173` |
| `resources/hostbundle/node_modules/node-pty/prebuilds/win32-x64/conpty.node` | `ee8f4e6f4dad71939eecfda11de249400e34bfefe4c8b48af13f3b5476f4035b` |
| `resources/hostbundle/node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll` | `7c7430632052ff703540b68371ec43821820aa1335d8e11dfbcd9ff00e9daaed` |
| `resources/hostbundle/node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe` | `d1fe7faa62f9e955e2ac2371f95d7e5513df4d496255097158f979c94782c5fc` |

## 실제 검증 범위

| 시나리오 | 확인한 증거 |
|---|---|
| 새 실행 및 그룹 생성 | 새 격리 데이터 폴더에서 앱이 독립 호스트를 시작하고, UI로 한글 이름 그룹과 PowerShell 생성 |
| 실제 셸 입력 | 키보드로 변수 저장과 `Write-Output` 입력. 출력 및 `$PID`가 호스트의 실제 셸 PID와 일치 |
| 분할 조작 | 두 개 셸, 좌우 분할, 키보드 크기 변경, 경계 더블 클릭 균등화, 최대화·복귀 |
| 그룹 전환 | 빈 그룹으로 이동했다가 돌아와 기존 두 터미널 연결 |
| 앱 종료·재실행 | 호스트 PID, 두 셸 PID, boot ID, 터미널 generation, 분할 트리 동일. 재실행 뒤 메모리의 PowerShell 변수를 실제 명령으로 다시 출력 |
| 모바일 브라우저 연결 | 390×844 터치 viewport의 Chrome에서 실제 HTTP 페어링 요청, 로컬 owner 승인, 쿠키 및 WebSocket 인증 |
| 모바일 제어 및 전환 | 한 패널 표시, 제어권 가져오기, 동일 PowerShell 변수 읽기. 데스크톱은 모바일 제어 상태로 변경. 두 패널 전환 시 데스크톱 분할 트리 보존 |
| 브라우저 재접속 | 새로 고침 뒤 기존 인증으로 같은 호스트에 재접속 |

검증용 데이터는 기본적으로 저장소의 `.test-data/desktop-e2e-*`에 생성한다. `MONGLE_E2E_DATA_ROOT`를 지정하면 그 부모 아래에 항상 새 고유 `desktop-e2e-*` 폴더를 생성한다. 사용자 기본 데이터를 쓰지 않는다. `finally`에서 테스트 Electron/Chrome을 닫고, 이 데이터 폴더의 owner RPC로 호스트를 종료하여 종료 여부를 확인한다. 최종 테스트는 앱 종료 전에 검사 도구의 owner 연결도 끊어 연결이 없는 상태에서 호스트가 유지되는지 확인한다.

## 캡처

실행 산출물은 Git에서 제외되는 `test-results/e2e/` 아래에 보관한다. 이전 배포본 산출물은 **`packaged/`**, 최신 새 캐릭터 패키지 산출물은 **`branding/`** 디렉터리에 별도로 남겼다.

- `desktop-split.png`: 그룹 목록과 두 실제 PowerShell 패널.
- `desktop-resumed.png`: 앱 재실행 뒤 `RESUMED:` 변수 출력.
- `mobile-terminal.png`: 모바일에서 같은 변수의 `MOBILE:` 출력, 제어 상태, 보조 키.
- `mobile-panel-switcher.png`: 모바일 터미널 전환 창.
- `result.json`, `console.json`: 검증 결과, PID/세대, 콘솔 기록.

개발 실행과 최종 배포본의 네 캡처를 각각 직접 확인했다. 데스크톱 그룹·패널과 모바일의 한 패널·보조 키·전환 창이 표시되며 주요 컨트롤이 화면 밖으로 밀리지 않았다. 셸 경로 줄바꿈은 실제 PowerShell 화면 출력으로 남는다.

## 발견 후 수정한 문제

1. 첫 실행 단계의 owner helper와 오래된 host 번들 계약이 달라 시작하지 못했다. 동일 소스로 전체 재빌드한 뒤 첫 실행이 정상화되었다.
2. 분할 경계의 단순 클릭도 저장되어 더블 클릭 균등화 요청과 충돌했다. UI 담당자가 실제 드래그 변화만 저장하고 레이아웃 변경을 순서대로 처리하도록 수정했고 실제 앱에서 재검증했다.
3. 초기 Electron CSP 경고와 연결 전에 보낸 초기 상태 요청 오류가 있었다. 수정 후 마지막 실제 실행에서 해당 경고와 오류는 관찰되지 않았다.
4. 작업 공간 내부에서 실행한 패키지는 상위 저장소의 `node_modules`를 통해 누락된 `node-pty`를 찾아 동작했다. 첫 E 드라이브 이동 검증에서는 `MODULE_NOT_FOUND: node-pty`로 실패했다. 스테이징에는 있던 `node_modules`가 배포 결과물에서 빠진 패키징 문제였다. 담당자가 배포 단계에서 native 패키지를 명시적으로 복사하고 포함·해석·로드 검사를 추가했다. E2E에도 패키지 내부 `node-pty`의 JS·ConPTY native 파일 존재를 미리 확인하는 검사를 추가했다. 수정본은 **개발 의존성에서 분리된 E 경로의 실제 실행에서 전체 통과**했다.

테스트 선택자와 초기 그룹 가정 때문에 발생한 중간 실패는 제품 오류로 분류하지 않았다. 모바일의 첫 선택 그룹은 클라이언트별로 기억하므로 테스트에서 해당 그룹을 명시적으로 선택한다.

## 재실행

Windows에서 `npm run build` 후 실행한다. 네이티브 GUI/프로세스 실행을 허용하는 환경이 필요하다.

```powershell
$env:MONGLE_E2E='1'
node --import tsx --test tests/e2e/desktop.test.ts
```

실행 파일이 준비된 배포 폴더를 검사할 때:

```powershell
$env:MONGLE_E2E='1'
$env:MONGLE_E2E_EXE='C:\path\to\win-unpacked\MongleTerminal.exe'
node --import tsx --test tests/e2e/desktop.test.ts
```

배포 실행 결과는 기본적으로 `test-results/e2e/packaged/`에 저장한다. 배포본의 owner helper 경로도 사용해 실제 배포 연결 검사를 유지한다.

새 캐릭터 패키지를 현재와 같은 설정으로 재검증할 때는 `E:\other_dev\mongle-terminal`에서 실행한다.

```powershell
$env:MONGLE_E2E='1'
$env:MONGLE_E2E_EXE='E:\other_dev\mongle-terminal\release-branding\win-unpacked\MongleTerminal.exe'
$env:MONGLE_E2E_REPORT='branding'
$env:MONGLE_E2E_BRANDING='1'
$env:MONGLE_E2E_DATA_ROOT=Join-Path $env:TEMP 'mongle-branding-e2e'
node --import tsx --test tests/e2e/desktop.test.ts
```

`MONGLE_E2E_REPORT`는 영문 소문자·숫자·하이픈으로 된 산출물 하위 폴더 이름이다. `MONGLE_E2E_BRANDING=1`은 사이드바 이미지 로드 검사와 아이콘 관련 캡처를 추가한다. `MONGLE_E2E_DATA_ROOT`는 새 임시 데이터 폴더의 부모만 지정하며 기존 데이터를 재사용하는 옵션이 아니다.

트레이 패키지 전용 검증과 동일 패키지 전체 회귀 검증:

```powershell
$env:MONGLE_E2E_EXE='E:\other_dev\mongle-terminal\release-tray\win-unpacked\MongleTerminal.exe'
$env:MONGLE_E2E_DATA_ROOT=Join-Path $env:TEMP 'mongle-tray-e2e'
$env:MONGLE_E2E_TRAY='1'
$env:MONGLE_E2E_REPORT='tray'
node --import tsx --test tests/e2e/desktop-tray.test.ts
$env:MONGLE_E2E='1'
$env:MONGLE_E2E_REPORT='tray-full'
node --import tsx --test tests/e2e/desktop.test.ts
```

전용 테스트는 매번 새 `desktop-tray-*`, 전체 테스트는 새 `desktop-e2e-*` 데이터 폴더를 만든다. 실제 사용자 데이터나 기존 호스트를 종료하지 않는다.

드래그 기능을 포함한 최신 배포 앱 전체 검증:

```powershell
$env:MONGLE_E2E='1'
$env:MONGLE_E2E_EXE='E:\other_dev\mongle-terminal\release-pane-drag\win-unpacked\MongleTerminal.exe'
$env:MONGLE_E2E_REPORT='pane-drag-full'
$env:MONGLE_E2E_BRANDING='1'
$env:MONGLE_E2E_PANE_DRAG='1'
$env:MONGLE_E2E_DATA_ROOT=Join-Path $env:TEMP 'mongle-pane-drag-e2e'
node --import tsx --test tests/e2e/desktop.test.ts
```

`MONGLE_E2E_PANE_DRAG=1`은 실제 배포 앱의 드래그 미리보기·배치·세션 유지 검사를 추가한다. 상세한 모든 드롭 방향·취소·입력 바이트 검사는 별도 `tests/ui/pane-drag.test.ts`가 담당한다.

## 아직 검증하지 않은 범위

실물 iPhone/Android, 실제 모바일 키보드·OS 한글 IME, Tailscale Serve HTTPS/WAN, 장시간 절전·연결 단절, 설치 마법사 및 OS 재부팅은 이 테스트의 검증 범위 밖이다. 모바일 캡처는 데스크톱 Chrome의 모바일 viewport이며 실제 휴대폰 캡처가 아니다. 브라우저는 로컬 loopback 인증 게이트웨이에 접속했다.
