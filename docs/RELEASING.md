# 배포와 자동 업데이트

**0.3.16 배포 준비(2026-10-07):** Claude 자동 연동·작업 중 맥동·확인 전 완료 종, 붙여넣기 Enter 포커스, Git Bash 현재 경로 수정을 포함한다. 최종 전체 검사와 CI 산출물·공개 업데이트 검증을 진행하며 [배포 기록](validation/public-release-0.3.16.md)에 실제 결과를 기록한다. 현재 공개 채널은 0.3.15다.

## 0.3.16의 Claude 자동 연동

0.3.16 배포 후보에 포함한다. 데스크톱이 새 실행부를 시작할 때 `--claude-integration`을 전달하여 지원되는 Windows Claude의 사용자 설정에 관리 훅을 병합한다. 기존 실행부에 다시 연결하는 것만으로 새 훅이 설치되지는 않는다. 실행 중인 작업을 종료하거나 셸을 자동 재시작하지 않으며, 새 터미널부터 상태 토큰을 받는다.

기존 설정 백업, 관리 훅 스크립트, SHA-256으로 검증한 독립 Node 런타임 복사본은 Claude 설정 폴더에 보관한다. 설치 파일/ZIP을 옮기거나 제거해도 훅의 실행 파일 경로가 깨지지 않으며 몽글 토큰이 없는 세션에서는 상태를 보내지 않는다. 시스템 PATH나 Claude 인증은 변경하지 않는다. 패키지는 별도 훅 다운로드가 필요하지 않다.

개발·E2E는 `MONGLE_DATA_DIR`를 지정해 사용자 설정 설치를 기본 차단한다. 연동 시험만 `MONGLE_CLAUDE_CONFIG_DIR`로 별도 시험 설정 폴더를 명시한다. 실제 설치·업데이트와 개인 설정에 대한 자동 설치는 별도 검증 범위로 기록한다.

<!-- release-0.3.15-finalized -->

**0.3.15 공개 배포 완료(2026-10-07):** [공개 릴리스](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.15). [개발 PR 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37585036031) 499 통과·0 실패·15 생략, [배포 PR 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37586578183) 499 통과·0 실패·15 생략, [최종 태그 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37587926965) 500 통과·0 실패·14 생략. 네이티브 2/2와 [실제 NSIS 교체·복원](https://github.com/bokjk/mongle-terminal/actions/runs/37586578164), 최종 태그 설치 payload 일치, 공개 첨부 5개 익명 전체 다운로드·해시, 실제 Electron의 격리 버전 어댑터로 0.3.14→0.3.15 다운로드 및 동일 버전 최신 상태 확인을 통과했다. 이전 공개 릴리스는 변경하지 않았다. [최종 증거](validation/public-release-0.3.15.md#0315-final).

필수 검사를 통과한 windows-release artifact의 동일 파일을 배포했다.

실제 Claude 2.1.292·Codex 0.160.0의 알림 표시·해제는 세션 한정 알림 설정에서 확인했다. Claude는 응답 뒤 유휴 지연을 거쳐 신호를 보냈으며 즉시 완료 판정이 아니다. 모바일 자동 검사는 Chrome 화면·trusted touch 에뮬레이션 기준이다. 실물 갤럭시·삼성 인터넷·설치형 PWA의 관성 체감, 실제 CLI에서 손을 뗀 뒤 이어지는 관성, 기본 CLI 알림 설정과 실제 창의 OS blur는 별도 범위다. 업데이트 검사는 현재 제품 updater에 격리 버전 어댑터를 사용했으며 설치된 구버전 앱의 실행으로 표현하지 않는다. 실제 사용자 설치본을 교체하거나 작업 중인 앱을 종료하지 않았다.

> 아래 미배포·준비·이전 버전 완료 문구는 당시 검사 이력이다. 현재 공개 상태는 위 최종 기록을 따른다.

**0.3.15 — 모바일/PWA 새로고침:** 웹앱은 설치된 PC 호스트의 웹 자산을 사용한다. PC 업데이트 설치·재시작 뒤 **설정 → 앱 업데이트 → 화면 새로고침**으로 새 화면을 불러올 수 있도록 버튼을 추가했다. 미저장·저장 중 파일은 새로고침을 막는다. 자동 버전 감지·자동 새로고침·배포 저장소 변경은 없다. [검증 기록](validation/mobile-refresh.md).

<!-- release-0.3.14-finalized -->

**0.3.14 공개 배포 완료(2026-10-07):** [공개 릴리스](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.14). [PR 검사 37552799912](https://github.com/bokjk/mongle-terminal/actions/runs/37552799912): 460 통과·실패 0·15 생략. [최종 태그 검사 37553799324](https://github.com/bokjk/mongle-terminal/actions/runs/37553799324): 461 통과·실패 0·14 생략. [설치 교체 검사 37552799928](https://github.com/bokjk/mongle-terminal/actions/runs/37552799928)와 설치 payload 일치, 공개 첨부 5개 전체 다운로드·해시, Electron 업데이트 다운로드 검증을 통과했다. 이전 공개 릴리스 파일은 유지했다. [최종 증거](validation/public-release-0.3.14.md#0314-final).

모든 필수 검사를 통과한 windows-release artifact의 동일 파일을 공개했다.

모바일은 Chrome의 화면·trusted touch 에뮬레이션과 실제 Claude·Codex PTY 연결을 검증했다. 실물 휴대폰·삼성 인터넷·OS 키보드·외부 Tailscale 네트워크 검증으로 표현하지 않는다. Claude의 Jump to bottom 안내가 가린 글자의 복사 누락은 사용자에게 설명하고 허용된 알려진 제약으로 남는다. 사용 중인 설치본의 자동 교체·모든 CLI 버전의 검증을 뜻하지 않는다.

> 이후 미배포·준비·진행 중 문구는 각 검사 당시의 이력이며, 현재 공개 상태는 위 최종 기록을 따른다.

> 배포 준비 당시 기록: **0.3.14 배포 준비(2026-10-07):** CLI 드래그·Shift 자동 복사와 모바일 전체화면 터치 스크롤 수정을 공개 준비한다. 0.3.13 태그는 회귀 456 통과·0 실패·14 선택 생략, 네이티브 2/2와 실제 NSIS 교체·복원을 통과했으나 배포 파일 보존에 실패해 공개하지 않았다. 자동화 토큰의 초안 목록 누락에 대응해 GraphQL 조회와 ID 기반 확인을 보완한다. 새 버전의 PR·최종 태그·공개 다운로드 검증은 진행 중이며 현재 공개는 0.3.12다. [0.3.14 배포 기록](validation/public-release-0.3.14.md), [0.3.13 미배포 기록](validation/public-release-0.3.13.md).

이전 공개 버전: **0.3.12 Windows 미리보기**(2026-10-06 공개). PDF 보기와 드래그 자동 스크롤 수정을 포함한다. 개발·배포 PR과 최종 태그 검사, 실제 NSIS 교체·전체 파일 일치·작업 복원, 공개 첨부 5개 익명 전체 다운로드·해시와 실제 Electron 업데이트 다운로드를 확인했다. [0.3.12 배포 기록](validation/public-release-0.3.12.md).

이전 버전: **0.3.11 Windows 미리보기**(2026-10-05 공개). 파일 편집·마크다운과 성능·저장 보호, NSIS 압축 호환성 수정을 포함한다. 최종 태그 회귀·네이티브·실제 설치 교체와 복원, 공개 첨부 5개 익명 전체 다운로드·해시 일치와 실제 Electron 업데이트 다운로드를 확인했다. [0.3.11 배포 기록](validation/public-release-0.3.11.md).

과거 버전: **0.3.10 Windows 미리보기**(2026-10-04 공개). 연속 출력·입력·워크트리 조회와 탐색기·재연결·복사·관리자 환경 첫 실행을 보완했다. 공식 태그 검사와 추가 패키지 QA를 통과한 산출물을 공개했으며 실제 Electron의 익명 설치본 다운로드·동일 버전 확인과 공개 첨부 5개의 전체 다운로드·해시 검증을 마쳤다. [0.3.10 배포 기록](validation/public-release-0.3.10.md)에 실제 검사와 게시 영수증을 기록한다. 0.3.9는 공개하지 않았고 실패한 소스 태그를 보존한다. 실제 사용자 설치본 교체와 NSIS 설치 마법사 전체 조작은 수행하지 않았다.

0.3.10 이전 공개 배포는 **0.3.8**이었다. 설치본의 익명 전체 다운로드·해시 검증 결과는 [0.3.8 검증](validation/public-release-0.3.8.md)에 기록한다. 소스는 2026-10-07 공개로 전환했으며 [배포 전용 공개 저장소](https://github.com/bokjk/mongle-terminal-releases/releases/latest)에 설치 파일과 업데이트 메타데이터를 게시한다. 코드 서명과 프로젝트의 오픈소스 라이선스는 추가하지 않는다. 이전 배포는 [0.3.7 검증](validation/public-release-0.3.7.md), 공개 주소 전환은 [0.3.1 검증](validation/public-release-0.3.1.md)을 확인한다.

0.3.11 파일 편집 변경: 데스크톱에 저장하지 않은 편집 파일 또는 진행 중인 저장 요청이 있으면 앱 종료·완전 종료·업데이트 설치를 먼저 차단한다. 사용자가 편집기에서 저장하거나 탭을 닫아 변경을 버린 뒤 다시 진행해야 한다. 설치 전에는 이 차단 동작과 기존 종료·복원 절차를 함께 검증한다. 이 변경은 최종 태그 산출물을 검증한 뒤 0.3.11에 공개했다. 현재 공개 업데이트 채널은 위의 0.3.15이다.

최종 태그 작업도 같은 NSIS 설치·교체·복원 검사를 수행하며, 설치된 app.asar와 전체 hostbundle의 상대 경로·SHA-256이 패키지 원본과 모두 일치해야 artifact를 보존한다. 최신 7-Zip의 ARM64 필터와 NSIS 압축 해제기의 호환성 문제로 일부 파일이 빠지는 것을 재현했으므로, 패키징에서 호환되는 BCJ 필터를 명시한다. 파일 검사의 예외를 추가하지 않는다.

`Installed upgrade validation`은 별도의 일회성 GitHub 호스팅 Windows에서 공개 0.3.8 NSIS를 설치하고 작업을 정상 종료한 뒤 현재 소스의 실제 NSIS로 교체한다. 설치 표식·실제 실행 버전·패키지 해시·작업 그룹과 터미널의 자동 복원·시험 프로세스 종료를 검사하며 결과 JSON을 보관한다. 로컬 PC와 자체 호스팅 실행기는 스크립트가 거부한다. 이 검사는 공개 업로드·태그 생성 없이 실행하며 확인창 응답은 자동화한다. 마법사 전체 수동 조작이나 실제 사용자 설치본 교체로 표현하지 않는다.

이전 단계 프로세스의 정상 종료를 확인한 뒤 새 실행 단계의 PID를 별도로 추적한다. Windows는 종료된 PID를 재사용할 수 있으므로 복원 셸의 새 `generation`과 실행 중 여부, 호스트의 새 `bootId`로 재생성을 검사한다. 이전·새 PID 숫자가 다르다는 조건으로 대체하지 않는다. 설치 파일 전체 해시와 작업 복원 검사는 그대로 유지한다.

## 배포 경로와 기존 사용자 전환

- 소스: `bokjk/mongle-terminal` (2026-10-07 사용자 승인으로 공개). 프로젝트 라이선스는 변경하지 않았다.
- 배포: `bokjk/mongle-terminal-releases` (공개). 사용자 안내와 Release 산출물만 게시하며 소스·개발 문서·검증 기록·Git 이력을 복사하지 않는다.
- 대상: Windows 11 x64, 현재 사용자용 NSIS 설치본. ZIP은 수동 교체용이다.
- 업데이트: 설치본에 내장된 GitHub provider의 `repo`가 `mongle-terminal-releases`를 가리킨다. 사용자는 GitHub 로그인이나 토큰 없이 받는다.
- **0.3.0 이하 설치본에는 옛 비공개 주소가 내장되어 있다.** 0.3.1 이상을 한 번 직접 설치해야 전환된다. 이후 새 안정 버전부터 자동 다운로드한다.

소스 공개 후에도 기존 배포 주소를 유지한다. 주소를 다시 바꾸면 기존 설치본에서 도달 가능한 이전 채널에 전환 버전을 먼저 게시해야 한다. `package.json`의 `private: true`는 npm 게시 방지 설정이며 GitHub 공개 여부와 별개다.

## 비공개 테스트 배포

0.3.0까지는 설치 파일을 테스터에게 직접 전달했다. 기존 사용자는 작업을 저장하고 앱 메뉴의 **완전 종료…** 후 공개 페이지에서 받은 최신 설치 파일을 실행한다. 실행 중인 호스트가 남으면 설치 프로그램이 진행을 멈춘다. 사용자 데이터는 업데이트·제거 시 자동 삭제하지 않는다.

코드 서명이 없어 Windows SmartScreen이 표시될 수 있다. 출처를 확인한 설치 파일에서 **추가 정보 → 실행**을 선택한다. 현재 사용자 설치이며 관리자 권한은 필요 없다. 같은 버전 번호로 다른 바이너리를 다시 배포하지 않는다.

## 사용자 동작과 설치 대상

NSIS 설치본은 시작 30초 후와 6시간마다 새 안정 버전을 확인하고 다운로드한다. 설정의 **앱 업데이트**, 앱 메뉴와 트레이에서 직접 확인할 수 있다. 접속 중인 다른 PC가 아닌 지금 실행하는 데스크톱 앱의 상태다.

다운로드 후 사용자가 **설치 후 다시 시작**을 선택하고 확인하면 현재 PC의 작업 저장·정상 종료를 거쳐 설치한다. 저장이나 종료가 실패하면 설치하지 않는다. 다운로드나 평소 앱 종료만으로 설치하지 않는다. 설치 중 원격 연결도 잠시 끊기며 다음 실행에서 작업 공간과 새 셸을 복원한다. 기존 프로그램을 자동 재실행하지 않는다.

ZIP·개발 실행은 작업 저장·완전 종료 후 수동 교체한다. 실제 구버전 NSIS → 신버전 설치·재실행·복원 검증은 패키지 실행이나 다운로드 검사와 구분한다.

## 필수 검증과 이전 0.3.10 결과

[Windows checks](../.github/workflows/ci.yml)는 빌드 직후 실제 Windows 클립보드 왕복과 업데이트 브리지를 모두 검사한 뒤 전체 회귀를 실행한다. `MONGLE_E2E_CLIPBOARD=1`과 `MONGLE_E2E_UPDATE_DESKTOP=1`을 설정하고 OwnerPipe 데이터는 `%TEMP%` 아래에 격리한다. 두 검사 중 하나라도 실패하면 해당 단계가 실패하며, 선택 검사를 생략한 기본 회귀만으로 대신하지 않는다. 접근 거부 상황에서 오류 표시만 확인하는 검사도 정상 복사 성공을 대신하지 않는다.

[태그 배포 작업](../.github/workflows/release.yml)은 최종 `release/win-unpacked/MongleTerminal.exe`로 네이티브 클립보드와 업데이트 브리지를 다시 검사한다. PR CI와 태그 작업 모두 두 검사의 JSON 결과를 보존한다. 이 단계가 성공해야 검증된 설치 파일·ZIP·메타데이터를 `windows-release` artifact로 보존하고 공개 저장소의 초안 생성 단계로 진행한다. 게시할 파일은 해당 태그 작업에서 검증한 artifact를 사용한다.

로컬 도구 실행 환경의 Windows 클립보드 접근 오류 5는 이력으로 보존한다. [0.3.10 기능 PR #35](https://github.com/bokjk/mongle-terminal/actions/runs/37197591497)·[배포 PR #36](https://github.com/bokjk/mongle-terminal/actions/runs/37198225967)·main push는 각각 전체 **407개 중 392 통과·실패 0·선택 실행 15 생략**, 별도 정상 클립보드·업데이트 브리지 **2/2**였다. [공식 태그 작업](https://github.com/bokjk/mongle-terminal/actions/runs/37198850889)은 업데이트 다운로드 선택 검사를 포함해 **407개 중 393 통과·실패 0·14 생략**, 최종 배포 EXE의 네이티브 검사 **2/2 통과·생략 0**을 확인했다. 두 시험은 정상 정리됐고 클립보드도 복원했다. 태그 artifact의 파일·메타데이터·패키지 확인과 같은 EXE의 추가 QA **3/3 통과·실패/생략 0**, 시험 뒤 파일 해시 불변을 확인하고 공개했다.

공개 뒤 실제 Electron에서 **기존 0.3.8의 업데이트 설정·태그와 같은 현재 소스·현재 버전 0.3.8 지정**으로 인증 없는 0.3.10 설치본 전체 다운로드와 해시 일치, 같은 버전 0.3.10의 최신 상태를 확인했다. 공개 첨부 5개도 모두 인증 없이 전체 다운로드해 태그 artifact와 대조했다. 기존 0.3.8 공개 첨부의 ID·크기·해시는 유지됐다. 이 검사는 설치된 구버전 앱을 실행하거나 설치본을 교체한 검사가 아니다.

Actions의 공개 저장소 초안 생성 단계는 `RELEASE_REPO_TOKEN`이 설정되지 않아 건너뛰었다. 이후 검증한 동일 artifact를 인증된 게시 스크립트로 초안에 올리고, 첨부 파일을 대조한 뒤 **2026-10-04T11:50:39Z (UTC)**에 [0.3.10 Release](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.10)를 공개했다. 실제 초안·게시 결과는 [0.3.10 배포 기록](validation/public-release-0.3.10.md)에 보존한다.

관리자 환경의 새 데이터 폴더를 현재 사용자 전용으로 먼저 준비하는 제품 수정은 Windows CI에서 첫 실행·정상 복사와 기존의 다른 소유자 폴더 거부까지 확인했다. 그러나 소스 태그 `v0.3.9`의 [패키징 작업](https://github.com/bokjk/mongle-terminal/actions/runs/37195219441)은 업데이트 시험이 데이터 폴더를 Administrators 소유로 미리 만들어 앱이 거부하면서 실패했다. 전체 회귀·패키지 클립보드 성공만으로 배포를 진행하지 않았고, 시험용 경로 준비를 보완한 0.3.10 기능 PR CI에서 업데이트 브리지도 통과했다. 최종 패키지 검사와는 구분하며 소유자·인증 검사를 완화하거나 기존 태그를 덮어쓰지 않는다. [0.3.9 실패 기록](validation/public-release-0.3.9.md)과 [0.3.10 검증](validation/public-release-0.3.10.md)을 구분한다.

업데이트 다운로드·체크섬, 패키지의 업데이트 브리지, 호스트 정상 종료·복원은 각각 수행 범위를 기록한다. 브리지 검사는 ZIP 실행본의 수동 업데이트 안내와 설치 불가 요청 시 호스트 보존을 확인하며, NSIS 설치 마법사로 구버전 설치본을 실제 교체·재실행하는 검사까지 완료했다는 뜻은 아니다.

## CI 결과 보존과 저장 공간

공개 협업용 정책에서도 모든 코드 PR의 전체 회귀는 유지한다. 별도 NSIS 설치 리허설은 웹 UI와 알려진 개발 문서의 추가·수정만 있는 PR에서 생략한다. Windows 아이콘 원본, 동봉 사용자 안내·제3자 고지·라이선스, 데스크톱·호스트·패키징·의존성·설정·시험·미확인 경로 변경과 모든 삭제·파일 유형 변경은 설치 검사를 수행한다. 배포 PR과 수동 실행은 항상 수행하고 범위 판정 실패도 실패로 전달한다. 최종 태그의 NSIS 검증은 그대로 유지한다. 이 변경은 저장소 공개나 라이선스·결제 설정 변경을 포함하지 않는다.

PR 본문 검사는 별도 **PR description** Linux 작업으로 수행하며 본문 수정 때문에 앱을 다시 빌드하지 않는다. `dev` 대상의 알려진 Markdown 문서만 바뀐 PR은 문서 정합성만 검사하고 런타임 검사를 생략했다고 요약한다. 코드 변경·수동 실행·`dev` → `main` 배포 PR은 Windows 전체 검사를 유지한다. 병합 후 `dev`·`main` push의 중복 빌드는 제거하므로, 유지보수자는 병합 직전 최신 base를 반영한 head의 **Windows checks**·**PR description**·**PR target branch**와 해당 설치 검사를 확인한다. base가 바뀌면 주제 브랜치를 갱신해 재검사한다. ruleset은 최신 base와 세 검사를 요구하며 공개 전환 후 active로 적용했다. 태그의 최종 산출물 검증·보존·공개 전 검증은 줄이지 않는다. [사용량 조사와 현재 적용 상태](validation/actions-usage.md).

검사 통과 여부와 결과 파일 업로드를 구분한다. 네이티브·설치 검사의 passed/cleanedUp과 원본 JSON SHA-256을 job 로그와 summary에 먼저 남기며, 누락·실패·정리 실패는 검사를 실패시킨다. 작은 진단 artifact 업로드만 저장 공간 오류로 전체 회귀를 막지 않도록 선택적 보존으로 처리한다. 각 변경 범위에 해당하는 타입·빌드·테스트·네이티브·NSIS 검증과 최종 태그 검증은 계속 필수다. 큰 windows-release 산출물 업로드는 필수이며 보존 기간은 1일이다. 게시에 필요한 파일은 즉시 내려받아 확인하고, 기존 공개 버전의 CI 사본을 정리할 때는 로컬 백업 6개 파일·자체 체크섬을 확인하고 공개 첨부와 대조한다. 초기 버전처럼 공개본과 태그 재빌드가 다르면 차이를 기록하고 CI 원본 전체를 별도 보존한다. 공개 Release·소스·실행 로그·작은 검사 증거는 보존한다.

## 브랜치와 배포 순서

1. `dev`에서 만든 주제 브랜치에서 버전·잠금 파일·README·사용자 안내를 갱신하고 미배포 변경을 날짜가 있는 CHANGELOG 항목으로 옮긴다. 공개 Release 본문으로 쓰므로 해당 버전 항목에는 내부 문서 링크나 개인 정보를 넣지 않는다.
2. 타입·빌드·회귀·패키지 검사를 수행하고 PR로 `dev`에 병합한다. 이어 최신 base를 반영한 `dev` → `main` 배포 PR의 **Windows checks**·**PR description**·**PR target branch** 및 해당 설치 검사 통과 후 병합한다. `main` 직접 push는 하지 않는다.
3. 병합된 `main` 커밋에 `vX.Y.Z` 태그를 push한다. [Windows release draft](../.github/workflows/release.yml)는 해당 태그를 검사·빌드·패키징하고 `windows-release` artifact를 보존한다.
4. 배포 자격 증명이 있으면 공개 저장소에 Release **초안**을 만든다. 없으면 artifact까지만 만들고 경고한다. 유지보수자가 아래 수동 게시 명령으로 초안을 만들 수 있다.
5. 검증된 초안의 파일·버전·변경 내용을 검토한 뒤 `gh release edit vX.Y.Z --repo bokjk/mongle-terminal-releases --draft=false --latest`로 공개한다. 인증 없는 다운로드·메타데이터·해시 일치를 확인하고 결과를 기록한다. 공개를 확인한 뒤 README의 후보 표시와 현재 공개 버전, 이 문서의 배포 상태를 갱신한다. 패키지에 동봉한 사용자 안내는 태그의 파일과 일치하게 보존한다.

공개 저장소의 태그는 안내 README 커밋을 가리킨다. 실제 빌드 출처는 소스 저장소의 동일 버전 태그와 Actions 기록으로 추적한다. 소스 Git 이력을 배포 저장소에 push하지 않는다. 이미 공개한 버전은 덮어쓰지 않으며 수정 시 버전을 올린다. 소스 공개 후 서버 측 ruleset을 적용했으며 [기여 절차](../CONTRIBUTING.md)를 지킨다.

## 자동 초안 생성 인증

GitHub Actions의 기본 `GITHUB_TOKEN`은 다른 저장소에 쓸 수 없다. 공개 배포 저장소 하나만 선택하고 **Contents: Read and write** 권한을 부여한 fine-grained PAT를 소스 저장소의 Actions secret **`RELEASE_REPO_TOKEN`**에 저장한다. 토큰은 초안 게시 단계에서만 사용하며 앱·소스·로그에 넣지 않는다. [GitHub 인증 문서](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token)

### Actions 저장 공간 제한 시 배포 파일 보존

`windows-release` 업로드가 실패하면 모든 필수 검사에 성공한 태그 빌드만 소스 저장소의 비공개 릴리스 초안에 동일 파일을 보존한다. 저장소 자체가 공개여도 초안 상태만 허용하며, 지정된 소스 저장소와 일관된 visibility 응답을 확인한다. 기존 태그·체크아웃·실행 SHA가 같아야 하며 공개된 릴리스나 다른 실행의 초안을 덮어쓰지 않는다. 파일 보존까지 실패하면 배포 작업도 실패한다. 이 경로는 검사 생략이나 공개 게시가 아니다.

태그 빌드 job은 이 보존을 위해 소스 저장소의 `contents: write` 권한을 사용한다. 이는 마지막 단계만의 권한 격리가 아닌 **job 전체 권한**이다. PR 검사는 계속 읽기 전용이며, 공개 배포 토큰은 빌드 job에 전달하지 않는다. 수동 실행 시에도 선택한 ref의 `GITHUB_SHA`와 입력 태그가 같아야 한다.

보존 경로를 사용하면 자동 공개 초안 단계는 건너뛰고 유지보수자가 기존 인증된 `gh`로 비공개 초안을 내려받는다. 로그·summary의 manifest SHA-256, 태그·실행 ID·시도 번호, 각 파일의 크기·SHA-256을 대조한 뒤 기존 `publish-release.ps1`로 공개 저장소의 초안을 만든다. 공개 첨부는 기존 5개만 허용하며 보존 manifest·내부 검사 기록·소스는 공개하지 않는다. 동일 실행·시도의 동일 manifest만 중단된 업로드를 이어갈 수 있다. 다른 실행의 부분 초안은 내용을 검토하고 별도로 정리하기 전까지 재사용하지 않는다.

현재 전용 secret은 미설정이다. 로그인된 유지보수자의 `gh`로 초안을 생성하는 경로를 제공하며, 이것은 설치한 사용자의 자동 업데이트와 별개다. 배포 파일이 공개되면 사용자 앱은 토큰 없이 확인·다운로드한다. 범용 개인 토큰을 자동으로 복제해 secret으로 등록하지 않는다.

## 로컬 패키징과 초안 생성

```powershell
node --import tsx scripts/release-check.ts
npm.cmd run typecheck
npx.cmd tsx --test --test-concurrency=1 tests/**/*.test.ts
node --import tsx scripts/package.ts --output release-candidate
# CHANGELOG의 현재 버전 항목을 검토해 release-candidate/RELEASE-NOTES.md로 저장
powershell.exe -NoProfile -File scripts/publish-release.ps1 -Version 0.3.11 -OutputDir release-candidate -CheckOnly
powershell.exe -NoProfile -File scripts/publish-release.ps1 -Version 0.3.10 -OutputDir release-candidate
```

`--output`은 프로젝트 아래 `release` 또는 `release-<이름>`을 받는다. 실사용 앱이 있는 `release/`를 덮어쓰지 않는다. `package.ts`는 토큰이 있어도 게시하지 않는다. 게시 스크립트는 지정된 공개 저장소만 대상으로 삼아 체크섬을 확인하고 초안만 생성·갱신한다. 태그 워크플로의 artifact를 내려받았다면 동봉된 `RELEASE-NOTES.md`를 사용한다.

공개 패키지에는 빌드된 실행 코드, 필수 Windows 보조 실행 파일, Node 런타임, 네이티브 의존성, 사용자 안내와 `THIRD-PARTY-NOTICES.md`·`docs/licenses`를 포함한다. 내부 검증 문서, 소스맵, 보조 프로그램 C# 소스는 제외한다. 실행 가능한 JavaScript 번들 자체를 비밀로 보호한다는 뜻은 아니다.

아이콘은 `scripts/build-icons.ts`에서 원본 PNG를 읽어 Windows 7개 크기와 웹 3개 크기로 생성한다. `sharp`는 Apache-2.0 라이선스의 빌드 전용 개발 의존성이며, 해당 모듈과 libvips 바이너리는 설치본에 포함하지 않는다. `IconBuilder.exe`는 생성·실행·배포하지 않는다. 기존 체크아웃에 남은 파일의 알약 탐지는 [검사 기록](validation/antivirus-icon-builder.md)을 참고하고 백신 제외로 빌드를 통과시키지 않는다.

## Release 첨부 파일

| 파일 | 용도 |
|---|---|
| `MongleTerminal-Setup-<version>-x64.exe` | NSIS 설치·업데이트 |
| 위 파일의 `.blockmap` | 차등 다운로드 메타데이터 |
| `MongleTerminal-<version>-x64.zip` | 수동 교체용 |
| `latest.yml` | 버전·파일 이름·크기·SHA-512 |
| `SHA256SUMS.txt` | 위 네 파일의 SHA-256 |

체크섬은 파일 일치를 확인하며 Windows 코드 서명을 대신하지 않는다. 초안은 `--latest=false`로 만들고 안정 버전을 게시할 때 latest로 지정한다. 사전 버전·초안은 일반 사용자의 안정 업데이트 채널로 사용하지 않는다.
