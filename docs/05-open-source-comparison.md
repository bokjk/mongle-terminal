# 몽글터미널 — 오픈소스 비교와 적용 판단

조사일: 2026-09-29 · 범위: 공식 문서, LICENSE, 대표 구현 소스

## 1. 결론

**Herdr의 독립 세션 서버, Paseo의 여러 기기에서 같은 데몬에 연결하는 구조, Orca의 살아 있는 세션과 저장 기록의 구분, Wave·Tabby의 분할/셸 UX를 조합해 참고한다.** WezTerm은 터미널 상태와 mux 프로토콜의 중요한 대안이다. 어느 앱도 설치 기본값 그대로 몽글터미널의 요구가 모두 충족된다고 확인하지 않았다.

여기서 '확인'은 문서와 소스에서 관찰했다는 뜻이다. 설치·실행·한글·모바일 안정성은 아직 시험하지 않았다. 소스 commit은 조사 당시 고정점이며 출시할 의존성 버전 추천이 아니다.

## 2. 비교 기준

1. Windows에서 PowerShell/CMD의 실제 PTY를 유지할 수 있는가.
2. GUI 종료 후에도 PTY와 **원격 접속 endpoint**가 모두 살아 있는가.
3. 저장된 배치/화면 복원과 동일 프로세스 재접속을 구분하는가.
4. 왼쪽 그룹·비대칭 분할·모바일 한 패널 보기와 잘 맞는가.
5. 필요한 코드만 활용할 수 있고 라이선스·배포·유지보수 비용이 합리적인가.

## 3. 제품 비교

| 프로젝트 | 적합한 부분 | 확인한 제약 | 몽글 적용 |
|---|---|---|---|
| **Herdr** | Windows ConPTY와 독립 서버, detach/attach, workspace/pane | TUI/SSH 중심. 모바일 웹을 그대로 제공하는 기반은 아님 | Windows daemon 수명과 session ID 참고 |
| **Paseo** | daemon + desktop/web/mobile, Tailscale 연결, terminal worker | GUI Quit 후 daemon 유지 설정이 기본 false. AI 제품 계층이 큼 | host와 여러 UI의 구조·모바일 terminal 조작 참고 |
| **Orca** | 프로젝트와 pane, 별도 PTY daemon, warm/cold restore 구분 | GUI Quit 시 runtime RPC 종료 경로가 있어 PTY 생존만으로 원격 보장 안 됨 | PTY와 gateway 수명을 함께 독립시킴 |
| **Wave Terminal** | split tree, maximize, workspace/기록 저장, 연결 상태 | durable session은 Unix 원격 SSH 중심이며 local/WSL 및 Windows job manager 제한 | 분할 모델·복원 UX만 선별 참고 |
| **Tabby** | Windows 셸 프로필, nested split, 일반 terminal 입력 | 탭/화면 복원과 Electron main 내 PTY 재연결을 완전한 daemon 지속성과 혼동하면 안 됨 | 프로필·분할·키보드 UX 비교 기준 |
| **WezTerm** | GUI와 분리된 mux, Windows daemon 소스, 성숙한 terminal 상태 모델 | browser에 바로 붙는 제품 API가 아니라 별도 binary PDU/상태 adapter 필요 | snapshot 문제가 큰 경우 backend 대안 |

### Herdr: 현재 원본과 Windows 제약을 확인해야 한다

현재 공식 저장소는 [herdrdev/herdr](https://github.com/herdrdev/herdr)다. 검색에 남아 있는 포크/오래된 Windows beta 설명을 현재 지원으로 인용하지 않는다. Windows daemon 소스에는 kill-on-close job object 경계 처리와 `DETACHED_PROCESS`가 나타난다. 단순한 child process spawn만으로 수명 문제를 해결했다고 가정하지 않는 근거다. [고정 소스](https://github.com/herdrdev/herdr/blob/d5680d84fd1df3b592424eae5c50d54642f0727d/src/platform/windows.rs#L1201-L1273), [지원 범위](https://herdr.dev/docs/windows-beta/)

**판단:** 세션 서버 구조를 참고하되 agent 상태 추정과 TUI 자체를 몽글 요구로 가져오지 않는다.

### Paseo: UI가 비슷해도 기본 종료·인증 정책은 그대로 쓰지 않는다

같은 daemon을 여러 클라이언트가 이용하는 구조는 요구에 가깝다. 하지만 조사한 설정은 `keepRunningAfterQuit:false`이고, daemon과 terminal worker의 수명도 연결되어 있다. 창 닫기와 프로그램 Quit, daemon 종료를 각각 검증해야 한다. [설정 소스](https://github.com/getpaseo/paseo/blob/d0a30ed4da17c6016f49e1aadda6cf4a279c92c3/packages/desktop/src/settings/desktop-settings.ts#L26-L40), [Quit 처리](https://github.com/getpaseo/paseo/blob/d0a30ed4da17c6016f49e1aadda6cf4a279c92c3/packages/desktop/src/daemon/quit-lifecycle.ts#L55-L73)

**판단:** 웹/PWA가 host의 세션에 붙는 방향을 채택한다. 원격 접근의 앱 인증은 선택값이 아니라 기본으로 설계한다. AI provider·chat·Git 등은 포함하지 않는다. [web UI 근거](https://github.com/getpaseo/paseo/blob/d0a30ed4da17c6016f49e1aadda6cf4a279c92c3/public-docs/web-ui.md#L9-L68)

### Orca: 프로세스 생존과 원격 가용성은 별개다

살아 있는 PTY에 다시 붙는 warm restore와 daemon 사망 이후의 cold restore 구분이 유용하다. Quit 소스는 PTY daemon 연결 해제와 runtime RPC 정지를 다르게 처리한다. 따라서 몽글은 PTY뿐 아니라 HTTP/WS gateway도 같은 독립 host가 소유한다. [복원 문서](https://www.onorca.dev/docs/model/session-restore), [종료 소스](https://github.com/stablyai/orca/blob/aedb9305cd1b3de859b5eafc1ee0d77fa0df8963/src/main/startup/main-process-quit.ts#L225-L255)

**판단:** 일반 폴더를 그룹으로 다루고 Git/worktree를 필수로 강요하지 않는다. 원격 UI는 별도 모바일 앱 없이 공통 웹 화면으로 제공한다.

### Wave: 좋은 분할 UI와 Windows 영속 엔진 적합성은 구분한다

분할 node에 방향·크기·children을 두는 모델은 비대칭 레이아웃과 잘 맞는다. 반면 durable shell 구현과 Windows job manager에는 지원 제한이 명시되어 있다. [layout node](https://github.com/wavetermdev/waveterm/blob/c58bf7f346d0a638f3e5d7c77b2688122d36fede/frontend/layout/lib/layoutNode.ts#L16-L28), [Windows job manager](https://github.com/wavetermdev/waveterm/blob/c58bf7f346d0a638f3e5d7c77b2688122d36fede/pkg/jobmanager/jobmanager_windows.go#L12-L14), [durable 문서](https://docs.waveterm.dev/durable-sessions)

**판단:** 재귀적 분할 모델·확대 후 복귀를 참고한다. 몽글 그룹은 처음부터 자동 저장하고 Windows 세션 호스트는 독립 설계한다.

### Tabby: 셸과 일상적인 터미널 동작의 기준

프로필·분할·입력 동작은 직접 비교할 가치가 있다. 다만 확인한 PTY 복구는 Electron main에 남아 있는 PTY map을 사용하며, 저장된 탭 token과 화면도 별개다. [split 모델](https://github.com/Eugeny/tabby/blob/4004cc51e95574658c96270322df8234d9d253ab/tabby-core/src/components/splitTab.component.ts#L9-L83), [PTY map](https://github.com/Eugeny/tabby/blob/4004cc51e95574658c96270322df8234d9d253ab/app/lib/pty.ts#L149-L185)

**판단:** 셸 선택·단축키·붙여넣기·분할 사용성을 참고하며 '탭 복원'만으로 지속 세션을 검증한 것으로 취급하지 않는다.

### WezTerm: Windows mux도 가능한 대안

Windows mux daemon을 분리 실행하는 코드가 있다. 'Windows daemon이 없어서 제외'하는 판단은 잘못이다. 다만 렌더링 변경과 line/cell 상태를 교환하는 binary PDU를 웹 클라이언트와 연결하는 작업이 필요하다. [Windows daemon](https://github.com/wezterm/wezterm/blob/b09b56c29c1e367e598b60ca266e2cc9038751e0/wezterm-mux-server/src/main.rs#L121-L169), [protocol codec](https://github.com/wezterm/wezterm/blob/b09b56c29c1e367e598b60ca266e2cc9038751e0/codec/src/lib.rs#L442-L505)

**판단:** xterm snapshot/응답 문제 해결 비용이 예상보다 커지면 비교할 대안이다. 이미 완성된 browser backend라고 주장하지 않는다.

## 4. 기반 라이브러리 분석

| 후보 | 직접 제공하는 것 | 직접 제공하지 않는 것 |
|---|---|---|
| xterm.js | 브라우저 terminal renderer와 입력 처리 | PTY 실행·기기 인증·호스트 수명 |
| @xterm/headless/serialize | 서버 측 terminal state와 선택된 화면/mode의 직렬화 | 임의 parser 중간 상태·모든 키보드 모드의 완전한 checkpoint 보장 |
| node-pty | Node에서 실제 PTY spawn/read/write/resize | GUI 종료 독립성·영속 기록·원격 접근 정책 |
| portable-pty | Rust에서 플랫폼별 PTY I/O abstraction | 웹 renderer·terminal emulation·reconnect protocol |

중요한 확인은 두 가지다. 첫째, xterm serializer는 화면과 일부 mode를 복원하지만 parser 진행 상태나 모든 keyboard mode를 저장하지 않는다. 둘째, 공개 `onData`에는 일부 자동 terminal response와 사용자 입력이 같은 형태로 전달된다. 따라서 renderer/headless를 단순 연결하면 재접속 깨짐과 중복 질의 응답이 생길 수 있다. 이 때문에 P0-B를 UI 구현보다 먼저 배치했다. [serializer 고정 소스](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/addons/addon-serialize/src/SerializeAddon.ts#L433-L569), [CoreService 입력 경로](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/src/common/services/CoreService.ts#L74-L103)

## 5. 조사한 라이선스와 재사용 원칙

| 프로젝트 | 조사한 LICENSE |
|---|---|
| Herdr, Wave, Paseo | Apache-2.0 |
| Orca, Tabby, WezTerm/portable-pty, xterm.js, node-pty | MIT |

이 표는 해당 revision의 최상위 라이선스 식별이다. 전체 배포물의 조건을 모두 평가한 법률 의견이 아니다. 구체적인 LICENSE 링크는 연구 메모에 있다. 코드 편입 시 파일 헤더와 제3자 코드·폰트·native binary의 별도 조건, LICENSE/NOTICE·수정 고지를 확인하고 제3자 고지 목록을 생성한다. 이번 작업에서는 참고 프로젝트 코드를 제품에 복사하거나 포크하지 않았다.

## 6. 결정 로그

| ADR | 결정 | 상태/다시 검토할 조건 |
|---|---|---|
| ADR-001 | GUI와 PTY+gateway host의 생명주기를 분리 | 핵심 구조 확정. launcher 구현은 P0-A 검증 |
| ADR-002 | 첫 원격은 private Tailscale Serve, 모바일 웹/PWA 포함 | 사용자 수용·범위 확정. 실제 WS/IME는 P0-C/D |
| ADR-003 | Electron+Node+node-pty+xterm 계열 우선 | 조건부. snapshot/provenance gate 실패 시 adapter 또는 mux 대안 비교 |
| ADR-004 | 한 터미널에 한 입력/geometry 제어자 | 제안 기본값. 협업 요구가 생기면 재검토 |
| ADR-005 | 재부팅 뒤 기록/환경만 복원, 자동 명령 재실행 없음 | 제안 기본값. 별도 resume 요구가 생기면 명시적 opt-in 설계 |
| ADR-006 | 앱 pairing 기본, 자체 AI·중계·계정 서비스 제외 | 첫 버전 범위. 승인·폐기 영속성 검증 필수 |
| ADR-007 | 호환 불가 업데이트는 GUI/host 교체 함께 보류 | 작업 접근 경로를 유지하기 위한 기본값 |

## 7. 상세 근거

- [참조 앱 연구 메모](research/research-reference-apps.md): 5개 앱의 고정 commit·라이선스·소스 위치
- [터미널 엔진 연구 메모](research/research-engines.md): xterm/node-pty/WezTerm 코드와 복원·입력 위험
- [원격 연구 메모](research/research-remote.md): 공식 네트워크/PWA/보안 자료와 미검증 환경

연구 메모는 조사 당시 관찰과 후보 제안을 보존한다. 최종 동작/API가 다르게 상세화된 경우 01–04 설계 문서를 우선하고 변경 이유는 결정 로그에 남긴다.
