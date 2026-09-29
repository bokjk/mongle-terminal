<div align="center">

<img src="apps/web/public/icon-512.png" width="116" alt="터미널을 안고 있는 몽글 캐릭터" />

# 몽글터미널

### 작업은 그대로. 어디서든, 이어서.

그룹으로 정리하고, 드래그로 나누고, 휴대폰에서 이어 쓰는 터미널.

[![Windows 11 x64 · Preview · Tailscale](docs/assets/status.svg)](docs/IMPLEMENTATION-STATUS.md)

[사용 안내](docs/USER-GUIDE.md) · [기여하기](CONTRIBUTING.md) · [변경 이력](CHANGELOG.md) · [구현 현황](docs/IMPLEMENTATION-STATUS.md)

</div>

<br />

![몽글터미널의 그룹 탐색과 여러 터미널 분할 화면](docs/assets/desktop.png)

<p align="center"><sub>실제 앱의 공통 화면을 격리된 데모 환경에서 촬영했습니다. 화면의 프로젝트와 출력은 설명용 예시입니다.</sub></p>

> [!NOTE]
> **0.3.0 Windows 미리보기 · 비공개 테스트 중.** 저장소는 비공개이며 테스트용 설치 파일은 직접 전달합니다. 공개 다운로드와 프로젝트 라이선스는 아직 준비되지 않았습니다. 공개 범위와 실제 검증 결과는 [구현 현황](docs/IMPLEMENTATION-STATUS.md)에서 확인할 수 있습니다.

## 터미널 여러 개, 하나의 작업 공간

<table>
<tr>
<td width="33%"><strong>정리하기</strong><br /><br />왼쪽에서 컴퓨터와 그룹을 고르고, 프로젝트마다 터미널과 배치를 모아 둡니다.</td>
<td width="33%"><strong>나누기</strong><br /><br />제목줄을 가장자리로 끌어 분할하고, 가운데에 놓아 위치를 바꿉니다.</td>
<td width="33%"><strong>이어 쓰기</strong><br /><br />작업 PC의 실행 중인 터미널에 다른 PC나 휴대폰으로 다시 접속합니다.</td>
</tr>
</table>

- **익숙한 셸 그대로.** PowerShell·명령 프롬프트, 설치된 Git Bash·WSL을 선택합니다. Claude·Codex 같은 CLI도 터미널에서 직접 실행하세요.
- **손에 맞는 분할.** 좌우·상하 분할, 경계 크기 조절, 드래그 이동과 한 패널 최대화를 제공합니다.
- **복사도 자연스럽게.** 블록 선택 후 자동 복사, 우클릭·`Ctrl+V` 붙여넣기, 검색과 글자 크기 조절을 지원합니다.
- **누르면 바로 입력.** PC와 모바일 모두 터미널 내용·제목을 누르면 제어권이 넘어옵니다. 붙여넣기와 보조 키도 같은 흐름으로 동작합니다.
- **닫아도 계속되는 작업.** 창을 닫으면 트레이에 남고 셸은 계속 실행됩니다. 종료 방식에 따른 차이는 아래에서 확인하세요.

## 휴대폰에서도 같은 터미널

<table>
<tr>
<td width="38%" align="center">
<img src="docs/assets/mobile.png" width="290" alt="몽글터미널 모바일 화면 — 글자 크기 조절과 터미널 보조 키" />
</td>
<td>
<h3>주소 대신 QR. 별도 앱 대신 브라우저.</h3>
<p>작업 PC와 휴대폰에서 Tailscale을 켠 다음, 원격 연결 설정의 QR코드를 스캔하세요. 첫 연결은 코드 입력과 작업 PC의 승인을 거칩니다.</p>
<p>작은 화면에서는 터미널 하나를 넓게 보여 줍니다. 패널 전환, Esc·Tab·Ctrl·방향키, 글자 크기 조절과 이전 출력 스크롤을 사용할 수 있습니다.</p>
<p>다시 PC에서 터미널을 누르면 그대로 이어서 입력합니다. 한 번에 한 기기가 제어하며, 스크롤하거나 창을 활성화하는 것만으로는 다른 기기의 입력을 가져오지 않습니다.</p>
<p><a href="docs/USER-GUIDE.md">원격 연결 안내 →</a></p>
</td>
</tr>
</table>

원격 접속 중에는 **작업 PC와 실행부가 켜져 있어야 합니다.** 자체 중계 서버 대신 Tailscale을 사용합니다. 동일 HTTPS 호스트에서 다른 웹 서비스가 확인되면 기존 서비스를 보존하고 연결을 차단합니다.

## 시작하기

Windows 11 x64를 대상으로 개발하고 있습니다. 전달받은 배포본에는 Node.js가 포함되며, 개발 환경은 아래에서 따로 준비합니다.

1. 설치본을 설치하거나, ZIP의 **폴더 전체**를 풀고 `MongleTerminal.exe`를 실행합니다.
2. **현재 컴퓨터 → + 터미널**에서 셸과 시작 폴더를 선택합니다. 로컬 앱에서는 **찾아보기**를 사용할 수 있습니다.
3. 제목줄을 끌어 분할하고, 터미널 내용을 눌러 입력합니다. 선택 후 놓으면 복사되고 우클릭으로 붙여넣습니다.
4. 원격 접속은 **설정 → 원격 연결**에서 켜고 QR코드·주소로 접속한 기기를 승인합니다.

여러 줄 붙여넣기는 먼저 내용을 확인합니다. 선택 없는 `Ctrl+C`는 실행 중인 작업을 중단합니다. 마우스를 직접 사용하는 프로그램에서는 `Shift+우클릭`으로 메뉴를 여세요. 자세한 조작은 [사용자 안내](docs/USER-GUIDE.md)에 있습니다.

### 창을 닫는 것과 작업을 끝내는 것은 다릅니다

| 동작 | 실행 중인 셸 | 다음에 열면 |
|---|---|---|
| 창의 **X** | 계속 실행 | 트레이·바로가기로 같은 화면에 복귀 |
| **앱 종료 · 터미널 유지** | 계속 실행 | 같은 호스트와 셸에 재연결 |
| **완전 종료…** 또는 PC 재시작 | 종료 | 저장된 그룹·배치·폴더·허용된 출력 기록과 **새 셸** 복원 |

완전 종료·재부팅 후 이전 명령, 셸 변수, CLI 대화나 개발 서버의 실행 상태를 자동 재개하지는 않습니다. [종료·복원 동작 자세히 보기](docs/USER-GUIDE.md)

<details>
<summary><strong>업데이트와 현재 확인 범위</strong></summary>

NSIS 설치본의 업데이트 확인·다운로드와 사용자 확인 후 설치를 구현했습니다. 설치를 선택하면 현재 PC의 작업을 저장·종료하고 진행하며, ZIP·개발 실행은 수동 업데이트 대상입니다. **공개 Release가 없으므로 일반 사용자를 위한 자동 업데이트 배포는 아직 열리지 않았습니다.**

수동 업데이트 전에는 작업을 저장하고 **완전 종료…**를 사용하세요. 실행 중인 앱 폴더를 덮어쓰지 않습니다. 사용자 데이터는 기본적으로 `%LOCALAPPDATA%\MongleTerminal`에 저장하고 업데이트·제거 시 자동 삭제하지 않습니다.

Windows의 실제 앱·PowerShell/ConPTY와 Android 삼성 인터넷의 키보드·스크롤 동작을 확인했습니다. 모든 모바일 브라우저, OS 재부팅 자체, WSL 실제 실행, 장시간 연결, NSIS 설치·제거와 공개 버전 간 자동 업데이트는 추가 검증이 필요합니다. 현재 산출물은 코드 서명 없는 미리보기입니다.

[배포 안내](docs/RELEASING.md) · [검증 결과와 알려진 제약](docs/IMPLEMENTATION-STATUS.md)

</details>

## 직접 실행하고 기여하기

**Windows 11 x64 · Node.js 24 LTS · Chrome**을 사용합니다. 첫 준비에는 인터넷 연결이 필요합니다.

```powershell
npm.cmd ci
node node_modules/node-pty/scripts/prebuild.js
node node_modules/node-pty/scripts/post-install.js
node node_modules/esbuild/install.js
node node_modules/electron/install.js

# 실사용 터미널과 분리한 개발 프로필
$env:MONGLE_DATA_DIR = Join-Path (Get-Location) '.test-data\dev-profile'
npm.cmd run typecheck
npm.cmd run build
npm.cmd start
```

네이티브 준비 명령은 의존성 설치 스크립트가 차단된 환경에서도 고정된 패키지의 공식 설치 절차를 실행합니다. UI 테스트용 Chrome이 없으면 `npx.cmd playwright install chrome`으로 준비하세요. `npm.cmd test`는 **빌드 후** 실행해야 UI 검사가 생략되지 않습니다.

개발 변경·검증·PR 순서는 **[CONTRIBUTING.md](CONTRIBUTING.md)**를 따라 주세요. **PR은 `dev`에서 만든 `<종류>/<설명>` 브랜치(예: `fix/tray-restore`)에서 `dev` 브랜치로 보냅니다.** `main`은 배포 브랜치라 유지보수자의 `dev` → `main` 배포 PR만 받습니다. 버그 제보, 사용 안내 개선, 접근성·모바일 수정, 코드 기여 모두 같은 기준으로 검토합니다. 기능 변경에는 사용자 문서와 변경 이력, 실제로 실행한 검사 결과를 함께 제출합니다.

PR 양식과 자동 검사를 제공합니다. `main` 등 다른 브랜치로 연 PR은 자동으로 `dev`로 옮겨지고, `main`·`dev` 브랜치나 이름 규칙에 맞지 않는 브랜치에서 연 PR은 **PR target branch** 검사가 실패합니다. 검사 통과와 승인을 서버에서 병합 조건으로 강제하는 GitHub ruleset은 [.github/rulesets](.github/rulesets/)에 정의했으며 저장소 공개 후 `scripts/apply-branch-rules.ts`로 적용합니다. 현재 비공개 저장소의 무료 요금제에서는 이 기능이 지원되지 않으므로 지금은 자동 검사·대상 이동과 유지보수자 리뷰가 강제 수단이고, 실패한 PR의 병합을 서버가 막지는 않습니다.

<details>
<summary><strong>개발 명령과 폴더 구조</strong></summary>

| 명령 | 역할 |
|---|---|
| `npm.cmd run dev` | 빌드 후 데스크톱 앱 실행 |
| `npm.cmd run typecheck` | TypeScript 검사 |
| `npm.cmd run build` | 실행부·데스크톱·웹 빌드 |
| `npm.cmd test` | 자동 검사; 조건부 생략 항목은 별도 확인 |
| `node --import tsx scripts/package.ts --output release-candidate` | 실사용 `release/`와 분리한 패키징 |

패키징은 `MongleTerminal-Setup-0.3.0-x64.exe`와 `MongleTerminal-0.3.0-x64.zip`을 생성합니다. 테스터에게는 설치 파일 하나만 전달하면 됩니다([비공개 테스트 배포](docs/RELEASING.md#비공개-테스트-배포)). `npm.cmd run package`의 기본 출력은 `release/`이므로 그 폴더에서 앱이 실행 중일 때 사용하지 마세요. `npm.cmd run host`는 개발용이며 배포본 실행 검증을 대신하지 않습니다.

| 경로 | 역할 |
|---|---|
| `apps/desktop` · `apps/web` | Electron 앱과 PC·모바일 공통 화면 |
| `packages/host` · `packages/terminal` | 독립 실행부와 터미널 화면·입력 동기화 |
| `platform` · `scripts` · `tests` | Windows 연결, 빌드·검사, 회귀 테스트 |
| `docs` | 사용자 안내, 설계, 공개 준비와 검증 기록 |

MSIX로 설치된 개발 도구는 AppData가 분리될 수 있습니다. 개발 프로필로 실사용 Tailscale 연결을 바꾸지 마세요. [설정 폴더 분리](docs/validation/msix-profile-recovery.md) · [생성 폴더 정리 기준](docs/WORKSPACE-HYGIENE.md)

</details>

## 더 알아보기

| 사용하기 | 함께 만들기 |
|---|---|
| [사용자 안내](docs/USER-GUIDE.md) | [기여 절차와 PR 기준](CONTRIBUTING.md) |
| [구현·검증 상태](docs/IMPLEMENTATION-STATUS.md) | [설계와 조사 문서](docs/README.md) |
| [변경 이력](CHANGELOG.md) | [보안 문제 제보](SECURITY.md) |
| [배포·업데이트](docs/RELEASING.md) | [이미지 출처와 재생성](docs/assets/README.md) |

---

<div align="center">

**몽글한 화면 위에, 하던 작업 그대로.**

프로젝트는 현재 **private / UNLICENSED**입니다.<br />공개 라이선스는 별도로 결정하며, 이 README와 기여 안내가 새 사용 허가를 부여하지 않습니다.<br />의존성 라이선스는 [제3자 고지](docs/THIRD-PARTY-NOTICES.md), 캐릭터 출처는 [브랜딩 기록](docs/branding/README.md)을 참고하세요.

</div>
