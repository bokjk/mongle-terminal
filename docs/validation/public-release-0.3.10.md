# 0.3.10 응답성·안정성 배포 검증

기준일: 2026-10-04. **0.3.10 공개와 익명 다운로드 검증을 완료했다.** 기능·배포 PR과 공식 태그 검사, artifact 파일·패키지 검증 및 최종 EXE의 추가 QA를 통과했다. 실제 Electron의 설치본 전체 다운로드·동일 버전 확인과 공개 첨부 5개의 전체 다운로드·해시 일치도 확인했다. 0.3.9는 최종 패키지의 업데이트 시험 준비 오류로 공개하지 않았고 실패한 소스 태그를 보존한다. 실제 사용자 설치본 교체와 NSIS 설치 마법사 전체 조작은 수행하지 않았다.

## 변경 범위와 버전 전환

작은 터미널 출력 배치와 화면 캡처 중복 억제, 워크트리 Git 조회 병렬화·브랜치/태그 충돌 처리, 재연결·화면 상태·편집창 응답 순서 보호, 탐색기 불필요한 대기 읽기 취소를 포함한다. 출력 중 마우스 선택을 유지하고, 데스크톱 복사의 실제 저장 결과를 확인하며 설정의 주소·연결 코드도 같은 복사 경로를 사용한다. 관리자 권한 환경의 첫 실행에서는 새 데이터 폴더를 현재 사용자 소유·전용 접근 권한으로 먼저 준비한다. 빠른 연속 입력의 미처리 요청 누적을 줄이는 후속 수정도 포함했다. [기능 재현·측정](responsiveness-reliability.md), [클립보드 원인·검증](clipboard-followup.md), [0.3.9의 첫 실행 수정과 CI 기록](public-release-0.3.9.md)을 함께 읽는다.

0.3.9 최종 태그의 업데이트 시험은 `mkdtemp`로 미리 만든 Administrators 소유 폴더를 앱 데이터 경로로 넘겼고, 앱의 기존 소유권 검사가 거부하여 시작 제한 25초로 실패했다. 0.3.10에서는 시험용 임시 부모 아래 아직 생성하지 않은 데이터 경로를 넘겨 앱이 올바른 보호 상태로 준비하도록 한다. 이 변경은 시험 환경 준비를 바로잡는 것이며, 소유자·인증 검사나 타임아웃을 완화하지 않는다. 이전 사용자 변경 6개를 CHANGELOG의 0.3.10 항목으로 옮기고 빠른 연속 입력 보완을 추가했으며, 0.3.9는 미공개 기록으로 남긴다.

## 이전 기능의 검증 근거

아래는 0.3.9 소스의 실제 결과이며 0.3.10 패키지를 검사한 수치가 아니다.

| 범위 | 실제 결과 | 근거 |
|---|---|---|
| 응답성·클립보드 후속 수정의 로컬 회귀 | 372개 중 357 통과·실패 0·선택 실행 15 생략. 타입·빌드·문서·별도 패키지 네이티브 로드·아이콘 검사 통과. | [응답성 검증](responsiveness-reliability.md), [클립보드 후속](clipboard-followup.md) |
| 관리자 환경 첫 실행 수정 | 데스크톱 시작 순서 5/5. 로컬 IPC 9 통과·권한 제한 1 생략. 개발 Electron의 시작·접근 거부 안내·종료 복원·업데이트 안내 3/3. 기존의 다른 소유자 폴더 거부는 후속 CI에서 생략 없이 통과. | [첫 실행 수정·로컬 검증](public-release-0.3.9.md#관리자-환경의-첫-실행-실패-확인) |
| 기능 PR #33와 배포 PR #34 | 각각 380개 중 365 통과·실패 0·선택 실행 15 생략, 별도 정상 네이티브 클립보드 1/1. 기능 PR 결과에 기존 클립보드 복원·시험 프로세스 정리 성공. | [기능 CI](https://github.com/bokjk/mongle-terminal/actions/runs/37194095694), [배포 CI](https://github.com/bokjk/mongle-terminal/actions/runs/37194682559) |
| 통합 브랜치 검사 | dev push 성공. main push 두 번째 실행은 380개 중 365 통과·실패 0·선택 실행 15 생략, 별도 정상 클립보드 1/1. 첫 실행의 시작 표식 대기 실패는 보존. | [dev CI](https://github.com/bokjk/mongle-terminal/actions/runs/37194654729), [main 재검사](https://github.com/bokjk/mongle-terminal/actions/runs/37195190402/attempts/2) |
| 0.3.9 태그 패키지 | 업데이트 다운로드 선택 검사를 포함한 회귀 380개 중 366 통과·실패 0·14 생략. 패키지 네이티브 2개는 클립보드 1 통과·업데이트 브리지 1 실패·생략 0. 시험용 기존 폴더 소유권 문제로 배포 중단. | [실패한 태그 작업](https://github.com/bokjk/mongle-terminal/actions/runs/37195219441), [원인 기록](public-release-0.3.9.md#태그-패키지-실패와-다음-버전-전환) |

기능 PR #33의 `dev` 병합 커밋은 `7c08bb5b12c729dbc7caedccaa70f2ae5d2cf80f`이고, 배포 PR #34와 보존하는 `v0.3.9` 소스 태그는 `e2cfffeda4eafaa1021d2b9e72e160b670395314`를 가리킨다. 기존 태그를 다른 소스로 바꾸거나 실패 실행을 성공으로 바꾸지 않는다. 병합 시각·실패 진단·원시 결과 위치는 [0.3.9 기록](public-release-0.3.9.md)에 보존한다.

## 개발 단계와 검사 구성

- 0.3.10 로컬 타입·빌드를 통과했다. 보완한 업데이트 시험은 재빌드 전 0.3.9 실행 코드와 재빌드한 0.3.10 개발 Electron에서 각각 **1/1 통과·생략 0**했다. 0.3.10 결과는 `test-results/release-0310/update-desktop-local-result.json`이며 새 프로필 생성·업데이트 안내·설치 거부 후 호스트 유지·정리를 확인했다. 최종 태그 패키지 검사와는 구분한다.
- 버전·잠금 파일·README·CHANGELOG·사용자 안내와 배포 명령을 0.3.10으로 맞췄다. 실제 0.3.8과 0.3.6 화면 캡처의 버전은 그대로 유지한다.
- PR CI는 빌드 직후 정상 네이티브 클립보드와 업데이트 브리지를 모두 실행하고 두 JSON 결과를 보존한다. 생략 없이 두 경로를 통과한 뒤 전체 회귀를 실행한다.
- 최종 태그는 전체 검사·패키징 후 배포 EXE로 네이티브 클립보드와 업데이트 브리지를 다시 검사하고 두 결과를 보존한다. 모두 통과한 태그의 배포 artifact만 게시 후보로 사용한다.
- 첫 PR CI의 실패, 수정 후 기능·배포 PR, 공식 태그의 최종 성공·산출물·추가 패키지 QA와 공개·익명 다운로드 영수증은 아래에 구분해 기록한다.

## 빠른 연속 입력의 실패와 후속 수정

`ff1ef98`의 [PR #35 첫 CI](https://github.com/bokjk/mongle-terminal/actions/runs/37196356600)에서 별도 네이티브 검사는 **업데이트 브리지 1 통과·클립보드 1 실패**였다. 업데이트 시험의 프로필 초기화·지원하지 않는 업데이트 안내·호스트 보존·정리는 통과했다. 클립보드 시험은 연결과 인증된 데이터 폴더 준비 후에도 시험 프로그램을 시작하지 못했다. 진단에는 `textareaReadOnly: true`, `input-uncertain`, `pidFileExists: false`가 남았고 시험 프로세스 정리는 성공했다. 이 실행은 정상 복사 성공으로 계산하지 않는다. 결과는 `test-results/release-0310/pr35-first/clipboard/result.json`, `update-desktop/result.json`에 보존한다.

별도 재현은 실제 `packages/local-ipc/index.ts` 클라이언트와 메모리상의 가상 자식 프로세스 전송을 사용했다. 응답을 보류한 요청 64개는 받아들였고 다음 요청은 전송하지 않은 채 `IPC_BUSY`로 거부했으며, 앞선 응답이 돌아온 뒤 다시 요청을 처리했다. 이 근거는 미처리 요청 상한에 도달하는 구체적인 실패 경로를 입증하지만 **실제 CI에서 같은 오류 코드가 발생했다고 확정하는 근거는 아니다**. 네이티브 프로세스나 실제 IPC 파이프로 재현한 검사와도 구분한다. 결과는 `test-results/release-0310/owner-ipc-busy-repro.json`이다.

후속 수정은 패널별 입력 요청을 한 번에 하나만 전송하고, 같은 인코딩의 인접 입력을 순서대로 합친다. 아직 보내지 않은 입력과 전송 중인 입력의 합계를 64KiB 이내로 제한한다. 크기 변경 뒤에는 해당 화면의 ACK까지 전송을 멈추며, 연결·제어권·셸 generation·화면 재마운트가 바뀌거나 전송이 실패하면 남은 대기 입력을 버린다. 전달 여부가 불확실한 입력은 자동으로 다시 보내지 않는다.

입력 큐 단위 검사 **13/13**과 실제 Chrome의 TerminalPane 검사 **14/14**를 통과했다. 160개 빠른 입력의 순서·단일 전송, 한글·이모지·binary 바이트 경계, 상한 초과, 제어권·연결·마운트 변경, 크기 변경 ACK, 빈 큐의 동기화 실패와 이전 effect의 늦은 ACK 성공·실패를 검사했다. 최초 제어권 획득 ACK와 일반 출력 ACK를 각각 검사했다. 화면 동기화 실패 뒤 큐 없이 입력을 허용하지 않으며, 이전 연결의 완료가 새 제어 상태를 바꾸지 않도록 보호했다.

최종 입력 수정 후 타입·빌드와 실제 개발 Electron의 접근 거부 클립보드·업데이트 브리지 검사는 **2/2 통과·생략 0**이다. 두 시험의 격리 프로세스 정리를 확인했으며 `test-results/release-0310/input-fix-native-local.log`, `input-fix-clipboard-denied-result.json`, `input-fix-update-result.json`에 보존한다. 로컬의 클립보드 접근 거부 조건에서 실행한 검사이며, 정상 네이티브 복사 성공은 아래 후속 Windows CI와 태그 패키지에서 별도로 확인했다. 공개 다운로드 결과도 별도 항목에 기록한다. 원시 시험 결과는 커밋하지 않는다.

신규 검사와 기존 모바일 화면·키보드·제어권 획득·복원·선택 복사를 함께 실행한 최종 관련 회귀는 **57/57 통과·실패 0·생략 0**이었다. 크기 변경은 이미 전송 중인 입력의 응답을 기다린다는 계약에 맞춰 모바일 회귀도 갱신했으며, 응답 실패 시 크기 변경 요청·대기 입력을 보내지 않는지 확인했다.

## 기능 PR 최종 CI와 배포 준비

[PR #35 최종 CI](https://github.com/bokjk/mongle-terminal/actions/runs/37197591497)는 head `a667a6d9283e7c6be202442c0f7d388bd577b9ad`에서 **전체 407개 중 392 통과·실패 0·선택 실행 15 생략**이었다. 기본 회귀와 별도로 필수 정상 네이티브 클립보드·업데이트 브리지 **2/2 통과·생략 0**를 확인했다. 클립보드는 실제 왕복 후 `clipboardRestoration: restored`, `passed: true`, `cleanedUp: true`였고 업데이트 브리지도 `passed: true`, `cleanedUp: true`였다. 결과는 `test-results/release-0310/pr35-final/clipboard/result.json`과 `test-results/release-0310/pr35-final/update-desktop/result.json`에 있다. 개발 Electron의 실제 Windows 검사이며 최종 태그 패키지 검사로 기록하지 않는다.

[PR #35](https://github.com/bokjk/mongle-terminal/pull/35)는 **2026-10-04T11:17:15Z (UTC)**에 `dev`의 `715d25588f027b40288693eb13f8c43d3f03dda4`로 병합했다. 첫 실행의 실패와 가상 전송 재현, 로컬 접근 거부 검사는 앞 단락에 그대로 보존하며 최종 CI 성공으로 덮어쓰지 않는다.

`dev` → `main`의 [배포 PR #36](https://github.com/bokjk/mongle-terminal/pull/36)은 [Windows checks](https://github.com/bokjk/mongle-terminal/actions/runs/37198225967)에서 **전체 407개 중 392 통과·실패 0·선택 실행 15 생략**, 별도 필수 정상 네이티브 클립보드·업데이트 브리지 **2/2 통과·생략 0**였다. [PR target branch 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37198226054)와 별도 [dev push 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37198222271)도 통과했다. 배포 PR은 **2026-10-04T11:27:56Z (UTC)**에 `main`의 `229bc12ffed16a07fb773ecfa3964b11123b790b`로 병합했다. 실행 로그와 병합 영수증은 `test-results/release-0310/pr36-final/actions.log`, `test-results/release-0310/pr36.json`에 보존한다.

소스 태그 `v0.3.10`을 배포 병합 커밋 `229bc12ffed16a07fb773ecfa3964b11123b790b`에 생성·push했으며, 태그가 실제로 이 커밋을 가리키는지 확인했다. [main 병합 후 push 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37198829247)도 전체 **407개 중 392 통과·실패 0·15 생략**, 별도 필수 네이티브 **2/2**로 통과했다.

## 공식 태그 검사와 산출물 검증

[태그 작업 37198850889](https://github.com/bokjk/mongle-terminal/actions/runs/37198850889)은 같은 소스 커밋에서 성공했다. `MONGLE_E2E_UPDATES=1`로 실행한 전체 회귀는 **407개 중 393 통과·실패 0·선택 실행 14 생략**이며, 패키징 후 실제 배포 EXE의 정상 클립보드·업데이트 브리지는 **2/2 통과·생략 0**였다. 두 결과 JSON은 `passed: true`, `cleanedUp: true`이며 클립보드는 `clipboardRestoration: restored`다. `test-results/release-0310/tag-final/actions.log`와 같은 폴더의 `clipboard/result.json`, `update-desktop/result.json`, 상위 폴더의 `tag-run.json`에 증거를 보존한다.

공식 `windows-release` artifact ID는 **11302127984**, 다운로드 archive 크기는 **353,821,710바이트**, 서버 SHA-256은 `004d467e57f74597794790c3f711c1af02278797c622bb289bb14d17baaa8770`이다. `test-results/release-0310/tag-artifacts.json`에서 이 artifact가 위 태그 작업·소스 커밋에 속하는 것을 확인했다.

이를 `release-public-0-3-10`에 내려받고 별도 검증 도구로 파일 크기·SHA-256, 설치본 SHA-512와 `latest.yml`, 변경 이력과 Release 본문, ZIP 530개 항목의 경로·CRC, 동봉 버전·업데이트 주소·필수 파일을 확인했다. ZIP에서 새 폴더로 푼 패키지의 파일 440개와 네이티브 의존성 7개도 검사했다. **이 파일 검사 자체는 앱 실행·설치·공개 검사가 아니다.** 결과는 `test-results/release-0310/artifact-verification.json`에 있다.

| 태그 artifact 파일 | 바이트 | SHA-256 |
|---|---:|---|
| `MongleTerminal-Setup-0.3.10-x64.exe` | 147,678,842 | `f51cc8fc5d626e37a9594aa8b306b20fc92ec5a171f5fd0ff7ffdb27974b3dc6` |
| `MongleTerminal-Setup-0.3.10-x64.exe.blockmap` | 154,507 | `2e7b20396b195ecc591bf1a10ff918588cf420b697dc1914850b39fb3f8568a5` |
| `MongleTerminal-0.3.10-x64.zip` | 206,603,695 | `d43d7b2d6a29de2d1be8b5b783f1f3c9eb935afeee44dc85f9ae500901f1e0c9` |
| `latest.yml` | 368 | `28ab268f580ec2e7b2b23840a094999c9f7409fa704606b2de3b7b172362a4b4` |
| `SHA256SUMS.txt` | 386 | `53bef1f4eedb3ba5dbc19943c7d7784f79456328e9dcbc410bdf1b0da695e772` |
| `RELEASE-NOTES.md` | 2,545 | `018c53d6e27aba01381ad994d2204638a55cc816a698f26a723b1647f2338b45` |

이 표의 6개는 태그 artifact 구성이다. 공개 Release에는 본문으로 사용하는 `RELEASE-NOTES.md`를 제외한 5개를 첨부했고, 공개 메타데이터의 파일명·바이트·SHA-256이 위 표와 일치한다. 태그에 동봉된 사용자 안내의 SHA-256은 `f3cc92048d2e70cacb8ee10c15ad74b50064d618a3954e73f52dcabd358939e0`이며 해당 파일을 수정하지 않는다. 로컬 Git 체크아웃의 줄바꿈과 실제 배포 파일의 바이트는 구분한다.

## 실제 최종 패키지 QA

공식 artifact에서 푼 0.3.10 EXE로 **출력 중 파일 탐색·업데이트 안내와 지원하지 않는 설치 거부·종료 취소와 정상 종료/새 셸 복원 3/3 통과·실패 0·생략 0**을 확인했다. 격리된 실제 호스트·cmd·Electron을 사용했고 시험 프로세스 잔류 0개, `hashesUnchanged: true`였다. 결과는 `test-results/release-0310/final-package-qa/result.json`과 전후 파일 해시 기록에 보존한다. 완료 시각은 **2026-10-04T11:48:22.466Z (UTC)**다. 후속 읽기 전용 프로세스 조회에서도 관측한 13개 PID의 종료와 패키지 시험 프로세스 잔류 0개를 확인했다. 근거는 같은 폴더의 `cleanup-process-proof.json`이다.

정상 종료 검사는 네이티브 확인창 표시를 시험에서 대신 처리하며 제품 콜백·호스트 수명주기·셸은 실제로 실행했다. 따라서 확인창 자체의 시각적 조작이나 NSIS 설치 마법사·실제 설치본 업그레이드 검증까지 완료한 것으로 쓰지 않는다. 사용자 프로필·인증 데이터·Tailscale Serve는 변경하지 않았다.

## 공개 게시

`RELEASE_REPO_TOKEN` 미설정으로 Actions의 초안 생성 단계는 건너뛰었다. 이후 검증한 동일 태그 artifact를 인증된 게시 스크립트로 초안에 올리고 첨부 파일을 대조한 뒤, [0.3.10 Release](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.10)를 **2026-10-04T11:50:39Z (UTC)**에 공개했다. Release ID는 **402992923**, `draft: false`, `prerelease: false`다. 실제 공개 메타데이터는 `test-results/release-0310/public-release.json`에 보존한다.

[공개 README PR #3](https://github.com/bokjk/mongle-terminal-releases/pull/3)은 **2026-10-04T11:50:15Z (UTC)**에 `4903c2cc848da6cd5c51aa6e512ef44b819b411c`로 병합했다. 공개 저장소의 `v0.3.10` 태그는 같은 안내 커밋을 가리킨다. 실제 제품 빌드 출처인 비공개 소스 태그 `229bc12ffed16a07fb773ecfa3964b11123b790b`와 구분한다. 공개 저장소에는 사용자 안내와 배포 파일만 반영했으며 소스 공개 범위·라이선스는 변경하지 않았다. 영수증은 `test-results/release-0310/public-readme-pr.json`, `public-tag.json`에 있다.

## 인증 없는 업데이트·공개 파일 다운로드

실제 Electron에서 이전 0.3.8 패키지의 `resources/app-update.yml`을 읽고, **태그와 동일한 현재 소스의 업데이트 코드·현재 버전 0.3.8 지정**으로 공개 0.3.10 설치본을 인증 없이 전체 다운로드했다. `ready`, 진행률 100%, `availableVersion: 0.3.10`을 확인했다. 파일은 **147,678,842바이트**이며 SHA-256 `f51cc8fc5d626e37a9594aa8b306b20fc92ec5a171f5fd0ff7ffdb27974b3dc6`으로 태그 artifact와 일치했다. updater의 SHA-512 검사도 통과했다. 현재 버전을 0.3.10으로 지정한 별도 확인에서는 `idle`과 **최신 버전입니다.**를 받았다.

이 시험은 기존 설치본이나 0.3.8 updater 실행 코드를 사용한 업그레이드 검사가 아니다. 현재 소스로 만든 별도 Electron 도구와 격리 TEMP를 사용했고, 설치·종료·재실행은 실행하지 않도록 막았다. `credentials: false`, `fullDownload: true`, `installerExecuted: false`이며 **2026-10-04T11:51:27.622Z (UTC)**에 완료했다. 실제 결과는 `test-results/public-update-0310/result.json`에 있다.

공개 최신 Release가 `v0.3.10`이고 초안·사전 버전이 아닌 것을 확인했다. 설치본의 위 다운로드 결과와 ZIP·blockmap·`latest.yml`·`SHA256SUMS.txt`의 익명 전체 다운로드를 합쳐 **공개 첨부 5개 모두** 크기·SHA-256이 태그 artifact와 일치했다. ZIP도 **206,603,695바이트** 전체를 내려받아 SHA-256 `d43d7b2d6a29de2d1be8b5b783f1f3c9eb935afeee44dc85f9ae500901f1e0c9`을 확인했다. 모든 항목은 `fullDownload: true`, `artifactMatched: true`, `credentials: false`다. 기존 0.3.8 공개 첨부의 ID·크기·해시 불변도 확인했다. 결과는 **2026-10-04T11:52:31.417Z (UTC)**에 완료한 `test-results/public-assets-0310/result.json`에 보존한다.

## 보호 범위와 남은 검증

로컬 도구 환경의 `OpenClipboard` 오류 5는 이력으로 유지한다. 독립 Windows CI의 정상 복사 성공과 접근 거부 안내 검사를 구분하며, 과거 성공을 새 버전의 최종 패키지 검사로 대신하지 않는다. 사용자 호스트·셸·인증 데이터·실제 Tailscale Serve 설정은 변경하지 않고 시험은 TEMP의 격리 프로필을 사용한다.

설치 파일 생성·해시 검증, 업데이트 다운로드, 업데이트 브리지, 호스트 정상 종료·복원은 각각의 범위다. **실제 사용자 설치본 교체와 NSIS 설치 마법사 전체 조작은 수행하지 않았다.** 공개 저장소에는 사용자 안내와 배포 산출물만 게시하고 소스는 비공개·UNLICENSED로 유지한다. 코드 서명을 추가하지 않았으며 기존 0.3.8 공개 첨부와 0.3.9 소스 태그를 덮어쓰지 않는다.
