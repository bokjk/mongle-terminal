# 몽글터미널에 기여하기

작은 버그 수정, 사용 경험 개선, 문서와 재현 가능한 문제 보고를 환영합니다. **한 PR은 한 가지 목적에 집중하고, 바뀐 동작·검증·문서를 함께 제출해 주세요.**

현재 저장소는 비공개이며 프로젝트 자체의 공개 라이선스는 아직 정하지 않았습니다. 이 가이드는 협업 준비 문서이며 공개 사용·재배포 허가를 추가하지 않습니다. 접근 권한이 있는 기여자는 아래 절차를 따릅니다. 공개 전환 후에는 같은 절차를 fork 기반으로 사용할 수 있습니다.

## 브랜치와 PR 대상

**기여 PR은 `dev`에서 만든 주제 브랜치에서 `dev`로 보냅니다.** `dev`는 기본 브랜치이자 통합 브랜치입니다. `main`은 배포 브랜치이며, 배포할 때 유지보수자가 이 저장소의 `dev`에서 여는 `dev` → `main` PR로만 바뀝니다.

1. 원본 저장소의 `dev`에서 주제 브랜치를 만듭니다. 쓰기 권한이 없으면 먼저 fork합니다.
2. 브랜치를 push합니다. fork를 쓰면 자신의 fork에 push합니다.
3. 대상(base)을 `dev`로 선택해 PR을 엽니다.

브랜치 이름은 `<종류>/<설명>` 형식입니다(예: `fix/tray-restore`, `fix/v0.3.0-installer`). 설명은 영문 소문자·숫자로 된 단어를 `-`, `.`, `_` 중 하나로 이어 1–60자로 씁니다. 대문자·한글·공백, 추가 `/`, 연속되거나 앞뒤에 오는 구분 기호는 쓸 수 없습니다. 이 규칙은 [scripts/pr-target.ts](scripts/pr-target.ts) 한 곳에 정의되어 있습니다.

| 종류 | 용도 |
|---|---|
| `feat` | 새 기능 |
| `fix` | 버그 수정 |
| `docs` | 문서·이미지 |
| `refactor` | 동작을 바꾸지 않는 구조 정리 |
| `perf` | 성능 개선 |
| `test` | 테스트 추가·수정 |
| `build` | 빌드·패키징·의존성 |
| `ci` | GitHub Actions·자동 검사 |
| `chore` | 그 밖의 유지 작업 |
| `codex` | 자동화 도구로 만든 작업 |

PR 양식의 변경 분류는 브랜치 종류와 별개로 실제 영향에 맞게 고릅니다.

[PR target policy](.github/workflows/pr-target.yml)는 PR을 열거나 다시 열 때, 수정하거나 새 커밋을 push할 때마다 대상과 브랜치 이름을 확인하고 PR 최신 커밋에 **PR target branch** 상태를 남깁니다.

- `main`이나 다른 브랜치를 대상으로 연 PR은 자동으로 `dev`로 옮겨지고, 같은 검사에서 곧바로 `dev` 기준으로 판정됩니다. `main`에서 브랜치를 만들었다면 **Files changed**에 의도하지 않은 커밋이 없는지 확인하세요.
- `main`·`dev` 브랜치에서 연 PR과 이름 규칙에 맞지 않는 브랜치의 PR은 실패합니다. 열린 PR의 원본 브랜치는 바꿀 수 없으므로 규칙에 맞는 새 브랜치를 push하고 `dev` 대상 새 PR을 연 뒤 기존 PR은 닫습니다.
- 안내 코멘트는 PR마다 하나만 남기고, 결과가 바뀌면 그 코멘트를 고칩니다.
- `dev` → `main` 배포 PR과 배포 뒤 `main` → `dev` 역병합 PR은 유지보수자만 이 저장소의 브랜치에서 엽니다.
- 상태는 PR이 아니라 커밋에 붙습니다. 같은 head 커밋을 공유하는 PR들은 마지막 판정을 함께 표시합니다.

서버 측 병합 차단의 적용 상태는 아래 [자동 검사와 병합 제한의 현재 상태](#자동-검사와-병합-제한의-현재-상태)에 정리했습니다.

## 1. 문제와 범위를 먼저 정하기

버그는 [버그 보고 양식](.github/ISSUE_TEMPLATE/bug_report.yml)에 재현 순서, 기대한 결과, 실제 결과와 환경을 적어 주세요. 기능 제안은 [기능 제안 양식](.github/ISSUE_TEMPLATE/feature_request.yml)에 해결하려는 불편과 원하는 사용 흐름을 적습니다. 큰 UI 변경, 저장 데이터 형식, 인증·원격 연결, 새 의존성, 배포 방식 변경은 구현 전에 이슈에서 범위를 맞춰 주세요. 오탈자나 작은 재현 가능한 수정은 바로 PR을 열어도 됩니다.

보안 취약점은 공개 이슈에 작성하지 말고 [보안 제보 안내](SECURITY.md)를 따릅니다. 사람을 존중하며 코드와 근거를 중심으로 의견을 나누고, 개인정보와 실제 작업 내용을 공유하지 않습니다.

## 2. 개발 환경과 격리된 작업 폴더 준비

현재 빌드 대상은 **Windows 11 x64, Node.js 24.x**입니다. 빌드에는 Windows의 .NET Framework C# 컴파일러를 사용합니다. UI 검사는 Chrome, 원격 전송 검사는 Git for Windows에 포함된 OpenSSL을 사용합니다.

```powershell
git clone https://github.com/bokjk/mongle-terminal.git
Set-Location mongle-terminal
git switch -c fix/short-description origin/dev

# 앱을 실행하기 전에 실사용 프로필과 분리합니다.
$env:MONGLE_DATA_DIR = Join-Path (Get-Location) '.test-data\dev-profile'
New-Item -ItemType Directory -Force -Path $env:MONGLE_DATA_DIR | Out-Null

npm.cmd ci
node node_modules/node-pty/scripts/prebuild.js
node node_modules/node-pty/scripts/post-install.js
node node_modules/esbuild/install.js
node node_modules/electron/install.js
npx.cmd playwright install chrome
npm.cmd run dev
```

브랜치 이름은 [브랜치와 PR 대상](#브랜치와-pr-대상)의 `<종류>/<설명>` 규칙을 따릅니다. fork를 사용한다면 clone 주소를 자신의 fork로 바꾸고 원본 저장소를 `upstream`으로 등록한 뒤, `git fetch upstream dev`와 `git switch -c fix/short-description upstream/dev`로 원본의 `dev`에서 시작합니다.

설치 스크립트는 잠금 파일에 고정된 의존성의 네이티브 바이너리를 준비합니다. 최초 다운로드에는 인터넷이 필요합니다. `npm run dev`는 빌드 후 앱을 엽니다. 개발 셸에서 설정한 `MONGLE_DATA_DIR`는 그 셸과 자식 프로세스에만 적용됩니다. 다른 셸에서 실행할 때도 다시 지정하세요.

개발 앱이 `권한이 없는 작업을 수행하려고 했습니다`라는 실행부 시작 오류로 연결되지 않으면, 데이터 폴더에 현재 사용자의 소유자 변경 권한이 없는 경우입니다. 실행부는 인증 파일을 보호하려고 데이터 폴더를 현재 사용자 전용 권한으로 다시 설정합니다. 이때는 `$env:MONGLE_DATA_DIR = Join-Path $env:TEMP 'mongle-dev-profile'`처럼 사용자 프로필 아래 폴더를 지정하세요.

**실사용 호스트·셸을 테스트 때문에 종료하거나 인증 파일을 초기화하지 않습니다.** 시험 프로필로 실제 Tailscale Serve 설정을 바꾸지 않습니다. Windows MSIX 앱에서 실행한 도구는 같은 AppData 문자열도 다른 위치로 연결될 수 있습니다. 인증 키·DB·세션을 서로 복사하지 말고 [프로필 분리 기록](docs/validation/msix-profile-recovery.md)을 확인하세요.

## 3. 작은 변경과 필요한 검증 만들기

관련 코드는 아래 경로에서 찾을 수 있습니다.

| 경로 | 담당 영역 |
|---|---|
| `apps/web` | 데스크톱·모바일 공통 UI |
| `apps/desktop` | Electron 창·트레이·업데이트·앱 연결 |
| `packages/host`, `packages/terminal` | 독립 호스트, 셸 수명과 화면·입력 동기화 |
| `packages/local-ipc`, `packages/auth`, `platform/windows` | 로컬 연결·인증·Windows 보조 프로그램 |
| `tests`, `docs` | 회귀 검사와 설계·검증 기록 |

기존 패턴과 잠금 파일을 따르고, 목적과 관련 없는 전체 포맷 변경이나 대규모 정리를 한 PR에 섞지 않습니다. 터미널의 입력 누락·중복, 제어권 전환, 재연결, 저장·종료, 인증에 영향이 있으면 해당 실패를 재현하는 검사를 추가합니다. 단순 문구 수정처럼 영향이 작은 변경에는 구현을 그대로 되풀이하는 테스트를 만들 필요가 없습니다.

기본 검증은 다음과 같습니다. `test` 전에 빌드해야 UI 검사가 실행됩니다.

```powershell
npm.cmd run typecheck
npm.cmd run build
npx.cmd tsx --test --test-concurrency=1 tests/**/*.test.ts
node --import tsx scripts/release-check.ts
git diff --check
```

변경을 개발하는 동안에는 관련 검사를 좁혀 실행할 수 있습니다.

```powershell
node --import tsx --test --test-concurrency=1 tests/ui/tap-control.test.ts tests/ui/tap-control-integration.test.ts
```

기본 테스트의 `MONGLE_E2E_*` 선택 실행 항목, 실제 설치·업데이트, 재부팅, Android 브라우저와 실제 Tailscale 연결은 **기본 CI 통과만으로 검증되지 않습니다.** 변경이 해당 영역에 영향을 주면 격리된 환경에서 필요한 항목을 실행하고 결과를 적거나, 실행하지 못한 이유와 남은 범위를 명시합니다. 테스트 더블·브라우저 에뮬레이션·실제 앱·사용자 확인을 구분해 주세요. [검증 기록](docs/validation/)의 관련 문서를 참고합니다.

스크린샷은 격리된 시험 데이터로 촬영합니다. 실제 토큰, 연결 코드, 기기 인증 정보, Tailscale 주소, 사용자 경로, 개인 터미널 출력은 이미지·로그·PR 어디에도 올리지 않습니다. 생성되는 `.test-data`, `test-results`, `dist`, `runtime`, `release*`, `node_modules`는 커밋하지 않습니다. 의도적으로 공개할 문서 이미지만 검토해 추가합니다.

## 4. 기능과 문서를 함께 갱신하기

| 변경 | 함께 확인할 문서 |
|---|---|
| 사용자에게 보이는 기능·동작 수정 | `README.md`, `CHANGELOG.md`의 **미배포 변경** |
| 조작·종료·복원·원격 연결·개인 데이터·업데이트 동작 | 위 문서와 `docs/USER-GUIDE.md` |
| 배포·자동 업데이트 방식 | 위 관련 문서와 `docs/RELEASING.md` |
| 실제 검사 결과·남은 제약 | `docs/IMPLEMENTATION-STATUS.md`, 관련 `docs/validation/` 문서 |
| 내부 리팩터링·개발 도구만 변경 | 기존 안내가 여전히 맞는지 확인하고 PR에 문서 수정이 불필요한 이유 설명 |

버전·파일 이름·명령은 실제 설정과 일치시킵니다. 릴리스 준비가 아닌 PR에서 임의로 버전을 올리거나 저장소 공개 범위·라이선스를 바꾸지 않습니다. 의존성을 추가하면 용도와 라이선스를 설명하고 잠금 파일 및 필요한 제3자 고지를 갱신합니다.

## 5. PR 제출과 리뷰

[PR 양식](.github/PULL_REQUEST_TEMPLATE.md)의 **변경 내용 / 검증 결과 / 문서 영향 / 확인**을 모두 작성합니다. 재현 조건과 이전·이후 동작, 실행한 명령과 결과, 실행하지 못한 검증을 구체적으로 적어 주세요. 사용자 동작 변경·내부 구현·문서 변경 중 해당 분류 하나를 고르고, 사용법·배포 문서가 필요한 변경인지 표시합니다. 확인 항목은 실제로 확인한 뒤 체크합니다.

AI 도구로 작성한 코드도 제출자가 설명하고 검증할 책임이 있습니다. 사용한 도구 이름을 반드시 나열할 필요는 없지만 이해하지 못한 코드나 확인하지 않은 결과를 검증 완료로 제출하지 않습니다. 공개 이슈·PR에 프롬프트나 로그를 첨부할 때도 비밀 정보가 없는지 확인합니다.

유지보수자는 목적·동작·테스트·문서·보안 경계를 검토하고 수정을 요청할 수 있습니다. CI 통과만으로 병합이 승인되지는 않습니다. 수정 후에는 영향받는 검사를 다시 수행하고 PR의 결과를 갱신합니다.

### 자동 검사와 병합 제한의 현재 상태

[Contribution checks](.github/workflows/ci.yml)는 모든 `pull_request`와 `main`·`dev` push에서 **Windows checks** 작업을 실행하도록 구성되어 있습니다. push는 `docs/**`와 `.md` 문서만 바뀌면 건너뛰지만 PR은 문서만 바뀌어도 검사하며, PR 본문 수정도 재검사합니다. 필수 섹션·검증 설명·확인 체크리스트와 선택한 변경 분류에 따른 문서 동반 여부를 검사하고 타입·빌드·기본 회귀·배포 문서 검사를 수행합니다. 내부 변경은 README/CHANGELOG 수정을 일괄 강제하지 않고 문서 영향 설명을 요구합니다. 자동 검사는 설명의 진실성이나 변경 분류의 정확성까지 판단할 수 없으므로 리뷰가 필요합니다.

[PR target policy](.github/workflows/pr-target.yml)는 PR 대상 변경·안내 코멘트·**PR target branch** 상태 기록에 쓰기 권한이 필요해 `pull_request_target`으로 실행됩니다. 권한은 저장소 읽기와 PR·커밋 상태 쓰기로 제한합니다. 기본 브랜치의 정책 스크립트 하나만 체크아웃해 실행하고 PR의 코드를 받거나 실행하지 않으므로, PR에서 정책 파일을 바꿔도 병합 전에는 적용되지 않습니다. 기여 코드는 읽기 권한만 있는 `pull_request`의 **Windows checks**에서만 실행됩니다.

CI 설정 추가와 실제 GitHub Actions 실행 완료는 별개입니다. 서버 측 병합 차단은 [.github/rulesets](.github/rulesets/)의 GitHub ruleset으로 정의합니다.

| 브랜치 | 서버 측 규칙 |
|---|---|
| `dev` | PR 필수, 승인 1명, 새 커밋 시 기존 승인 무효화, **Windows checks**·**PR target branch** 통과, 삭제·강제 push 금지 |
| `main` | PR 필수, 저장소 관리자만 갱신(배포 PR 병합), **Windows checks**·**PR target branch** 통과, 삭제·강제 push 금지 |

저장소 관리자 역할은 두 규칙을 우회할 수 있습니다. **GitHub 무료 요금제의 비공개 저장소는 ruleset과 브랜치 보호를 지원하지 않아(브랜치 보호 API 403 확인) 서버 측 병합 차단이 아직 적용되지 않았습니다.** 그동안은 `main` 대상 PR의 자동 `dev` 이동, **PR target branch**·**Windows checks** 실패 표시와 유지보수자 리뷰가 규칙을 지키는 수단이며, 실패한 PR의 병합을 서버가 막지는 않습니다. 저장소 공개 여부나 요금제는 이 문서만으로 바꾸지 않습니다. 소유자 본인이 작성한 PR은 스스로 승인할 수 없으므로 공개 협업 시 승인 가능한 유지보수자와 우회 사용 기준도 함께 정합니다.

유지보수자는 공개 전환 후 다음 순서로 적용하고 확인합니다. GitHub Actions의 `integration_id`(15368), 저장소 관리자 역할의 `actor_id`(5)와 `pull_request` 규칙 값은 아직 실제 GitHub 응답으로 확인하지 않았습니다.

1. 저장소 Administration 쓰기 권한이 있는 소유자 계정으로 `gh auth login`합니다.
2. `node scripts/apply-branch-rules.ts --dry-run`으로 생성·갱신 계획을 확인한 뒤 `node scripts/apply-branch-rules.ts`로 적용합니다.
3. 적용 응답과 저장소 **Settings → Rules**에서 규칙, 우회 대상, `pull_request` 값이 의도대로인지 확인합니다.
4. 첫 PR에서 **PR target branch** 상태가 필수 검사로 인정되는지 확인합니다. 상태가 기록됐는데도 대기(Expected)로 남으면 `.github/rulesets/*.json`의 해당 항목에서 `integration_id`를 지우고 다시 적용합니다.

기여 코드를 실행하는 PR CI는 읽기 권한만 사용하고 저장소 자격 증명을 체크아웃에 남기지 않습니다. 외부 fork의 코드를 비밀 키나 쓰기 토큰과 함께 실행하지 않습니다. 태그 기반 Release 초안 생성은 별도 [배포 절차](docs/RELEASING.md)를 따릅니다.
