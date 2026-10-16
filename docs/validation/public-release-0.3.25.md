# 0.3.25 공개 배포 검증

**공개 완료.** [최종 결과](#final)를 따른다. 아래 준비 기록은 당시 이력이다.

## 변경 범위

- **구성원끼리 메시지:** 구성원 CLI마다 몽글 팀 도구(MCP 서버 `mongle_team`의 `list_agents`·`send_message`)를 실행 옵션으로 붙인다. 붙이는 옵션은 Claude Code가 `--mcp-config`·`--allowedTools`, Codex가 `-c mcp_servers.mongle_team=...`이다. 중계는 구성원 키와 함께 실행부의 로컬 파이프로 요청을 넘기고, 실행부는 받는 사람의 보류함에 사용자 메시지와 같은 조건으로 넣는다. 사용자의 `~/.claude`·`~/.codex` 설정 파일은 고치지 않는다. 본문 앞에 모델이 다시 쓴 머리글은 지운다. [검증 기록](agent-team-relay.md)
- **작업 범위와 브랜치 맞추기:** 팀이 함께 볼 폴더 여러 개와 시작 폴더를 고르고, 체크한 Git 저장소를 시작할 때 같은 브랜치로 맞춘다. 점검에서 Git이 거절할 경우를 미리 알리고, 하나라도 실패하면 팀을 시작하지 않는다. [검증 기록](agent-team-scope.md)
- **모델 고르기:** 구성원 모델을 각 CLI가 알려 주는 목록(Codex `codex debug models`, Claude Code `--help`의 별칭)에서 고른다. 모델 요청은 보내지 않는다. [검증 기록](agent-team-models.md)
- **팀 화면 크기 조절:** 팀장·구성원 칸 사이와 구성원 칸 사이에 손잡이를 두고, 크기를 팀마다 저장한다. [검증 기록](agent-team-relay.md)
- **시작 막힘 수정과 기본 폴더:** 작업 폴더로 워크트리 저장소를 찾고, 기본 템플릿 구성원은 모두 기본 폴더로 시작한다. [검증 기록](agent-teams-host.md#작업-폴더로-저장소-찾기)
- README·변경 이력·사용자 안내·배포 문서와 버전을 0.3.25로 정리한다. 저장소 공개 범위·라이선스는 바꾸지 않는다.

## 개발 단계 근거

- [#96](https://github.com/bokjk/mongle-terminal/pull/96)과 [#97](https://github.com/bokjk/mongle-terminal/pull/97)은 최신 dev를 반영한 head에서 필수 검사 7개를 모두 통과한 뒤 일반 병합했다. 검사에는 Windows checks와 실제 NSIS 업그레이드·복원이 포함된다.
- 로컬 전체 회귀는 #96이 733개 중 712 통과, #97이 734개 중 713 통과였다. 두 번 모두 1개 실패(이 PC의 PowerShell 실행 정책이 막는 기존 배포 스크립트 시험)와 20개 생략이 있었다.
- 아스트라(`gpt-6-astra`)가 #96 코드를 격리한 실제 Electron 앱에서 확인했다. Claude `haiku` 구성원 세 명이 사람 개입 없이 일을 넘기고 보고했고, 크기 조절도 동작했다. 설치본과 사용자 설정은 시험 전후가 같았다. 그때 찾은 머리글 중복과 손잡이 두 번 클릭 뒤 글자 선택은 #97에서 고쳤다. 이 두 수정은 시험과 Aside 미리보기로 확인했고, 실제 앱에서는 다시 확인하지 않았다.
- 실제 CLI(대역 실행부)에서 Codex 0.162.1과 Claude Code 2.1.300이 두 도구를 승인 없이 불렀다. Codex는 읽기 전용이었고, Claude는 `--tools 'Read,Grep,Glob'`로 실행했다.
- 확인하지 못한 범위:
  - Codex 구성원의 대화형 실행에서 중계를 부르는 것(`codex exec`로만 확인)
  - 실제 앱에서 브랜치 맞추기
  - 팀별 크기 저장 분리, 앱 재시작 뒤 크기 복원
  - 실물 휴대폰

## 배포 안내에 넣을 내용

- 팀장에게 한 번 맡기면 팀장이 구성원에게 일을 나누고 구성원이 결과를 보고하는 과정이 자동으로 이어진다. 오간 내용은 팀 대화에 남는다.
- 여러 저장소를 한 팀이 같은 브랜치에서 함께 고칠 수 있다.
- 구성원 모델을 CLI가 알려 주는 목록에서 고른다.
- 팀 화면의 칸 크기를 끌어서 바꾼다.

## 알려진 문제

- Windows PowerShell 5.1만 있는 PC에서는 Codex 구성원의 역할 지시문 옵션(0.3.24부터)의 큰따옴표가 빠질 수 있다. PowerShell 7이 있으면 몽글이 7을 먼저 쓰므로 드러나지 않는다. 중계 설정은 큰따옴표를 쓰지 않아 영향이 없다. [기록](agent-team-relay.md#확인하지-못한-범위)
- `tests/ui/worktrees.test.ts`의 시간 경합(0.3.24 기록)은 고치지 않았다.

## 배포 전 검사

배포 준비 커밋의 PR 검사, 배포 PR·최종 태그 검사, 패키지와 공개 다운로드 결과는 수행한 뒤 기록한다. 실패·생략한 검사를 통과로 표시하지 않는다. 사용자 설치본·인증·작업은 변경하지 않는다.

<a id="final"></a>

## 최종 공개 결과

**0.3.25 공개 배포 완료(2026-10-16):** [공개 릴리스](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.25).

| 검사 | 회귀 | 네이티브 | 실제 NSIS 업그레이드·복원 |
|---|---|---|---|
| [개발 PR #98](https://github.com/bokjk/mongle-terminal/actions/runs/38769951542) | 734개 중 717 통과·0 실패·17 생략 | 2/2 | 통과 |
| [배포 PR #99](https://github.com/bokjk/mongle-terminal/actions/runs/38772408626) | 734개 중 717 통과·0 실패·17 생략 | 2/2 | 통과 |
| [최종 태그](https://github.com/bokjk/mongle-terminal/actions/runs/38774937848) 두 번째 시도 | 734개 중 719 통과·0 실패·15 생략 | 2/2 | 통과 |

- 최종 태그 작업의 첫 시도는 `tests/ui/worktrees.test.ts` 하나가 실패해 패키징 전에 멈췄다(718 통과·1 실패·15 생략). 새 터미널의 폴더로 `RUNNER~1` 짧은 경로를 기대했는데 직전 터미널의 워크트리 경로를 읽었다. 0.3.24 때 기록한 같은 시험의 시간 경합이다. 제품 코드와 무관하다고 판단해 같은 커밋으로 실패한 작업만 다시 돌렸고, 두 번째 시도는 모든 단계를 통과했다. 이 시험은 아직 고치지 않았다.
- 최종 태그 작업이 실제 NSIS 검사에 쓴 새 설치 파일의 SHA-256(`3f26b97c…`)이 공개 설치 파일과 같다.
- 태그 작업 `windows-release` artifact의 설치 파일·blockmap·ZIP·`latest.yml`이 `SHA256SUMS.txt`와 맞았다(`publish-release.ps1 -CheckOnly`). 공개 첨부 5개를 인증 없이 전체 다운로드해 그 artifact와 SHA-256이 모두 같음을 확인했다. `releases/latest/download/latest.yml`이 0.3.25를 가리킨다.
- Release 본문은 `v0.3.25` 태그의 CHANGELOG 0.3.25 항목이다. 공개 다운로드 저장소의 소개 README도 0.3.25(와 그때 빠졌던 0.3.24) 소개를 더해 갱신했다([공개 저장소 PR #18](https://github.com/bokjk/mongle-terminal-releases/pull/18)). 이전 공개 릴리스는 보존했다.

- 게시 시각(UTC): 2026-10-15T17:53:55Z
- 소스 태그: [v0.3.25](https://github.com/bokjk/mongle-terminal/tree/v0.3.25)
- main SHA: `a1944b6470a28bcdaea488cde540c650ba4c636f`
- PR: 기능 [#96](https://github.com/bokjk/mongle-terminal/pull/96)·[#97](https://github.com/bokjk/mongle-terminal/pull/97), 배포 준비(main 이력 동기화 포함) [#98](https://github.com/bokjk/mongle-terminal/pull/98), [배포 #99](https://github.com/bokjk/mongle-terminal/pull/99)

#96~#98은 `dev` 규칙의 필수 검사를 통과해 일반 병합했다. 세 PR 모두 본문을 완성한 상태로 열고 고치지 않아, 0.3.24 때처럼 본문 확인용 실행 때문에 막히는 일은 없었다. `main`은 `update` 규칙으로 저장소 관리자만 갱신할 수 있어, 배포 PR #99는 필수 검사와 실제 NSIS 검사를 통과한 뒤 사용자 승인을 받아 관리자 병합했다. 원본 자동 초안 생성은 `RELEASE_REPO_TOKEN`이 없어 건너뛰었고, 같은 태그 작업의 artifact를 내려받아 `publish-release.ps1`(프로세스 한정 `-ExecutionPolicy Bypass`)로 초안을 만든 뒤 검토하고 공개했다.

### 공개 파일

| 파일 | 바이트 | SHA-256 |
|---|---:|---|
| MongleTerminal-Setup-0.3.25-x64.exe | 161384091 | `3f26b97c4b430959f07ff6bf2a46ae30a7e63e0bf75c15a3577edc3442fb512d` |
| MongleTerminal-Setup-0.3.25-x64.exe.blockmap | 168106 | `e695b0b4ea2a2679a8be56671c10ad5fc2b0f6498ba2ad3c70e77b04401225bd` |
| MongleTerminal-0.3.25-x64.zip | 209445164 | `5bc26c17c322b36efde195258879165606466bf3a615facf8b6df2135d277f52` |
| latest.yml | 368 | `24da6f858d27d2d9ee4d3f8af06593ad9fe5a6a0c719dc01eb9daa4340736ad7` |
| SHA256SUMS.txt | 386 | `36037eca5e199424c854217da39c819403772ff90a37fd2f6a8ba7508f075c81` |

### 확인하지 못한 범위

실제 Electron updater로 0.3.24→0.3.25를 내려받는 과정은 확인하지 않았다. 구성원끼리 메시지의 두 수정(#97)을 실제 앱에서 다시 확인하는 것, Codex 구성원의 대화형 실행에서 중계를 부르는 것, 실제 앱에서 브랜치 맞추기, 실물 휴대폰도 확인하지 않았다. 실제 사용자 설치본·인증·작업은 변경하지 않았다.
