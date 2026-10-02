# 기본 작업 표시·탭 재병합·한글 Shift+Enter 후속 검증

기준일: 2026-10-02 · `codex/worktree-support` · 0.3.6 이후 미배포 소스

## 변경과 원인

- 기본 작업은 실제 프로젝트 폴더 이름과 `기본` 배지로 표시한다. 사이드바와 기본 터미널 탭에서 Git 아이콘 대신 이름 앞에 배지를 두며, 추가 워크트리는 가지 아이콘을 사용한다. 후속 목록 압축에서 중복 `워크트리` 태그를 제거했다. 기존 자동 이름 `원래 작업`·`원본 폴더`는 화면에서 실제 폴더 이름으로 표시하며 다른 사용자 지정 이름은 유지한다. 일반 터미널은 터미널 아이콘을 유지한다. 아래 앞선 검증의 원본·태그 표시는 당시 화면을 뜻하며 마지막 표시 검증을 따로 기록한다.
- 탭 제목을 같은 영역·다른 영역의 탭 앞뒤에 놓으면 세로 삽입선 위치로 옮긴다. +에 놓으면 마지막에 붙인다. 기존 가장자리 분리·중앙 병합·점 손잡이의 영역 전체 이동을 유지한다. 마지막 탭이 이동한 빈 영역만 정리하며 셸 PID·generation은 유지한다. 16개 탭 제한, 연결·호스트·그룹·revision 검사, 외부 드래그 거부와 Esc 취소를 유지한다.
- 지난 입력 수정은 한글 조합 중 `Process/229` 키 이벤트를 그대로 넘겼다. 마지막 글자만 전달되고 Shift+Enter가 누락되는 조건을 Chrome에서 재현했다. 물리 키 `code=Enter`와 Shift를 확인해 조합 확정 후 수정 키 이벤트를 한 번 전달한다. 일반 Enter의 조합 확정 동작은 유지한다. 확정 전 다른 키 입력·새 조합·초점/제어권 상실·종료 때 대기 키를 취소한다.
- 조합 확정 직후 다음 키가 xterm의 지연 처리보다 먼저 도착하면 대기 중이던 줄바꿈을 취소하는 추가 경합도 재현했다. xterm이 마지막 글자를 전송한 직후 수정 Enter를 보내 글자·줄바꿈·다음 키 순서를 유지한다. 수정 전 `한`과 왼쪽 방향키만 전송되었고 수정 후 그 사이에 Shift+Enter가 정확히 한 번 전송된다.

## 디자인 참고

Aside 브라우저에서 [Mobbin Notion Workspace](https://mobbin.com/explore/screens/cbf7d1f7-7603-405e-ba9e-dc7573bc71e4)와 [Mobbin Front Inbox Email Thread](https://mobbin.com/explore/screens/3e29dd35-0c1d-4f71-831b-af35c13bf1ec)를 열고 스크린샷을 직접 확인했다. Notion 사이드바의 항목별 아이콘, Front의 다중 열·상단 탭·항목 보조 표시를 비교했다. 종류를 색상만으로 구분하지 않고 아이콘과 짧은 글자를 함께 쓰며 기존 테마·32px 제목줄을 유지했다. Mobbin의 정적 화면에서 드래그 동작을 확인한 것으로 표현하지 않는다.

## 검증

- 타입 검사·전체 빌드 통과. 기존 번들 크기 안내는 유지된다.
- 전체 회귀 **321개 중 308 통과, 실패 0, 선택 실행 13 생략**. `.test-data/followup-regression.log`. 마지막 연속 입력 경합 보완 전 실행이다. 이후 관련 입력·탭 검사를 아래처럼 다시 실행했다. 최종 타입·빌드·배포 문서 검사 `release-check.ts`도 통과했다.
- 브라우저/레이아웃 관련 검사 24개 중 23 통과, 실패 0, 기존 선택 실행 1 생략. 한글 IME 재현 검사는 수정 전 `한`만 전송되어 실패했고 수정 후 `한` 다음에 수정 Enter가 정확히 한 번 전송되어 통과했다.
- 실제 Chrome·HostCore·ConPTY: 원본/워크트리 표시, 탭 분리→다른 탭 앞에 재병합, 같은 영역 내 순서 변경, +로 끝에 이동, Esc, 기존 PID·generation·화면 DOM 유지 통과. 전체 영역 드래그 및 워크트리 생성·삭제·모바일 검증도 통과했다.
- 실제 개발 Electron·OwnerPipe·Git·ConPTY 1/1 통과. 원본 표시, 실제 마우스로 탭 분리·재병합·순서 변경, 모든 PID·generation 유지, 기존 작업 메뉴 위치·GUI 재시작·승인된 웹 동작을 확인했다. `test-results/e2e/worktrees/result.json`, `desktop-tab-rejoin.png`.
- 연속 입력 보완 후 Chrome 입력·레이아웃 **24개 중 23 통과, 실패 0, 선택 실행 1 생략**. 터미널 전체·탭·PowerShell 제어권 통합 검사 **40개 중 39 통과, 실패 0, 선택 실행 1 생략**. `.test-data/ime-following-key-before.log`에 재현 실패, `.test-data/ime-following-key-after.log`와 `.test-data/followup-final-input-regression.log`에 수정 후 성공을 기록했다.
- 최종 실제 개발 Electron·Codex CLI 0.160.0: **PowerShell 7에서 1/1, CMD에서 1/1 통과**. PowerShell에서는 `--sandbox read-only`, CMD에서는 `--no-daemon --sandbox read-only`로 전체 화면에서 검증했다. 영문 Shift+Enter와 Chromium IME 조합 직후 Shift+Enter 모두 입력창 줄바꿈으로 남는다. 프롬프트는 전송하지 않았으며 Codex 종료 후 일반 Enter의 CMD 명령 실행도 확인했다. `test-results/e2e/codex-keyboard-powershell-default/result.json`, `test-results/e2e/codex-keyboard-cmd-direct/result.json`.
- 종류 표시를 브랜치 보조 줄로 옮긴 최종 화면에서 실제 Git·셸 워크트리 UI 검사 **1/1 통과**. 최신 예제 앱에서도 원본/워크트리 표시, 실제 마우스로 다른 탭 앞에 합치기, PID·generation 유지와 다시 분리한 화면을 확인했다. `test-results/e2e/latest-worktree-preview/result.json`, `.test-data/followup-final-worktree-ui.log`. PowerShell 4개·영역 2개인 **최신 수정본 · 탭 이동** 창을 열어 두었으며 기존 미리보기는 종료하지 않았다.

탭 검사 초기 실패는 탭 아이콘에 진입할 때 `dragenter`만 연속 발생하고 `dragover`가 아직 발생하지 않아 미리보기가 이전 분할 위치에 남는 문제였다. `dragenter`에서도 위치를 갱신해 수정했다. Codex 검사는 시작 안내가 뜨기 전 입력하거나 제어권 준비 전에 명령을 입력하던 검사 순서를 보완했다. 옵션 없는 CMD 시도에서 초기 설정 화면이 다시 표시되어 실패한 기록도 있으며 최종 CMD 검증 옵션과 구분한다. 종료 검사는 화면 기록에 남은 과거 프롬프트를 현재 프롬프트로 잘못 판단해 명령 앞부분을 잃었다. 마지막 비어 있지 않은 행의 현재 프롬프트를 기다리도록 고친 후 두 셸 모두 통과했다. 검사 준비 오류와 제품의 IME 누락을 구분한다.

로그: `.test-data/followup-tabs.log`, `.test-data/followup-ui.log`, `.test-data/keyboard-tabs-unit.log`, `.test-data/followup-final-codex-powershell.log`, `.test-data/followup-final-codex-cmd.log`, `.test-data/followup-electron-tabs.log`. 격리 임시 경로가 포함된 캡처·로그는 커밋하지 않는다.

## 후속 표시 수정: 기본 태그

사용자의 요청에 따라 `원본 폴더`라는 이름과 폴더 아이콘을 제거했다. 새 기본 작업 이름은 실제 폴더 이름이며, 예전 자동 이름은 화면에서 해당 이름으로 변환한다. 사용자 지정 이름은 유지한다. 사이드바와 기본 터미널 탭에 `기본` 태그를 표시하고 Git 작업에는 공통 가지 아이콘을 사용한다. 이 태그는 기본 작업 위치를 뜻하며 현재 브랜치 이름은 별도로 표시한다.

Mobbin Notion Workspace·Front Inbox Email Thread의 공개 화면을 Aside 브라우저에서 다시 열고 스크린샷을 확인했다. Notion의 항목명·아이콘 구분과 Front의 제목 주변 작은 보조 태그를 참고했다. 기존 테마의 보조 테두리·텍스트 색으로 작은 태그를 적용했다.

`npm run typecheck`, `npm run build` 통과. 관련 호스트·워크트리 UI·터미널 탭 검사 **8/8 통과**(`.test-data/basic-tag-regression.log`). 실제 개발 Electron 예제에서도 `frontend`·`backend`와 `기본` 태그, 작업/탭의 폴더 아이콘 제거, 메뉴 열기·닫기를 확인했다. 검증 전후 PID·generation·레이아웃이 같으며 이전 자동 이름 변환과 사용자 지정 이름 유지를 확인했다. 증거는 `test-results/e2e/basic-tag-preview/result.json`과 `basic-tag.png`다. 닫혀 있던 예제는 동일한 격리 프로필로 다시 열었으며 새 개발 창을 남겨 두었다.

## 후속 표시 수정: Git 아이콘 대신 기본 배지

사용자가 요청한 위치는 이름이나 브랜치 옆의 추가 태그가 아니라 기존 Git 아이콘 자리였다. 기본 작업은 사이드바와 터미널 탭 모두 이름 앞의 30×18px `기본` 배지로 교체하고 중복 태그를 제거했다. 사이드바의 아이콘 영역 폭을 맞춰 기본 작업과 추가 워크트리의 제목을 정렬했다. 기존 테마의 표면·보조 텍스트·테두리 토큰을 사용하고 선택 시 강조색을 적용한다.

Mobbin의 위 Notion Workspace·Front Inbox Email Thread 공개 화면을 이번 수정에서도 Aside 브라우저로 직접 열고 스크린샷을 확인했다. Notion의 이름 앞 표식과 Front의 작은 보조 표시를 비교해 앞쪽에 짧은 글자 배지를 두었다. `기본` 문구와 Git 아이콘 교체 위치는 사용자가 지정한 요구사항이며 Mobbin에 같은 워크트리 배지가 있는 것으로 표현하지 않는다.

- `npm run typecheck`, `npm run build`, `release-check.ts`, `git diff --check` 통과. 기존 번들 크기 안내는 유지된다.
- `tests/ui/worktrees.test.ts`, `tests/ui/terminal-tabs.test.ts` **2/2 통과**. 실제 Git·셸과 Chrome에서 생성·선택·메뉴·삭제·탭 및 모바일 화면 회귀를 확인했다. `.test-data/basic-badge-regression.log`.
- 기존 격리 개발 Electron 예제에서 Git 아이콘 제거, 사이드바·탭 제목 앞 배지 위치, 크기·중복 표시 없음, 추가 워크트리의 Git 아이콘 유지, 배지 클릭으로 기존 터미널 선택, 메뉴 열기·닫기를 확인했다. 검증 전후 터미널 PID·generation·레이아웃이 같았다. 검증 코드의 최초 정수 크기 비교는 브라우저 좌표의 소수점 오차로 실패해 0.1px 허용치로 조정했으며 제품 크기는 30×18px로 확인했다.
- 증거: `test-results/e2e/basic-badge-preview/result.json`, `basic-badge.png`, `sidebar-basic-badge.png`. 예제 창에 수정본을 반영하고 열어 두었다. 설치본 교체·공개 배포는 수행하지 않았다.

## 후속 수정: 터미널 수와 사이드바 선택 목록

사용자 예제의 그룹에는 터미널 5개가 있었지만 사이드바는 연결된 Git 작업 4개만 렌더링했다. 나머지 `일반 폴더` 터미널은 탭에는 존재했으나 사이드바에서 빠져 있었다. 그룹 수는 분할·탭 레이아웃의 모든 터미널을 세고 있었으므로 터미널 소실이 아니라 선택 목록의 누락이었다.

그룹 레이아웃의 터미널 중 표시 중인 Git 작업에 묶이지 않은 항목을 터미널 아이콘·이름·현재 폴더로 표시한다. 현재 폴더를 모르면 시작 폴더를 사용하며 종료된 탭은 종료됨을 표시한다. Git 연결 없는 그룹에도 접기/펼치기와 목록을 제공한다. 선택은 기존 화면 이동 경로를 이용해 새 셸을 생성하지 않는다. Git 작업별 여러 터미널은 기존 숫자 버튼으로 선택하므로 행 수와 전체 터미널 수가 항상 같지는 않다.

Mobbin의 [Front Inbox Email Thread](https://mobbin.com/explore/screens/3e29dd35-0c1d-4f71-831b-af35c13bf1ec)를 Aside 브라우저로 다시 열어 스크린샷을 확인했다. 서로 다른 항목의 아이콘·이름·보조 정보가 같은 사이드바 목록에 있는 구성을 참고하고 기존 행 크기·색·선택 상태를 재사용했다. Git/일반 터미널 분류는 이번 앱 요구사항이며 참고 화면의 기능으로 주장하지 않는다.

- 수정 전 빌드에서 회귀 검사 2건이 일반 터미널 행 없음으로 실패했다. `.test-data/sidebar-terminal-before.log`.
- 수정 후 타입 검사·빌드 통과. `tests/ui/worktrees.test.ts`, `tests/ui/terminal-tabs.test.ts` **2/2 통과**. Git 연결 전 일반 행 표시→연결 후 중복 제거, 혼합 그룹의 수 합계, 일반 행 선택, Git 없는 그룹의 접기/펼치기와 다른 그룹에서 직접 선택, 390px 모바일 메뉴 닫힘, PID·generation·레이아웃 보존을 검증했다. `.test-data/sidebar-terminal-after.log`.
- 기존 격리 개발 Electron 예제에 수정본을 적용했다. 그룹 수 5 = Git 작업별 터미널 4 + 개별 일반 터미널 1, 이름·현재 폴더·터미널 아이콘, 기존 탭 선택·접기/펼치기, 세션 식별자·분할 배치 유지 확인. `test-results/e2e/sidebar-terminals-preview/result.json`, `sidebar-all-terminals.png`. 기존 창을 열어 두었으며 실사용 셸을 종료하지 않았다.
- Git 작업 생성·메뉴·삭제와 기존 탭 회귀도 함께 통과했다. 실물 모바일·설치본 교체·공개 배포·전체 회귀 재실행은 이번 수정의 검증 범위가 아니다.

## 후속 수정: 일반 터미널의 사이드바 이름 변경

일반 터미널은 탭 더블클릭·터미널 메뉴에서 이미 이름을 바꿀 수 있었지만 새로 추가한 사이드바 행에는 메뉴가 없었다. 행 오른쪽에 기존 위치 보정·키보드 동작을 갖춘 `···` 메뉴를 재사용하고 `이름 변경`을 기존 터미널 편집 폼으로 연결했다. 폼에 사이드바·탭 표시 이름이며 폴더와 셸은 유지된다는 안내를 추가했다.

Mobbin의 [Notion Workspace](https://mobbin.com/explore/screens/cbf7d1f7-7603-405e-ba9e-dc7573bc71e4) 공개 화면을 Aside 브라우저로 다시 열어 항목명·아이콘 구성과 작업 영역의 보조 동작 배치를 확인했다. 기존 Front 참고 화면과 함께 이름·종류 표식을 유지하고 행 오른쪽 동작을 기존 앱 메뉴와 일관되게 배치했다. 참고 화면에서 펼쳐진 이름 변경 메뉴나 해당 동작까지 확인한 것은 아니다.

예제 생성 스크립트가 터미널 제목을 `일반 폴더`로 지정했던 것을 확인했다. 새 터미널의 실제 기본 제목은 호스트가 선택한 셸 프로필의 이름이며, 종류 이름이나 실제 폴더 이름으로 고정되지 않는다. 제품의 기본 이름 규칙은 바꾸지 않았다.

- 타입·빌드·`release-check.ts`·`git diff --check` 통과. 기존 번들 크기 안내는 유지된다.
- 관련 UI 회귀 **2/2 통과**: 일반 터미널 메뉴에서 이름 변경→사이드바·탭·호스트 제목 반영, 폴더 유지, 렌더러 새로고침 후 유지, 390px 모바일에서 이름 편집 취소, 기존 선택·세션·탭 동작. `.test-data/sidebar-rename-regression.log`.
- 기존 격리 개발 Electron 예제에서 메뉴가 해당 행에 붙는 위치·Escape 초점 복귀, 이름 저장·새로고침 후 반영, 폴더·PID·generation·레이아웃 유지와 취소를 확인했다. 검증용 `메모 작업` 제목은 같은 UI로 기존 제목에 복원했다. `test-results/e2e/sidebar-rename-preview/result.json`, `sidebar-rename.png`.
- 예제 창에 메뉴가 포함된 수정본을 반영했다. 이번 검증에서 호스트 재시작·실물 모바일·설치본 교체·공개 배포는 수행하지 않았다.

## 후속 수정: 작업 목록 높이 줄이기

실제 예제의 Git 행은 이름·브랜치/종류·저장소가 세 줄로 표시되고 행 안팎 여백도 커서 74~75.2px를 차지했다. 일반 터미널은 55px였고 5개 목록은 361.4px였다. 이름 12px·보조 정보 10px 글자 크기는 유지하면서 행을 두 줄·40px로 맞추고, 작업 그룹 제목줄도 여백을 줄였다. 모바일의 본문 선택·수 버튼·메뉴는 기존 최소 44px 영역을 유지한다.

기본 작업과 같은 저장소 이름은 반복하지 않는다. 여러 저장소에 속한 작업은 보조 줄에 `저장소 · 브랜치`를 모아 표시하며 오류·삭제 상태는 우선 표시한다. 추가 워크트리는 기존 가지 아이콘으로 구분하고 중복 글자 태그를 제거했다. 이름·보조 정보·전체 경로를 제목 툴팁에 제공한다. 터미널 수와 이름 변경 메뉴, 일반 터미널 행은 유지한다.

Mobbin의 위 Notion Workspace와 Front Inbox Email Thread를 Aside 브라우저에서 다시 열어 스크린샷을 직접 비교했다. 좁은 사이드바의 짧은 행·이름 우선 표시와 절제된 보조 정보를 참고했다. 40px 수치와 Git 메타데이터의 통합 방식은 몽글터미널 화면을 측정해 결정한 것으로, Mobbin 화면의 실제 치수를 인용한 것은 아니다.

- 타입·전체 빌드·배포 문서 검사·`git diff --check` 통과. 기존 번들 크기 안내 유지.
- 기존 워크트리·터미널 탭 UI 회귀 **2/2 통과**. 작업 선택·생성·삭제, 메뉴 아래/위 위치, 일반 터미널 이름 변경, 모바일 320/390px, 탭 이동·세션 보존 등을 확인했다. `.test-data/compact-sidebar-regression.log`.
- 기존 격리 개발 Electron 예제에서 모든 행 40px, 5개 목록 **361.4→204px(약 44% 감소)**를 측정했다. 목록 스크롤 넘침은 55px에서 0으로 줄었다. 기본 배지·추가 Git 아이콘·일반 터미널·툴팁 정보, 기존 터미널 선택·이름 변경 메뉴·터미널 수 선택을 확인했고 PID·generation·상태·분할 배치가 같았다.
- 증거: `test-results/e2e/compact-sidebar-preview/before.json`, `before.png`, `result.json`, `after.png`, `compact-list.png`. 예제 창에 수정본을 적용했다. 실물 모바일·설치본 교체·공개 배포는 수행하지 않았다.

## 격리와 한계

호스트는 `%TEMP%` 아래 고유 `MONGLE_DATA_DIR`로 실행했다. PowerShell은 시험 자식에서만 `-NoProfile`과 기록 저장 안 함을 사용한다. Codex 설정은 시험 자식 전용 프로필, 모델 제공자는 루프백 주소만 사용한다. 실사용 설정·로그인·세션을 복사하지 않는다. 검사 종료 시 시험 호스트만 정상 종료하며 실제 Tailscale Serve는 변경하지 않았다.

IME 검증은 실제 Chromium 조합 API·키 이벤트를 사용했다. 물리 한/영 키와 사용자 OS IME의 전체 입력 경로, WSL/SSH·모든 CLI, 설치본 교체·공개 배포·실물 모바일은 이번 검증에 포함하지 않는다. 사용 중인 기존 미리보기 창은 종료하지 않는다.
