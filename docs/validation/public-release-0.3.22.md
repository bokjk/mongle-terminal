# 0.3.22 공개 배포 검증

**공개 완료.** [최종 결과](#final)를 따른다. 아래 준비 기록은 당시 이력이다.

## 변경 범위

- Git 변경 보기: Git 목록에서 파일을 누르면 그 파일 하나의 비교 탭(한 화면, 줄 번호 옆 +/−, 오른쪽 변경 위치 표시, 나란히 전환)이 열리고, **변경 검토 열기**는 바뀐 파일 전체를 잇는 검토 탭을 연다. 기본 기준은 프로젝트의 기준 브랜치 또는 `origin/HEAD`에서 갈라진 지점이며 커밋 안 한 변경만 볼 수도 있다. 호스트에 `git.diff`·`git.review` 읽기 RPC를 추가했고 Git 필터·외부 프로그램은 실행하지 않는다. 새 의존성 `@codemirror/merge` 6.12.2(MIT)를 추가하고 제3자 고지를 다시 생성했다. [검증 기록](git-diff.md)
- Codex 확인 요청 정리: Codex 화면에 승인 창이 뜰 때만 확인 요청으로 표시하고 자동 검토가 처리하는 승인은 알리지 않는다. 함께 실행된 도구가 먼저 끝나도 기다리는 요청의 표시를 지우지 않는다. `Hooks need review` 창에 한국어 안내를 붙인다. 훅 등록 내용은 그대로다. [검증 기록](codex-status.md#동시-실행과-자동-검토)
- README·변경 이력·사용자 안내·배포 문서와 버전을 0.3.22로 정리한다. 저장소 공개 범위·라이선스는 바꾸지 않는다.

## 개발 단계 근거

Git 변경 보기는 실제 Git 호스트 시험(`git-diff` 10개 중 이 PC 7 통과·3 건너뜀, 건너뛴 링크 시험은 GitHub Windows CI·POSIX 시험은 WSL Ubuntu에서 확인, 기존 Git 6/6)과 HostCore·cmd·Chrome 화면 시험 2/2를, Codex 정리는 [Codex 상태 기록](codex-status.md#동시-실행과-자동-검토)의 시험과 아스트라 실제 확인을 따른다. 두 브랜치를 합친 상태에서 타입 검사·빌드와 관련 시험 34/34를 통과했다. Git 변경 보기는 실제 Electron 앱·패키지에서 조작하지 않았고(저장소 규칙상 아스트라 모델 담당) Mobbin 사례도 확인하지 못했다. 독립 코드 검토는 GitHub Codex 자동 검토를 아홉 번 돌렸다. [Git 변경 보기 검증](git-diff.md#pr-74-검토-반영)

## 배포 안내에 넣을 내용

- Git 목록에서 파일을 누르면 바뀐 내용을 비교하는 탭이 열리고, 목록 위 **변경 검토 열기**로 바뀐 파일 전체를 볼 수 있다. 원격 PC의 파일은 그 PC도 0.3.22 이상이어야 한다.
- Codex 확인 요청은 승인 창이 뜰 때만 표시한다. 훅을 다시 신뢰할 필요는 없다.

## 배포 전 검사

배포 준비 커밋의 PR 검사, 배포 PR·최종 태그 검사, 패키지와 공개 다운로드 결과는 수행한 뒤 기록한다. 실패·생략한 검사를 통과로 표시하지 않는다. 사용자 설치본·인증·작업은 변경하지 않는다.

<a id="final"></a>

## 최종 공개 결과

**0.3.22 공개 배포 완료(2026-10-12):** [공개 릴리스](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.22). [개발 PR](https://github.com/bokjk/mongle-terminal/actions/runs/38225189063) 650 통과·0 실패·17 생략, [배포 PR](https://github.com/bokjk/mongle-terminal/actions/runs/38235838617) 650 통과·0 실패·17 생략, [최종 태그](https://github.com/bokjk/mongle-terminal/actions/runs/38237410420) 652 통과·0 실패·15 생략. 최종 태그 작업에서 네이티브 2/2와 실제 NSIS 업데이트·작업 복원을 통과했고, 그 검사의 새 설치 파일 SHA-256(`1cff656b…`)이 공개 설치 파일과 같다. 공개 첨부 5개를 인증 없이 전체 다운로드해 검증한 artifact와 바이트 단위로 일치함을 확인했고, `latest.yml`의 SHA-512·크기가 설치 파일과 맞으며 `releases/latest/download/latest.yml`이 0.3.22를 가리킨다. Release 본문은 `v0.3.22` 태그의 CHANGELOG 0.3.22 항목과 같다. 이전 공개 릴리스는 보존했다.

- 게시 시각(UTC): 2026-10-12T11:03:34Z
- 소스 태그: [v0.3.22](https://github.com/bokjk/mongle-terminal/tree/v0.3.22)
- main SHA: `a345c08f1b2062f6ad0a83a621cb6f9a273a34dd`
- PR: [개발 #74](https://github.com/bokjk/mongle-terminal/pull/74)(Codex 정리 [#73](https://github.com/bokjk/mongle-terminal/pull/73) 포함), 문서 보완 [#76](https://github.com/bokjk/mongle-terminal/pull/76), main 이력 동기화 [#77](https://github.com/bokjk/mongle-terminal/pull/77), 시험 정리 보완 [#78](https://github.com/bokjk/mongle-terminal/pull/78), [배포 #75](https://github.com/bokjk/mongle-terminal/pull/75)
- 공개 안내: [배포 README #16](https://github.com/bokjk/mongle-terminal-releases/pull/16)

배포 PR의 한 실행에서 Git 비교 화면 시험이 모든 확인 뒤 임시 폴더 삭제 단계에서 `EBUSY`로 실패해(667개 중 1개), 시험 정리가 잠시 기다렸다 다시 지우도록 #78에서 고친 뒤 다시 검사했다. 제품 코드는 바뀌지 않았다. 본문 수정으로 다시 돈 PR target policy 작업이 GitHub API의 일시적 HTTP 500으로 한 번 실패해 다시 실행했다.

최신 head·base의 필수 검사와 독립 검토(GitHub Codex 자동 검토, #74 열 번·#76 두 번·#78 한 번) 후 CONTRIBUTING에 따른 소유자 PR 관리자 병합 경로를 사용했다. #77은 파일 변경이 없는 이력 병합이라 별도 코드 검토를 하지 않았다. 원본 자동 초안 생성은 `RELEASE_REPO_TOKEN`이 없어 건너뛰었고, 같은 태그 작업의 `windows-release` artifact를 내려받아 `publish-release.ps1`로 초안을 만든 뒤 검토하고 공개했다.

### 공개 파일

| 파일 | 바이트 | SHA-256 |
|---|---:|---|
| MongleTerminal-Setup-0.3.22-x64.exe | 161338279 | `1cff656b886a6f1f37029919336d3d5f57b54a67b63419e583523640e3880998` |
| MongleTerminal-Setup-0.3.22-x64.exe.blockmap | 168032 | `4c3826641b92c166958e93b05078f3ec1fd68cbdcc021e4265f95ccbc5feee47` |
| MongleTerminal-0.3.22-x64.zip | 209387961 | `940bbc2d3bc091e2f22b48498fe0960b3443b04b9b2838ade8dec927422f9fe6` |
| latest.yml | 368 | `1d4c35510a0232806d9efff6f4c556432c1d0c17194c5a586aa3e7bbfbcc07e1` |
| SHA256SUMS.txt | 386 | `58248e10cf71f086f097d2001bebc3447d27a39bb9463691ab66773794e1dd54` |

### 확인하지 못한 범위

Git 변경 보기는 실제 Electron 앱·패키지에서 조작하지 않았고(저장소 규칙상 아스트라 컴퓨터 유즈 담당) Mobbin 사례도 확인하지 못했다. 실제 Electron updater로 0.3.21→0.3.22 다운로드와 같은 버전의 최신 상태 확인, 최종 설치 payload 전체 대조는 이번에 따로 하지 않았다. Codex 자동 검토 구간 전체와 실물 휴대폰 수신, OS 재부팅·모든 CLI 버전·WSL 조합도 검증하지 않았다. 실제 사용자 설치본·인증·작업은 변경하지 않았다.

