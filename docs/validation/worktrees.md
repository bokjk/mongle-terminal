# 프로젝트·워크트리 검증

기준일: 2026-10-01 · 개발 브랜치: `codex/worktree-support` · 소스 버전: 0.3.6의 미배포 변경

**후속 변경(2026-10-02):** 아래는 최초 구현·메뉴 수정의 기록이다. 현재는 한 그룹에 여러 저장소를 연결하며, **+ 워크트리**를 터미널 상단(좁은 패널은 `···`)으로 옮겼다. 탭 +는 바로 왼쪽 탭의 현재 폴더를 따른다. 최신 동작과 검사 결과는 [터미널 기준 작업 검증](terminal-context.md)을 따른다.

## 구현 범위

- 기존 그룹에 저장소를 연결하거나 **프로젝트 열기**로 등록한다. 저장소의 공통 Git 디렉터리로 중복 등록을 판별한다. 기존 워크트리를 발견하고 원래 폴더와 함께 표시한다.
- **+ 워크트리**의 이름·기준 브랜치·경로 미리보기·기존 브랜치 선택·선택적 터미널 열기를 제공한다. 작업 이름 클릭은 현재 그룹의 기존 터미널을 재사용하고 없을 때 하나를 만든다. 탭·분할·그룹 이동에서 연결 ID를 유지한다.
- Git 명령은 셸 문자열 조합 없이 인자로 전달하며, 조회/변경 시간과 출력 크기를 제한한다. 저장소별 작업을 직렬화하고 터미널 입력/상태 큐 밖에서 수행한다. 체크아웃 hook은 비활성화하고 정상 Git 필터는 수행한다. 오류의 원문 필터 출력은 UI에 전달하지 않는다.
- 생성 요청 ID·준비한 경로·브랜치·커밋을 저장해 응답 유실과 저장 실패를 복구한다. Git 결과가 불확실하면 새 요청으로 중복 생성하지 않고 **결과 확인**을 제공한다. 생성한 폴더는 부분 실패 시에도 임의 삭제하지 않는다.
- 삭제는 앱이 만든 연결 워크트리만 대상으로 하며, 모든 그룹의 터미널 참조와 현재/시작 경로·dirty/ignored 파일·잠금·하위 모듈·실제 경로를 확인한다. `--force`를 사용하지 않으며 브랜치는 보존한다. 앱 밖의 프로세스까지 잠그는 기능은 없다.
- SQLite 저장 형식을 1에서 2로 트랜잭션 안에서 전환한다. 호스트·터미널 ID, 배치, 세대, 저장 출력을 유지하며 새 저장소를 구버전 호스트로 여는 것은 차단한다. 연결된 UI에는 `worktrees.manage` capability로 노출한다.

구현 위치: [Projects.tsx](../../apps/web/src/Projects.tsx), [App.tsx](../../apps/web/src/App.tsx), [HostCore](../../packages/host/core.ts), [Git 작업](../../packages/host/worktrees.ts), [저장소](../../packages/storage/index.ts). 사용자 흐름은 [사용자 안내](../USER-GUIDE.md#프로젝트와-워크트리미배포)를 따른다.

## 실제 수행한 검사

| 검사 | 확인한 내용 |
|---|---|
| 실제 Git + HostCore | 한글·공백 경로, hook 미실행, 중복 브랜치·원본 하위 경로 거부, ignored 파일 삭제 차단, 정상 삭제 후 브랜치 유지, 동일 요청 재시도, 동시 클릭의 단일 터미널 생성, 탭·그룹 이동에서 PID·연결 유지 |
| 지연·장애 주입 | 실제 Git smudge 필터가 지연 중일 때 heartbeat/이름 변경 응답과 기존 PID 유지, 생성 요청자의 연결 종료 후 폴더 보존, Git 체크아웃 뒤 DB 저장 실패를 주입하고 새로고침으로 동일 ID 복구·추가 셸 0개 확인 |
| 저장 마이그레이션 | 실제 SQLite schema 1 fixture를 열어 schema 2, ID·레이아웃·저장 출력 보존 확인 |
| 실제 Chrome + HostCore + 셸 | 프로젝트 등록·재사용, 터미널 열기 체크 해제, 지연 생성·더블클릭, 탭 추가의 cwd, 커스텀 제목, 마지막 탭 선택, 워크트리별 파일 분리, 다른 기기 제어권 유지, 삭제 차단, 탭 닫기/재열기, 페이지 재접속, 생성 응답 유실·결과 재조회, 모바일 화면 |
| 개발 Electron + OwnerPipe + ConPTY | 기존 폴더 선택 결과를 실제 데스크톱 bridge로 연결, 워크트리의 실제 cmd에서 파일 작성·브랜치 확인, Electron 정상 종료/재실행 후 동일 host boot/PID 유지, 열지 않은 워크트리의 터미널 수 0개 유지 |
| 승인된 웹 연결 | 격리 호스트의 실제 루프백 HTTP 게이트웨이에 Chrome 모바일 에뮬레이션으로 접속·기기 승인 후 같은 워크트리를 찾아 호스트에서 터미널 생성 |

워크트리 전용 검사는 [호스트 검사](../../tests/host/worktrees.test.ts), [화면 검사](../../tests/ui/worktrees.test.ts), [데스크톱 E2E](../../tests/e2e/worktrees.test.ts)에 있다. UI 검사의 bridge 대체와 실제 데스크톱·웹 전송 검사를 구분한다.

기본 검사:

```powershell
$env:MONGLE_DATA_DIR = Join-Path (Get-Location) '.test-data/worktree-regression-final'
npm.cmd run typecheck
npm.cmd run build
node --import tsx --test --test-concurrency=1 tests/**/*.test.ts
node --import tsx scripts/release-check.ts
git diff --check
```

선택 실행한 데스크톱 검사:

```powershell
$env:MONGLE_DATA_DIR = Join-Path (Get-Location) '.test-data/worktree-e2e'
$env:MONGLE_E2E_DATA_ROOT = Join-Path $env:TEMP 'mongle-worktree-e2e'
$env:MONGLE_E2E_WORKTREES = '1'
node --import tsx --test tests/e2e/worktrees.test.ts
```

Windows Job/HostLauncher와 개발 Electron 실행은 Codex 샌드박스에서 각각 접근 거부·GPU 프로세스 시작 실패가 발생해, 동일한 격리 데이터를 쓰는 일반 실행 권한으로 검증했다. 이는 실사용 앱의 관리자 권한 실행을 요구한다는 뜻이 아니다. 최초 전체 회귀는 314개 중 300 통과·2 실패·12 선택 실행 생략이었다. 한 건은 이 샌드박스 제약, 다른 건은 팝업 단축키 조건이 Esc 닫기를 막던 구현 오류였다. 팝업 조건을 수정하고 기존 패널 드래그·탭 검사로 재검증했다. 새 복구 검사의 Windows 경로 구분자 비교와 HTML option의 disabled 판정도 실제 경로/DOM 속성 기준으로 수정했다.

후속 전체 실행은 **315개 중 302 통과·1 실패·12 선택 실행 생략**이었다. 유일한 실패는 새 화면 검사의 부분 라벨 선택자가 이름 입력과 도움말이 있는 체크박스를 동시에 선택한 검사 오류로, 정확한 라벨로 수정했다. Git/호스트/저장소 검사는 모두 통과했다. 이후 워크트리 열기 응답 전에 사용자가 다른 탭으로 이동했을 때 그 선택을 보존하는 조건과 지연 응답 검사를 보완했다.

로컬 원본 로그·이미지에는 격리 임시 경로가 포함되어 있어 배포 문서 이미지로 추가하지 않는다. `.test-data/worktree-regression-final.log`, `.test-data/worktree-final-ui.log`, `test-results/worktrees/`, `test-results/e2e/worktrees/result.json`에 로컬 증거를 보관한다.

| 최종 확인 | 결과 |
|---|---|
| 타입 검사·웹/호스트/데스크톱 빌드 | 통과. 기존 웹 번들 크기 안내가 있으며 빌드 오류는 없다. |
| 워크트리 호스트·저장소 검사 | 8/8 통과. 새 복구 검사까지 포함한다. |
| 워크트리 화면·기존 탭·기존 패널 드래그 재실행 | 3/3 통과, 실패·생략 0. 응답 유실·늦은 열기 응답·Esc 닫기 포함. |
| 실제 개발 Electron + 승인된 웹 E2E | 1/1 통과, 정리 오류 없음. 정상 GUI 재실행과 동일 PID를 확인했다. |
| Windows 호스트 수명 검사 | 일반 실행 권한으로 3/3 통과. |
| 배포 문서·공백 검사 | `release-check.ts`, `git diff --check` 통과. 새 설치 패키지 검증을 뜻하지 않는다. |

전체 실행에서 남았던 화면 검사 오류는 수정 후 위 3개 관련 검사로 재검증했다. 마지막 보완 뒤 전체 315개를 다시 실행한 것으로 표현하지 않는다.

## 디자인 적용

논의 과정에서 직접 확인한 Mobbin [Front 사이드바](https://mobbin.com/explore/screens/3e29dd35-0c1d-4f71-831b-af35c13bf1ec)와 [Notion 워크스페이스](https://mobbin.com/explore/screens/cbf7d1f7-7603-405e-ba9e-dc7573bc71e4)의 계층형 목록·작업 영역 구분·절제된 선택 표시를 참고했다. 프로젝트의 기존 색·여백·모달·테마 토큰에 맞췄고, 워크트리 생성은 프로젝트 아래 한 개의 **+ 워크트리**에 모았다. 해당 Mobbin 화면에서 이 워크트리 기능 자체를 확인했다는 뜻은 아니다. 실제 UI 조작·캡처로 PC와 모바일 크기에서 확인했다.

## 워크트리 메뉴 위치 후속 수정(2026-10-02)

워크트리 메뉴에 공통 `position: fixed`와 `right: 0`이 함께 적용되어, 작업 행이 아닌 화면 오른쪽 끝에 메뉴가 나타났다. [WorktreeActions](../../apps/web/src/WorktreeActions.tsx)에서 버튼의 실제 위치를 기준으로 오른쪽 끝을 맞추고 4px 아래에 표시한다. 아래 공간이 부족하면 위로 열고 화면 가장자리에 8px 여백을 둔다. 메뉴는 `body`에 표시해 스크롤 컨테이너와 모바일 사이드바의 transform에 잘리지 않는다. 스크롤 중에는 버튼을 따라가며 작업 행이 목록 밖으로 벗어나면 닫는다. 바깥 클릭·Esc·Tab과 방향키·Home·End 조작을 지원한다.

Mobbin의 [Notion 워크스페이스](https://mobbin.com/explore/screens/cbf7d1f7-7603-405e-ba9e-dc7573bc71e4)를 이번 수정에서도 직접 열어 사이드바와 작업 영역의 관계를 확인했다. 기존 목록 구조·색·메뉴 크기를 유지하고 눌렀던 작업에 가까이 메뉴를 표시하도록 판단했다. 이 참고 화면에는 펼쳐진 작업 메뉴가 없으므로 팝업 배치나 키보드 동작까지 확인한 것으로 표현하지 않는다.

| 후속 검사 | 실제 결과 |
|---|---|
| `npm run typecheck`, `npm run build` | 통과. 기존 번들 크기 안내는 유지된다. |
| 워크트리·터미널 탭·패널 드래그 UI | **3/3 통과**, 실패·생략 0. 원래 작업/연결 작업 메뉴, 1440·1024·390·320px 화면, 아래/위 배치, 창 크기 변경, 모바일 전환, 목록 스크롤, 바깥 클릭, Esc 초점 복귀, 방향키, 메뉴 항목 실행을 확인했다. 버튼·메뉴 좌표와 `elementFromPoint`로 인접 배치와 클릭 가능 영역을 검사한다. |
| 격리 개발 Electron + OwnerPipe + ConPTY + 승인된 웹 | **1/1 통과**, 정리 오류 없음. 실제 데스크톱에서도 버튼 아래 4px·오른쪽 정렬, 메뉴 Esc 초점 복귀·이름 변경 창 열기를 확인했다. 기존 워크트리/GUI 재실행/셸 PID 유지 검사도 통과했다. |
| 문서·공백 검사와 미리보기 | `release-check.ts`, `git diff --check` 통과. 수정 빌드의 별도 미리보기 창을 열고 창 제목·응답 상태를 확인했다. 기존 미리보기와 실사용 터미널은 종료하지 않았다. |

실행 명령은 `node --import tsx --test --test-concurrency=1 tests/ui/worktrees.test.ts tests/ui/terminal-tabs.test.ts tests/ui/pane-drag.test.ts`와 위의 `MONGLE_E2E_WORKTREES=1` 데스크톱 검사다. 개발 데이터는 명시적인 격리 `MONGLE_DATA_DIR`, OwnerPipe 데이터는 `%TEMP%/mongle-worktree-menu-e2e`를 사용했다. 로컬 증거는 `test-results/worktrees/desktop-menu.png`, `mobile-menu.png`, `mobile-menu-above.png`와 `test-results/e2e/worktrees/desktop-worktree-menu.png`, `result.json`에 있다.

첫 화면 검사는 자동 스크롤 직후 지연된 scroll 이벤트로 메뉴가 닫히는 문제를 찾아 버튼이 보이는 동안 위치를 갱신하도록 보완한 뒤 통과했다. 최초 데스크톱 검사의 공용 이름 변경 모달 종료 후 초점 복귀 기대값은 통과하지 않았다. 기존 모달의 자동 초점 동작은 이번 위치 수정 범위에 넣지 않았으며, 최종 검사는 작업 메뉴 자체의 Esc 초점 복귀와 이름 변경 창의 열기·닫기를 구분해 검증했다. 전체 회귀·패키지 설치·공개 배포를 다시 수행한 것은 아니다.

## 남은 범위

- 개발 빌드 검증이다. 워크트리 변경을 담은 NSIS/ZIP 패키지 생성·설치·공개 배포, 실사용 앱 교체, 사용자 확인은 수행하지 않았다.
- Windows 폴더 선택창의 반환값을 검사에서 제공했다. 실제 OS 선택창을 사람이 조작하는 검사는 이번 범위에 포함하지 않았다.
- 모바일은 Chrome 에뮬레이션이다. 실물 휴대폰·IME·Tailscale 네트워크, 실제 PC 재부팅은 확인하지 않았다. 호스트를 새로 초기화한 자동 검사와 Electron 창 재실행 검사는 구분한다.
- WSL·UNC/네트워크 경로·bare 저장소·하위 모듈 관리, 변경 파일 자동 이관·환경 파일 복사·의존성 설치·병합/PR·브랜치 정리는 제공하지 않는다. 외부 프로그램이 Git 메타데이터/경로를 동시에 바꾸거나 필터가 끝나지 않는 모든 경우를 실기 검증한 것은 아니다.
