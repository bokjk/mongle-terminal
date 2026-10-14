# AI 팀 실행 (호스트)

2026-10-15, Windows x64, 미배포. AI 팀 기능의 2단계 중 호스트 부분이다([설계안](../08-agent-team-design.md)). 팀 화면과 새 작업 흐름은 [AI 팀 화면](agent-teams-ui.md)에 있다.

## 동작

- **템플릿:** 기본 제공 3개(설계·개발·검토 3명, 4명 개발팀, 구현·검토 2명)는 바꾸거나 지울 수 없다. 사용자가 고친 구성은 `user:` 아이디로 따로 저장한다(최대 50개).
- **구성원:** 이름, 역할(설계(팀장)·개발·검토·테스트·조사·직접 만들기), CLI(Claude Code·Codex), 모델, 끝나면 보고할 대상, 역할 지시문, 덧붙일 말, 작업 폴더(기본 폴더·새 워크트리), 읽기 전용. 첫 구성원이 팀장이다. 최대 6명.
- **시작 전 점검(`teams.check`):** PowerShell, CLI별 설치·버전·로그인·몽글 연동, 작업 폴더, 워크트리가 필요할 때 그룹에 연결된 Git 저장소와 저장하지 않은 변경 수, 터미널 한도, 읽기 전용 구성원, 팀 구성 오류를 줄마다 알린다. 오류가 하나라도 있으면 팀을 시작하지 않는다. 모델 요청은 보내지 않는다.
- **팀 시작(`teams.start`):** 구성원마다 기본 폴더 터미널 또는 기존 워크트리 작업(`worktrees.create`)으로 만든 워크트리의 터미널을 PowerShell 탭으로 연다. 탭 이름은 구성원 이름이다. 셸이 첫 프롬프트를 낸 뒤 CLI 실행 줄을 한 번 입력한다. 그 전에 사람이 입력하거나 15초 안에 프롬프트가 오지 않으면 입력하지 않고 알린다. 시작하지 못한 구성원은 이유를 남기고, 나머지는 계속 시작한다.
- **역할 지시문:** 실행부 데이터 폴더의 `agent-teams/<팀>/<구성원>` 파일에 둔다. 팀 이름, 구성원 목록(팀장, CLI·모델, 읽기 전용, 보고 대상), 메시지가 들어오는 형식, 역할 지시문, 덧붙일 말이 들어간다. Claude는 `--append-system-prompt-file`로, Codex는 파일 내용을 `-c developer_instructions=`로 넘긴다. 명령줄에는 파일 경로만 들어가므로 지시문의 따옴표·줄바꿈이 셸 명령이 되지 않는다.
- **읽기 전용:** Claude는 `--tools 'Read,Grep,Glob'`, Codex는 `-s read-only -a never`로 실행한다. 0단계에서 Codex는 `-s read-only`만 주면 사용자의 자동 검토 설정이 쓰기를 승인했다.
- **이어 켜기:** 실행부를 다시 시작해 구성원의 대화를 이어 열 때도 모델, 역할 지시문 파일, 읽기 전용 옵션을 다시 붙인다. 0단계에서 Claude는 지시문 없이 이어 켠 실행에서 압축하면 역할을 잊었다.
- **저장:** 팀과 내 템플릿은 별도 `agents.sqlite`(user_version 1)에 둔다. `sessions.sqlite`는 더 새 user_version을 열지 않으므로 그 파일은 바꾸지 않았다.
- **팀 지우기(`teams.remove`):** 팀 기록과 역할 지시문 파일만 지운다. 터미널과 워크트리는 일반 터미널·워크트리로 남는다.

## 구현 전 확인 (2026-10-15)

- Claude Code 2.1.299: `claude -p --model haiku --append-system-prompt-file <파일>`로 넘긴 한국어 지시문 속 암호명과 `C:\work\a.ts` 경로를 그대로 답했다(격리 시험 폴더, 모델 요청 1회).
- Codex 0.162.1: 같은 내용을 JSON 문자열로 쓴 파일을 PowerShell의 `-c ('developer_instructions=' + [IO.File]::ReadAllText(...))`로 넘기고 `codex debug prompt-input`으로 로컬에서 확인했다. developer 메시지에 따옴표·백슬래시까지 그대로 들어갔다. 지시문 끝 바로 뒤에 다른 안내문이 붙어서, 몽글이 만드는 지시문은 빈 줄로 끝낸다. 실제 모델 요청으로 확인하려던 시험은 지시문을 외부 서비스로 보내는 범위라는 이유로 자동 승인 검토가 거절해, 로컬 확인으로 대신했다.

## 변경

- `packages/host/teams.ts`(신규): 역할 기본값, 기본 템플릿, 팀 검사, 역할 지시문 조립, 실행·재개 인자.
- `packages/host/team-store.ts`(신규): `agents.sqlite`.
- `packages/host/team-environment.ts`(신규): CLI 위치·버전·로그인, Git 변경 수. 시험에서 바꿔 끼운다.
- `packages/host/core.ts`: `teams.*` 요청(터미널 큐 밖에서 처리하고 메타데이터만 큐로 커밋), 첫 프롬프트 뒤 실행 줄 입력, 재개 줄에 구성원 인자 추가, 상태의 `teams`, 기능 `agent.teams`.
- `packages/protocol/index.ts`: `AgentRole`·`TeamMemberSpec`·`TeamTemplate`·`TeamMember`·`Team`·`TeamCheck`.

## 검증

- `npm.cmd run typecheck` 통과.
- `tests/host/teams.test.ts` 5/5(신규): 기본 템플릿이 유효하고 검토가 읽기 전용, 팀 검사 문구, 역할 지시문 내용과 끝의 빈 줄, Codex용 TOML 문자열, 실행 인자(작은따옴표 경로, 읽기 전용, 위험한 경로·모델 거부), 저장소 다시 열기.
- `tests/host/teams-host.test.ts` 2/2(신규, Git 사용으로 샌드박스 밖에서 실행): 템플릿 보호·저장·수정, 시작 전 점검(프로젝트 없는 워크트리 오류, 준비 완료 줄), 두 구성원이 리더 칸의 탭으로 열리고 이름이 붙음, 역할 지시문 파일, 첫 프롬프트 뒤 입력한 Claude·Codex 실행 줄(가짜 PowerShell이 쓴 바이트), 실행부 재시작 뒤 팀 유지와 Codex 구성원이 역할·읽기 전용 인자를 붙여 재개됨, 팀 지우기. 임시 Git 저장소에서 워크트리 구성원이 새 워크트리·브랜치·탭을 받음.
- 관련 회귀(`tests/host` 전체, 에이전트 상태·재개 시험, 메시지 화면 시험): 244개 중 241 통과·3 생략.
- 실제 앱·실제 CLI로 팀을 띄우는 확인은 화면이 생기는 다음 PR에서 한다.
