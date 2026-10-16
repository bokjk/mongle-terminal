# 0.3.26 공개 배포 검증

**공개 완료.** [최종 결과](#final)를 따른다. 아래 준비 기록은 당시 이력이다.

## 변경 범위

- **Codex 구성원 전달:** Codex 0.163.0은 첫 요청 전에는 `SessionStart` 훅을 보내지 않는다. 몽글 PowerShell `codex` 감싸기가 실행 표식을 내면, 새로 그려진 입력창을 보고 첫 메시지 하나를 넣는다. 붙여넣은 뒤 화면이 멈추면 Enter를 보내고(최대 3초), 받는 CLI가 Codex이면 줄바꿈을 LF로 넣는다. [검증 기록](agent-team-flow-and-codex-start.md)
- **일 흐름 지키기:** 팀장·구성원 지시문을 보강하고, 받은 일 끝에 다음 차례 안내를 붙이고, 흐름을 벗어난 보고에는 도구 답으로 다음 차례를 알린다. 전달하지 못한 구성원 메시지는 이유와 함께 팀 대화에 남긴다.
- **팀 해제와 템플릿 지우기:** 그룹을 삭제하면 그 그룹의 팀도 해제한다. 사이드바 팀 행에 `···` 메뉴를 둔다. 팀을 해제하면 보류 중이던 팀 메시지는 취소한다. 팀 시작 창에서 내 템플릿을 지운다.
- README·변경 이력·사용자 안내·배포 문서와 버전을 0.3.26으로 정리한다. 저장소 공개 범위·라이선스는 바꾸지 않는다.

## 개발 단계 근거

- [#101](https://github.com/bokjk/mongle-terminal/pull/101)은 최신 dev를 반영한 head에서 필수 검사를 모두 통과한 뒤 일반 병합했다. 검사에는 Windows checks와 실제 NSIS 업그레이드·복원이 포함된다.
- 로컬: 타입 검사·빌드·`release-check` 통과, 관련 시험 71개 통과. 전체 회귀는 742개 중 716 통과, 3 실패, 3 취소, 20 생략이었다. 시간 초과가 난 화면 시험 5개 파일은 다시 돌려 17/17 통과했고, 남은 실패는 기존 PowerShell 실행 정책 환경 문제다.
- 아스트라(`gpt-6-astra`)가 격리한 실제 Electron 앱(Codex 연동 켬)에서 확인했다. 최종 코드(`823a1bc`)로 설계·개발 Claude, 검토 Codex 팀이 사람 개입 없이 `나 → 설계 → 개발 → 검토 → 설계 → 나(보고)`를 약 38초에 마쳤다. 템플릿 지우기, 그룹 삭제·사이드바 팀 해제, 팀장 지시와 무관한 일 흐름 지키기도 확인했다. 사용자 Codex 설정 파일 해시는 시험 전후가 같았다.
- 확인하지 못한 범위:
  - 다른 Codex·Claude 버전
  - 실물 휴대폰
  - 실제 Electron updater로 0.3.25에서 0.3.26으로 내려받기

## 배포 안내에 넣을 내용

- Codex 구성원이 낀 팀도 사람 개입 없이 끝까지 이어진다.
- 팀장이 "나에게 보고"라고 해도 구성원은 일 흐름대로 다음 차례에게 보낸다.
- 사이드바에서 팀을 해제하고, 그룹을 지우면 팀도 함께 해제된다. 내 템플릿을 지울 수 있다.

## 알려진 문제

- 시작 전 점검이 보여 주는 Codex 버전이 실제 실행되는 CLI와 다를 수 있다(이 PC에서 0.162.0 표시, 실제 0.163.0).
- Codex 입력창 판단은 Codex 화면의 `? for shortcuts` 글자에 기댄다. 이 문구가 바뀌면 이전처럼 첫 요청을 기다린다.
- Windows PowerShell 5.1만 있는 PC에서 Codex 역할 지시문 옵션의 큰따옴표가 빠질 수 있는 문제(0.3.25 기록)는 그대로다.
- `tests/ui/worktrees.test.ts`의 시간 경합(0.3.24 기록)은 고치지 않았다.

## 배포 전 검사

배포 준비 커밋의 PR 검사, 배포 PR·최종 태그 검사, 패키지와 공개 다운로드 결과는 수행한 뒤 기록한다. 실패·생략한 검사를 통과로 표시하지 않는다. 사용자 설치본·인증·작업은 변경하지 않는다.

<a id="final"></a>

## 최종 공개 결과

**0.3.26 공개 배포 완료(2026-10-16):** [공개 릴리스](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.26).

| 검사 | 회귀 | 네이티브 | 실제 NSIS 업그레이드·복원 |
|---|---|---|---|
| [기능 PR #101](https://github.com/bokjk/mongle-terminal/actions/runs/38846752866) | 742개 중 725 통과·0 실패·17 생략 | 2/2 | 통과 |
| [개발 PR #102](https://github.com/bokjk/mongle-terminal/actions/runs/38848279884) | 742개 중 725 통과·0 실패·17 생략 | 2/2 | 통과 |
| [배포 PR #103](https://github.com/bokjk/mongle-terminal/actions/runs/38849638379) | 742개 중 725 통과·0 실패·17 생략 | 2/2 | 통과 |
| [최종 태그](https://github.com/bokjk/mongle-terminal/actions/runs/38850989945) 첫 시도 | 742개 중 727 통과·0 실패·15 생략 | 2/2 | 통과 |

- #101의 첫 검사 실행은 `tests/host/teams-host.test.ts`의 시험 하나가 실패했다. 리드 셸의 프롬프트 표식이 시험 메시지보다 먼저 오면 중계가 "CLI 꺼짐"으로 거절하는 시험 준비의 순서 경합이었다. 시험에서 메시지를 보내기 전에 리드 CLI가 실행 중인 상태를 고정하도록 고친 커밋(`09d3b4f`)으로 다시 검사해 통과했다. 제품 코드는 바꾸지 않았다.
- 최종 태그 작업은 첫 시도에 모든 단계를 통과했다. 0.3.24·0.3.25 때 기록한 `tests/ui/worktrees.test.ts` 시간 경합은 이번에 나타나지 않았지만 고치지는 않았다.
- 최종 태그 작업이 실제 NSIS 검사(0.3.16 → 0.3.26)에 쓴 새 설치 파일의 SHA-256(`341bb6b3…`)이 공개 설치 파일과 같다.
- 태그 작업 `windows-release` artifact의 설치 파일·blockmap·ZIP·`latest.yml`이 `SHA256SUMS.txt`와 맞았다(`publish-release.ps1 -CheckOnly`). `latest.yml`의 SHA-512도 설치 파일과 같다. 공개 첨부 5개를 인증 없이 전체 다운로드해 그 artifact와 SHA-256이 모두 같음을 확인했다. `releases/latest/download/latest.yml`이 0.3.26을 가리킨다.
- Release 본문은 `v0.3.26` 태그의 CHANGELOG 0.3.26 항목이다. 공개 다운로드 저장소의 소개 README도 0.3.26 소개를 더해 갱신했다([공개 저장소 PR #19](https://github.com/bokjk/mongle-terminal-releases/pull/19)). 이전 공개 릴리스는 보존했다.

- 게시 시각(UTC): 2026-10-16T04:56:04Z
- 소스 태그: [v0.3.26](https://github.com/bokjk/mongle-terminal/tree/v0.3.26)
- main SHA: `afbac05a66e1095508d052a599cf9b6250126b15`
- PR: 기능 [#101](https://github.com/bokjk/mongle-terminal/pull/101), 배포 준비(main 이력 동기화 포함) [#102](https://github.com/bokjk/mongle-terminal/pull/102), [배포 #103](https://github.com/bokjk/mongle-terminal/pull/103)

#101·#102는 `dev` 규칙의 필수 검사를 통과해 일반 병합했다. 두 PR 모두 본문을 완성한 상태로 열고 고치지 않았다. `main`은 `update` 규칙으로 저장소 관리자만 갱신할 수 있어, 배포 PR #103은 필수 검사와 실제 NSIS 검사를 통과한 뒤 사용자 승인을 받아 관리자 병합했다. 원본 자동 초안 생성은 `RELEASE_REPO_TOKEN`이 없어 건너뛰었고, 같은 태그 작업의 artifact를 내려받아 `publish-release.ps1`(프로세스 한정 `-ExecutionPolicy Bypass`)로 초안을 만든 뒤 검토하고 공개했다.

### 공개 파일

| 파일 | 바이트 | SHA-256 |
|---|---:|---|
| MongleTerminal-Setup-0.3.26-x64.exe | 161386453 | `341bb6b39f5d8e2a0dee821aae551db3ae4964846310dfbac773b4cf0ad07d05` |
| MongleTerminal-Setup-0.3.26-x64.exe.blockmap | 167945 | `9fa845b7b6d7546555b73a501eca4bcb098f01098b4a06ab910d651e6362e040` |
| MongleTerminal-0.3.26-x64.zip | 209448118 | `169b186a3e8688716fba367eabb2d718780b53db9648db82a80567daf5169645` |
| latest.yml | 368 | `62c7c5f6dcdfb34856cbacc939a816fb578e4e7fd16268a49a44ceead4fc779a` |
| SHA256SUMS.txt | 386 | `efbe88d68400b0cfc5dd94ea05eea5d8d96ea2ae155c8eb146908653b8e12dda` |

### 확인하지 못한 범위

실제 Electron updater로 0.3.25→0.3.26을 내려받는 과정은 확인하지 않았다. 다른 Codex·Claude 버전과 실물 휴대폰도 확인하지 않았다. 실제 사용자 설치본·인증·작업은 변경하지 않았다.
