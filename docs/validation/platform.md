# Windows 데스크톱과 배포 검증

검증일: 2026-09-29. Windows 11 x64 (10.0.26200), Node 24.18.0, Electron 44.4.5.

## 구현

- Electron 창은 번들된 로컬 HTML만 연다. sandbox/contextIsolation을 켜고 Node integration·웹뷰·팝업·외부 탐색·기본 권한을 차단했다. preload는 고정 RPC/컴퓨터 목록/연결 상태만 노출한다. main은 호출 창과 최상위 frame의 정확한 파일 URL을 확인한다.
- 현재 컴퓨터는 SID 제한 named pipe로 연결한다. 원격 컴퓨터는 등록한 Tailscale HTTPS origin만 허용하고, 컴퓨터별 Electron session partition의 HttpOnly cookie와 Chromium 네트워크/WebSocket을 사용한다. health에서 설치 ID를 확인한 후 자격 증명을 전송한다. 다른 설치 ID로 바뀌면 연결하지 않는다.
- GUI와 독립된 번들 Node가 실제 호스트를 실행한다. Node native addon은 Electron ABI로 다시 빌드하지 않는다. Electron의 `ELECTRON_RUN_AS_NODE`나 사용자의 전역 Node 설치에 의존하지 않는다.
- `HostLauncher.exe`는 `CreateProcess`의 DETACHED_PROCESS·CREATE_NEW_PROCESS_GROUP과 필요한 경우 CREATE_BREAKAWAY_FROM_JOB을 사용한다. 부모 Job이 breakaway를 금지하면 `Win32_Process.Create`에 CREATE_BREAKAWAY_FROM_JOB을 지정한다. 셸 문자열 조합·상주 예약 작업·관리자 권한 상승은 사용하지 않는다.
- GUI 종료는 클라이언트만 연결 해제한다. 명시적 `host.shutdown`은 호스트 종료 후 자동 재시작을 보류한다. 현재 컴퓨터를 다시 선택해야 시작한다.
- 설치/제거는 기본 데이터 폴더의 `host-info.json`이 있으면 차단한다. 실행 중인 호스트 또는 비정상 종료 흔적을 보수적으로 취급하여 기존 앱에서 명시적으로 호스트를 종료한 뒤 설치하도록 안내한다. 프로세스를 강제로 종료하거나 사용자 데이터를 삭제하지 않는다.

## 실제 검증

`node --import tsx --test tests/platform/lifecycle.test.ts`: **3/3 통과**.

1. 원격 URL의 HTTP·임의 사이트·사용자명/암호·경로·query를 거부하고, 등록된 설치 ID가 바뀌면 연결을 거부한다. 저장한 컴퓨터 선택과 설치 ID를 다시 읽는다.
2. 번들 Node의 시험 호스트를 독립 런처로 시작한 뒤 런처가 끝나도 동일 PID의 heartbeat가 계속 증가한다.
3. 런처를 KILL_ON_JOB_CLOSE가 설정된 Windows Job에 넣고 종료 시 Job handle을 닫아도 시험 호스트의 동일 PID와 heartbeat가 유지된다.

세 번째 시험의 WMI API는 Codex 제한 샌드박스에서 접근 거부되었다. 테스트 실행만 일반 사용자 컨텍스트로 승인받아 재실행했고 통과했다. 관리자 권한 상승은 사용하지 않았다. 시험은 매번 생성한 임시 폴더와 해당 시험 PID만 사용하며 끝나면 정리한다. 이 결과는 모든 기업의 WMI 정책에서 작동한다는 보장이 아니다. WMI가 정책상 차단된 환경에서 직접 breakaway도 불가능하면 시작 오류로 표시한다.

`tsc --noEmit`: 전체 코드에 대해 오류 0 확인(2026-09-29).

`node --import tsx scripts/package.ts --dir`: **성공**, `release/win-unpacked/MongleTerminal.exe`와 `resources/hostbundle/` 생성 확인. Electron 배포 파일은 이미 설치된 정확한 44.4.5 배포 디렉터리를 사용했다.

최종 `node --import tsx scripts/package.ts`: **NSIS·ZIP 생성 성공**. 브랜드 아이콘 및 EXE의 ProductName=`Mongle Terminal`, ProductVersion=`0.1.0.0` 확인. 번들의 Node·OwnerPipe·HostLauncher·ICO·host JS·웹 HTML은 빌드 원본과 SHA-256이 모두 같았다. 라이선스 원문과 사용자 안내를 포함한 `docs/`도 배포한다.

다음 표는 아이콘 변경 이전 스크롤 수정 배포물이다. 새 브랜드 배포물은 아래 「몽글 브랜드 아이콘」에 별도로 기록한다.

| 산출물 | 바이트 | SHA-256 |
|---|---:|---|
| `MongleTerminal-Setup-0.1.0-x64.exe` | 146858727 | `93a642a677e4e4779e95e6233dc60fabaa702888dcd3f691d73d9437ca9c9ff1` |
| `MongleTerminal-0.1.0-x64.zip` | 204684481 | `3fda04bdbcdab6db832bd564b15adf938c61966b08b8522028d9a115b57093ce` |
| `win-unpacked/MongleTerminal.exe` | 246033408 | `9e25539bc128370109fe9e9672acc7c12802ffd857122a7b36a9b48eef6f549b` |

위 해시는 모바일 PowerShell 출력 기록의 한 손가락 스크롤과 새 출력 도착 시 읽던 위치 유지 수정을 포함한 최신 배포물이다. 여러 손가락 확대는 브라우저 동작으로 유지한다. 최종 웹 자산은 `index-IolZCipf.js` / `index-8RvfpKoF.css`다. 최종 `node --import tsx scripts/package.ts`는 종료 코드 0으로 완료됐다. 빌드 원본과 배포 폴더의 HTML·JS·CSS는 SHA-256이 모두 같았고, 번들 모듈 해석과 native 로드 검사도 통과했다. ZIP 중앙 디렉터리의 520개 항목에서도 필수 native 7파일을 확인했다. 전체 체크섬은 `release/SHA256SUMS.txt`에 기록했다. 재패키징은 C 작업공간에서만 수행했으며, 이 담당 작업에서 E 실행 폴더·실행 중인 호스트·셸·Tailscale Serve는 변경하지 않았다.

이번 스크롤 수정은 실제 Chrome CDP 터치 입력 검사 **4/4**, 기존 터미널 검사 **18/18**, 모바일 키보드·표시 UI 검사 **5/5**와 타입 검사·웹 빌드를 통과했다. 보기 전용 상태의 기록 이동에 셸 입력이 발생하지 않고, 추가 출력과 화면 복원 뒤에도 읽던 줄이 유지되며, 편집 포커스·한국어 입력·두 손가락 확대가 유지되는 것을 확인했다. 이 자동화 검사는 데스크톱 Chrome의 모바일 에뮬레이션 결과다. 이후 별도 웹 배포와 새로고침 후 **사용자가 실제 Android Samsung Internet에서 “스크롤 잘 됨”을 확인**했다. 근거는 [mobile-scroll.md](mobile-scroll.md)와 `test-results/mobile-scroll/result.md`다.

이전 표시 설정 회귀 검사는 **4/4 통과(상위 1개·하위 3개, 13.59초)**했고, 실제 글자 크기 10 렌더링과 ACK를 확인했다. 증거와 화면 캡처는 `test-results/mobile-display/`에 저장했다. 기존 모바일 키보드·설정 검사 2개와 실제 호스트 UI 검사 1개, 당시 전체 타입 검사도 통과했다. 별도 배포 담당자는 실행 중인 E 호스트 PID 6400과 셸 PID 14060을 유지하면서 표시 설정 웹 자산을 적용했고, HTTPS로 제공되는 자산의 SHA-256 일치를 확인했다고 보고했다. **사용자가 실제 Android 기기의 Samsung Internet에서 키보드가 작동함을 확인했다.** 키보드와 새 스크롤은 각각의 사용자 확인 결과로 기록한다.

이전 모바일 키보드 수정본의 전체 E2E는 30.72초에 통과했다. 이는 실행 중인 E 호스트를 유지한 키보드 수정 검증 기준이며, 이후 표시 설정·스크롤 수정을 포함한 최신 배포물 전체 E2E 또는 새 NSIS 설치·제거 결과로 해석하지 않는다.

첫 C 작업공간 내부의 배포 EXE 시험은 통과했지만, E 드라이브로 옮긴 시험에서 `node-pty` 누락을 발견했다. 개발 폴더의 상위 `node_modules`를 찾던 경로가 문제를 가렸으므로 **이전 C 시험을 배포 독립성의 근거로 사용하지 않는다.** `afterPack`에서 native 의존성을 명시적으로 복사하고, 배포 폴더 내부의 모듈 해석·필수 7파일·번들 Node의 native 모듈 로드를 필수 검사로 추가했다. ZIP 중앙 디렉터리에서도 517개 항목 중 필수 7파일을 확인했다.

native 누락을 수정한 배포본을 개발 의존성이 없는 **`E:\other_dev\mongle-terminal\release\win-unpacked\MongleTerminal.exe`에서 실행한 전체 E2E가 23.75초에 통과**했다. 이 검증은 위 모바일 키보드 재패키징 이전 결과다. 창 종료 후 호스트/셸 PID·세대·배치·셸 변수가 그대로 유지되고, 승인한 모바일 Chrome 화면에서 같은 세션을 제어하고 다시 연결하는 흐름을 확인했다. 증거는 저장소의 `test-results/e2e/packaged/result.json`과 화면 캡처다. 모바일은 데스크톱 Chromium의 모바일 화면 크기를 사용했으며 실물 휴대폰 테스트가 아니다.

`node --import tsx --test tests/platform/remote-transport.test.ts`: **1/1 통과**. 격리된 Electron 프로필과 임시 localhost HTTPS 서버에서 페어링, Secure/HttpOnly/SameSite cookie 유지, CSRF 헤더, Chromium WebSocket의 origin/cookie, RPC를 실제 실행했다. 설치 ID 변경 시 cookie 없이 health만 요청하고 인증된 요청을 중단하는 것도 확인했다. 시험 세션에만 생성한 localhost 인증서를 허용했으며 제품 코드에는 인증서 예외가 없다. 이 검사는 Tailscale나 실물 다른 기기의 네트워크 검증을 대신하지 않는다.

named pipe의 HMAC 상호 인증·SID ACL·동시 시작·경계 크기 검증은 [local-ipc.md](local-ipc.md)에 별도 기록한다. 실제 Electron UI와 PTY를 함께 사용하는 재접속 검증은 E2E 결과를 참조한다.

## 몽글 브랜드 아이콘

2026-09-29, 작업 위치를 `E:\other_dev\mongle-terminal`로 옮겨 확정한 캐릭터 PNG에서 Windows 아이콘을 생성했다. `apps/web/public/mongle-terminal-icon.png`가 공통 원본이며, `IconBuilder`가 16·24·32·48·64·128·256px PNG 프레임을 담은 ICO와 웹용 32·192·512px PNG를 만든다. 원본 교체 시 시간 정보만 보고 오래된 아이콘을 재사용하지 않는다.

Electron 창 아이콘과 EXE 아이콘은 같은 ICO를 사용하고, 작업 표시줄의 AppUserModelID는 설치 설정과 같은 `dev.mongle.terminal`이다. NSIS는 `몽글터미널` 바탕화면·시작 메뉴 바로가기를 생성하도록 설정했으며, 바로가기 아이콘은 새 EXE의 아이콘을 사용한다. 설치 파일과 제거 프로그램 아이콘도 같은 ICO를 지정했다. 이는 설치 설정 검증이며 실제 설치 마법사를 실행한 결과가 아니다.

`node --import tsx scripts/package.ts --output release-branding`은 **종료 코드 0**으로 완료됐다. 별도 출력·스테이징 폴더에서 생성하여 패키징 중에는 기존 실행 중인 `release/win-unpacked`를 변경하지 않았다. 패키징 완료 당시 기존 GUI PID 15484·호스트 PID 6400·셸 PID 14060의 시작 시각과 생존 상태, 기존 EXE 해시가 유지됐다. 이후 GUI 파일과 웹 자산만 선별 교체하고 새 창 PID 44424를 열었다. 실제 창 아이콘, 바탕화면·시작 메뉴 바로가기, HTTPS 자산과 기존 호스트·셸 보존 확인은 [브랜드 적용 검증](branding.md)에 기록했다.

아이콘 검사는 **9/9 통과**했다. 새 EXE의 `RT_GROUP_ICON` 1개와 `RT_ICON` 7개의 이미지 바이트가 ICO와 모두 일치하며, 기존 EXE가 새 ICO와 다르다는 것도 검출했다. PE32·PE32+·리소스 경계 오류 회귀를 포함하며 EXE를 실행하지 않고 읽기 전용으로 검사했다. 전체 타입 검사도 통과했다. 근거는 `test-results/branding/windows-icon.json`이다. 기존 native 모듈 로드 검사와 ZIP 531개 항목의 필수 native 7파일 검사도 통과했다.

| `release-branding/` 산출물 | 바이트 | SHA-256 |
|---|---:|---|
| `MongleTerminal-Setup-0.1.0-x64.exe` | 149029527 | `e7a123be76040932b9ba7e53e1094bc43708c67111e166336a570945a46aec10` |
| `MongleTerminal-0.1.0-x64.zip` | 206505330 | `aa60891d17a410473c9f195dc758b0ab98658211a3455f43728403f7aba06961` |
| `win-unpacked/MongleTerminal.exe` | 246119424 | `88abac444d3ee00eb93e9298521306f0363fb2f9adcd295249aaa6630ea02bf3` |

전체 체크섬은 `release-branding/SHA256SUMS.txt`에 기록했다. ICO SHA-256은 `08971c8f9233a411c8aa58d4d167878e8001a09ad58b9efbe2589a3326df9ec4`다. 이번 변경의 웹 자산은 `index-M52kDaxX.js` / `index-_XnxQp6I.css`다.

## 배포 주의 및 남은 검증

트레이 기능을 추가한 최신 배포물은 `release-tray`에서 생성 후 `release`에 반영했다. 현재 앱의 EXE·app.asar만 선별 교체했으며, 최신 체크섬·전용 E2E·Windows 트레이 등록·실사용 세션 유지 결과는 [트레이 검증](tray.md)을 참조한다. 위 브랜드 전용 패키지 해시는 해당 시점의 기록이다.

- 현재 Windows 설치 파일은 코드 서명되지 않았다. SmartScreen 신뢰·공개 배포용 코드 서명은 완료한 것으로 표시하지 않는다.
- 로그인 시 자동 시작, 무중단 호스트 업데이트, 로그인 전 Windows service는 구현하지 않았다.
- NSIS installer와 ZIP은 실제 생성에 성공했다. 모바일 표시·스크롤·캐릭터 아이콘·트레이를 포함한 최신 배포본의 전체 E2E는 23.51초에 통과했다. NSIS 설치·제거 동작 자체는 아직 실행하지 않았다.
- 기본 데이터 위치 이외의 개발용 `MONGLE_DATA_DIR`는 NSIS 설치 차단 검사의 대상이 아니다. 배포 앱은 기본 위치를 사용한다.
- 실제 Android Samsung Internet의 키보드와 새 스크롤 작동은 사용자가 확인했다. iPhone·다른 PC·네트워크 변화 검증은 남아 있다.

## 근거

- [Electron stable 릴리스](https://releases.electronjs.org/release?channel=stable)
- [Electron Session API](https://www.electronjs.org/docs/latest/api/session)
- [Electron WebSocket API](https://www.electronjs.org/docs/latest/api/web-socket)
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Win32_Process.Create](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/create-method-in-class-win32-process)
- [Win32_ProcessStartup flags](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-processstartup)
