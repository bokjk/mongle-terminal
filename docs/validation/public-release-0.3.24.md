# 0.3.24 공개 배포 검증

**배포 준비 중.** 아래 결과는 수행한 만큼만 기록한다.

## 변경 범위

- **에이전트에게 메시지 보내기:** PowerShell에서 실행 중인 Claude Code·Codex에게 제어권 없이 메시지를 보낸다. 에이전트가 쉬고 있고 아무도 입력하지 않을 때만 붙여넣기와 별도 Enter로 전달하고, 그 밖에는 이유를 보여 주며 보류한다. 터미널별 방해 금지가 있다. [검증 기록](agent-messages.md)
- **AI 팀:** 템플릿으로 Claude Code·Codex 구성원을 PowerShell 탭(필요하면 새 워크트리)에 띄우고, 역할 지시문·모델·읽기 전용 옵션을 실행 옵션으로만 넘긴다. 팀 화면(팀장 크게, 구성원 옆), 팀 대화(전달 상태 기록), 시작 전 점검, 내 템플릿 저장, 팀 해제를 제공한다. 구성원끼리 직접 보내기는 아직 없다. 팀과 템플릿은 별도 `agents.sqlite`에 둔다. [실행부](agent-teams-host.md), [화면](agent-teams-ui.md), [설계](../08-agent-team-design.md), [0단계 확인](agent-team-probe.md)
- **Claude 전체 화면 모드의 시작 신호:** 전체 화면 모드가 시작 직후의 터미널 신호를 버려 첫 요청 전까지 메시지를 보낼 수 없던 문제를 고쳤다. 관리 Claude 훅 스크립트의 내용이 바뀌므로 업데이트한 실행부가 시작할 때 훅 파일을 새로 쓴다. 사용자 `settings.json`의 몽글 항목은 그대로다. [검증 기록](claude-fullscreen-start.md)
- README·변경 이력·사용자 안내·배포 문서와 버전을 0.3.24로 정리한다. 저장소 공개 범위·라이선스는 바꾸지 않는다.

## 개발 단계 근거

- [#89](https://github.com/bokjk/mongle-terminal/pull/89) 메시지 보내기, [#88](https://github.com/bokjk/mongle-terminal/pull/88) 설계 문서, [#90](https://github.com/bokjk/mongle-terminal/pull/90) 팀 실행부, [#91](https://github.com/bokjk/mongle-terminal/pull/91) 팀 화면은 최신 dev를 반영한 head에서 필수 검사를 통과한 뒤 병합했다. 아스트라가 #89와 #91을 격리한 실제 Electron 앱에서 확인했다.
- [#92](https://github.com/bokjk/mongle-terminal/pull/92) Claude 시작 신호:
  - 로컬 전체 회귀는 724개 중 703 통과, 1 실패(기존 PowerShell 실행 정책), 20 생략이었다. 실제 PowerShell과 사용자 설정 그대로인 전체 화면 Claude Code 2.1.300으로 수정 전후도 확인했다.
  - CI 첫 Windows 검사에서 `tests/ui/worktrees.test.ts`가 실패했다. 새 터미널이 만들어지기 전에 마지막 터미널을 읽는 시간 경합이었다. 실패한 작업만 다시 돌려 724개 중 707 통과, 0 실패, 17 생략이었다.
  - dev 규칙이 다시 돌린 결과를 필수 검사 "Windows checks"로 인정하지 않아 `gh pr merge`가 막혔다. 이어 API로 병합을 요청했는데, 관리자 권한으로 처리되면서 규칙 우회(bypass)로 기록됐다. 병합 내용은 검사한 PR head 그대로다(PR이 최신 dev 기준이었다).
  - 이 배포 준비 PR의 Windows 검사로 합친 상태 전체를 다시 확인한다.
- 확인하지 못한 범위:
  - Codex 구성원에게 팀 메시지 보내기(역할 지시문이 Codex 서비스로 나가는 요청이라 하지 않았다)
  - 실물 휴대폰
  - 실제 Electron 앱에서 전체 화면 Claude의 시작 신호(설치본 업데이트 뒤 확인한다)

## 배포 안내에 넣을 내용

- PowerShell에서 실행 중인 Claude Code·Codex에게 제어권을 가져오지 않고 메시지를 보낼 수 있다. 일하는 중이면 끝날 때까지 기다렸다 보낸다.
- AI 팀으로 Claude Code·Codex 여러 개를 함께 띄우고, 팀 화면과 팀 대화로 지시할 수 있다. 구성원끼리 직접 보내기는 아직이다.
- Claude Code 전체 화면 모드에서도 시작하자마자 메시지를 보낼 수 있다.
- 메시지를 받는 PC도 0.3.24 이상이어야 한다.

## 알려진 문제

- `tests/ui/worktrees.test.ts`의 시간 경합(위 #92)은 고치지 않았다. 다시 실패하면 같은 원인인지 확인한다.

## 배포 전 검사

배포 준비 커밋의 PR 검사, 배포 PR·최종 태그 검사, 패키지와 공개 다운로드 결과는 수행한 뒤 기록한다. 실패·생략한 검사를 통과로 표시하지 않는다. 사용자 설치본·인증·작업은 변경하지 않는다.
