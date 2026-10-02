# 터미널 기준 워크트리·새 탭 경로·수정 키 입력 검증

> 이 문서는 개발 시점의 검증 기록이다. 최종 공개 결과는 [0.3.7 배포 검증](public-release-0.3.7.md)을 확인한다.

기준일: 2026-10-02 · 브랜치: `codex/worktree-support` · 0.3.6 소스의 미배포 변경

## 바뀐 동작과 구조

- 그룹을 하나의 Git 저장소에 고정하지 않는다. `repositoryIds`로 여러 저장소 연결을 저장하고 이전 `repositoryId`도 읽는다. 터미널이 없는 워크트리도 유지하며, 그룹 시작 폴더를 변경하거나 같은 저장소를 다른 그룹에서도 사용할 수 있다.
- `+ 워크트리`는 보이는 터미널 상단에 두고, 600px 이하의 패널에서는 해당 터미널 `···` 메뉴에 둔다. 현재 폴더의 저장소를 조회하고 생성 화면에 이름·전체 경로·현재 작업 폴더의 기준 브랜치를 표시한다. Git 저장소가 아니면 이유와 함께 비활성화한다. 도구 모음에 마우스나 키보드 초점이 들어오면 다시 확인한다. 여러 패널의 조회와 사이드바 갱신은 호스트별로 순서대로 보내 조회 한도에 몰리지 않게 한다.
- 탭 `+`는 선택된 탭과 관계없이 바로 왼쪽 마지막 탭의 `currentCwd`를 기본값으로 쓴다. 보고가 없으면 해당 탭의 `cwd`를 사용한다. 단축키·분할은 선택한 터미널을 기준으로 한다. 사용자가 다른 폴더를 지정했을 때 원래 워크트리로 강제하지 않는다.
- Windows 콘솔이 요청한 `DEC 9001` 모드를 호스트가 보관하고 화면 스냅샷으로 전달한다. xterm 6의 기본 Enter 인코딩은 Shift를 보존하지 않으므로, 이 모드에서 수정 키가 있는 Enter를 Win32 키 이벤트로 전달한다. 일반 Enter·기존 IME 경로·제어권과 ACK 입력 보호는 유지한다. 모드 해제·RIS·새 셸에서는 초기화하며 오래된 프레임에 모드가 없으면 기존 입력을 사용한다.

## 확인한 참고 자료

Mobbin의 [Notion 워크스페이스](https://mobbin.com/explore/screens/cbf7d1f7-7603-405e-ba9e-dc7573bc71e4)와 [Front 메일 작업 화면](https://mobbin.com/explore/screens/3e29dd35-0c1d-4f71-831b-af35c13bf1ec)을 브라우저에서 직접 확인했다. Notion의 사이드바 탐색과 콘텐츠 상단 동작, Front의 다중 열·현재 항목 상단 도구 배치를 비교했다. 작업 대상을 결정하는 버튼은 그 터미널에 가까이 두고, 사이드바는 연결된 작업을 찾는 데 사용한다. 기존 색·테두리·모달·32px 제목줄을 유지했다. 이 자료에서 워크트리나 펼친 메뉴의 동작을 확인한 것은 아니다.

입력 원인은 로컬 xterm 키 인코더와 실제 ConPTY `ReadKey` 출력으로 확인했다. [Microsoft의 ConPTY 키 입력 규격](https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md)의 수정 키 전달 형식을 적용하고, 설치된 Codex CLI 0.160.0으로 재검증했다. Kitty 키보드 프로토콜 전체 구현을 의미하지 않는다.

## 실제 검사

| 검사 | 결과와 범위 |
|---|---|
| 타입·빌드·배포 문서 검사 | `npm run typecheck`, `npm run build`, `node --import tsx scripts/release-check.ts` 통과. 기존 번들 크기 안내는 유지된다. |
| 전체 회귀 | **319개 중 306 통과, 실패 0, 선택 실행 13 생략**. 마지막 조회 순서·도구 모음 재확인 보완 전에 실행했다. 이후 관련 화면·실제 앱 검사를 아래와 같이 다시 수행했다. |
| 최종 화면 회귀 | 탭·패널 드래그 **2/2**, 워크트리 후속 **1/1** 통과. 여러 저장소와 일반 폴더 혼합, 선택된 탭과 다른 마지막 탭의 실제 `cd` 경로, 저장소·기준 브랜치 표시, 좁은 패널 메뉴, Git 초기화 후 같은 폴더 재확인, 추가 패널 5개 동시 조회를 확인했다. |
| 호스트·입력 회귀 | 여러 저장소 연결·대상 저장소 명시·동일 저장소의 여러 그룹 연결·다른 폴더로 새 탭·호스트 재시작 후 연결 복원 통과. 모드 분할 수신·해제·RIS·실제 Chrome의 Shift+Enter/일반 Enter·닫힌 입력 게이트·IME 우선 처리 통과. |
| 실제 개발 Electron·Codex | **1/1 통과**, 정리 오류 없음. 실제 키보드 `첫 줄 → Shift+Enter → 둘째 줄`이 Codex 입력창의 연속 두 행에 남고 프롬프트를 전송하지 않음을 확인했다. Codex 종료 후 일반 Enter로 CMD 명령을 실행하고 결과 파일도 확인했다. |
| 실제 개발 Electron·워크트리·승인된 웹 | **1/1 통과**, 정리 오류 없음. 워크트리 생성 시 터미널 생략·나중에 열기·실제 셸의 분리 폴더 쓰기·GUI 재시작 후 PID 유지·메뉴 정렬·승인된 웹 연결을 확인했다. |

최초 화면 검사에서 새 비동기 모달을 기다리지 않은 Esc 입력, 경로 구분자 비교, 화면만 선택하고 제어권을 확보하지 않은 테스트 입력이 실패했다. 모달 표시 대기·정규화한 경로·실제 터미널 내용 클릭으로 검사 순서를 수정한 뒤 통과했다. 동작 오류와 검사 가정을 구분한다.

조회 제한 후속 검사의 최초 동시성 계측은 페이지를 새로고침하기 전·후 두 클라이언트 인스턴스를 합산해 2로 판정했다. 한 인스턴스에 패널 5개를 추가하는 재현 구간으로 계측을 한정한 뒤, 조회 최대 1개와 모든 버튼 활성화를 확인했다. 이 보완 후 전체 319개를 다시 실행한 것으로 표현하지 않는다.

로컬 로그는 `.test-data/context-regression.log`, `.test-data/context-final-ui.log`, `.test-data/context-final-worktree-ui.log`, `.test-data/context-final-e2e.log`에 있다. 캡처와 결과는 `test-results/worktrees/`, `test-results/e2e/worktrees/result.json`, `test-results/e2e/codex-keyboard/codex-shift-enter.png`, `test-results/e2e/codex-keyboard/result.json`에 있다. 격리 임시 경로가 포함되므로 저장소에 캡처를 추가하지 않는다.

## 재현 명령과 격리

```powershell
npm.cmd run typecheck
npm.cmd run build
node --import tsx --test --test-concurrency=1 tests/**/*.test.ts
node --import tsx --test --test-concurrency=1 tests/ui/worktrees.test.ts tests/ui/terminal-tabs.test.ts tests/ui/pane-drag.test.ts

$env:MONGLE_E2E_DATA_ROOT = Join-Path $env:TEMP 'mongle-terminal-context-e2e'
$env:MONGLE_E2E_WORKTREES = '1'
$env:MONGLE_E2E_CODEX_EXECUTABLE = (Get-Command codex.exe).Source
node --import tsx --test --test-concurrency=1 tests/e2e/worktrees.test.ts tests/e2e/codex-keyboard.test.ts
node --import tsx scripts/release-check.ts
git diff --check
```

OwnerPipe E2E는 `%TEMP%` 아래의 고유 데이터 폴더를 `MONGLE_DATA_DIR`로 지정한다. Codex도 시험 자식 프로세스에만 별도의 프로필을 지정하며 실사용 설정·로그인·세션을 복사하지 않는다. 모델 제공자는 루프백 주소로 한정하고 프롬프트를 제출하지 않는다. 시험이 만든 호스트만 정상 종료한다. 실제 Tailscale Serve는 변경하지 않는다.

사용자가 확인할 개발 미리보기도 별도 임시 프로필로 열었다. `여러 폴더 함께 작업` 그룹에 프런트엔드·일반 폴더·백엔드 탭과 아직 터미널을 열지 않은 워크트리 2개를 준비했다. Electron 창이 표시되고 응답하는 것을 확인했으며, 기존 사용자의 앱과 셸은 종료하지 않았다.

## 남은 범위

개발 소스·개발 Electron 검증이다. 새 NSIS/ZIP 생성·설치본 교체·공개 배포·사용자 확인은 별도다. 실물 휴대폰·Tailscale 경로·WSL/SSH에서 모든 CLI의 수정 키 조합·다른 Codex 버전은 이번 검사에 포함하지 않았다. 기존 워크트리의 WSL·네트워크 경로·하위 모듈 등의 제한은 [워크트리 검증](worktrees.md)을 따른다.
