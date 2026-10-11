# Codex 작업 상태

2026-10-11, Windows x64, 미배포. PowerShell에서 `codex`로 시작한 Codex의 작업 중·확인 요청·응답 완료를 Claude와 같은 표시와 알림 번호로 보여 준다. 다음 기능과 함께 배포할 예정이며 공개 배포 검증은 하지 않았다.

## 배경

0.3.18 확인에서 Codex는 작업 상태를 보내지 않았고([작업 상태 표시 재설계](agent-status-indicator.md)), 몽글은 Codex 터미널에 진행 표시를 하지 않았다. 몽글이 관리하는 Codex 훅은 대화 재개용 `SessionStart`·`SessionEnd`만 등록했다. 사용자가 Claude에는 작업 중 표시가 나오는데 Codex에는 없다고 알려 왔다. 예정된 휴대폰 알림도 Codex의 질문·승인 요청을 알아야 하므로 같은 신호가 필요하다.

## 근거

- [Codex Hooks 공식 문서](https://learn.chatgpt.com/docs/hooks)를 2026-10-11에 열어 확인했다. 차례 중 이벤트로 `UserPromptSubmit`·`PreToolUse`·`PermissionRequest`·`PostToolUse`·`Stop`, 진행 중인 차례를 중단하면 `Interrupt`가 있다. 훅은 stdin으로 JSON 하나를 받고, 차례 이벤트에는 Codex 확장 필드 `turn_id`가 있다. `PermissionRequest`는 승인이 필요한 명령에만 실행된다. `async: true`인 훅은 Codex가 끝나기를 기다리지 않는다. 비관리 훅은 정의의 해시로 신뢰를 기록하므로 새로 추가되거나 바뀐 훅은 `/hooks`에서 신뢰하기 전에는 실행되지 않는다. `Stop`·`Interrupt`는 일반 텍스트 출력을 허용하지 않는다.
- 이 PC에 있는 Codex 실행 파일 두 개, npm 전역 설치본(0.162.1)과 Codex 앱 내장본(`0.162.0-alpha.17.2`)에 들어 있는 훅 입력 스키마(`*.command.input`)를 읽기 전용으로 추출했다. 두 실행 파일의 스키마는 아래 내용이 같았다. `interrupt`·`stop`·`user-prompt-submit`·`permission-request`·`post-tool-use`·`pre-tool-use` 모두 `turn_id`가 필수다. `permission-request`·`pre-tool-use`·`post-tool-use`·`user-prompt-submit`에는 하위 에이전트의 `agent_id`·`agent_type`이 선택 필드로 있고, `permission-request`에는 `tool_use_id`가 없다. `session-start`의 `source`는 `startup`·`resume`·`clear`·`compact`·`fork`다. 실행 파일에는 질문 도구 이름 `request_user_input`과 승인 창 문구("Yes, and don't ask again …", "No, and tell Codex what to do differently")도 들어 있다. 승인 창의 기본 선택과 단축키는 실행 파일에서 확인할 수 없었다.
- 훅 한 번은 Node 시작이 대부분이며, 이 PC에서 Node 시작은 5회 측정에 42~64ms였다.

## 설계 판단

- 신호 전달: Codex 훅의 stdout은 모델 맥락이 되므로 Claude처럼 터미널 신호(OSC)로 보낼 수 없다. 기존 재개 훅과 같이 셸별 토큰으로 인증된 이 PC 안의 이름 있는 파이프로 보낸다. 훅이 보내는 값은 이벤트 이름, 세션 UUID(기존), 시작 종류, `turn_id`와 하위 에이전트 ID의 SHA-256, 질문 도구 여부뿐이다. 질문·명령·도구 출력·답변·transcript 경로·모델 이름은 보내지 않는다. 파이프는 그 셸에서 마지막으로 시작한 실행·대화와 같은 것만 전달하고, 호스트는 형식을 다시 검사한 뒤 토큰이 맞는 실행 중 터미널에만 적용한다.
- 차례 판정(`CodexTaskState`): `UserPromptSubmit`은 작업 중, `PermissionRequest`나 질문 도구의 `PreToolUse`는 확인 요청(알림), `PostToolUse`는 작업 중, `Stop`은 응답 완료(알림), `Interrupt`는 대기다. `turn_id`로 다른 차례나 끝난 차례의 늦은 이벤트를 버린다. 압축이 아닌 `SessionStart`, `SessionEnd`, 셸 프롬프트 복귀는 초기화한다. 하위 에이전트의 요청은 그 에이전트의 도구가 끝날 때까지 확인 요청으로 두고, 하위 에이전트의 질문 입력과 종료는 사용자의 차례로 보지 않는다. 사용자의 차례가 없을 때 온 하위 에이전트 요청은 표시하지 않는다.
- 실행 방식: 모든 관리 훅을 동기로 실행해, Codex가 보고를 마친 뒤 다음 단계로 넘어가게 했다. 처음에는 도구마다 오는 `PostToolUse`를 백그라운드로 두었다. 그런데 실제 확인 중 검토에서 앞 도구의 늦은 완료 보고가 다음 승인 요청 표시를 지울 수 있다는 점이 드러나 동기로 바꿨다(아래 P2). 비용은 도구마다 Node 시작 시간(이 PC에서 42~64ms)이며, 같은 이벤트의 다른 훅과 함께 실행된다. 모든 관리 훅은 `Interrupt`·`SessionEnd`의 최대값인 3초 제한을 쓰고, `PreToolUse`는 `^request_user_input$`에만 등록했다. 도구 출력이 커도 상태가 빠지지 않도록 훅 입력 한도를 64KiB에서 4MiB로 늘렸다. 몽글 밖의 Codex(Codex 앱이나 다른 터미널)에서도 훅은 입력을 끝까지 읽은 뒤 끝난다. 전에는 읽지 않고 바로 끝나서, 출력이 큰 `PostToolUse`라면 Codex가 닫힌 파이프에 쓰게 될 수 있었다.
- 키 입력: Codex가 중단을 직접 알리므로 키는 보이는 요청에 대해서만 해석한다. Esc·Ctrl+C는 표시를 내린다(중단이나 거절). 요청이 뜬 뒤 다른 키 없이 누른 Enter는 미리 선택된 승인으로 보고 작업 중으로 표시한다. 그 밖의 답은 거절일 수 있어 표시를 내리고, 승인한 명령이 끝나면 다시 작업 중으로 표시한다. 기본 선택이 승인이라는 점은 Codex 화면에서 아직 확인하지 않은 가정이다. 판정기에는 지금처럼 키의 의미만 전달하고 입력한 글자는 전달하지 않는다.
- 신뢰 유지와 버전: `SessionStart`·`SessionEnd` 항목은 정의를 그대로 두어 기존 신뢰를 유지한다. 새 이벤트는 스키마를 확인한 0.162.0 이상에서만 등록하고, 낮은 버전에서는 몽글 항목만 지우며 사용자 훅은 유지한다. 훅 스크립트 머리줄은 그대로 두어 이전 버전 몽글도 같은 파일을 자기 것으로 인식한다.
- 버전 확인: 호스트는 PATH에서 처음 찾은 `codex.exe`의 버전을 본다. 이 PC에서는 Codex 앱 내장본(0.162.0-alpha.17.2)이 먼저 잡히고, 몽글 터미널의 `codex`는 PowerShell 순서대로 npm 설치본(0.162.1)을 실행한다. 처음 기준을 0.162.1로 두었다가, 실제 확인을 준비하면서 이 차이 때문에 상태 훅이 설치되지 않는 것을 발견했다. 두 실행 파일 모두 같은 스키마를 가진 것을 확인하고 기준을 0.162.0으로 낮췄다.
- 화면: 기존 표시(돌아가는 고리, 물음표 말풍선, 점)를 그대로 쓰고 새 화면 요소는 만들지 않았다. 그래서 Mobbin 사례는 새로 찾지 않았다. **설정 → 도움말**의 문구만 고쳤다. 제목에 Codex를 넣고, 0.3.18 디자인과 맞지 않던 "맥동·종" 설명을 "고리·점"으로 바로잡았다.

## 변경

- `packages/host/codex-hook-source.ts`: 훅 스크립트와 이벤트별 등록 방식(`CODEX_HOOK_HANDLERS`).
- `packages/host/codex-integration.ts`: 0.162.0 이상에서 차례 이벤트 등록, 낮은 버전에서 제거, 안내 문구.
- `packages/host/agent-pipe.ts`: 같은 실행·대화의 차례 이벤트만 전달.
- `packages/host/core.ts`·`main.ts`: `reportAgentStatus`로 해당 셸의 엔진에 전달하고 화면 갱신을 예약.
- `packages/terminal/agent-status.ts`: `CodexTaskState`·`validCodexEvent`, 붙여넣기 판별을 Claude와 함께 쓰도록 분리.
- `packages/terminal/engine.ts`: Codex 이벤트를 출력 처리 순서 뒤에 적용하고, 알림 번호를 기록하고, 셸 프롬프트 복귀 때 초기화.
- `packages/protocol/index.ts`·`apps/web/src/TerminalStatus.tsx`: `agentProvider`에 `codex` 추가. `apps/web/src/Settings.tsx`: 도움말 문구.

## 검증

- `npm.cmd run typecheck`, `npm.cmd run build` 통과(기존 대형 청크 경고만 있음).
- `tests/terminal/codex-status.test.ts` 5/5(신규): 차례 판정(늦은·다른 차례 무시, 압축 유지, `/clear`·세션 종료·셸 프롬프트 초기화, 차례마다 새 완료 알림), 하위 에이전트 요청, 키 입력(미리 선택된 승인, 선택 이동 뒤 답, Esc, 질문, Ctrl+C, 요청 2개, 붙여넣기 안의 Enter), 입력 형식 검사, 엔진의 처리 순서·알림 번호(사이에 온 일반 벨은 별도 알림)·셸 프롬프트 초기화·알림 꺼짐.
- `tests/host/codex-integration.test.ts` 9/9(신규 2, 변경 2): 0.162.0에서 이벤트마다 몽글 항목 하나, 모두 같은 명령문과 3초 제한, 질문 도구 matcher, 모든 항목 동기 실행(`async` 없음), 사용자 훅 보존, 세션 항목 그대로, 반복 설치 시 변화 없음, 0.161.0으로 낮추면 몽글 차례 항목만 제거. 0.160.0에서는 세션 훅만 설치. 훅 스크립트는 질문·명령·출력·답변·transcript·모델·원래 ID를 내보내지 않고 화면에 아무것도 쓰지 않으며, 64KiB가 넘는 도구 출력도 처리한다. 몽글 밖에서는 2MB 입력도 끝까지 읽는다. 바로 끝나는 프로세스가 이 확인에서 실패하는 것도 따로 확인했다. 파이프는 시작 전·다른 실행·다른 대화·해시가 아닌 값·모르는 이벤트·종료 뒤 이벤트를 버린다.
- `tests/host/codex-status.test.ts` 1/1(신규): 호스트가 토큰이 맞는 터미널만 바꾸고 연결된 화면에 `agentProvider: codex` 상태를 보내며, 응답 완료가 그 터미널의 에이전트 알림 번호가 된다.
- `tests/ui/terminal-status.test.ts` 3/3(신규 1). Claude의 기존 상태 시험 `tests/terminal/agent-status.test.ts` 16/16(붙여넣기 판별 분리 뒤), 대화 재개 시험(`agent-session`·`agent-resume-*`)도 통과했다.
- 전체 회귀: 격리한 `MONGLE_DATA_DIR`로 순차 실행해 615개 중 598 통과·1 실패·16 생략(따로 지정해야 실행되는 설치·데스크톱 시험). 실패 1개는 이 PC의 PowerShell 실행 정책이 배포 스크립트 시험(`release publisher checks all deliverables and rejects tampering before contacting GitHub`)을 막은 환경 문제다. 이 실행 뒤 훅 스크립트의 입력 읽기만 고쳤고, Codex 연동 시험 9/9와 문서 검사 17/17을 다시 통과했다. 실행이 덮어쓴 `artifacts/ui` 스크린샷 4장은 원래 파일로 되돌렸다.
- 수정 중 발견: 호스트 시험의 가짜 셸(Node)이 뒤에 붙는 PowerShell 통합 인자를 Node 옵션으로 읽어 곧바로 끝났다. 끝나면 상태가 지워져 방송 확인이 실패했다. 시험 명령에 `--`를 넣어 고쳤고, 시험 끝까지 셸이 실행 중인지도 확인한다.

## 실제 앱·Codex 확인 (2026-10-12)

사용자가 채팅으로 승인한 범위에서 아스트라(`gpt-6-astra`)가 확인했다. 범위는 사용자 Codex 설정에 몽글 훅을 추가하고, `/hooks`에서 몽글 훅만 신뢰하고, 기존 로그인으로 짧은 요청을 6번 보내는 것이었다. 대상은 HEAD `1a9593a`를 %TEMP%에 복사해 빌드한 개발 앱이다. 격리 데이터 폴더와 `MONGLE_CODEX_HOME`(사용자 Codex 설정 폴더)으로 실행했다. Codex CLI는 0.162.1이고, 작업 폴더는 Codex가 이미 신뢰하는 저장소 안의 `.test-data\codex-live`였다.

- 연동: 몽글 항목 8개가 같은 명령문으로 등록됐다. `SessionStart`·`SessionEnd` 정의는 시작 전과 같았고 새 백업이 생겼다. 설정 → 도움말에 "Codex 연동 등록됨"과 작업 상태 안내가 보였다. Codex는 새 몽글 훅 6개를 검토 대상으로 보여 주었고, 신뢰는 `config.toml`의 `[hooks.state]`에 항목마다 `trusted_hash`로 기록됐다. 시험 호스트가 이 Codex 대화를 재개 기록으로 저장했으므로, 세션 시작 신호는 호스트까지 왔다.
- 표시: 파일을 만드는 요청 두 번에서 작업 중 고리가 탭·사이드바·그룹에 나타났다. 응답 뒤에는 "응답 완료 · 미확인" 점이 나타났고, 그 터미널에 입력하자 사라졌다. 첫 요청(짧은 답)에서는 다른 탭으로 옮기는 사이 고리와 점을 포착하지 못했다. 응답이 끝난 뒤에 옮겼는지 확정할 수 없어 미확인으로 둔다. `/quit`로 끝낸 뒤 표시가 남지 않았다.
- Codex 화면: 질문을 보낸 직후 "Running hooks"가 잠깐 보였다. 몽글 명령문, 훅 출력, `Stop`의 출력 형식 오류는 보이지 않았다.
- 확인하지 못한 것: 파일 생성 요청이 승인 창 없이 실행돼 Enter 승인과 Esc 거절을 볼 수 없었다. 숫자 쓰기 요청은 Esc를 누르기 전에 약 6초 만에 끝나 중단을 확인하지 못했다. 질문 도구 요청에는 선택 창이 나오지 않았다. 처음 정한 `-a untrusted`는 이 Codex가 지원하지 않아(`on-request`·`never`만 허용) `-a on-request`로 바꿨다.
- 초점 수정 재확인(`7e075d7`): 터미널의 **··· → 이름 변경 → Esc**와 그룹의 **··· → 그룹 설정 → Esc**에서 초점이 **···**로 돌아왔다. 다음 Tab은 바로 옆 버튼과 그룹의 작업 줄로 이동했다.
- 코드 검토: P2 1건이 나왔다. 백그라운드로 실행하던 `PostToolUse`가 늦게 도착하면, 아직 승인을 기다리는 다음 도구의 확인 요청 표시가 지워진다. 상태 판정기에 그 순서로 이벤트를 넣어 재현했다. 모든 관리 훅을 동기로 바꿔 고쳤고, 시험으로 모든 항목에 `async`가 없음을 확인한다. 이 수정은 실제 Codex에서 다시 확인하지 않았다. P0·P1·P3는 없었다. 훅이 원문을 보내지 않는 점, 입력·파이프 검증, Windows 명령 제약, 세션 항목 유지도 검토에서 문제가 없었다.
- 정리: Codex를 정상 종료하고, 설정 화면에서 호스트를 정상 종료하고, 남은 시험 Electron PID만 정리하고, TEMP 빌드·데이터와 시험 파일을 지웠다. 시험 잔존 프로세스는 없었고 설치본 몽글 프로세스는 그대로였다. Tailscale Serve 해시는 전후가 같았다. 몽글 훅과 신뢰는 승인대로 남겼다. `config.toml`은 신뢰 기록 때문에 해시가 달라졌다. 원본을 보관하지 않아 다른 설정이 바이트 단위로 같은지는 증명하지 못했지만, 몽글 항목 외에는 신뢰를 누르지 않았다. 기록은 커밋하지 않는 `test-results/codex-status-live/`에 있다.

## 확인하지 않은 범위

- 실제 Codex에서 승인 창의 Enter 승인과 Esc 거절(이번에는 승인 창이 뜨지 않음), 진행 중 Esc 중단과 `Interrupt`(응답이 먼저 끝남), 질문 도구(`request_user_input`)를 확인 요청으로 잡는지(선택 창이 뜨지 않음), 승인 창의 기본 선택과 단축키.
- P2 수정(모든 훅 동기 실행) 뒤의 실제 Codex 동작. 바뀐 `PostToolUse` 항목은 신뢰 해시가 달라져 `/hooks`에서 다시 신뢰해야 한다.
- 휴대폰 브라우저에서의 표시.
- Codex 0.162.0보다 낮은 버전이 새 이벤트 이름을 만났을 때의 동작. 그래서 그 버전에는 등록하지 않는다. 다만 호스트가 확인하는 실행 파일과 몽글 터미널에서 실행되는 실행 파일이 다를 수 있다. 예를 들어 Codex 앱 내장본은 새 버전이고 npm 설치본이 오래되었다면, 오래된 CLI가 새 이벤트가 든 `hooks.json`을 읽게 된다.
- 같은 차례에서 도구 두 개가 동시에 실행되고 그중 하나만 승인을 기다리면, 다른 도구가 먼저 끝날 때 확인 요청 표시가 일찍 내려갈 수 있다. 알림은 요청 시점에 이미 센다.
- 사용자의 차례가 끝난 뒤에도 실행 중인 하위 에이전트의 요청은 표시하지 않는다. 다른 훅이 `Stop`에서 차례를 이어 가게 하면 첫 `Stop`에서 응답 완료로 표시한다.
- cmd·Git Bash·WSL, `codex exec`, 실행 파일 직접 호출.
