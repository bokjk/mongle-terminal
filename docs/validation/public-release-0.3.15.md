# 0.3.15 공개 배포 검증

> 공개 완료. [최종 결과](#0315-final)를 따른다. 아래 준비·로컬 검사 기록은 당시 이력이다.

## 준비

2026-10-07, 사용자 승인에 따라 0.3.15를 배포 준비한다. 현재 공개 채널은 0.3.14이며 이 문서의 준비 기록은 게시 완료를 뜻하지 않는다. 기존 공개 배포 저장소와 업데이트 주소·라이선스·코드 서명 상태를 유지한다.

## 포함 기능

- 모바일의 기본 글자 크기 11px, 손가락 이동 거리 기준 감도, 짧은 감속과 다시 터치하면 정지, 기기별 속도 설정.
- 브라우저/PWA의 화면 새로고침과 미저장·저장 중 파일 보호.
- 터미널 알림 신호에 따른 목록·탭·그룹의 미확인 점. 보이는 최신 화면만 읽음 처리하며 CLI의 알림 설정에 영향을 받는다.

## 로컬 검증

0.3.15 최종 소스의 타입·프로덕션 빌드·배포 문서 검사 통과. 전체 회귀는 **514개 중 497 통과·환경 실패 1·16 선택 생략**(약407초)이었다. 기존 모바일 resize fixture 검사는 이번 전체 실행에서 통과했다. 실패한 배포 스크립트 검사는 자식 Windows PowerShell의 실행 정책 `UnauthorizedAccess`였으며, 시험 프로세스에만 `PSExecutionPolicyPreference=Bypass`를 적용한 재검사 **1/1 통과**로 실행 대상 총498개를 확인했다. 사용자·시스템 실행 정책은 바꾸지 않았다. 단일 전체 실행 무실패나 GitHub CI 성공을 뜻하지 않는다. 로그는 `.test-data/release-0315-regression.log`, `.test-data/release-0315-publisher.log`이며 PR/태그의 별도 전체 실행 결과를 게시 후 기록한다.

기능별 검사: [모바일 스크롤](mobile-scroll-speed.md), [새로고침](mobile-refresh.md), [알림 표시](terminal-notifications.md). 전체 회귀 514개 중 497 통과·1 실패·16 선택 생략 뒤, 실패한 모바일 시험 호스트의 resize 응답 누락을 고쳐 알림과 함께 7/7 재검사 통과했다. 이 기록은 버전 변경 전 검사이며 최종 PR/태그 검사와 구별한다. 실제 격리 앱의 표준 알림 표시·확인 해제·모달 보존, PWA 새로고침, Claude/Codex 양방향 스크롤을 확인했다. 실물 갤럭시·설치형 모바일 브라우저의 관성 체감은 별도다.

독립 코드 검토에서 알림의 적용된 화면 기준 읽음 처리와 재연결 캐시 무효화, 모바일 입력 대기·관성 중단, 새로고침의 미저장·저장 중 파일 보호를 확인했고 새로운 병합 차단 결함은 발견하지 않았다. 누락된 resize 응답 fixture 수정도 입력 대기·정확히 한 번 전달 검증을 유지한다.

Astra가 격리된 실제 몽글 웹앱·호스트·cmd/ConPTY에서 Claude 2.1.292와 Codex 0.160.0에 요청을 한 번씩 보내 CLI 자체 BEL/OSC9 수신, 비활성 목록·탭·그룹 점 표시, 선택 약766/769ms 뒤 해제를 확인했다. 세션 한정 알림 설정을 켰으며 기본 설정은 검사하지 않았다. Claude는 응답 뒤 유휴 지연을 거쳐 알렸다. 시험 탭·호스트·자식 프로세스 잔여는 0개다. [실제 CLI 검사와 범위](cli-notifications.md). 실사용 호스트·셸·설정·인증·Tailscale Serve는 변경하지 않았다.

## 게시 전 필수 확인

PR #51의 첫 설치 검사 [37584172531](https://github.com/bokjk/mongle-terminal/actions/runs/37584172531)는 새 NSIS의 app.asar·694개 hostbundle 파일 일치까지 통과했으나 앱 시작 직후 `app.getVersion()`이 `0.3.15.0`으로 읽혀 실패했다. 검사가 main inspector 접속 직후 실행되어 Electron의 package.json 초기화보다 먼저 버전을 읽을 수 있었다. [Electron 44.4.5 초기화 코드](https://github.com/electron/electron/blob/v44.4.5/lib/browser/init.ts#L112-L115)는 package.json을 읽은 뒤 앱 버전을 설정한다. 검사를 `app.whenReady()` 뒤로 옮기고 실행 버전과 내장 package.json을 각각 `0.3.15`와 엄격히 대조하도록 보완했다. 숫자를 잘라내거나 허용 버전을 넓히지 않으며 초기·준비 완료 버전을 증거에 남긴다. 실제 앱·설치 파일의 버전 설정은 변경하지 않았다. 수정 후 CI 결과를 별도 확인한다.

주제 브랜치→dev 및 dev→main의 PR 정책·문서·Windows 회귀와 설치 검사를 확인한다. 병합 main의 0.3.15 태그에서 패키징·네이티브·NSIS 교체·복원과 산출물 보존까지 통과한 동일 파일만 공개한다. 공개 첨부 5개와 latest.yml을 익명으로 내려받아 크기·해시·버전을 대조하고 실제 Electron 업데이트 다운로드를 확인한다. 기존 공개 릴리스는 변경하지 않는다.

<!-- release-0.3.15-finalized -->
<a id="0315-final"></a>

## 최종 공개 결과

**0.3.15 공개 배포 완료(2026-10-07):** [공개 릴리스](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.15). [개발 PR 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37585036031) 499 통과·0 실패·15 생략, [배포 PR 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37586578183) 499 통과·0 실패·15 생략, [최종 태그 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37587926965) 500 통과·0 실패·14 생략. 네이티브 2/2와 [실제 NSIS 교체·복원](https://github.com/bokjk/mongle-terminal/actions/runs/37586578164), 최종 태그 설치 payload 일치, 공개 첨부 5개 익명 전체 다운로드·해시, 실제 Electron의 격리 버전 어댑터로 0.3.14→0.3.15 다운로드 및 동일 버전 최신 상태 확인을 통과했다. 이전 공개 릴리스는 변경하지 않았다.

- 게시 시각(UTC): 2026-10-07T07:53:02Z
- main SHA: `20868d10ae13154f9d084a64c5d290602477aeca`
- 소스 태그: [v0.3.15](https://github.com/bokjk/mongle-terminal/tree/v0.3.15)
- PR: [개발 #51](https://github.com/bokjk/mongle-terminal/pull/51), [배포 #52](https://github.com/bokjk/mongle-terminal/pull/52)
- 공개 README: [PR](https://github.com/bokjk/mongle-terminal-releases/pull/8)
- [개발 PR 실제 설치 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37585035954): 통과

필수 검사를 통과한 windows-release artifact의 동일 파일을 배포했다.

소유자 작성 PR은 자체 승인이 불가능하므로 최신 base의 필수 상태·설치 검사와 독립 코드 검토를 확인한 뒤 CONTRIBUTING 기준으로 PR 병합에만 관리자 권한을 사용했다. 직접 main push나 실패 검사 무시는 하지 않았다.

### 공개 첨부 해시

| 파일 | 바이트 | SHA-256 |
|---|---:|---|
| MongleTerminal-Setup-0.3.15-x64.exe | 161276978 | `17a32f49f0499868de3f740869e4cb8f0157cc2ebcadcff3d6939f057e24e270` |
| MongleTerminal-Setup-0.3.15-x64.exe.blockmap | 168028 | `a47b0d24f0cd7f3a6a0b2b1e36ea691386c76cf3c78f09b9b58f9e1a2553d3e9` |
| MongleTerminal-0.3.15-x64.zip | 209315312 | `df8737bb810b01c3e8afd2dbd4d5e01ccc6432969d16430b9a24d0380d4b476e` |
| latest.yml | 368 | `e3f369cf3e0f98d18f737eb06481d537c0d7c97e0fd3b6797ebe6728ff8bdd12` |
| SHA256SUMS.txt | 386 | `903c5959dce8d81d20438ac5e8c387e81d330bfc18809963a748e58d31d3f308` |

### 최종 검사 영수증

원본 JSON은 개인 경로·프로세스 정보를 포함할 수 있어 커밋하지 않고 해시만 남긴다.

| 검사 | 결과 | JSON SHA-256 |
|---|---|---|
| artifact-verification | 통과 | `dad8657ba7ef40d71dece1f0b5632b97f21514d7a257faf80d75fdbd3931589c` |
| draft-verification | 통과 | `5e8b63d4f7f9057594cfbca49788109863a9724116350de94817107b80d7d77a` |
| public-downloads | 통과 | `ac115edba03b8b369420698e0143b3e25415f60a4c6087a33d28d36049ca76ff` |
| public-updater | 통과 | `532b8ae5ae566d70185f211415abac3c32eaa39277e92d76d6d05571a320a50c` |
| installed-payload-match | 통과 | `ba966081f7bab3da099422f72e88ad9b54ad76e6cbb8a2d8f207584ce6b9a60a` |
| previous-public-preservation | 통과 | `757c60fcac5f5ff7ee2ce8f0590799c02e74f2a0456327e801af3455f24ffa73` |

### 남은 범위

실제 Claude 2.1.292·Codex 0.160.0의 알림 표시·해제는 세션 한정 알림 설정에서 확인했다. Claude는 응답 뒤 유휴 지연을 거쳐 신호를 보냈으며 즉시 완료 판정이 아니다. 모바일 자동 검사는 Chrome 화면·trusted touch 에뮬레이션 기준이다. 실물 갤럭시·삼성 인터넷·설치형 PWA의 관성 체감, 실제 CLI에서 손을 뗀 뒤 이어지는 관성, 기본 CLI 알림 설정과 실제 창의 OS blur는 별도 범위다. 업데이트 검사는 현재 제품 updater에 격리 버전 어댑터를 사용했으며 설치된 구버전 앱의 실행으로 표현하지 않는다. 실제 사용자 설치본을 교체하거나 작업 중인 앱을 종료하지 않았다.
