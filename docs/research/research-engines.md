# Mongle Terminal: 터미널 엔진 조사

**권고(설계 판단): Electron 웹 UI와 node-pty·xterm/headless를 사용하는 독립 실행 Node 호스트를 함께 배포하는 구성이 Windows 우선 개발에 가장 직접적입니다. 재접속 정확성은 반드시 통과해야 할 검증 항목이며, serialize만으로 터미널 상태의 무손실 복원을 보장할 수 없습니다.**

조사 기준일: **2026-09-29**. 공식 문서와 주요 구현 소스를 확인했으며 설치·구현·실행 검증은 하지 않았습니다. 아래의 “확인된 사실”은 문서 또는 소스에서 확인한 내용이며, 제품 실행으로 검증한 동작을 뜻하지 않습니다. AI·채팅·에이전트 연동은 필요하지 않습니다.

## 1. 조사한 소스 기준과 라이선스

GitHub API로 다음 기본 브랜치의 최신 커밋을 확인한 뒤, 해당 커밋의 관련 파일을 직접 읽었습니다. 조사 출처를 고정하기 위한 커밋이며, **제품에 사용할 릴리스 버전을 선정한 것은 아닙니다.**

| 프로젝트 | 확인한 커밋·날짜(UTC) | 라이선스 근거 |
|---|---|---|
| xterm.js/headless/serialize | `c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2`, 8월 30일 | [소스의 MIT 표기](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/addons/addon-serialize/src/SerializeAddon.ts#L1-L5) |
| node-pty | `82090661786b95d3ad4fd1310c2631a4f9a92b39`, 9월 14일 | [매니페스트의 MIT 표기](https://github.com/microsoft/node-pty/blob/82090661786b95d3ad4fd1310c2631a4f9a92b39/package.json#L1-L8) |
| WezTerm/portable-pty | `b09b56c29c1e367e598b60ca266e2cc9038751e0`, 9월 17일 | [WezTerm MIT](https://github.com/wezterm/wezterm/blob/b09b56c29c1e367e598b60ca266e2cc9038751e0/LICENSE.md), [portable-pty MIT](https://github.com/wezterm/wezterm/blob/b09b56c29c1e367e598b60ca266e2cc9038751e0/pty/Cargo.toml#L1-L8) |
| Tabby | `4004cc51e95574658c96270322df8234d9d253ab`, 9월 24일 | [MIT 라이선스](https://github.com/Eugeny/tabby/blob/4004cc51e95574658c96270322df8234d9d253ab/LICENSE) |

배포 시 해당 저작권·라이선스 고지를 보존하고, 함께 제공하는 의존성·폰트·ConPTY 바이너리의 라이선스를 별도로 관리해야 합니다. 최상위 라이선스만으로 전체 배포물의 의무를 파악할 수는 없습니다.

## 2. 기반 기술 비교

| 후보 | 확인된 특성 | Mongle 설계에 미치는 영향(판단) |
|---|---|---|
| xterm.js + Node 호스트 | 브라우저용 터미널이며, headless Node 버전의 용도로 서버 측 상태 관리·재접속을 명시합니다. [공식 README](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/README.md) | 데스크톱과 모바일 웹이 렌더러·컴포넌트 코드를 공유할 수 있습니다. 접속자가 없어도 호스트가 모든 PTY를 소유해야 합니다. 그룹과 재귀 분할은 애플리케이션 데이터로 관리합니다. |
| Tauri + Rust portable-pty | Tauri는 OS WebView와 Rust 코어를 사용합니다. portable-pty는 네이티브 PTY I/O와 크기 변경을 제공합니다. [Tauri 프로세스 모델](https://v2.tauri.app/concept/process-model/), [Windows 구현](https://github.com/wezterm/wezterm/blob/b09b56c29c1e367e598b60ca266e2cc9038751e0/pty/src/win/conpty.rs#L1-L111) | 가능한 대안이지만 portable-pty 자체는 터미널 에뮬레이터나 재접속 엔진이 아닙니다. Rust 호스트에 에뮬레이터·호환 상태 전송 계층을 추가하거나, 별도의 JS 호스트가 필요합니다. Tauri나 Rust 선택만으로 세션 지속성이 생기지는 않습니다. |
| WezTerm mux | `DETACHED_PROCESS`로 다시 실행하는 네이티브 Windows 데몬화 코드가 있으며, mux는 GUI 없이 동작합니다. [소스](https://github.com/wezterm/wezterm/blob/b09b56c29c1e367e598b60ca266e2cc9038751e0/wezterm-mux-server/src/main.rs#L121-L169), [공식 mux 문서](https://wezterm.org/config/lua/wezterm.mux/index.html) | Unix 전용이 아니며 참고 구현·대체 백엔드로 검토할 가치가 있습니다. 다만 브라우저 연동 작업이 큽니다. 버전이 있는 바이너리 PDU로 pane·렌더링 변경·직렬화된 행을 교환하므로, 바로 연결할 WebSocket ANSI 스트림은 아닙니다. [Codec](https://github.com/wezterm/wezterm/blob/b09b56c29c1e367e598b60ca266e2cc9038751e0/codec/src/lib.rs#L442-L505), [렌더링 데이터](https://github.com/wezterm/wezterm/blob/b09b56c29c1e367e598b60ca266e2cc9038751e0/codec/src/lib.rs#L892-L985) |
| Tabby | `SplitContainer`의 중첩 자식·비율을 관리하며, 로컬 세션은 새 프로세스 생성 전에 PTY-ID 복원을 시도합니다. [분할 소스](https://github.com/Eugeny/tabby/blob/4004cc51e95574658c96270322df8234d9d253ab/tabby-core/src/components/splitTab.component.ts#L14-L122), [세션 소스](https://github.com/Eugeny/tabby/blob/4004cc51e95574658c96270322df8234d9d253ab/tabby-local/src/session.ts#L60-L143) | UI·프로필 설계 참고에 유용합니다. 이 메서드만으로 애플리케이션을 완전히 종료한 뒤에도 세션이 유지된다고 판단할 수 없습니다. “탭 기억”을 실행 중인 프로세스의 생존 근거로 해석해서는 안 됩니다. |

**소유권 설계 제안:** 독립 호스트가 PTY, 에뮬레이터 상태, 세션 ID, 크기, 출력 순서, 조작권 임대(controller lease), 레이아웃 기록을 소유합니다. 데스크톱/PWA는 다시 연결할 수 있는 클라이언트입니다. 창을 닫으면 연결만 해제하고, 명시적인 세션 종료 시 PTY를 닫습니다. 재부팅·호스트 충돌·사용자 로그오프는 별도의 지속성 경계이며, 그 이후까지 살아 있는 세션을 복구한다고 약속하지 않습니다.

지원되는 Node 런타임을 함께 배포하고, 고정한 ABI·아키텍처에 맞춰 node-pty를 빌드합니다. node-pty는 Electron의 런타임 의존성에서 분리합니다. Electron 공식 문서는 네이티브 모듈에 일반 Node와 다른 ABI가 필요하다고 설명합니다. [Electron 네이티브 모듈 안내](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules). 별도 런타임은 이 경계를 단순화하지만 패키징·업데이트·아키텍처·수명 주기 검증을 없애지는 않습니다. 사용자별 데몬, 독립 IPC, 준비 완료 핸드셰이크를 사용합니다. GUI가 소유하는 utility process나 상속한 stdio 연결만으로 지속성을 보장할 수 없습니다. Node 문서의 detached/unref 및 stdio 조건도 실제 Windows 배포 패키지에서 검증해야 합니다. [Node 자식 프로세스 문서](https://nodejs.org/api/child_process.html#optionsdetached)

## 3. 재생 정확성: 확인된 한계와 필요한 설계

**확인된 사실:** serialize는 normal buffer, 활성 alternate buffer, 커서·스타일, 일부 모드, 스크롤 영역을 재구성합니다. 내부 비공개 API에 접근하며 combined-data 관련 TODO가 남아 있습니다. 파서의 이어서 처리할 상태나 모든 모드를 직렬화하지는 않습니다. 현재 코어에는 serializer의 모드 목록에 없는 Win32 input·Kitty keyboard 상태가 있습니다. [Serializer](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/addons/addon-serialize/src/SerializeAddon.ts#L433-L569), [코어 모드](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/src/common/services/CoreService.ts#L15-L35). 공식 API는 원래 크기로 복원한 뒤 필요한 크기로 변경하도록 권장합니다. [API](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/addons/addon-serialize/typings/addon-serialize.d.ts#L22-L29)

**핵심 추론:** write 콜백은 해당 청크를 처리했다는 뜻이며, 터미널 제어 시퀀스가 끝났다는 뜻은 아닙니다. 파서 상태와 파라미터는 다음 호출까지 유지됩니다. `ESC [` 직후 스냅샷을 만들고 이후의 `31m`을 실시간으로 전달하면, 대기 중이던 접두사가 없는 새 클라이언트는 다른 결과를 낼 수 있습니다. OSC/DCS/APC 페이로드와 스트리밍 디코더 상태에도 유사한 위험이 있습니다. [파서 필드](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/src/common/parser/EscapeSequenceParser.ts#L263-L297), [인코딩 규약](https://xtermjs.org/docs/guides/encoding/)

**확인된 응답 위험:** DSR은 `onData` 응답을 생성합니다. headless와 브라우저는 공통 코어를 상속합니다. 공개 `onData`에는 문자열만 전달되며 내부의 `wasUserInput` 정보는 빠집니다. `disableStdin`은 자동 응답과 사용자 입력을 모두 억제합니다. 따라서 각 클라이언트의 `onData`와 headless의 `onData`를 모두 PTY로 보내면 응답이 중복됩니다. [DSR](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/src/common/InputHandler.ts#L2743-L2768), [이벤트 전달](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/src/common/services/CoreService.ts#L74-L103)

**아래는 해결된 구현이 아니라 검증해야 할 설계 항목입니다.**

1. 호스트를 유일한 자동 응답 주체로 정합니다. IME·마우스·붙여넣기·포커스·키보드 프로토콜을 망가뜨리지 않으면서 렌더러의 자동 응답만 억제할 수 있는지 증명해야 합니다. `onData`를 정규식으로 거르는 것으로는 입력 출처를 정확히 구분할 수 없습니다. headless에는 브라우저 전용 색상·창 리스너가 없으므로 지원할 질의와 호스트의 테마·크기 응답을 명시해야 합니다. [Headless 초기화](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/src/headless/Terminal.ts#L42-L57), [브라우저 리스너](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/src/browser/CoreBrowserTerminal.ts#L184-L194)
2. session epoch와 단조 증가하는 출력·이벤트 순번을 사용합니다. 스냅샷과 대기 중인 후속 데이터의 경계를 원자적으로 확정하고, 원래 크기와 순서가 있는 resize 이벤트를 포함합니다. 버전·옵션·Unicode provider가 일치하는 새 에뮬레이터에 복원한 뒤 후속 데이터를 한 번만 적용합니다. 이 경계가 정확해도 serializer의 상태 누락까지 해결되지는 않습니다.
3. 어떤 상태까지 복원할지 명시하고 검증합니다. 완전한 체크포인트 기능을 유지보수하거나, 자동 응답·과거 이벤트의 부수 효과를 억제한 상태로 전체 출력·resize 저널을 재생하는 방안을 검토합니다. 전체 재생에는 저장 공간·지연 비용이 있습니다. 일반적으로 “최근 N바이트”만으로 터미널을 재구성할 수 없습니다. 파서에 안전한 경계만으로는 빠진 모드를 복원하지 못합니다. 임의의 TUI를 정확히 복원한다고 주장하기 전에 지원할 제어 시퀀스 범위를 정해야 합니다.
4. PTY→headless 흐름 제어를 관찰자 큐와 분리합니다. 호스트의 high/low watermark는 호스트 파서를 보호하고, 느리거나 오프라인인 관찰자는 용량이 제한된 큐와 재동기화로 처리합니다. 이 때문에 PTY를 무기한 중단시키지 않도록 합니다. xterm 쓰기는 비동기이며, 전송 ACK를 통한 진행량 추적은 애플리케이션이 구현해야 합니다. [흐름 제어 안내](https://xtermjs.org/docs/guides/flowcontrol/)

## 4. Windows 관련 근거와 필수 검증 항목

node-pty는 ConPTY와 `CreateProcessW`를 사용하며, Windows agent가 출력 worker·5초 연결 타임아웃·종료 정리를 조정합니다. 시스템 ConPTY 경로의 kill은 콘솔 PID 정리를 시도하지만, 분리된 모든 자손 프로세스가 종료된다는 증거는 아닙니다. 여러 Node worker thread에서 PTY API를 사용하는 것은 안전하지 않다고 명시되어 있습니다. [네이티브 소스](https://github.com/microsoft/node-pty/blob/82090661786b95d3ad4fd1310c2631a4f9a92b39/src/win/conpty.cc), [Windows agent](https://github.com/microsoft/node-pty/blob/82090661786b95d3ad4fd1310c2631a4f9a92b39/src/windowsPtyAgent.ts#L185-L270), [README](https://github.com/microsoft/node-pty/blob/82090661786b95d3ad4fd1310c2631a4f9a92b39/README.md#L117-L123)

portable-pty는 `Arc<Mutex<_>>`로 Windows 핸들을 공유합니다. `PseudoCon::drop`은 ConPTY를 닫고, 자식 프로세스의 kill은 해당 프로세스 핸들에 `TerminateProcess`를 호출합니다. Rust 소유권만으로 교착 없는 종료나 전체 프로세스 트리 종료를 보장할 수는 없습니다. [Drop/resize](https://github.com/wezterm/wezterm/blob/b09b56c29c1e367e598b60ca266e2cc9038751e0/pty/src/win/pseudocon.rs#L71-L106), [자식 프로세스 kill](https://github.com/wezterm/wezterm/blob/b09b56c29c1e367e598b60ca266e2cc9038751e0/pty/src/win/mod.rs#L40-L74)

Microsoft는 ConPTY 종료 시 출력 파이프를 계속 읽어 비우거나 닫도록 요구합니다. Windows 11 24H2 이전에는 `ClosePseudoConsole`이 무기한 대기할 수 있으며, 24H2부터는 즉시 반환합니다. EOF까지 읽는 것은 별도의 종료 완료 신호입니다. [Microsoft 종료 규약](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole). Resize는 문자 셀 단위로 콘솔 크기를 바꾸므로, 데스크톱·모바일의 fit 이벤트가 경쟁하지 않도록 크기 결정 주체를 하나로 정해야 합니다. [Resize 규약](https://learn.microsoft.com/en-us/windows/console/resizepseudoconsole)

**아직 실행 검증하지 않은 출시 조건:** PowerShell 5.1·설치된 PowerShell 7·CMD, 설치된 WSL 배포판·Git Bash, 공백·Unicode 경로와 argv, GUI 종료·충돌·재실행 후 동일 PID의 생존, 대량 출력 중 호스트 종료, 지원할 가장 오래된 Windows와 24H2 이상 비교, 전체 화면 앱의 빠른 크기 변경, 두 클라이언트 접속 시 DSR 응답이 정확히 한 번만 전달되는지, UTF·제어 시퀀스의 각 분할 위치에서 연결 끊김, alternate-screen 복귀·저장 커서·하이퍼링크·스크롤 영역·키보드 모드·스크롤백, 한글 조합·백스페이스·CJK/emoji 폭·모바일 키보드·크기 변경 중 IME입니다. xterm에는 textarea·composition 전용 처리가 있지만 소스에 기능이 있다는 사실만으로 호환성을 보장할 수는 없습니다. [Composition 연결 코드](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/src/browser/CoreBrowserTerminal.ts#L414-L429)

Tailscale은 원격 클라이언트의 전송 경계로 제안한 기술이며, PTY 소유권·재생 정확성·조작권 중재·애플리케이션 인증을 대체하지 않습니다. 모바일에서 그룹·pane을 탐색할 때는 기존 세션을 선택해야 하며, 셸을 다시 만들거나 관찰자가 접속할 때마다 전체 세션의 크기를 강제로 바꾸지 않아야 합니다.
