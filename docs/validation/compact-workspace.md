# 간결한 상단과 접을 수 있는 사이드바 검증

검증일: 2026-10-02. 이 문서는 0.3.7 기반 개발 시점의 기록이다. 최종 0.3.8 배포 결과는 [배포 검증](public-release-0.3.8.md)을 확인한다.

## 디자인 근거와 적용

사용자가 선택한 두 번째 시안과 후속 접힌 상태 시안을 기준으로 기존 몽글 색상·캐릭터·Lucide 아이콘을 유지했다. 새로운 이미지로 UI를 덮지 않고 실제 컴포넌트를 배치했다.

- 직접 열어 확인한 [Mobbin Front](https://mobbin.com/explore/screens/3e29dd35-0c1d-4f71-831b-af35c13bf1ec)의 좁은 탐색 영역과 작업별 조작 배치를 참고해 왼쪽 목록·하단 액션을 줄였다.
- 직접 열어 확인한 [Mobbin Notion](https://mobbin.com/explore/screens/cbf7d1f7-7603-405e-ba9e-dc7573bc71e4)의 작업 공간 선택과 탐색 패턴을 참고해 컴퓨터·그룹 전환을 전역 상단에 배치했다.
- [Electron의 제목 표시줄 문서](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)를 확인하고 Windows의 네이티브 창 버튼을 남기는 `titleBarOverlay`를 사용했다. 상단 버튼은 드래그 영역에서 제외하고 오른쪽 창 버튼 공간을 확보한다.

상단은 36px이며 작업 그룹을 전환한다. 각 분할 영역의 기존 터미널 탭·워크트리·검색·분할 조작은 그대로 사용한다. 사이드바는 기본 212px에서 44px 아이콘 줄로 접고, 접힘 상태와 펼친 너비를 따로 저장한다. PC의 저장값 없는 터미널 기본 크기는 13px, 모바일은 14px다. 유효한 기존 글자 크기·너비를 덮어쓰지 않는다. 터미널 출력 크기 변경은 기존 ResizeObserver/fit 경로를 사용하며 접기 때문에 터미널 컴포넌트를 다시 마운트하지 않는다.

## 실행 환경과 격리

Windows 11 x64, Electron 44.4.5, Node 24.18.0 번들을 사용했다. 일반 검사에는 작업 폴더의 `.test-data/compact-checks`를 지정했고 실제 Electron/OwnerPipe 검사는 `MONGLE_E2E_DATA_ROOT`를 TEMP 아래로 지정해 `mkdtemp`가 만든 별도 프로필을 사용했다. 테스트 셸은 `C:\Windows`에서 실행한 cmd이며 실사용 호스트·Tailscale·인증 설정을 조작하지 않았다. 종료는 시험 프로필의 `host.shutdown`과 앱 종료를 사용했다.

실제 앱 검사는 다음 명령으로 재현한다. 패키지 검사 시에는 `MONGLE_E2E_EXE`에 `release-compact-validation/win-unpacked/MongleTerminal.exe`의 절대 경로를 지정한다.

```powershell
$env:MONGLE_E2E_COMPACT = '1'
$env:MONGLE_E2E_DATA_ROOT = Join-Path $env:TEMP 'mongle-compact-e2e'
$env:MONGLE_DATA_DIR = Join-Path $env:TEMP 'mongle-compact-launch'
node --import tsx --test --test-concurrency=1 tests/e2e/compact-workspace.test.ts
```

## 결과

| 검사 | 실제 결과 |
|---|---|
| 타입·빌드 | `npm run typecheck`, `npm run build` 통과. 기존 웹 번들 크기 안내가 있으며 빌드 오류는 없음 |
| 전체 회귀 | 322개 중 307 통과, 1 실패, 선택 실행 14 생략. `tests/platform/lifecycle.test.ts`의 kill-on-close Job에서 샌드박스의 프로세스 실행 권한 거부. 해당 파일을 제한 밖에서 재실행해 3/3 통과. 전체 집합을 제한 밖에서 재실행한 결과로 표현하지 않음 |
| 터미널 탭·사이드바 회귀 | 같은 xterm DOM·PID·generation·분할 배치와 attach/detach/제어권 요청 수 유지. 접힘 폭·펼친 폭·설정·기본 13px 확인. 기존 탭 전환/이동/닫기·입력·좁은 화면 회귀 통과 |
| 모바일·호스트 선택 | 320/390px 표시·기존 글자 크기·입력·호스트 선택 회귀 통과. 실물 모바일 검사는 아님 |
| 개발 Electron | `compact-workspace.test.ts` 1/1 통과. 최초 샌드박스 실행은 시작 제한으로 타임아웃했으며 제한 밖에서 실제 실행해 검증 |
| Windows 패키지 | `npm run package -- --dir --output release-compact-validation` 통과. 번들 Node·네이티브 모듈 로드·EXE 아이콘 리소스 검사 통과. NSIS/ZIP 배포 산출물은 생성하지 않음 |
| 패키징한 앱 | 같은 compact E2E 1/1 통과. 수명주기 3개와 합쳐 4/4 통과. 실제 OwnerPipe·ConPTY·창 오버레이 사용 |
| 문서·공백 | `node --import tsx scripts/release-check.ts`, `git diff --check` 통과 |

실제 앱 검사는 상단 오버레이 활성화, 3개 셸, 사이드바 접기/펼치기, 파일 패널·설정 열기, 새로고침 후 접힘 상태와 셸 변수 유지, 너비 222px·글자 크기 16px 저장, 밝은 테마, 760×600 창의 그룹 전환과 가로 넘침 없음, BrowserWindow API의 최대화/복귀를 확인했다. 페이지 오류는 0개였다.

1440×900 CSS px 창에서 기본 사이드바 212px를 44px로 접으면 사용 가능한 가로 공간이 168px 늘었다. 좌우 반반 분할 중 왼쪽 터미널은 **75열·45행 → 86열·45행**으로 바뀌었다. 이 수치는 같은 새 화면의 접기 전후 비교이며 이전 공개 버전과의 성능·면적 비교가 아니다.

## 증거

로컬 생성물은 개인 정보·시험 프로필과 함께 커밋하지 않는다. 다음 파일은 이번 실행의 작업 폴더에 있다.

- `.test-data/compact-full-regression.log`: 전체 회귀 원본.
- `.test-data/compact-packaged-e2e.log`: 패키지 1개 + 수명주기 3개 통과 원본.
- `.test-data/compact-package.log`: 패키징·네이티브·아이콘 검사.
- `test-results/e2e/compact-workspace/result.json`: 패키지 앱 측정값·오류 배열.
- 같은 폴더의 `01-expanded.png`, `02-collapsed.png`, `03-settings-light.png`, `04-narrow-light.png`: 실제 패키지 화면.
- 같은 폴더의 `compare-expanded.png`, `compare-collapsed.png`, `compare-expanded-header.png`, `compare-collapsed-header.png`: 승인 시안과 실제 패키지 화면을 같은 이미지에 놓은 비교.

디자인 비교 기록은 저장소 루트의 [design-qa.md](../../design-qa.md)에 있다. Windows 배율 125%로 앱 캡처는 1800×1125px이고 콘텐츠 뷰포트는 1440×900 CSS px다. 캡처에는 Windows 네이티브 창 버튼이 포함되지 않으므로 사진에 없는 버튼을 확인했다고 주장하지 않는다. 오버레이 API에서는 활성 상태·35px 높이·1303px 콘텐츠 영역을 확인했다.

## 남은 범위

### 사용자 피드백: 접기 버튼 위치

최상단 컴퓨터 선택 옆의 버튼을 찾기 어렵다는 피드백에 따라 **사이드바 내부 맨 위**로 옮겼다. 펼친 상태에는 `사이드바 접기` 문구를 함께 표시하며 접힌 상태도 같은 아이콘 좌표(x=12, y=46 CSS px)를 유지한다. 기존의 별도 `작업 목록 펼치기` 버튼은 합쳤다. 앞서 확인한 Mobbin의 탐색 영역별 조작 배치를 같은 영역 안에 적용한 수정이다.

후속 타입·빌드·터미널 탭/모바일 회귀 5/5, 테스트용 패키지의 웹 자산 갱신 후 실제 Electron 검사 1/1을 통과했다. 동일 좌표·셸 유지·좁은 창을 재검증했고 `result.json`에 `sidebarToggle.fixedAcrossStates: true`를 기록했다. 앞선 전체 회귀를 이 수정 후 재실행했다고 표현하지 않는다. 스크린샷 4개는 이 최신 실행으로 갱신했다. 사용자 확인용 새 격리 창을 열었으며 기존에 열어 둔 창의 작업을 종료하지 않았다.

Windows 캡션 버튼의 실제 마우스 클릭, 제목 표시줄을 잡아 창 이동, Snap 레이아웃·다중 모니터별 배율 전환, 스크린리더 실기와 실물 모바일은 이번 검사에 포함하지 않았다. 최대화/복귀는 BrowserWindow API로만 검증했다. 실제 설치본 교체·사용자 확인·공개 배포는 별도이며 앱 버전을 올리지 않았다.
