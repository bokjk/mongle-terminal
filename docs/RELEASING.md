# 배포와 자동 업데이트

기준 버전: **0.3.12 Windows 미리보기**(2026-10-06 공개). PDF 보기와 드래그 자동 스크롤 수정을 포함한다. 개발·배포 PR과 최종 태그 검사, 실제 NSIS 교체·전체 파일 일치·작업 복원, 공개 첨부 5개 익명 전체 다운로드·해시와 실제 Electron 업데이트 다운로드를 확인했다. [0.3.12 배포 기록](validation/public-release-0.3.12.md).

이전 버전: **0.3.11 Windows 미리보기**(2026-10-05 공개). 파일 편집·마크다운과 성능·저장 보호, NSIS 압축 호환성 수정을 포함한다. 최종 태그 회귀·네이티브·실제 설치 교체와 복원, 공개 첨부 5개 익명 전체 다운로드·해시 일치와 실제 Electron 업데이트 다운로드를 확인했다. [0.3.11 배포 기록](validation/public-release-0.3.11.md).

과거 버전: **0.3.10 Windows 미리보기**(2026-10-04 공개). 연속 출력·입력·워크트리 조회와 탐색기·재연결·복사·관리자 환경 첫 실행을 보완했다. 공식 태그 검사와 추가 패키지 QA를 통과한 산출물을 공개했으며 실제 Electron의 익명 설치본 다운로드·동일 버전 확인과 공개 첨부 5개의 전체 다운로드·해시 검증을 마쳤다. [0.3.10 배포 기록](validation/public-release-0.3.10.md)에 실제 검사와 게시 영수증을 기록한다. 0.3.9는 공개하지 않았고 실패한 소스 태그를 보존한다. 실제 사용자 설치본 교체와 NSIS 설치 마법사 전체 조작은 수행하지 않았다.

0.3.10 이전 공개 배포는 **0.3.8**이었다. 설치본의 익명 전체 다운로드·해시 검증 결과는 [0.3.8 검증](validation/public-release-0.3.8.md)에 기록한다. 소스는 비공개로 유지하고 [배포 전용 공개 저장소](https://github.com/bokjk/mongle-terminal-releases/releases/latest)에 설치 파일과 업데이트 메타데이터를 게시한다. 코드 서명과 프로젝트의 오픈소스 라이선스는 추가하지 않는다. 이전 배포는 [0.3.7 검증](validation/public-release-0.3.7.md), 공개 주소 전환은 [0.3.1 검증](validation/public-release-0.3.1.md)을 확인한다.

0.3.11 파일 편집 변경: 데스크톱에 저장하지 않은 편집 파일 또는 진행 중인 저장 요청이 있으면 앱 종료·완전 종료·업데이트 설치를 먼저 차단한다. 사용자가 편집기에서 저장하거나 탭을 닫아 변경을 버린 뒤 다시 진행해야 한다. 설치 전에는 이 차단 동작과 기존 종료·복원 절차를 함께 검증한다. 이 변경은 최종 태그 산출물을 검증한 뒤 0.3.11에 공개했다. 현재 공개 업데이트 채널은 위의 0.3.12다.

최종 태그 작업도 같은 NSIS 설치·교체·복원 검사를 수행하며, 설치된 app.asar와 전체 hostbundle의 상대 경로·SHA-256이 패키지 원본과 모두 일치해야 artifact를 보존한다. 최신 7-Zip의 ARM64 필터와 NSIS 압축 해제기의 호환성 문제로 일부 파일이 빠지는 것을 재현했으므로, 패키징에서 호환되는 BCJ 필터를 명시한다. 파일 검사의 예외를 추가하지 않는다.

`Installed upgrade validation`은 별도의 일회성 GitHub 호스팅 Windows에서 공개 0.3.8 NSIS를 설치하고 작업을 정상 종료한 뒤 현재 소스의 실제 NSIS로 교체한다. 설치 표식·실제 실행 버전·패키지 해시·작업 그룹과 터미널의 자동 복원·시험 프로세스 종료를 검사하며 결과 JSON을 보관한다. 로컬 PC와 자체 호스팅 실행기는 스크립트가 거부한다. 이 검사는 공개 업로드·태그 생성 없이 실행하며 확인창 응답은 자동화한다. 마법사 전체 수동 조작이나 실제 사용자 설치본 교체로 표현하지 않는다.

## 배포 경로와 기존 사용자 전환

- 소스: `bokjk/mongle-terminal` (비공개). 공개 범위·라이선스를 바꾸지 않는다.
- 배포: `bokjk/mongle-terminal-releases` (공개). 사용자 안내와 Release 산출물만 게시하며 소스·개발 문서·검증 기록·Git 이력을 복사하지 않는다.
- 대상: Windows 11 x64, 현재 사용자용 NSIS 설치본. ZIP은 수동 교체용이다.
- 업데이트: 설치본에 내장된 GitHub provider의 `repo`가 `mongle-terminal-releases`를 가리킨다. 사용자는 GitHub 로그인이나 토큰 없이 받는다.
- **0.3.0 이하 설치본에는 옛 비공개 주소가 내장되어 있다.** 0.3.1 이상을 한 번 직접 설치해야 전환된다. 이후 새 안정 버전부터 자동 다운로드한다.

나중에 소스를 공개하더라도 배포 주소는 그대로 유지할 수 있다. 주소를 다시 바꾸면 기존 설치본에서 도달 가능한 이전 채널에 전환 버전을 먼저 게시해야 한다. `package.json`의 `private: true`는 npm 게시 방지 설정이며 GitHub 공개 여부와 별개다.

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

## 브랜치와 배포 순서

1. `dev`에서 만든 주제 브랜치에서 버전·잠금 파일·README·사용자 안내를 갱신하고 미배포 변경을 날짜가 있는 CHANGELOG 항목으로 옮긴다. 공개 Release 본문으로 쓰므로 해당 버전 항목에는 내부 문서 링크나 개인 정보를 넣지 않는다.
2. 타입·빌드·회귀·패키지 검사를 수행하고 PR로 `dev`에 병합한다. 이어 `dev` → `main` 배포 PR의 **Windows checks**·**PR target branch** 통과 후 병합한다. `main` 직접 push는 하지 않는다.
3. 병합된 `main` 커밋에 `vX.Y.Z` 태그를 push한다. [Windows release draft](../.github/workflows/release.yml)는 해당 태그를 검사·빌드·패키징하고 `windows-release` artifact를 보존한다.
4. 배포 자격 증명이 있으면 공개 저장소에 Release **초안**을 만든다. 없으면 artifact까지만 만들고 경고한다. 유지보수자가 아래 수동 게시 명령으로 초안을 만들 수 있다.
5. 검증된 초안의 파일·버전·변경 내용을 검토한 뒤 `gh release edit vX.Y.Z --repo bokjk/mongle-terminal-releases --draft=false --latest`로 공개한다. 인증 없는 다운로드·메타데이터·해시 일치를 확인하고 결과를 기록한다. 공개를 확인한 뒤 README의 후보 표시와 현재 공개 버전, 이 문서의 배포 상태를 갱신한다. 패키지에 동봉한 사용자 안내는 태그의 파일과 일치하게 보존한다.

공개 저장소의 태그는 안내 README 커밋을 가리킨다. 실제 빌드 출처는 비공개 소스의 동일 버전 태그와 Actions 기록으로 추적한다. 소스 Git 이력을 배포 저장소에 push하지 않는다. 이미 공개한 버전은 덮어쓰지 않으며 수정 시 버전을 올린다. 소스 저장소의 무료 비공개 요금제에서는 서버 측 ruleset이 미적용인 상태이므로 [기여 절차](../CONTRIBUTING.md)를 지킨다.

## 자동 초안 생성 인증

GitHub Actions의 기본 `GITHUB_TOKEN`은 다른 저장소에 쓸 수 없다. 공개 배포 저장소 하나만 선택하고 **Contents: Read and write** 권한을 부여한 fine-grained PAT를 소스 저장소의 Actions secret **`RELEASE_REPO_TOKEN`**에 저장한다. 토큰은 초안 게시 단계에서만 사용하며 앱·소스·로그에 넣지 않는다. [GitHub 인증 문서](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token)

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
