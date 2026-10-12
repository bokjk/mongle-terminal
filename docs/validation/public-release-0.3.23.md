# 0.3.23 공개 배포 검증

**공개 완료.** [최종 결과](#final)를 따른다. 아래 준비 기록은 당시 이력이다.

## 변경 범위

- 터미널 파일 경로 열기: 터미널 출력의 파일 경로를 `Ctrl+클릭`하면 현재 폴더 안의 파일을 오른쪽 파일 탭으로 연다. 화면에 그려진 글자만 읽고 CLI에는 아무것도 보내지 않으며, 일반 클릭은 이전처럼 전달한다. [검증 기록](terminal-file-links.md)
- 모바일 보조 키 편집: **설정 → 화면 → 모바일 보조 키**에서 키를 빼고 더하고 순서를 바꾼다. 기기 브라우저에만 저장하며 고치지 않으면 이전과 같은 키 줄이다. [검증 기록](mobile-key-bar.md)
- 화면 켜 두기: **설정 → 화면 → 화면 켜 두기**를 켜면 몽글터미널을 보고 있고 연결된 동안 Screen Wake Lock으로 화면을 켜 둔다. 기본값은 꺼짐이다. [검증 기록](keep-screen-on.md)
- 파일 첨부: 터미널 `···` → **파일 첨부…** 또는 클립보드 이미지 붙여넣기로 파일을 터미널의 PC에 보내 현재 폴더의 `.mongle-attachments`에 저장하고 경로를 Enter 없이 입력한다. Git 저장소면 로컬 `.git/info/exclude`에 한 줄을 한 번 추가한다. 호스트에 업로드 RPC를 추가했다. [검증 기록](terminal-file-upload.md)
- README·변경 이력·사용자 안내·배포 문서와 버전을 0.3.23으로 정리한다. 저장소 공개 범위·라이선스는 바꾸지 않는다.

## 개발 단계 근거

각 기능은 기능별 브랜치(PR #80~#83)에서 자동 시험과 아스트라 검토를 통과했다. 네 브랜치를 `chore/release-0.3.23`에 합치며 `App.tsx`·`Settings.tsx`·`TerminalPane.tsx`와 문서의 충돌을 양쪽 내용을 모두 남기는 방식으로 풀었다. 합친 상태에서 타입 검사·빌드와 관련 시험 72개 중 71 통과·0 실패·1 생략을 확인했다. Ctrl+클릭의 실제 앱 조작, 실물 휴대폰과 원격 연결에서의 보조 키·화면 켜 두기·파일 첨부는 아직 확인하지 않았다.

## 배포 안내에 넣을 내용

- 터미널에 나온 파일 경로를 `Ctrl+클릭`하면 파일 탭으로 연다.
- 휴대폰 보조 키를 설정에서 고르고 순서를 바꿀 수 있다.
- 휴대폰에서 작업을 지켜보는 동안 화면을 켜 둘 수 있다(기본 꺼짐).
- 휴대폰 사진이나 PC 클립보드의 화면 캡처를 터미널의 작업 폴더로 보내 경로를 입력할 수 있다. 받는 PC도 0.3.23 이상이어야 한다.

## 배포 전 검사

배포 준비 커밋의 PR 검사, 배포 PR·최종 태그 검사, 패키지와 공개 다운로드 결과는 수행한 뒤 기록한다. 실패·생략한 검사를 통과로 표시하지 않는다. 사용자 설치본·인증·작업은 변경하지 않는다.

<a id="final"></a>

## 최종 공개 결과

**0.3.23 공개 배포 완료(2026-10-13):** [공개 릴리스](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.23). [개발 PR](https://github.com/bokjk/mongle-terminal/actions/runs/38280596603) 680 통과·0 실패·17 생략, [배포 PR](https://github.com/bokjk/mongle-terminal/actions/runs/38291414967) 680 통과·0 실패·17 생략, [최종 태그](https://github.com/bokjk/mongle-terminal/actions/runs/38293114184) 682 통과·0 실패·15 생략. 최종 태그 작업에서 네이티브 2/2를 통과했고, 개발 PR·배포 PR에서 실제 NSIS 업그레이드·작업 복원을 통과했다. 태그 작업의 `windows-release` artifact 5개 파일이 `SHA256SUMS.txt`와 맞았고, 공개 첨부 5개를 인증 없이 전체 다운로드해 그 artifact와 SHA-256이 모두 같음을 확인했다. `releases/latest/download/latest.yml`이 0.3.23을 가리킨다. Release 본문은 `v0.3.23` 태그의 CHANGELOG 0.3.23 항목이다. 이전 공개 릴리스는 보존했다.

- 게시 시각(UTC): 2026-10-12T22:37:34Z
- 소스 태그: [v0.3.23](https://github.com/bokjk/mongle-terminal/tree/v0.3.23)
- main SHA: `501f2df27a2fc7ce12b70a7bc8e85d10e268b1ce`
- PR: 기능 [#80](https://github.com/bokjk/mongle-terminal/pull/80)·[#81](https://github.com/bokjk/mongle-terminal/pull/81)·[#82](https://github.com/bokjk/mongle-terminal/pull/82)·[#83](https://github.com/bokjk/mongle-terminal/pull/83), 통합·배포 준비 [#84](https://github.com/bokjk/mongle-terminal/pull/84), main 이력 동기화 [#85](https://github.com/bokjk/mongle-terminal/pull/85), [배포 #86](https://github.com/bokjk/mongle-terminal/pull/86)

#84의 첫 Windows 검사에서 두 시험이 실패했다. 하나는 실행기 임시 폴더의 8.3 짧은 이름 때문에 드러난 첨부 경로 결함(짧은 이름 터미널 폴더에서 첨부 경로가 `Ctrl+클릭`으로 열리지 않음)이었고, 다른 하나는 승인 0명으로 바꾼 ruleset의 시험 기대값이었다. 둘 다 고친 뒤 아스트라 재검토와 전체 검사를 통과했다. [첨부 검증 기록](terminal-file-upload.md)

필수 검사와 아스트라(`gpt-6-astra`) 검토 뒤 CONTRIBUTING에 따른 소유자 PR 관리자 병합 경로를 사용했다. #85는 파일 변경이 없는 이력 병합이라 별도 코드 검토를 하지 않았다. 공개 직전 사용자 승인으로 `dev` ruleset의 필수 승인을 1명에서 0명으로 서버에 적용하고 API 응답(`required_approving_review_count: 0`)을 확인했다. 원본 자동 초안 생성은 `RELEASE_REPO_TOKEN`이 없어 건너뛰었고, 같은 태그 작업의 artifact를 내려받아 `publish-release.ps1`(이 PC의 Windows PowerShell 실행 정책 때문에 프로세스 한정 `-ExecutionPolicy Bypass`)로 초안을 만든 뒤 검토하고 공개했다.

### 공개 파일

| 파일 | 바이트 | SHA-256 |
|---|---:|---|
| MongleTerminal-Setup-0.3.23-x64.exe | 161347852 | `1e09b477f7dfe58acc87d22c0db2ad4c8768d9549dfb63a3edab312c311641c2` |
| MongleTerminal-Setup-0.3.23-x64.exe.blockmap | 167953 | `1098dfb76efaad6832855dc57bb9ea56351218d1dd16342a617edf10b70ad0d6` |
| MongleTerminal-0.3.23-x64.zip | 209400258 | `b6496fb21fdda2dec481546caf2d9cc438b215bcd0e5d8a074864107f579d0ad` |
| latest.yml | 368 | `e89051cdabb0710d842dcec2ed5ecbdaa0edc5064537612d85b84547e55cc5a0` |
| SHA256SUMS.txt | 386 | `a691e5c50a731bbaac58314450d244254fd215dbf35ab3731d31cdb07014e68b` |

### 확인하지 못한 범위

실제 앱에서의 `Ctrl+클릭`, 실물 휴대폰과 실제 원격(Tailscale) 연결에서의 보조 키·화면 켜 두기·파일 첨부, Windows 파일 선택창의 선택 완료는 확인하지 않았다. 실제 Electron updater로 0.3.22→0.3.23 다운로드와 최종 태그 작업의 NSIS 설치 검사 결과 대조는 이번에 따로 하지 않았다. 실제 사용자 설치본·인증·작업은 변경하지 않았다.
