# AI 팀 0단계 확인 실험

2026-10-14, Windows x64. [AI 팀 기능 설계안](../08-agent-team-design.md#먼저-확인할-항목)의 "먼저 확인할 항목"을 구현 전에 실제 Claude Code·Codex CLI로 확인했다. 몽글 코드는 바꾸지 않았고 몽글 앱도 실행하지 않았다. 이 기록은 설계 판단의 근거이며 기능 구현·출시 검증이 아니다.

## 조건

- 도구: Codex CLI 0.162.1(npm 설치본), Claude Code 2.1.299, Claude Agent SDK 0.3.299(시험 폴더에만 설치), Node 24.11.1. Claude Code는 실험을 시작할 때 2.1.296이었고 사용자가 다시 로그인한 뒤 2.1.299로 바뀌었다. 실험에서 설치하거나 업데이트하지 않았으며, 대화형 시작 화면과 실험 뒤 `claude --version`이 모두 2.1.299였다.
- 장소: 커밋하지 않는 `.test-data\agent-team-probe\work`에 만든 빈 Git 저장소. 대화형 CLI는 node-pty 1.1.0과 @xterm/headless로 만든 터미널(150×45)에서 실행하고 화면 글자로 결과를 읽었다. 몽글 셸 통합(`__MongleCodex`)은 쓰지 않고 `codex --no-daemon`을 직접 실행해 같은 조건을 만들었다.
- 계정: 이 PC에 로그인된 Codex 계정과 Claude Code 계정(Claude Team). 실험 중 Claude 로그인이 만료돼 사용자가 다시 로그인했다.
- 모델 요청: 짧은 요청 약 50회. Claude는 `haiku`, Codex는 `gpt-6-luna`(추론 low)를 썼다.
- Codex 격리 실행: 사용자 설정(`[windows] sandbox = "elevated"`)에서는 격리 준비 단계가 다른 프로세스가 쓰고 있는 파일(Codex 앱 런타임의 `node_repl.exe`) 때문에 실패했다. 그 결과 모든 명령이 `helper_unknown_error: setup refresh had errors`로 실행되지 않았다. 이후 Codex 실험은 `-c windows.sandbox="unelevated"`를 붙여 실행했다.

## 결과 요약

| 항목 | 결과 | 설계에 주는 영향 |
|---|---|---|
| (a) `codex queue` → `--no-daemon` Codex | 닿음. 쉬는 중이면 수 초 안에, 작업 중이면 차례가 끝난 뒤, 꺼져 있으면 다시 켤 때 전달. 사람 승인 창이 떠 있는 동안은 전달하지 않음. 승인을 거절해 차례가 중단되면 다음 차례가 끝날 때까지 멈춤 | Codex 기본 경로로 확정. 중단 뒤에는 다른 경로가 필요 |
| (b) Claude Channels | 이 계정은 조직 정책으로 막힘 | Claude 기본 경로를 보호된 터미널 입력으로 |
| 보호된 터미널 입력(Claude) | 붙여넣은 내용이 Enter 전까지 입력창에 머물고, Enter 뒤 정상 응답 | Claude 기본 경로 |
| (c) 역할 지시문 | 두 CLI 모두 적용되고 이어 하기 뒤에도 남음. Claude는 지시문 없이 이어 켠 실행에서 압축하면 사라짐 | 켤 때마다 지시문을 붙이고 압축 뒤 다시 알림 |
| (d) 읽기 전용 | Claude `--tools Read,Grep,Glob`, Codex `-s read-only -a never`는 막음. Codex `-s read-only -a on-request`는 사용자의 자동 검토가 권한 상승을 승인해 파일이 만들어짐 | 검토·조사 Codex는 `-a never`도 함께 |
| (e) 모델 목록 | Codex `model/list` 7개, Claude 13개(SDK `supportedModels()`). 로그인한 계정만으로 동작 | 목록을 도구에서 받는 방식 유지 |

## (a) codex queue

대화형 Codex를 `codex --no-daemon -m gpt-6-luna ...`로 켜고, 다른 프로세스에서 `codex queue --thread <ID> --message ...`를 실행했다. 공용 백그라운드 서버(daemon)는 꺼져 있었다(`codex app-server daemon version`이 연결 거부).

| 상황 | 결과 |
|---|---|
| 쉬는 중 | `Queued message ...`가 나온 뒤 약 6초 안에 새 차례로 시작해 응답(2회) |
| 20초·75초 명령 실행 중 | 실행 중에는 끼어들지 않고, 차례가 끝나자 다음 차례로 시작(2회) |
| 사람이 입력창에 글을 쓰다 멈춘 상태 | 약 6초 뒤 전달됨. 쓰던 글은 입력창에 그대로 남음 |
| 사람 승인 창(`-c approvals_reviewer="user"`) | 25초 동안 전달하지 않고 승인 창을 유지 |
| 승인 창에서 Esc로 거절해 차례 중단 | 45초 동안 전달되지 않음. 사람이 다음 요청을 보내 그 차례가 끝나자 전달 |
| 자동 검토(사용자 설정 `approvals_reviewer = "auto_review"`)로 승인된 차례 | 차례가 끝난 뒤 전달 |
| Codex를 끈 상태 | `codex queue`는 성공. `codex resume --no-daemon`으로 켜자 약 15초 안에 전달 |

`codex queue` 한 번은 약 5초 걸렸다. 공개 소스(openai/codex의 `codex-rs/ext/queue/src/service.rs`, `codex-rs/tui/src/session_queue_commands.rs`, 2026-10-14 main)를 읽어 보면, 메시지는 대화 저장소(SQLite)에 쌓이고 실행 중인 Codex가 10초마다 변경을 확인해 대화가 쉬고 있을 때 시작한다. 대화 상태가 `Interrupted`이면 꺼내지 않는다. 위의 "중단 뒤 멈춤"과 맞는다. `codex queue` 자체는 `--no-daemon`을 받지 않고, daemon이 없으면 내장 서버로 저장한다. daemon이 켜져 있을 때의 동작은 확인하지 않았다.

## (b) Claude Channels

stdio MCP 서버 하나를 만들었다. `claude/channel` 기능을 선언하고, 127.0.0.1로 들어온 POST를 `notifications/claude/channel`로 넘기는 서버다. 이 서버를 `--mcp-config`로 넣고 `claude --dangerously-load-development-channels server:mongleprobe`로 대화형 실행했다. 시작 화면에 다음이 나왔다.

```text
--dangerously-load-development-channels blocked by org policy (server:mongleprobe)
Inbound messages will be silently dropped
Have an administrator set channelsEnabled: true in managed settings to enable
server:mongleprobe · no MCP server configured with that name
Channels are not enabled for your org · have an administrator set channelsEnabled: true in managed settings
```

MCP 서버는 시작되어 `initialize`를 받았다. Team·Enterprise 조직은 관리자가 Channels를 켜야 한다는 [공식 문서](https://code.claude.com/docs/en/channels-reference)(2026-10-14 확인)와 맞는다. 정책 때문에 수신은 확인하지 못했고, 이어서 켠 대화에서의 동작([#67024](https://github.com/anthropics/claude-code/issues/67024))도 확인하지 못했다. "no MCP server configured with that name"이 `--mcp-config`로 넣은 서버라서 나온 것인지도 가릴 수 없었다.

## 보호된 터미널 입력

대화형 Claude 입력창에 bracketed paste(`ESC[200~ … ESC[201~`)로 메시지를 넣고, 0.7초 뒤 Enter를 따로 보냈다. 붙여넣은 직후에는 입력창에만 들어가 있었고, Enter를 보내자 정상 응답했다. 사람이 입력 중이거나 승인 창이 떠 있을 때 넣으면 글이 섞이거나 Enter가 승인으로 처리될 수 있어 시험하지 않았다. 설계대로 이때는 보류한다.

## (c) 역할 지시문

"Team codename: PELICAN-73 …"을 지시문으로 넣고, 지시문에 있는 팀 암호명을 물었다. 대화 기록에 같은 단어가 이미 있으면 답이 기록에서 나올 수 있으므로, 기록에 그 단어가 없을 때의 답만 근거로 삼았다.

| 경우 | Claude Code | Codex |
|---|---|---|
| 지시문 없음 | NONE | NONE |
| 지시문을 붙여 실행 | 답함(`--append-system-prompt`) | 답함(`-c developer_instructions=...`) |
| 지시문 없이 이어 하기 | 유지(`-p --resume`) | 유지(`exec resume`, 대화형 `resume`) |
| 지시문을 붙인 실행에서 `/compact` | 유지. 그 뒤 지시문 없이 이어 해도 유지 | 유지 |
| 지시문 없이 이어 켠 실행에서 `/compact` | **사라짐** | 확인 못 함(기록에 같은 단어가 있었음) |
| 사라진 뒤 지시문을 다시 붙여 이어 하기 | 여전히 없음 | — |

Claude 결과는 도움말의 `--system-prompt-snapshot` 설명과 맞는다. 처음 기록한 시스템 프롬프트를 압축 전까지 그대로 다시 쓰고, 압축이 일어난 실행에서 새로 기록한다. 그래서 압축이 일어난 실행에 지시문이 없으면 지시문이 빠진 상태로 다시 기록된다. `--system-prompt-snapshot off`와 지시문을 함께 주면 다시 답했지만, 그 대화 기록에 같은 단어가 있어 단정하지 않는다.

## (d) 읽기 전용

"현재 폴더에 파일을 만들라"고 요청한 뒤 파일이 생겼는지 직접 확인했다.

| 설정 | 결과 |
|---|---|
| Claude `-p --permission-mode plan` | 안 만듦(계획만 작성) |
| Claude `-p --permission-mode bypassPermissions --tools Read,Grep,Glob` | 안 만듦 |
| Claude `-p --permission-mode bypassPermissions --disallowed-tools Write,Edit,NotebookEdit,Bash,PowerShell` | 안 만듦 |
| Claude 대화형 `--tools Read,Grep,Glob` | `No such tool available: Write`로 실패 |
| Claude `-p --permission-mode acceptEdits`(대조) | 만듦 |
| Codex `exec -s read-only` | 접근 거부 |
| Codex `exec -s workspace-write`(대조) | 만듦 |
| Codex 대화형 `-s read-only -a never` | 접근 거부 |
| Codex 대화형 `-s read-only -a on-request`, 사용자 설정 `approvals_reviewer = "auto_review"` | 모델이 권한 상승을 요청했고 자동 검토가 승인해 **만듦** |
| Codex 대화형 `-s read-only -a on-request -c approvals_reviewer="user"` | 승인 창이 떴고, 거절하자 안 만듦 |

Codex 대화 기록의 차례 설정에서 `sandbox_policy`가 `read-only`로 바뀐 것도 확인했다. Claude의 `--tools`는 내장 도구만 정한다. 사용자가 설정한 MCP 서버의 도구로 쓰기가 가능한지는 확인하지 않았다.

## (e) 모델 목록

- Codex: `codex app-server`(stdio)에 `initialize` 뒤 `model/list`를 보냈다. 7개가 왔다. `gpt-6-astra`(기본), `gpt-6.1-sol`, `gpt-6-luna`와 `anthropic/claude-fable-5-1`·`anthropic/claude-haiku-5-5`·`anthropic/claude-opus-5-5`·`anthropic/claude-sonnet-5-5`다. `anthropic/...` 항목은 이 PC의 Codex 공급자 설정에서 온 것이다. `experimentalApi`를 켜지 않아도 같은 목록을 받았다. 모델 요청은 보내지 않았다.
- Claude: Agent SDK 0.3.299의 `query().supportedModels()`와, 같은 정보를 주는 `claude -p --input-format stream-json`의 `initialize` 제어 요청이 모두 13개를 돌려줬다. 별칭 `default`·`opus`·`fable`·`sonnet`·`haiku`와 고정 이름들이다. 다시 로그인한 뒤에는 `default`·`opus`가 `claude-opus-5-5`, `sonnet`이 `claude-sonnet-5-5`, `haiku`가 `claude-haiku-5-5`를 가리켰다. 로그인 만료를 확인하기 직전에 받은 목록에서는 `default`가 `claude-fable-5-1`이었다. 가리키는 모델은 계정과 시점에 따라 달라진다.

## 설계에 반영한 점

1. Claude 기본 배달 경로를 보호된 터미널 입력으로 바꾸고, Channels는 조직에서 켠 경우에만 쓰는 선택 경로로 낮췄다.
2. Codex는 `codex queue`를 기본 경로로 확정했다. 차례가 중단되면 Codex 대기열이 멈추므로, 중단(`Interrupt`) 뒤에는 보호된 터미널 입력으로 보낸다. 이미 대기열에 들어간 메시지가 있으면 사용자에게 알린다.
3. 검토·조사 역할의 Codex는 `-s read-only -a never`로 실행한다.
4. 몽글은 구성원을 켤 때마다(이어 하기 포함) 역할 지시문을 붙인다. 사용자가 지시문 없이 이어 켠 뒤 압축하면 Claude의 지시문이 사라지므로, `SessionStart`의 시작 종류가 `compact`이면 역할 요약을 다시 보낸다.
5. 모델은 각 CLI가 돌려준 목록을 그대로 보여 준다. 별칭이 가리키는 모델은 계정에 따라 다르다.
6. 시작 전 점검에 Codex 명령 실행 확인을 넣는다. 이 PC처럼 격리 준비가 실패하면 구성원이 명령을 하나도 실행하지 못한다. 모델 요청 없이 확인하는 방법은 1단계에서 정한다.

## 남은 흔적과 정리

- Codex `config.toml`에 시험 폴더 `work`의 신뢰 항목이 추가됐다. Claude Code에서도 같은 폴더를 신뢰했다(`Yes, I trust this folder`). 다른 설정은 고치지 않았다.
- 사용자 프로필에 Codex 대화 기록 10개와 Claude 대화 기록 폴더 2개(`work`, `work\sub`)가 남았다. 지우지 않았다.
- 자동 검토가 승인한 쓰기 1건(`approval-test.txt`)은 시험 폴더 안이었다.
- 실험에서 띄운 claude·codex 프로세스는 모두 종료했다. 몽글 호스트, 사용자 셸, Tailscale Serve는 건드리지 않았다.
- 사용자 Claude 설정의 훅 일부(`SessionStart`·`UserPromptSubmit`)가 Python을 찾지 못해 오류를 냈다. 결과에는 영향이 없었다. 팀 구성원 CLI도 사용자 훅을 그대로 실행한다.
- 실험 스크립트와 로그는 커밋하지 않는 `.test-data\agent-team-probe`에 있다.
