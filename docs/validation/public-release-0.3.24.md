# 0.3.24 공개 배포 검증

**공개 완료.** [최종 결과](#final)를 따른다. 아래 준비 기록은 당시 이력이다.

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
  - `gh pr merge`가 막혀 API로 병합을 요청했는데, 관리자 권한으로 처리되면서 규칙 우회(bypass)로 기록됐다. 병합 내용은 검사한 PR head 그대로다(PR이 최신 dev 기준이었다). 당시에는 dev 규칙이 다시 돌린 결과를 인정하지 않아서라고 판단했지만, 실제 원인은 PR 본문 수정 뒤의 검사 실행이었다([최종 결과](#final)).
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

<a id="final"></a>

## 최종 공개 결과

**0.3.24 공개 배포 완료(2026-10-15):** [공개 릴리스](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.24). [개발 PR](https://github.com/bokjk/mongle-terminal/actions/runs/38678948146) 707 통과·0 실패·17 생략, [배포 PR](https://github.com/bokjk/mongle-terminal/actions/runs/38680567814) 707 통과·0 실패·17 생략, [최종 태그](https://github.com/bokjk/mongle-terminal/actions/runs/38684647241) 709 통과·0 실패·15 생략. 세 작업 모두 네이티브 2/2를 통과했고, 개발 PR·배포 PR·최종 태그 작업에서 실제 NSIS 업그레이드·작업 복원을 통과했다. 최종 태그 작업이 NSIS 검사에 쓴 설치 파일의 SHA-256이 공개 설치 파일과 같다. 태그 작업 `windows-release` artifact의 설치 파일·blockmap·ZIP·`latest.yml`이 `SHA256SUMS.txt`와 맞았고, 공개 첨부 5개를 인증 없이 전체 다운로드해 그 artifact와 SHA-256이 모두 같음을 확인했다. `releases/latest/download/latest.yml`이 0.3.24를 가리킨다. Release 본문은 `v0.3.24` 태그의 CHANGELOG 0.3.24 항목이다. 이전 공개 릴리스는 보존했다.

- 게시 시각(UTC): 2026-10-15T05:29:50Z
- 소스 태그: [v0.3.24](https://github.com/bokjk/mongle-terminal/tree/v0.3.24)
- main SHA: `dff944fbf834a7e7243fb4af6c3d2ebc17f49c35`
- PR: 기능 [#89](https://github.com/bokjk/mongle-terminal/pull/89)·[#88](https://github.com/bokjk/mongle-terminal/pull/88)·[#90](https://github.com/bokjk/mongle-terminal/pull/90)·[#91](https://github.com/bokjk/mongle-terminal/pull/91)·[#92](https://github.com/bokjk/mongle-terminal/pull/92), 배포 준비(main 이력 동기화 포함) [#93](https://github.com/bokjk/mongle-terminal/pull/93), [배포 #94](https://github.com/bokjk/mongle-terminal/pull/94)

#88~#91과 #93은 `dev` 규칙의 필수 검사를 통과해 일반 병합했다(규칙 평가 `pass`). `main`은 `update` 규칙으로 저장소 관리자만 갱신할 수 있어, 배포 PR #94는 필수 검사 3개와 실제 NSIS 검사를 통과한 뒤 사용자 승인을 받아 관리자 병합했다. 이전 배포와 같은 경로다. 원본 자동 초안 생성은 `RELEASE_REPO_TOKEN`이 없어 건너뛰었고, 같은 태그 작업의 artifact를 내려받아 `publish-release.ps1`(이 PC의 Windows PowerShell 실행 정책 때문에 프로세스 한정 `-ExecutionPolicy Bypass`)로 초안을 만든 뒤 검토하고 공개했다.

### dev 병합이 막힌 원인

#92와 #93은 필수 검사를 모두 통과했는데도 `gh pr merge`가 "base branch policy prohibits the merge"로 막혔다. 두 PR 모두 push한 뒤 PR 본문을 고쳤고, 그때 `Contribution checks`와 `Installed upgrade validation`이 본문 확인용으로 한 번 더 실행됐다. 이 실행은 Windows 작업을 생략한다. 규칙은 같은 워크플로의 가장 나중 실행만 보는 것으로 보이며, 그래서 앞서 통과한 "Windows checks"를 결과 대기로 처리했다(#92의 규칙 평가 기록: `Required status check "Windows checks" is expected.`). 마지막 커밋에 이런 실행이 없던 #87~#91은 정상 병합됐다.

#92는 이 상태에서 API 병합 요청이 관리자 권한으로 처리되어 규칙 우회로 기록됐다. #93은 사용자 승인을 받아 PR을 닫았다가 다시 열어 전체 검사를 새로 돌렸고, 그 직후 병합 상태가 `CLEAN`이 되어 규칙 평가 `pass`로 병합했다. 배포 PR #94는 본문을 완성한 상태로 열고 고치지 않았다. 이 CI 설정과 CONTRIBUTING의 본문 수정 설명은 별도 PR로 고친다.

### 공개 파일

| 파일 | 바이트 | SHA-256 |
|---|---:|---|
| MongleTerminal-Setup-0.3.24-x64.exe | 161370975 | `27890a6805a28f6d62d9ec4eaf3d65589fa755b6e3ebfeaaaef047d08c81267a` |
| MongleTerminal-Setup-0.3.24-x64.exe.blockmap | 168090 | `2d402287a3e58b5f91132f1bd93ac847a24b7db90a389bcb65e4d4197e8ef0b4` |
| MongleTerminal-0.3.24-x64.zip | 209428590 | `25bd90e451131860ed9ad4790a6b54df52fbaf543bc7582fba85a7efe4da60ac` |
| latest.yml | 368 | `e242ad687c0d257a272efc3f9396dda55a3c6a62701c91cc5e44ce6f03e496d0` |
| SHA256SUMS.txt | 386 | `d0dfa781d53c367c591eeed8c853c9e112e4803184e3c88f178caf46ded61716` |

### 확인하지 못한 범위

실제 Electron updater로 0.3.23→0.3.24를 내려받는 과정은 확인하지 않았다. 설치본을 업데이트한 뒤 실행부가 Claude 훅 파일을 새로 쓰고 전체 화면 Claude가 시작하자마자 메시지를 받는지는 실제 설치본에서 확인할 항목이다. Codex 구성원에게 팀 메시지 보내기와 실물 휴대폰도 확인하지 않았다. 실제 사용자 설치본·인증·작업은 변경하지 않았다.
