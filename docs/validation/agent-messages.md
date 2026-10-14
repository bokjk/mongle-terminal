# 에이전트에게 메시지 보내기

2026-10-14, Windows x64, 미배포. PowerShell 터미널에서 실행 중인 Claude Code·Codex에게 제어권 없이 메시지를 보내는 기능이다. AI 팀 기능의 1단계 "안전한 전달"에 해당한다([설계안](https://github.com/bokjk/mongle-terminal/pull/88)). 팀 없이도 쓸 수 있다.

## 배경

AI 팀에서는 팀장과 구성원이 서로의 터미널에 메시지를 넣어야 한다. 사람이 그 터미널에 입력하는 중이거나, 에이전트가 일하거나 승인 창을 띄운 중에 글을 넣으면 사람의 글과 섞이거나 Enter가 승인으로 처리될 수 있다. 에이전트가 끝나 셸 프롬프트로 돌아온 뒤에 넣으면 메시지가 PowerShell 명령으로 실행된다. 1단계는 이런 경우를 모두 피해서 보내는 길을 호스트에 만든다. 사람이 쓰는 화면(휴대폰 포함)도 이 길을 쓴다.

## 근거

- 0단계 확인 실험([PR #88](https://github.com/bokjk/mongle-terminal/pull/88)의 `docs/validation/agent-team-probe.md`): 대화형 Claude Code 2.1.299와 Codex 0.162.1 모두 bracketed paste(`ESC[200~ … ESC[201~`)로 넣은 여러 줄 글을 입력창에 받고, 따로 보낸 Enter에 응답했다. 붙여 넣은 직후에는 전송되지 않았다.
- 2026-10-14 추가 확인(같은 격리 폴더, 아래 "구현 전 확인"): 여러 줄·긴 글 붙여넣기.
- Claude Channels는 이 PC의 Team 계정에서 조직 정책으로 막혀 있었다(0단계). 그래서 두 CLI 모두 보호된 터미널 입력을 쓴다.
- `codex queue`는 0단계에서 `--no-daemon` Codex에 닿았지만, 호스트가 사용자 셸과 같은 Codex 실행 파일·버전을 찾아 실행해야 한다. 이 PC에서는 PATH의 첫 `codex.exe`가 Codex 앱 내장본(0.162.0-alpha)이고 셸의 `codex`는 npm 설치본(0.162.1)이다([Codex 작업 상태](codex-status.md)). 차례가 중단되면 대기열이 멈추는 문제도 있다. 1단계에서는 쓰지 않고, 에이전트끼리 보내는 3단계에서 다시 판단한다.

## 구현 전 확인 (2026-10-14)

0단계와 같은 격리 폴더(`.test-data\agent-team-probe\work`)와 PTY 제어 스크립트로 확인했다.

- Codex 0.162.1(`gpt-6-luna`): 세 줄짜리 한국어·영어 글을 붙여 넣자 입력창에 세 줄로 들어가고 전송되지 않았다. Enter를 보내자 응답했다. 다만 `→`(U+2192)가 화면에서 사라졌다. 메시지 본문은 그대로 보내지만, 몽글이 붙이는 머리말에는 이런 기호를 쓰지 않는다.
- Claude Code 2.1.299(`haiku`): 같은 세 줄 글을 세 줄로 받고 Enter에 응답했다. 약 1,450자 글은 `[Pasted text #1 +1 lines]`로 접혀 들어갔고 Enter에 응답했다.

## 동작

- **보낼 수 있는 조건:** 터미널이 PowerShell이고(셸 프롬프트로 돌아온 것을 알리는 몽글 표식이 PowerShell 통합에만 있다), 그 셸에서 Claude의 `SessionStart`·`UserPromptSubmit` 훅이나 Codex의 `SessionStart` 훅이 대화 ID를 알려 왔고, 그 뒤 셸 프롬프트 표식이나 대화 종료 신호가 오지 않았을 때. 화면 글자는 읽지 않는다.
- **보류 조건:** 방해 금지, 에이전트 없음, 앞 메시지가 아직 차례를 시작하지 않음(최대 20초), 확인 요청 중, 작업 중, 시작 직후 1.5초, 사람이 Enter로 보낸 입력에 아직 훅이 반응하지 않음(`/model`처럼 메뉴를 여는 명령), 사람이 3초 안에 입력했거나 쓰다 만 글이 있음. 쓰다 만 글은 Enter(붙여넣기 안의 Enter와 win32-input-mode의 Enter 누름 구분)가 지울 때까지 있다고 본다. 지운 키(Backspace)로는 비었는지 알 수 없다.
- **지금 보내기:** 사람의 입력 때문에 기다리는 경우(입력 중·처리 대기)만 건너뛴다. 작업 중·확인 요청·방해 금지·에이전트 없음은 건너뛰지 않는다.
- **전달:** 한 번에 하나. 본문은 글자·줄바꿈·탭만 남기고(제어 문자, ESC, C1 제어 문자, U+2028·2029 제거) 줄바꿈은 CR로 바꿔 bracketed paste 하나로 쓴다. 150ms 뒤 에이전트가 여전히 실행 중일 때만 Enter를 따로 쓴다. 다음 메시지는 그 메시지로 차례가 시작(작업 중·확인 요청)되거나 20초가 지난 뒤 보낸다.
- **보관:** 보내기 전 메시지는 실행부 메모리에만 있고, 터미널 세대(새 셸·종료·실행부 재시작)와 함께 사라진다. 다른 기기에는 앞 120자 미리보기와 보낸 기기 이름만 전달한다. 방해 금지는 터미널 설정으로 저장한다. 한 메시지 4,000자, 터미널당 10개까지.
- **프로토콜:** `agent.message.send`·`agent.message.cancel`·`agent.message.force`·`agent.dnd` 요청과 `TerminalInfo`의 `agentReady`·`agentInbox`·`agentDnd`. 호스트가 `agent.messages` 기능을 알릴 때만 화면에 메뉴를 보여 준다. 제어권은 필요 없다.

## 화면

저장소 규칙에 따라 구현 전에 Mobbin을 확인했다(2026-10-14, Aside, `bok` 계정 Free 요금제). Slack 웹 `Pausing notifications`(3개 화면), Superhuman 웹 `Scheduling a message`(4개)·`Setting up a reminder`(6개), Linear 웹 `Snoozing a notification`(3개), Discord iOS `Sending a new message`(8개) 흐름을 찾았지만, 화면 이미지가 Pro 제한으로 흐리게 가려져 버튼 문구·대기 표시·방해 금지 토글 위치를 확인하지 못했다. Telegram iOS에서는 예약 메시지 흐름을 찾지 못했다. 그래서 다른 앱의 패턴을 참고했다고 하지 않고, 몽글의 기존 패턴을 따랐다. 터미널 아래 안내 줄은 Codex 훅 안내·파일 첨부 진행 줄과 같은 모양이고, 작성 창은 기존 모달이며, 메뉴 항목은 기존 `···` 메뉴에 넣었다.

- 터미널 머리줄의 말풍선 버튼(보낼 메시지 수 표시), `···` 메뉴의 **Claude Code에게 메시지…**·**방해 금지 켜기/끄기**.
- 메시지 창: 설명 한 줄, 방해 금지 안내, 입력칸(4,000자, `Ctrl+Enter`), **보내기**.
- 터미널 아래 알림 줄: **보낼 메시지 N개**, 기다리는 이유, 맨 앞 메시지 미리보기, 입력 때문일 때만 **지금 보내기**, 맨 앞 메시지 취소.

## 변경

- `packages/host/agent-inbox.ts`(신규): 보류함, 쓰다 만 글 판정, 본문 정리.
- `packages/host/core.ts`: 터미널 세대마다 보류함 생성, 훅·셸 프롬프트·사람 입력 연결, 요청 4개, 저장에서 메모리 상태 제외, 기능 표시.
- `packages/terminal/engine.ts`·`types.ts`: 상태가 바뀌지 않은 훅 신호도 알리는 `onAgentReport`.
- `packages/protocol/index.ts`: `AgentHoldReason`·`AgentInboxSummary`와 `TerminalInfo` 필드.
- `apps/web/src/AgentMessage.tsx`(신규)·`TerminalPane.tsx`·`styles.css`: 메시지 창, 알림 줄, 메뉴와 버튼.

## 검증

- `npm.cmd run typecheck`, `npm.cmd run build` 통과(기존 대형 청크 경고만 있음).
- `tests/host/agent-inbox.test.ts` 6/6(신규): 본문 정리, 쓰다 만 글 판정(화살표·포커스 보고 무시, 지우기 뒤에도 유지, 붙여넣기 안의 Enter, win32 Enter·글자 누름과 뗌), 훅 확인 전 쓰지 않음·시작 직후 대기·붙여넣기와 별도 Enter, 차례 시작 확인 뒤 다음 메시지, 작업 중·확인 요청 보류, 입력·쓰다 만 글·처리 대기 보류와 지금 보내기의 범위, 방해 금지·취소, 붙여 넣은 뒤 셸 프롬프트가 돌아오면 Enter를 쓰지 않음, 차례 시작 신호가 없을 때 20초 대기 뒤 다음 메시지, 폐기 뒤 쓰지 않음.
- `tests/host/agent-messages.test.ts` 1/1(신규): 실제 HostCore와 PTY, Claude 훅 OSC와 셸 프롬프트 표식을 내보내는 가짜 셸로 확인. 호스트가 PTY에 쓴 바이트를 기록해 붙여넣기 하나와 별도 Enter, 작업 중 보류 뒤 전달, 방해 금지·취소, 사람의 쓰다 만 글과 지금 보내기, 셸 프롬프트 뒤 보내지 않음, 명령 프롬프트 거부, 다시 시작한 뒤 방해 금지만 남고 메시지·준비 상태는 저장되지 않음을 확인했다.
- `tests/ui/agent-message.test.ts` 3/3(신규): 보낼 수 있는 조건, 보류 이유 문구, 알림 줄의 지금 보내기 표시 조건.
- 관련 회귀(Claude·Codex 상태, 코어, 대화 재개, 작업 복원, 저장, 알림, 종료, 엔진) 109/109 통과.
