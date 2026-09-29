# 몽글 터미널: 참조 앱 조사

**추천: Herdr의 Windows 세션 서버, Paseo의 같은 데몬에 붙는 웹·모바일, Orca의 프로젝트 구조와 복원 구분, Wave·Tabby의 분할 모델을 선별 참조한다.** 어느 제품도 기본 설정 그대로 몽글의 모든 요구를 충족한다고 확인되지는 않았다.

조사일: 2026-09-29, Asia/Seoul. 범위: Windows 셸, 왼쪽 프로젝트 그룹, 분할 pane, GUI 종료 후 실행 유지, Tailscale로 다른 PC·모바일 웹에서 같은 세션 조작. AI 채팅·에이전트 공급자 통합은 제외한다. 공식 문서와 아래 SHA의 대표 소스를 직접 읽었다. 설치·실행·기기 테스트는 하지 않았다. **문서와 코드가 일치하는 사실은 높은 신뢰, 사용성·운영 안정성 평가는 미검증**이다.

| 앱 / 조사 커밋 | LICENSE 확인 | 핵심 적합성 | 그대로 쓰기 어려운 지점 |
|---|---|---|---|
| Herdr `d5680d84` | [Apache-2.0](https://github.com/herdrdev/herdr/blob/d5680d84fd1df3b592424eae5c50d54642f0727d/LICENSE) | Windows 독립 서버·실제 PTY 유지 | TUI/SSH 중심, 모바일 웹은 별도 제작 |
| Wave `c58bf7f3` | [Apache-2.0](https://github.com/wavetermdev/waveterm/blob/c58bf7f346d0a638f3e5d7c77b2688122d36fede/LICENSE) | 분할 트리·확대·연결 상태 표현 | durable은 Unix 원격 SSH 전용 |
| Paseo `d0a30ed4` | [Apache-2.0](https://github.com/getpaseo/paseo/blob/d0a30ed4da17c6016f49e1aadda6cf4a279c92c3/LICENSE) | 데몬·웹·모바일·프로젝트 구조 | 종료 후 유지 기본 꺼짐, AI 중심 |
| Orca `aedb9305` | [MIT](https://github.com/stablyai/orca/blob/aedb9305cd1b3de859b5eafc1ee0d77fa0df8963/LICENSE) | 프로젝트·worktree·pane·warm restore | GUI Quit 후 원격 서버는 별도 문제 |
| Tabby `4004cc51` | [MIT](https://github.com/Eugeny/tabby/blob/4004cc51e95574658c96270322df8234d9d253ab/LICENSE) | Windows 셸·입력·분할의 비교 기준 | 탭 복원이 독립 영속 서버를 뜻하지 않음 |

라이선스 명칭은 해당 저장소의 직접 확인 결과다. 코드를 가져오는 단계에서는 각 저장소의 LICENSE/NOTICE와 포함한 의존성 고지를 함께 확인해야 한다.

## 1. Herdr — Windows 프로세스 수명 참고 우선

현재 공식 원본은 `herdrdev/herdr`다. 검색에 나오는 오래된 포크의 Linux/macOS 전용 또는 Windows beta 문구를 현재 지원으로 인용하면 안 된다. 공식 0.9.1 문서는 Windows를 GA로 표기하며 ConPTY, `cmd.exe`, 로컬 지속 세션, Windows SSH 호스트를 지원한다. 다만 한중일 IME 위치·실시간 cwd 추적은 부분 지원이고, native Windows direct terminal attach와 live handoff는 미지원이다. [Windows 지원 범위](https://herdr.dev/docs/windows-beta/)

코드의 Windows daemon 시작은 일반 spawn뿐 아니라 부모 Job Object의 kill-on-close를 감지한 WMI 생성 분기를 갖고, `DETACHED_PROCESS`를 사용한다. Windows PTY는 `portable_pty`의 `openpty`/`spawn_command`로 소유한다. 따라서 **UI에서 PTY를 떼어내는 것뿐 아니라 Windows의 부모 종료·SSH 로그아웃 경계도 처리해야 한다**는 구체적 참고다. [daemon 생성](https://github.com/herdrdev/herdr/blob/d5680d84fd1df3b592424eae5c50d54642f0727d/src/platform/windows.rs#L1201-L1273), [분리 플래그](https://github.com/herdrdev/herdr/blob/d5680d84fd1df3b592424eae5c50d54642f0727d/src/platform/windows.rs#L1373-L1377), [PTY 생성](https://github.com/herdrdev/herdr/blob/d5680d84fd1df3b592424eae5c50d54642f0727d/src/pty/backend.rs#L7-L38)

살아 있는 서버에 재접속하면 원래 프로세스가 계속되지만, 서버 재시작 후 snapshot restore는 workspace/tab/pane/cwd/layout을 다시 만들 뿐이다. 원격은 OpenSSH 인증을 재사용한다. 모바일에서는 SSH 앱으로 접근하는 경로이며 브라우저 UX의 완성품 근거가 아니다. **채택:** 서버 소유 세션, stable ID, detach/stop 분리. **수정:** TUI 대신 공통 웹 renderer와 상시 왼쪽 프로젝트 트리. **제외:** agent 상태 탐지·provider resume·플러그인 오케스트레이션. [복원 구분](https://herdr.dev/docs/session-state/), [원격·인증·입력 소유권](https://herdr.dev/docs/persistence-remote/)

## 2. Wave — 화면 구성 참고, Windows 영속 엔진으로는 부족

Wave의 저장 workspace는 탭·레이아웃·터미널 기록을 저장하지만, 새 workspace는 저장 전까지 임시이며 창을 닫으면 삭제될 수 있다. 몽글에서는 프로젝트를 처음부터 자동 저장하는 편이 요구에 맞다. 분할 노드는 ID·방향·크기·자식으로 표현하고, 분할·이동·resize·확대를 별도 action으로 처리한다. **채택:** 재귀 분할 모델, pane 확대 후 원래 배치 복귀, 연결 상태 표시. **수정:** switcher 팝업을 왼쪽 프로젝트 그룹으로 바꾸고 terminal만 제공. [workspace 동작](https://docs.waveterm.dev/workspaces), [layout node](https://github.com/wavetermdev/waveterm/blob/c58bf7f346d0a638f3e5d7c77b2688122d36fede/frontend/layout/lib/layoutNode.ts#L16-L28), [layout model](https://github.com/wavetermdev/waveterm/blob/c58bf7f346d0a638f3e5d7c77b2688122d36fede/frontend/layout/lib/layoutModel.ts#L14-L50)

공식 durable session은 SSH 원격 전용이고 local/WSL에는 적용되지 않는다. 소스도 local 연결을 거부하고 job manager를 Linux/macOS에 한정한다. Windows `daemonize`는 unsupported를 반환한다. 원격 출력 buffer·재접속·상태 표현은 유용하지만 Windows 호스트에서 같은 프로세스를 유지하는 기반으로 그대로 채택할 수 없다. SSH가 인증과 전송을 담당하며, 조사한 공식 배포 범위는 desktop이고 모바일 웹 클라이언트는 확인하지 못했다. AI·editor·web widget은 몽글 범위에서 제외한다. [durable 문서](https://docs.waveterm.dev/durable-sessions), [local 거부](https://github.com/wavetermdev/waveterm/blob/c58bf7f346d0a638f3e5d7c77b2688122d36fede/pkg/blockcontroller/durableshellcontroller.go#L130-L147), [Unix 제한](https://github.com/wavetermdev/waveterm/blob/c58bf7f346d0a638f3e5d7c77b2688122d36fede/pkg/jobmanager/jobmanager.go#L48-L51), [Windows 구현](https://github.com/wavetermdev/waveterm/blob/c58bf7f346d0a638f3e5d7c77b2688122d36fede/pkg/jobmanager/jobmanager_windows.go#L12-L14)

## 3. Paseo — 같은 세션의 웹·모바일 접근 참고 우선

daemon, Expo app, Electron desktop 구조이며 Windows x64/ARM64 및 모바일·웹 경로를 제공한다. 프로젝트→workspace→tab 구조에서 agent 없이 일반 폴더와 terminal을 만들 수 있고 중첩 split을 구현한다. Windows terminal 기본은 `cmd.exe`이며 custom command/args를 받는다. **채택:** 하나의 서버 세션을 여러 클라이언트가 조회·attach하는 구조. **수정:** PowerShell/CMD/WSL/Git Bash 프로필을 명시적으로 제공하고 agent 중심 화면을 일반 셸 세션으로 단순화한다. [workspace 모델](https://github.com/getpaseo/paseo/blob/d0a30ed4da17c6016f49e1aadda6cf4a279c92c3/public-docs/workspaces.md#L15-L60), [분할 구현](https://github.com/getpaseo/paseo/blob/d0a30ed4da17c6016f49e1aadda6cf4a279c92c3/packages/app/src/components/split-container.tsx#L924-L1114), [Windows 셸](https://github.com/getpaseo/paseo/blob/d0a30ed4da17c6016f49e1aadda6cf4a279c92c3/packages/server/src/terminal/terminal.ts#L235-L245)

주의할 기본값은 `keepRunningAfterQuit:false`다. 이 경우 Quit는 관리 daemon도 중지한다. true일 때 background daemon이 유지되지만 daemon IPC가 끊기면 terminal worker는 `killAll()`한다. GUI 종료 유지와 daemon 재시작 복원은 다른 기능이다. [기본값](https://github.com/getpaseo/paseo/blob/d0a30ed4da17c6016f49e1aadda6cf4a279c92c3/packages/desktop/src/settings/desktop-settings.ts#L26-L40), [Quit 처리](https://github.com/getpaseo/paseo/blob/d0a30ed4da17c6016f49e1aadda6cf4a279c92c3/packages/desktop/src/daemon/quit-lifecycle.ts#L55-L73), [worker 종료](https://github.com/getpaseo/paseo/blob/d0a30ed4da17c6016f49e1aadda6cf4a279c92c3/packages/server/src/terminal/terminal-worker-process.ts#L347-L350)

자체 web UI는 같은 daemon의 API/WebSocket에 붙고 Tailscale Serve 예제가 있다. direct 접속은 기본 무인증이며 비밀번호는 선택 기능이므로 이 기본값은 채택하지 않는다. 몽글은 tailnet 접근 제한과 앱의 pairing/revocation을 함께 제공해야 한다. 모바일 compact pane·키보드 공간·제어키 UX를 참조하되 실제 한글 IME·iOS Safari 테스트가 필요하다. [web UI](https://github.com/getpaseo/paseo/blob/d0a30ed4da17c6016f49e1aadda6cf4a279c92c3/public-docs/web-ui.md#L9-L68), [연결](https://paseo.sh/docs/connectivity), [인증](https://paseo.sh/docs/security#password-authentication)

## 4. Orca — warm/cold 복원과 원격 서버 수명 구분

프로젝트→worktree 구조와 pane 분할을 제공하고 Windows shell allowlist는 PowerShell/pwsh/CMD/WSL/bash/Git Bash를 포함한다. PTY daemon을 분리 실행해 GUI quit/crash 후 살아 있는 PTY에 warm reattach한다. daemon 사망·재부팅 후 cold restore는 배치·scrollback 복원이며 원래 프로세스 유지가 아니다. **채택:** warm/cold 상태 구분, 프로젝트 그룹, 명시적 shell 선택. **수정:** worktree를 필수 단위로 강요하지 않고 일반 폴더를 동등하게 다룬다. [복원 모델](https://www.onorca.dev/docs/model/session-restore), [분리 spawn](https://github.com/stablyai/orca/blob/aedb9305cd1b3de859b5eafc1ee0d77fa0df8963/src/main/daemon/daemon-launched-child-spawn.ts#L60-L82), [Windows 셸](https://github.com/stablyai/orca/blob/aedb9305cd1b3de859b5eafc1ee0d77fa0df8963/src/shared/windows-terminal-shell.ts#L72-L86)

중요한 제한: desktop Quit는 daemon에는 disconnect하지만 runtime RPC는 stop한다. 즉 **PTY가 살아 있어도 원격 접속은 끊길 수 있다.** GUI 없이 상시 접속하려면 별도 `orca serve` 수명이 필요하다. Tailscale/LAN 및 폐기 가능한 pairing token을 참고하되, 공식 모바일은 companion 앱 중심이다. web client 코드 존재만으로 모바일 웹 사용성이 검증됐다고 말할 수 없다. [Quit 소스](https://github.com/stablyai/orca/blob/aedb9305cd1b3de859b5eafc1ee0d77fa0df8963/src/main/startup/main-process-quit.ts#L225-L255), [모바일 제한](https://www.onorca.dev/docs/mobile), [원격·pairing](https://www.onorca.dev/docs/remote-servers), [web build](https://github.com/stablyai/orca/blob/aedb9305cd1b3de859b5eafc1ee0d77fa0df8963/vite.web.config.ts#L9-L26)

## 5. Tabby — 일반 터미널의 비교 기준

PowerShell·CMD·WSL·Git Bash 등 프로필, nested split, Unicode와 bracketed paste를 제공한다. split container의 방향·children·ratio 모델과 Windows ConPTY 실패 시 fallback이 실용적이다. SSH는 SSH 인증을 사용한다. **채택:** 셸 프로필·입력 동작·분할 비율 모델. **제외:** plugin marketplace·SFTP·serial 등 이번 범위 밖 기능. [지원 기능](https://github.com/Eugeny/tabby/blob/4004cc51e95574658c96270322df8234d9d253ab/README.md), [분할 모델](https://github.com/Eugeny/tabby/blob/4004cc51e95574658c96270322df8234d9d253ab/tabby-core/src/components/splitTab.component.ts#L9-L83), [ConPTY fallback](https://github.com/Eugeny/tabby/blob/4004cc51e95574658c96270322df8234d9d253ab/tabby-local/src/session.ts#L111-L136)

탭 복원은 localStorage recovery token과 저장 화면을 사용한다. 살아 있는 PTY 재연결도 가능하지만 확인 범위는 Electron main의 메모리 map에 존재하는 ID다. 전체 앱 종료 후 독립 서버가 기존 PTY를 계속 소유한다는 보장은 아니다. 별도 Tabby Web은 OAuth/OIDC와 TCP gateway를 갖춘 SSH 웹 클라이언트이며 desktop의 로컬 PTY 공유 기능으로 오해하면 안 된다. 현재 유지관리자는 web 프로젝트 지원 시간이 없다고 명시한다. [탭 저장](https://github.com/Eugeny/tabby/blob/4004cc51e95574658c96270322df8234d9d253ab/tabby-core/src/services/tabRecovery.service.ts#L22-L30), [PTY 복구](https://github.com/Eugeny/tabby/blob/4004cc51e95574658c96270322df8234d9d253ab/tabby-electron/src/pty.ts#L25-L29), [PTY map](https://github.com/Eugeny/tabby/blob/4004cc51e95574658c96270322df8234d9d253ab/app/lib/pty.ts#L149-L185), [Tabby Web 범위](https://github.com/Eugeny/tabby-web)

## 몽글 설계에 적용할 결정

1. **PTY와 HTTP/WebSocket은 GUI와 독립된 사용자 daemon이 소유한다.** 창 닫기는 detach이며 세션 종료·전체 엔진 종료는 별도 동작이다. 다른 PC와 모바일 웹도 같은 session ID에 붙는다.
2. **영속 상태를 세 층으로 나눈다.** 실행 중 PTY, 화면/scrollback, 프로젝트·분할 배치다. 재부팅 후에는 배치와 기록을 복원하고 새 셸임을 표시한다. 임의 장기 명령을 자동 재실행하지 않는다.
3. **왼쪽 프로젝트 그룹과 분할 트리는 같은 세션을 가리킨다.** 모바일에서는 한 pane을 집중 표시하고 프로젝트 drawer·pane 전환·Esc/Tab/Ctrl/방향키를 제공한다. 모바일 크기가 desktop PTY를 계속 resize하지 않도록 입력·resize 소유권 규칙을 둔다. 이는 조사에서 도출한 설계 제안이다.
4. **원격은 tailnet 안에서 시작한다.** HTTPS/WSS, 기기 pairing·폐기, 서버 측 요청 인증·Origin 검증을 기본 설계에 포함한다. Tailscale 연결과 앱 접근 권한을 구분한다. 공급자 계정·API key·AI 대화 저장소는 만들지 않는다.
5. **검증해야 할 미확정 항목:** Windows 창 닫기·GUI crash·daemon crash·호스트 재부팅을 각각 시험하고 PID 연속성을 확인한다. tailnet 재접속·동시 클라이언트·대량 출력 backpressure·한글 IME·모바일 키보드·ConPTY upgrade도 실제 기기에서 확인해야 한다.
