# Codex 작업 상태

2026-10-11, Windows x64, 0.3.21 공개. PowerShell에서 `codex`로 시작한 Codex의 작업 중·확인 요청·응답 완료를 Claude와 같은 표시와 알림 번호로 보여 준다. 공개 검증은 [0.3.21 배포 검증](public-release-0.3.21.md#final)을 따른다.

## 배경

0.3.18 확인에서 Codex는 작업 상태를 보내지 않았고([작업 상태 표시 재설계](agent-status-indicator.md)), 몽글은 Codex 터미널에 진행 표시를 하지 않았다. 몽글이 관리하는 Codex 훅은 대화 재개용 `SessionStart`·`SessionEnd`만 등록했다. 사용자가 Claude에는 작업 중 표시가 나오는데 Codex에는 없다고 알려 왔다. 예정된 휴대폰 알림도 Codex의 질문·승인 요청을 알아야 하므로 같은 신호가 필요하다.

## 근거

- [Codex Hooks 공식 문서](https://learn.chatgpt.com/docs/hooks)를 2026-10-11에 열어 확인했다. 차례 중 이벤트로 `UserPromptSubmit`·`PreToolUse`·`PermissionRequest`·`PostToolUse`·`Stop`, 진행 중인 차례를 중단하면 `Interrupt`가 있다. 훅은 stdin으로 JSON 하나를 받고, 차례 이벤트에는 Codex 확장 필드 `turn_id`가 있다. `PermissionRequest`는 승인이 필요한 명령에만 실행된다. `async: true`인 훅은 Codex가 끝나기를 기다리지 않는다. 비관리 훅은 정의의 해시로 신뢰를 기록하므로 새로 추가되거나 바뀐 훅은 `/hooks`에서 신뢰하기 전에는 실행되지 않는다. `Stop`·`Interrupt`는 일반 텍스트 출력을 허용하지 않는다.
- 이 PC에 있는 Codex 실행 파일 두 개, npm 전역 설치본(0.162.1)과 Codex 앱 내장본(`0.162.0-alpha.17.2`)에 들어 있는 훅 입력 스키마(`*.command.input`)를 읽기 전용으로 추출했다. 두 실행 파일의 스키마는 아래 내용이 같았다. `interrupt`·`stop`·`user-prompt-submit`·`permission-request`·`post-tool-use`·`pre-tool-use` 모두 `turn_id`가 필수다. `permission-request`·`pre-tool-use`·`post-tool-use`·`user-prompt-submit`에는 하위 에이전트의 `agent_id`·`agent_type`이 선택 필드로 있고, `permission-request`에는 `tool_use_id`가 없다. `session-start`의 `source`는 `startup`·`resume`·`clear`·`compact`·`fork`다. 실행 파일에는 질문 도구 이름 `request_user_input`과 승인 창 문구("Yes, and don't ask again …", "No, and tell Codex what to do differently")도 들어 있다. 승인 창의 기본 선택과 단축키는 실행 파일에서 확인할 수 없었다.
- 훅 한 번은 Node 시작이 대부분이며, 이 PC에서 Node 시작은 5회 측정에 42~64ms였다.

## 설계 판단

- 신호 전달: Codex 훅의 stdout은 모델 맥락이 되므로 Claude처럼 터미널 신호(OSC)로 보낼 수 없다. 기존 재개 훅과 같이 셸별 토큰으로 인증된 이 PC 안의 이름 있는 파이프로 보낸다. 훅이 보내는 값은 이벤트 이름, 세션 UUID(기존), 시작 종류, `turn_id`와 하위 에이전트 ID의 SHA-256, 질문 도구 여부뿐이다. 미배포 변경부터는 승인 요청과 도구 보고에 도구 이름·명령(또는 입력)의 SHA-256도 보낸다([동시 실행과 자동 검토](#동시-실행과-자동-검토)). 질문·명령·도구 출력·답변·transcript 경로·모델 이름은 보내지 않는다. 파이프는 그 셸에서 마지막으로 시작한 실행·대화와 같은 것만 전달하고, 호스트는 형식을 다시 검사한 뒤 토큰이 맞는 실행 중 터미널에만 적용한다.
- 차례 판정(`CodexTaskState`): `UserPromptSubmit`은 작업 중, `PermissionRequest`나 질문 도구의 `PreToolUse`는 확인 요청(알림), `PostToolUse`는 작업 중, `Stop`은 응답 완료(알림), `Interrupt`는 대기다. `turn_id`로 다른 차례나 끝난 차례의 늦은 이벤트를 버린다. 압축이 아닌 `SessionStart`, `SessionEnd`, 셸 프롬프트 복귀는 초기화한다. 하위 에이전트의 요청은 그 에이전트의 도구가 끝날 때까지 확인 요청으로 두고, 하위 에이전트의 질문 입력과 종료는 사용자의 차례로 보지 않는다. 사용자의 차례가 없을 때 온 하위 에이전트 요청은 표시하지 않는다.
- 실행 방식: 모든 관리 훅을 동기로 실행해, Codex가 보고를 마친 뒤 다음 단계로 넘어가게 했다. 처음에는 도구마다 오는 `PostToolUse`를 백그라운드로 두었다. 그런데 실제 확인 중 검토에서 앞 도구의 늦은 완료 보고가 다음 승인 요청 표시를 지울 수 있다는 점이 드러나 동기로 바꿨다(아래 P2). 비용은 도구마다 Node 시작 시간(이 PC에서 42~64ms)이며, 같은 이벤트의 다른 훅과 함께 실행된다. 모든 관리 훅은 `Interrupt`·`SessionEnd`의 최대값인 3초 제한을 쓰고, `PreToolUse`는 `^request_user_input$`에만 등록했다. 도구 출력이 커도 상태가 빠지지 않도록 훅 입력 한도를 64KiB에서 4MiB로 늘렸다. 몽글 밖의 Codex(Codex 앱이나 다른 터미널)에서도 훅은 입력을 끝까지 읽은 뒤 끝난다. 전에는 읽지 않고 바로 끝나서, 출력이 큰 `PostToolUse`라면 Codex가 닫힌 파이프에 쓰게 될 수 있었다.
- 키 입력: Codex가 중단을 직접 알리므로 키는 보이는 요청에 대해서만 해석한다. Esc·Ctrl+C는 표시를 내린다(중단이나 거절). 요청이 뜬 뒤 다른 키 없이 누른 Enter는 미리 선택된 승인으로 보고 작업 중으로 표시한다. 그 밖의 답은 거절일 수 있어 표시를 내리고, 승인한 명령이 끝나면 다시 작업 중으로 표시한다. 기본 선택이 승인이라는 점은 Codex CLI 0.162.1의 명령 승인 창이 첫 항목 `Yes, proceed`를 선택한 채로 열리는 것으로 실제 확인했다([동기 훅 실제 확인](#동기-훅-실제-확인-2026-10-12)). 판정기에는 지금처럼 키의 의미만 전달하고 입력한 글자는 전달하지 않는다.
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

## 동기 훅 실제 확인 (2026-10-12)

사용자가 채팅으로 승인한 범위에서 아스트라가 다시 확인했다. 대상은 모든 몽글 훅을 동기로 실행하는 `ec1917d`를 %TEMP%에 복사해 빌드한 개발 앱이며, 0.3.21 공개본과 Codex 관련 코드가 같다. 격리 데이터 폴더와 `MONGLE_CODEX_HOME`(사용자 Codex 설정 폴더)으로 실행했다. 승인 창이 뜨도록 Codex CLI 0.162.1을 `codex -c approvals_reviewer=user -a on-request -s read-only`로 시작했고, `config.toml`은 직접 고치지 않았다. 모델 요청은 5번이었다.

- 훅: Codex `/hooks` 검토 화면에 바뀐 몽글 `PostToolUse` 훅이 동기 실행으로 나왔고, 그 훅 하나만 신뢰했다. `hooks.json`은 앱의 정상 연동으로 `PostToolUse`의 `async: true`만 빠졌고 명령문은 그대로였다.
- Enter 승인: 명령 승인 창(`Would you like to run the following command?`)이 뜨자 그룹·작업 줄·탭에 **확인 요청**이 표시됐다. 승인 창은 첫 항목 `Yes, proceed`를 선택한 채로 열렸고, Enter를 누르자 **작업 중**으로 바뀐 뒤 명령이 실행돼 격리 폴더에 파일이 생겼다.
- Esc 거절: 다음 요청의 승인 창에서 Esc를 누르자 Codex가 취소와 `Conversation interrupted`를 표시했고, 확인 요청이 사라진 뒤 다시 나타나지 않았다. 명령은 실행되지 않았다.
- 진행 중 중단: 긴 출력을 요청하고 Codex의 `Working`과 몽글의 **작업 중**이 보일 때 Esc를 눌렀다. 출력이 끝나기 전에 `Conversation interrupted`가 나왔고 작업 표시가 사라졌다.
- 질문 도구: `/plan`에서 Codex가 `request_user_input` 선택 창을 띄우자 **확인 요청**이 표시됐고, Enter로 답하자(`Questions 1/1 answered`) 사라졌다.
- 응답 완료 점: Codex 화면에서 응답이 끝난 것은 보았지만 몽글의 완료 점은 포착하지 못했다. 마지막 요청이 4초 만에 끝나, 설정 창으로 화면을 가린 시점이 완료보다 앞섰는지 확정할 수 없어 통과로 보지 않는다. 완료 점의 표시와 해제는 첫 번째 확인에서 보았다.
- 정리: Codex `/quit`와 설정 화면의 정상 호스트 종료 뒤, 남은 시험 Electron PID만 끝내고 TEMP 폴더를 지웠다. 설치본 몽글과 그 하위 셸·CLI 프로세스 35개가 그대로였고 Tailscale Serve 해시도 같았다. 신뢰 기록을 뺀 `config.toml` 내용 해시는 시험 전과 같았다. 기록은 커밋하지 않는 `test-results/phone-notifications-live/`에 있다.

## 동시 실행과 자동 검토

2026-10-12, 미배포. 0.3.21 공개 뒤 고쳤다.

- 문제 1(PR #69 검토 P2): 확인 요청을 스레드마다 하나로만 기억해, 같은 차례에서 함께 실행된 도구가 끝나면 아직 승인을 기다리는 요청까지 지웠다. 확인 요청 표시가 내려가고, 아직 보내지 않은 휴대폰 알림도 빠졌다.
- 문제 2(고치는 중에 발견): Codex는 자동 검토(`approvals_reviewer = "auto_review"`, `--approve-for-me`)를 쓸 때도 승인 요청 훅을 먼저 실행한다. 그래서 사람이 답할 필요가 없는 요청에도 확인 요청 표시와 앱 알림이 나왔고, 자리를 비웠으면 휴대폰 알림이 바로 나갔다.
- 근거: 2026-10-12에 Codex 공개 소스(openai/codex 기본 브랜치)를 읽었다. `codex-rs/core/src/tools/approvals.rs`는 승인을 훅, 자동 검토(켜져 있으면), 사용자 순으로 처리한다. 훅 입력의 `permission_mode`는 승인 정책만 반영하므로(`hook_runtime.rs`의 `hook_permission_mode`) 자동 검토 여부를 알 수 없고, 승인 요청에는 `tool_use_id`가 없다. 명령 실행의 승인 요청 입력은 `{"command": 명령, "description": 사유}`이고, 작업 시작·완료 입력은 `{"command": 명령}`이다. 둘 다 같은 `cmd` 인자에서 만든다(`exec_command.rs`, `context.rs`). 파일 수정은 세 경우 모두 `{"command": 패치}`다. 승인 창의 제목과 바닥글은 `codex-rs/tui/src/bottom_pane/approval_overlay.rs`에 있다(`Would you like to run the following command?` 등, `Press enter to confirm or esc to cancel`). 자동 검토 중에는 `Reviewing approval request`가 표시된다. 이 문구들은 이 PC의 Codex 0.162.1 실행 파일에도 들어 있다.
- 지문 맞추기: 훅이 도구 이름과 명령(명령이 없으면 키를 정렬한 입력 전체)의 SHA-256을 함께 보낸다. 원문은 보내지 않는다. 끝난 도구는 같은 스레드에서 지문이 같은 요청만 지운다. 지문이 없는 이전 훅 스크립트의 보고는 예전처럼 그 스레드의 가장 오래된 요청을 지운다.
- 누가 답하는지: 승인 요청은 바로 표시하지 않는다. 그 터미널의 보이는 화면에 Codex 승인 창의 제목이나 바닥글이 나타나면 확인 요청(알림 포함)으로 표시하고, 자동 검토 표시가 나타나면 버린다. 요청이 도착한 순간에는 승인 창만 본다. 화면에 남아 있는 이전 요청의 자동 검토 표시로 새 요청을 버리지 않기 위해서다. 2.5초 안에 둘 다 알아보지 못하면(Codex 문구가 바뀐 경우 등) 이전처럼 확인 요청으로 표시한다. 판단하기 전에 Enter로 답한 요청은 표시하지 않는다. 화면은 훅이 이미 보고한 요청을 누가 답하는지만 판단하며, 화면만으로 요청이나 상태를 만들지 않는다.
- 다시 신뢰할 필요 없음: 훅 등록 내용(`hooks.json`)은 바꾸지 않았다. 훅 스크립트와 호스트만 바뀌었으므로 Codex `/hooks`에서 다시 신뢰하지 않아도 된다.
- 변경: `packages/host/codex-hook-source.ts`(지문), `packages/terminal/agent-status.ts`(`CodexTaskState`의 요청 목록, `observeScreen`, `showOverdue`), `packages/terminal/engine.ts`(출력 뒤 화면 판독, 2.5초 대기, 종료 시 정리).
- 검증: 타입 검사·빌드, 격리한 `MONGLE_DATA_DIR`의 전체 회귀 653개 중 635 통과·1 실패(기존 PowerShell 실행 정책 환경 문제)·17 생략. `tests/terminal/codex-status.test.ts` 11/11(신규 6, 아래 훅 확인 창 감지 1개 포함): 함께 실행된 도구, 같은 명령 두 번, 지문 없는 이전 보고, 자동 검토의 승인·거절, 2.5초 대기와 판단 전에 답한 키, 엔진의 화면 판독(Codex가 나눈 줄과 터미널이 접은 줄, 이전 요청의 검토 표시), 엔진의 대기 타이머. `tests/host/codex-integration.test.ts` 9/9: 같은 명령의 승인 요청과 완료 보고는 사유와 관계없이 같은 지문, 다른 명령은 다른 지문, 원문은 보내지 않음. Claude 상태 시험 16/16.
- 실제 확인(2026-10-12, 아스트라): `fc3a5a3`을 TEMP에 복사해 빌드한 격리 앱, 사용자 Codex 설정 폴더, Codex CLI 0.162.1로 확인했다. 모델 요청은 3번이었다. 승인 설정을 덮어쓰지 않은 실행에서는 사용자 승인 없이 시험 파일이 만들어졌고, 관찰한 시작·완료 화면에 물음표와 알림 표시가 없었다. `Reviewing approval request` 화면은 짧게 지나가 포착하지 못해, 자동 검토 구간 전체의 표시 억제는 확인하지 못했다. `approvals_reviewer=user`로 실행하자 승인 창과 물음표가 함께 나타났고, Enter로 승인하자 작업 중으로 바뀐 뒤 파일이 만들어졌다. 두 도구를 병렬로 실행하게 한 요청에서는 읽기 명령이 Codex 실행 환경 오류(`helper_unknown_error: setup refresh had errors`)로 실행 전에 실패했다. 그동안 쓰기 승인 대기 표시는 유지됐지만, 다른 도구가 정상으로 끝난 뒤에도 유지되는지는 확인하지 못했다. 훅 등록 내용은 그대로였고 Codex는 신뢰를 다시 묻지 않았다. 정리 뒤 설치본 프로세스 35개, Tailscale Serve, `config.toml`·`hooks.json`은 시험 전과 같았고, 사용자 Codex 폴더의 훅 스크립트만 이번 빌드 내용으로 바뀌었다. 기록은 커밋하지 않는 `test-results/codex-parallel-live/`에 있다.
- 확인하지 않은 범위: 자동 검토 구간 전체, 다른 도구가 정상으로 끝나는 실제 동시 실행. MCP 도구 승인처럼 제목을 따로 등록하지 않은 승인 창은 공통 바닥글로 알아보며, 바닥글 문구가 다르면 2.5초 뒤 표시된다. 다른 훅이 도구 입력을 바꾸거나 승인을 대신 결정하면 지문이나 화면 판단이 어긋날 수 있다.

## 훅 확인 창 안내

2026-10-12, 미배포.

- 배경: 사용자가 실제 사용자에게 훅 신뢰를 어떻게 알릴지 물었다. 그때까지 안내는 README·사용 안내·배포 안내·설정 도움말에 "`/hooks`를 열어 신뢰"로만 있었다.
- 근거: Codex는 새로 생기거나 바뀐 훅이 있으면 시작할 때 스스로 확인 창을 띄운다. 0.3.17 시험에서 몽글 안의 Codex가 띄운 실제 화면(`test-results/codex-resume-desktop/frame-trust-ready.json`)은 제목 `Hooks need review`, `2 hooks are new or changed.`, 선택지 `1. Review hooks`(처음 선택됨)·`2. Trust all and continue`·`3. Continue without trusting (hooks won't run)`, 바닥글 `enter confirm · esc skip`이었다. 같은 문구가 이 PC의 Codex 0.162.1 실행 파일(`tui/src/startup_hooks_review.rs`)에도 있다. 영어 창이고 몽글 훅이라는 설명이 없어 건너뛰기 쉽다.
- 설계: 엔진이 출력 뒤 전체 화면(대체 화면)에 `Hooks need review`와 `Trust all and continue`가 함께 보이는지 보고, 바뀔 때만 `codexHooksReview`를 알린다. 일반 셸 출력의 같은 글자는 무시한다. 호스트가 터미널 정보에 실어 보내고, 터미널이 끝나거나 다시 시작하면 지운다. 화면은 그 터미널 아래, 기존 경고 띠와 같은 자리와 모양으로 안내한다. 신뢰는 사용자의 결정이고 `Trust all and continue`는 다른 프로그램의 훅도 함께 신뢰하므로, 대신 누르는 버튼은 두지 않고 다른 훅이 있으면 `1. Review hooks`에서 확인하라고 적었다.
- 변경: `packages/terminal/engine.ts`(감지), `packages/terminal/types.ts`·`packages/protocol/index.ts`(`codexHooksReview`), `packages/host/core.ts`(전달·정리), `apps/web/src/TerminalPane.tsx`·`styles.css`(안내 띠), `apps/web/src/Settings.tsx`·`packages/host/codex-integration.ts`(안내 문구).
- 검증: 타입 검사. `tests/terminal/codex-status.test.ts`의 엔진 감지 시험(일반 출력의 같은 글자 무시, 창이 뜨면 한 번, 답하면 내림).
- 실제 확인(2026-10-12, 아스트라): 같은 격리 앱에서 PowerShell로 같은 문구를 전체 화면에 그려 확인했다. 첫 명령에서는 전체 화면에 남은 이전 글자가 제목 바로 뒤에 붙어 알아보지 못했다(`ad43a23`에서 제목 뒤 공백을 요구하지 않게 고침). 화면을 지운 명령에서는 PC 앱과 Aside 원격 화면(기본 폭) 모두에 안내 띠가 나타났고 Enter 뒤 사라졌다. Aside 원격 화면은 캡처가 시간 초과되어 접근성 기록으로 확인했다. 실제 Codex가 띄운 확인 창은 이번에 관찰하지 못했다. 다만 0.3.17 시험에서 몽글 안의 Codex가 그린 화면 기록 21개는 모두 전체 화면 모드였다. 배포 저장소 README의 0.3.21 안내도 같은 기준으로 고쳤다(배포 저장소 PR #15).
- 확인하지 않은 범위: 실제 Codex 확인 창에서의 안내 띠, 390px 같은 좁은 화면, `--no-alt-screen`으로 실행한 Codex. 저장소 규칙의 Mobbin 사례 확인은 Aside에서 Mobbin이 로그아웃되어 있어 하지 못했다.

## 확인하지 않은 범위

- 승인 창에서 Enter·Esc 외의 선택지(다시 묻지 않고 허용, Codex에 다르게 하라고 답하기)와 단축키(`y` 등). 동기 훅 확인에서는 Enter 승인과 Esc 거절만 눌렀다.
- 동기 훅 빌드에서의 응답 완료 점(위 동기 훅 확인에서 포착하지 못함).
- P2가 지적한 순서(앞 도구의 완료 보고가 다음 승인 요청보다 늦게 도착)를 실제 Codex에서 재현하지는 않았다. 동기 훅 빌드에서 승인·거절·중단·질문 표시가 맞는 것은 확인했다. 비동기 `PostToolUse`를 신뢰했던 Codex 설정에서는 신뢰 해시가 달라져 `/hooks`에서 다시 신뢰해야 한다(동기 훅 확인에서 다시 신뢰했다).
- 휴대폰 브라우저에서의 표시.
- Codex 0.162.0보다 낮은 버전이 새 이벤트 이름을 만났을 때의 동작. 그래서 그 버전에는 등록하지 않는다. 다만 호스트가 확인하는 실행 파일과 몽글 터미널에서 실행되는 실행 파일이 다를 수 있다. 예를 들어 Codex 앱 내장본은 새 버전이고 npm 설치본이 오래되었다면, 오래된 CLI가 새 이벤트가 든 `hooks.json`을 읽게 된다.
- 0.3.21에서는 같은 차례에서 함께 실행된 도구가 먼저 끝나면 아직 승인을 기다리는 요청의 확인 요청 표시가 내려가고, 아직 보내지 않은 [휴대폰 알림](phone-notifications.md)도 빠졌다(GitHub Codex 검토 PR #69의 P2). [동시 실행과 자동 검토](#동시-실행과-자동-검토)에서 고쳤고(미배포), 실제 Codex에서는 아직 확인하지 않았다.
- 사용자의 차례가 끝난 뒤에도 실행 중인 하위 에이전트의 요청은 표시하지 않는다. 다른 훅이 `Stop`에서 차례를 이어 가게 하면 첫 `Stop`에서 응답 완료로 표시한다.
- cmd·Git Bash·WSL, `codex exec`, 실행 파일 직접 호출.
