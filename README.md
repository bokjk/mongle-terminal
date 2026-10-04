<div align="center">

<img src="apps/web/public/icon-512.png" width="112" alt="터미널을 안고 있는 몽글 캐릭터" />

# 몽글터미널

### 작업은 그대로. 어디서든, 이어서.

여러 폴더의 터미널을 한곳에.<br />워크트리로 나누고, 휴대폰에서 이어서.

[![Windows 11 x64 · Preview · Tailscale](docs/assets/status.svg)](docs/IMPLEMENTATION-STATUS.md)

**[Windows 다운로드](https://github.com/bokjk/mongle-terminal-releases/releases/latest)**

[사용 안내](docs/USER-GUIDE.md) · [변경 이력](CHANGELOG.md) · [기여하기](CONTRIBUTING.md)

</div>

<br />

![몽글터미널 — 작업 그룹, 기본 작업과 워크트리, 터미널 탭과 분할](docs/assets/desktop.png)

<p align="center"><sub>격리된 예제 프로젝트와 실제 Windows 셸로 촬영한 0.3.8 화면입니다.</sub></p>

## 한 화면에서, 각자의 작업을

<table><tr>
<td width="33%"><strong>모아서 정리</strong><br /><br />서로 다른 폴더의 터미널을 작업 그룹 하나에. 이름을 붙이고 목록에서 바로 찾습니다.</td>
<td width="33%"><strong>나눠서 집중</strong><br /><br />탭을 옮기고 화면을 분할하세요. 워크트리로 같은 저장소의 다른 작업도 함께 진행합니다.</td>
<td width="33%"><strong>어디서든 계속</strong><br /><br />작업 PC에서 실행 중인 터미널에 다른 PC나 휴대폰으로 다시 연결합니다.</td>
</tr></table>

PowerShell·명령 프롬프트와 설치된 Git Bash·WSL을 사용합니다. Claude·Codex 같은 CLI도 평소처럼 실행하세요. 밝은 테마와 어두운 테마, 글자 크기 조절, 검색, 선택 후 자동 복사와 우클릭 붙여넣기를 지원합니다.

**0.3.9 배포 후보에서는 기다림을 줄이고 복사를 안정화했습니다.** 연속 터미널 출력과 워크트리 조회를 더 빠르게 처리하고, 파일 탐색기에서 떠난 화면의 대기 요청을 정리합니다. 늦은 응답이 새 작업 화면을 덮지 않으며, 클립보드에 저장한 내용을 확인한 뒤 복사 완료를 표시합니다. 관리자 권한 환경의 첫 실행에서도 새 데이터 폴더를 현재 사용자 전용으로 준비합니다.

## 화면은 간결하게, 작업 영역은 넓게

컴퓨터 선택과 작업 그룹 전환을 얇은 상단 줄에 모았습니다. **왼쪽 사이드바 맨 위**에서 접고 펼칠 수 있습니다. 접으면 44px 아이콘 줄만 남고, 같은 자리에 펼치기 버튼이 유지됩니다.

![사이드바를 접어 작업 영역을 넓힌 몽글터미널](docs/assets/desktop-collapsed.png)

- **필요할 때만 목록을 펼치세요.** 접힌 상태에서도 터미널 전환·새 터미널·파일 탐색기·설정을 사용할 수 있습니다.
- **돌아와도 익숙한 화면입니다.** 접힘 상태와 펼친 너비를 기억하며, 접고 펼쳐도 실행 중인 셸과 분할 배치는 유지됩니다.
- **글자 크기는 편한 대로.** PC 기본값은 13px, 모바일은 14px입니다. 이전에 저장한 크기는 유지하며 **설정 → 화면**에서 바꿀 수 있습니다.

[화면 조작 자세히 보기](docs/USER-GUIDE.md#간결한-pc-화면)

## 시작은 터미널 하나부터

1. **[Windows 11 x64 설치 파일](https://github.com/bokjk/mongle-terminal-releases/releases/latest)**을 받아 설치합니다. 현재 공개 설치본은 **0.3.8 미리보기**이며, 이 소스는 **0.3.9 배포 후보**입니다.
2. **새 터미널**을 누르고 셸과 시작 폴더를 고릅니다. Git 저장소가 아니어도 사용할 수 있습니다.
3. 탭 옆 **+**로 터미널을 더하고, 탭 제목을 가장자리로 끌어 화면을 나눕니다.
4. 다른 기기에서 이어 쓰려면 **설정 → 원격 연결**에서 연결을 준비합니다.

<details>
<summary>설치 파일과 ZIP, 업데이트 안내</summary>

아래 파일명은 **0.3.9 배포 후보** 기준입니다. 공개 페이지에서는 실제 게시된 버전 번호를 확인하세요.

- **설치 파일:** `MongleTerminal-Setup-0.3.9-x64.exe`. 현재 사용자용으로 설치하며 관리자 권한이 필요하지 않습니다. 설치본은 새 버전을 확인·다운로드한 뒤 사용자 확인을 받아 설치합니다.
- **ZIP:** `MongleTerminal-0.3.9-x64.zip`. 폴더 전체를 풀고 `MongleTerminal.exe`를 실행합니다. 업데이트는 수동으로 교체합니다.
- Node.js는 배포본에 포함됩니다. 사용할 셸과 Git은 PC에 설치되어 있어야 합니다.
- 현재 코드 서명이 없는 미리보기입니다. Windows의 보호 안내가 나타나면 다운로드 출처를 확인하세요.
- **0.3.0 이하**는 새 공개 업데이트 주소로 전환하려면 0.3.1 이상 설치 파일을 한 번 직접 설치해야 합니다. 수동 교체 전에는 작업을 저장하고 앱 메뉴의 **완전 종료…**를 사용합니다.

[설치·업데이트 자세히 보기](docs/USER-GUIDE.md) · [배포와 검증 범위](docs/RELEASING.md)

</details>

## 워크트리, 필요한 터미널에서 바로

**작업 그룹은 터미널을 모으는 공간입니다.** 한 그룹 안에 프런트엔드 저장소, 백엔드 저장소, 일반 폴더를 함께 둘 수 있습니다. 워크트리는 만들기를 누른 **터미널의 현재 Git 저장소**를 기준으로 합니다.

1. 터미널 상단의 **+ 워크트리**를 누릅니다. 좁은 영역에서는 **···** 메뉴에 있습니다.
2. 작업 이름과 기준 브랜치를 입력하고 **생성 후 터미널 열기**를 선택합니다. 폴더와 브랜치 이름은 고급 설정에서 바꿀 수 있습니다.
3. 나중에 왼쪽 목록의 이름을 누르면 연결된 터미널로 이동합니다. 열려 있는 터미널이 없으면 그때 하나를 만듭니다.

| 목록에서 보이는 것 | 의미 |
|---|---|
| **기본** 배지 + 프로젝트 이름 | 저장소의 기본 작업 폴더 |
| 가지 아이콘 + 작업 이름 | 추가 워크트리 |
| 터미널 아이콘 + 터미널 이름 | Git 작업에 연결하지 않은 일반 터미널 |
| 터미널 개수 | 같은 워크트리에 연결된 터미널 선택 |

같은 폴더의 Windows 짧은 경로·폴더 별칭도 실제 위치를 기준으로 연결합니다. 목록은 이름과 보조 정보 두 줄로 정리했습니다. **··· → 이름 변경**으로 알아보기 쉽게 바꾸고, 긴 경로와 브랜치는 마우스를 올려 확인합니다. **프로젝트 열기**로 Git 폴더를 먼저 등록할 수도 있습니다.

터미널을 닫아도 워크트리 폴더는 남습니다. 삭제는 앱에서 만든 워크트리에만 제공하며, 연결된 터미널이나 남은 변경·새 파일·ignored 파일이 있으면 중단합니다. 삭제해도 브랜치와 커밋은 유지합니다.

[생성·선택·삭제 자세히 보기 →](docs/USER-GUIDE.md#프로젝트와-워크트리)

## 탭을 옮겨도, 실행 중인 작업은 그대로

각 분할 영역에 독립된 탭과 **+**가 있습니다. 탭을 분리했다가 다른 탭 옆으로 다시 가져오거나 순서만 바꿀 수 있습니다.

| 하고 싶은 일 | 조작 |
|---|---|
| 새 탭 열기 | **+** — 바로 왼쪽 마지막 탭의 현재 폴더를 기본값으로 사용 |
| 선택한 터미널 옆에 새 탭 | `Ctrl+Shift+T` — 현재 선택한 터미널의 폴더 기준 |
| 탭 분리 | 탭이 둘 이상인 영역에서 탭 제목을 가장자리로 끌기 |
| 탭 합치기·순서 변경 | 탭 제목줄의 삽입선 위치에 놓기; **+** 위는 맨 뒤 |
| 영역 전체 이동 | 왼쪽 점 손잡이로 끌기 |

현재 폴더를 보고하지 않는 셸은 시작 폴더를 사용합니다. `Ctrl+Tab` / `Ctrl+Shift+Tab`으로 현재 영역의 탭을 전환합니다. Windows Codex CLI의 **Shift+Enter** 줄바꿈과 한글 조합 직후 연속 입력도 개선했습니다. 실제 키 동작은 실행 중인 프로그램의 설정을 따릅니다.

[탭과 분할 사용법 →](docs/USER-GUIDE.md#그룹과-분할)

## 파일과 Git 변경을 바로 옆에

**파일 탐색기**는 마지막으로 선택한 터미널의 현재 폴더를 따라갑니다. **파일 / Git**을 전환하면 폴더 트리와 변경 목록을 확인할 수 있습니다. 원격 터미널에서는 해당 PC의 파일을 보여 줍니다.

<table><tr>
<td align="center"><img src="docs/assets/git-files.png" width="260" alt="파일 트리의 Git 상태 색·문자와 폴더 변경 표시" /><br /><sub>파일 트리와 변경 상태</sub></td>
<td align="center"><img src="docs/assets/git-changes.png" width="260" alt="스테이징됨·작업 폴더 변경·새 파일을 구분한 Git 목록" /><br /><sub>상태별 Git 변경 목록</sub></td>
</tr></table>

텍스트 미리보기와 경로 복사를 지원합니다. 읽기 전용이며 커밋·스테이징·파일 편집은 터미널에서 진행합니다. 위 Git 화면은 0.3.6에서 촬영했습니다.

[파일 탐색기와 Git 보기 →](docs/USER-GUIDE.md#파일-탐색기)

## 휴대폰에서도 같은 터미널

<table><tr>
<td width="38%" align="center"><img src="docs/assets/mobile.png" width="270" alt="휴대폰 크기에서 실행한 몽글터미널과 터미널 보조 키" /></td>
<td>
<h3>QR로 연결하고, 브라우저에서 이어 쓰세요.</h3>
<p>작업 PC와 휴대폰에서 Tailscale을 켠 다음 원격 연결 설정의 QR코드를 스캔합니다. 첫 연결은 코드 입력과 작업 PC의 승인을 거칩니다.</p>
<p>터미널 전환, Esc·Tab·Ctrl·방향키, 글자 크기 조절과 이전 출력 스크롤을 지원합니다. 입력할 터미널을 누르면 그 기기로 제어권이 넘어옵니다.</p>
<p>작업 PC와 실행부가 켜져 있어야 합니다. 한 번에 한 기기가 입력을 제어하며, 단순 스크롤이나 창 활성화만으로 다른 기기의 입력을 가져오지 않습니다.</p>
<p><a href="docs/USER-GUIDE.md">원격 연결 안내 →</a></p>
</td>
</tr></table>

<p align="center"><sub>이미지는 모바일 크기의 브라우저 데모입니다. 실물 휴대폰 캡처는 아닙니다.</sub></p>

## 창 닫기와 작업 종료

| 동작 | 실행 중인 셸 | 다시 열면 |
|---|---|---|
| 창의 **X** | 계속 실행 | 트레이·바로가기로 복귀 |
| **앱 종료 · 터미널 유지** | 계속 실행 | 같은 호스트와 셸에 재연결 |
| **완전 종료…** 또는 PC 재시작 | 종료 | 저장한 그룹·배치·폴더·허용된 출력 기록과 **새 셸** 복원 |

완전 종료나 재부팅 뒤에는 이전 명령, CLI 대화, 개발 서버를 자동으로 다시 실행하지 않습니다. 사용자 데이터는 기본적으로 `%LOCALAPPDATA%\MongleTerminal`에 보관하며 업데이트·제거 시 자동 삭제하지 않습니다.

## 개발과 기여

0.3.9 배포 후보의 측정 조건과 실제 검사 범위는 [응답성·안정성 검증 기록](docs/validation/responsiveness-reliability.md)에 정리했습니다. 소스의 검사 통과, 공개 게시와 실사용 설치본 교체는 구분해 기록합니다.

**Windows 11 x64 · Node.js 24.x · Chrome**이 필요합니다. 소스 저장소 접근 권한이 있는 환경에서 실행합니다.

```powershell
npm.cmd ci
node node_modules/node-pty/scripts/prebuild.js
node node_modules/node-pty/scripts/post-install.js
node node_modules/esbuild/install.js
node node_modules/electron/install.js

# 실사용 터미널과 분리한 개발 프로필
$env:MONGLE_DATA_DIR = Join-Path $env:TEMP 'mongle-dev-profile'
npm.cmd run dev
```

네이티브 준비 명령은 설치 스크립트가 차단된 환경에서도 잠금 파일에 고정된 런타임을 준비합니다. UI 검사에 필요한 Chrome은 `npx.cmd playwright install chrome`으로 설치할 수 있습니다.

변경은 **`dev`에서 만든 주제 브랜치 → `dev` PR**로 제출합니다. 배포는 **`dev` → `main` PR**을 거칩니다. 격리 실행, 필수 검사와 문서 기준은 [기여 안내](CONTRIBUTING.md)를 확인하세요.

<details>
<summary>개발 명령과 코드 구조</summary>

| 명령 | 용도 |
|---|---|
| `npm.cmd run typecheck` | TypeScript 검사 |
| `npm.cmd run build` | 웹·호스트·Electron 빌드 |
| `npx.cmd tsx --test --test-concurrency=1 tests/**/*.test.ts` | 빌드 후 순차 회귀 검사 |
| `node --import tsx scripts/release-check.ts` | 버전·README·CHANGELOG 정합성 |
| `node --import tsx scripts/package.ts --output release-candidate` | 별도 폴더에 패키징 |

`apps/desktop`·`apps/web`은 화면, `packages/host`는 실행부, `packages/terminal`은 터미널 표시·입력을 담당합니다. `platform`·`scripts`·`tests`에는 Windows 연결과 개발·검증 도구가 있습니다.

실사용 앱이 있는 `release/`를 덮어쓰지 마세요. MSIX 개발 도구의 AppData 가상화와 OwnerPipe 검증 경로는 [프로필 분리 기록](docs/validation/msix-profile-recovery.md)에 설명합니다. CI 통과와 서버 측 병합 제한의 적용 상태는 [기여 안내](CONTRIBUTING.md#자동-검사와-병합-제한의-현재-상태)에서 구분합니다.

</details>

## 문서

| 사용하기 | 함께 만들기 |
|---|---|
| [사용자 안내](docs/USER-GUIDE.md) | [기여 절차](CONTRIBUTING.md) |
| [변경 이력](CHANGELOG.md) | [설계 문서](docs/README.md) |
| [구현·검증 범위와 알려진 제약](docs/IMPLEMENTATION-STATUS.md) | [보안 문제 제보](SECURITY.md) |
| [배포·자동 업데이트](docs/RELEASING.md) | [이미지 출처와 README 참고 사례](docs/assets/README.md) |

Windows 실제 앱과 선택 실행 검증, 모바일 에뮬레이션, 실물 기기 검증은 구분해 기록합니다. 실사용 NSIS 설치본 교체·OS 재부팅·모든 WSL 및 모바일 브라우저 조합은 추가 확인 대상입니다.

---

<div align="center">

프로젝트는 현재 **private / UNLICENSED**입니다.<br />공개 라이선스는 별도로 결정하며, 이 안내가 새 사용 허가를 부여하지 않습니다.<br />[제3자 고지](docs/THIRD-PARTY-NOTICES.md) · [캐릭터 출처](docs/branding/README.md)

</div>
