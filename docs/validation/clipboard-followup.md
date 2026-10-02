# 클립보드 실패 후속 수정

기준일: 2026-10-03. 소스 버전은 **0.3.8 + 미배포 수정**이다. 공개 배포나 실사용 설치본 교체를 뜻하지 않는다.

## 확인한 원인

실제 Windows `OpenClipboard(NULL)` 호출이 반복해서 `false`, `GetLastError() = 5`(접근 거부)를 반환했다. 이 진단은 클립보드 본문을 읽거나 변경하지 않았다. 기본 도구 실행과 `require_escalated` 실행에서 모두 동일했다. 기본 실행의 desktop은 Codex 격리 desktop, 후자는 Default였지만 후자의 토큰도 `TokenHasRestrictions=1`이었다. `WinSta0`, session 1, 패키지 identity 없음, AppContainer 아님을 확인했다. 어떤 restricted SID/ACL 항목이 거부했는지까지 확인한 것은 아니다.

Windows는 클립보드 사용에 `WINSTA_ACCESSCLIPBOARD`를 요구한다. [Microsoft 권한 문서](https://learn.microsoft.com/en-us/windows/win32/winstation/window-station-security-and-access-rights). 앱의 선택 처리 이전에도 동일한 접근 실패가 있으므로, 이전에 미확정으로 남긴 시험 실패는 이 실행 환경의 네이티브 접근 실패와 구분할 수 있다. 권한·ACL·토큰 변경이나 다른 데스크톱을 통한 우회는 하지 않았다.

Electron 44.4.5의 `writeText`는 Chromium writer 사용 뒤 Promise를 resolve한다. Chromium 152.0.7977.130의 Windows backend는 클립보드를 열지 못하면 쓰기를 중단하면서 상위에 오류를 전달하지 않는다. 따라서 앱에서 `await writeText`가 끝났다는 사실만으로 복사 완료를 표시하던 것은 별도의 제품 결함이다. [고정 Electron 소스](https://raw.githubusercontent.com/electron/electron/v44.4.5/shell/browser/api/electron_api_clipboard.cc), [고정 Chromium 소스](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.130/ui/base/clipboard/clipboard_win.cc).

## 제품 변경

- 데스크톱 IPC는 쓰기 직후 텍스트를 읽어 정확히 일치하는지 확인한다. 앱 자체의 연속 쓰기와 확인은 순서대로 처리한다. 실패해도 다음 사용자의 복사 시도는 진행한다.
- 불일치할 때 자동으로 다시 쓰지 않는다. 그 사이 사용자가 다른 앱에서 복사한 내용을 덮어쓰지 않으며, 확인을 위해 읽은 본문도 main 프로세스 밖이나 로그로 보내지 않는다.
- 새 복사를 시작하면 이전 성공 표시를 지우고, 가장 최근 복사만 피드백을 갱신한다. 실패를 성공으로 보이게 하는 늦은 응답도 차단한다.
- 설정의 접속 주소·연결 코드 복사가 브라우저 API를 직접 호출하던 경로를 데스크톱 IPC에 연결한다. 데스크톱의 기존 브라우저 권한 거부 정책과 신뢰한 main frame 검사, 16 MiB 텍스트 제한, OSC 52 차단은 유지한다.

설정에서 네이티브 또는 브라우저 복사가 실패하면 주소·코드를 직접 선택해 복사하라는 한국어 안내를 보여준다. Electron의 내부 IPC 오류 문구는 표시하지 않는다.

Mobbin 공개 [Toast UI](https://mobbin.com/glossary/toast)의 성공 확인과 오류 안내 사례 설명을 직접 읽고 비교했다. 기존 성공·오류 스타일을 유지하면서 성공을 표시할 조건과 이전 표시의 수명을 바로잡았다. 유료 앱 갤러리나 접근하지 못한 개별 이미지 사례를 확인한 것으로 간주하지 않는다.

## 시험 보호 보완

`clipboard.read()`가 반환하는 항목은 지연 읽기 객체이며 그대로 `clipboard.write()`에 넣을 수 없다. 기존 E2E의 복원 코드는 이 제약 때문에 정상 환경에서 실패할 수 있었다. [Electron ClipboardItem 구현](https://raw.githubusercontent.com/electron/electron/v44.4.5/lib/browser/api/clipboard-item.ts).

이제 쓰기 전에 모든 형식을 메모리에 읽고 새 ClipboardItem으로 보관한다. 빈 클립보드는 빈 배열로 보관하며, 백업 실패 시 쓰기를 시작하지 않는다. 시험 문자열이 그대로 남았을 때만 복원하고, 복원 실패를 정리 오류로 기록한다. 실제 본문은 파일·로그·시험 결과에 저장하지 않는다.

E2E는 TEMP 아래의 격리 경로를 검사하고 cmd와 시험용 폴더를 사용한다. 앱 시작부터 정리 구문 안에서 실행하고, 화면에 문제가 있어도 격리 OwnerPipe를 통해 정상 종료한다. 정리할 호스트 identity와 PID를 확인하며 정리를 검증하지 못한 경우 성공으로 기록하지 않는다.

## 검증 경계

| 실행한 검사 | 결과 |
|---|---|
| 전체 회귀 `npx.cmd tsx --test --test-concurrency=1 tests/**/*.test.ts` | **372개, 357 통과, 실패 0, 선택 실행 15 생략**, 약 400.1초. 격리 데이터, Windows Job 지원을 위한 `require_escalated` 실행. |
| 클립보드 writer 단위 검사 | **4/4 통과**. 조용한 실패, 읽기 실패 후 복구, Unicode·여러 줄, 연속 요청 순서. 전체 회귀에도 포함. |
| 실제 Chrome의 TerminalPane·Settings | **7/7 통과**. 선택 복사와 중첩 피드백, 설정의 native/browser 성공·실패·미지원. 클립보드와 호스트 응답은 테스트 더블. 전체 회귀에도 포함. |
| 최종 패키지 접근 거부 E2E | **1/1 통과**, 7.81초. 실제 OwnerPipe·cmd·ConPTY·Electron IPC·Windows 접근 거부. 선택 자동복사·Ctrl+C·설정 접속 주소·연결 코드의 오류 안내와 성공 표시 부재. 화면 오류 0, 앱·호스트·셸·시험 Node 정상 종료. |
| 정상 네이티브 복사·붙여넣기 E2E | **사전검사 실패**, Windows 오류 5. 앱 시작·클립보드 변경 전에 중단. |
| 타입·빌드·패키지·배포 문서 | 통과. `release-quality-pass/win-unpacked`를 재생성하고 동봉 Node 24.18.0 네이티브 로드·외부 의존성 격리·7종 아이콘 확인. 버전은 0.3.8 유지. |

Settings 오류 문구를 마지막으로 조정한 뒤 해당 소스 UI 검사와 타입 검사를 다시 통과했다. 최종 패키지의 실제 설정 버튼도 위 E2E에 포함했다. 첫 설정 E2E 확장 시 시험용 주소가 기존 `.ts.net` 검증에 막혔으며, 시험 주소를 올바른 형식으로 바꾼 뒤 통과했다. 제품의 주소 검증은 변경하지 않았다. 시험 호스트 DB에 가상 주소를 잠시 등록했을 뿐 실제 Tailscale Serve나 외부 연결은 변경하지 않았다.

원시 로그는 `test-results/clipboard-followup-{regression,package,denied,native}.log`, 실제 패키지 결과는 `test-results/e2e/clipboard-denied/result.json` 및 `test-results/e2e/clipboard/result.json`이다. `denied`의 성공을 정상 복사 성공으로 읽지 않는다. 공개 배포·설치·실사용 사용자 확인은 수행하지 않았다.

일반 네이티브 복사·붙여넣기 검사는 `OpenClipboard` 읽기 전용 사전검사부터 시작한다. 접근하지 못하면 원인을 기록하고 실패한다. 이를 생략 처리하거나 성공으로 바꾸지 않는다.

별도 `MONGLE_E2E_CLIPBOARD_DENIED=1` 검사는 실제 접근 거부 환경에서 선택 자동복사·Ctrl+C가 오류를 안내하고 성공 표시와 셸 중단 입력을 만들지 않는지 검사한다. 정상 복사·붙여넣기 성공 검증과 별개다.

현재 환경에서는 정상 클립보드 접근이 허용되지 않으므로 최신 패키지의 실제 Windows 복사·붙여넣기 **성공 경로를 완료로 표시하지 않는다**. 일반 Windows 터미널에서 아래 명령으로 같은 검사를 재실행할 수 있다. 앱·시험 호스트는 별도 프로필을 사용하고 실제 Tailscale 설정을 변경하지 않는다.

```powershell
Set-Location E:\other_dev\mongle-terminal
$env:MONGLE_E2E_DATA_ROOT = Join-Path $env:TEMP 'mongle-clipboard-verification'
$env:MONGLE_E2E_EXE = Join-Path (Get-Location) 'release-quality-pass\win-unpacked\MongleTerminal.exe'
$env:MONGLE_E2E_CLIPBOARD = '1'
Remove-Item Env:MONGLE_E2E_CLIPBOARD_DENIED -ErrorAction SilentlyContinue
node --import tsx --test tests/e2e/clipboard.test.ts
```

원시 접근 진단은 `test-results/clipboard-access-metadata.json`에 있으며 Git에는 포함하지 않는다.
