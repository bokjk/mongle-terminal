# 0.3.1 공개 배포 전환 검증

기준일: 2026-09-30. 소스 저장소를 비공개로 유지하고 `bokjk/mongle-terminal-releases`를 공개 배포 전용으로 생성했다.

## 변경

- 설치본의 GitHub 업데이트 주소를 공개 배포 저장소로 변경. 0.3.0 이하는 한 번 수동 설치 필요.
- 0.3.1에 한글 입력·현재 폴더·밝은 테마 수정 포함.
- 내부 문서·개발 소스·소스맵의 패키지 포함 제외. 사용자 안내·제3자 고지 유지.
- 태그 빌드와 공개 저장소 초안 게시 분리. `RELEASE_REPO_TOKEN` 미설정 시 artifact만 보존하고 경고. 유지보수자 gh 인증으로 수동 초안 생성 가능.

## 수행 결과

- 타입 검사·빌드·릴리스 문서 검사 통과.
- 전체 회귀: 285개 중 275 통과, 실패 0, 선택 실행 10 생략. `MONGLE_E2E_UPDATES=1`로 실제 Electron 정상 다운로드·SHA-512 변조 거부 포함. `test-results/public-release-tests.log`.
- 게시 스크립트 검사 1/1 통과: 정상 체크섬 승인, 파일 변조·중복 이름·경로 이탈·누락된 노트 거부. `-CheckOnly`로 네트워크·게시 없이 실행. PowerShell 모듈 경로는 부모 pwsh와 분리한다.
- `release-public-0-3-1`에 NSIS·ZIP·blockmap·latest.yml·SHA256SUMS 생성. 네이티브 모듈·아이콘·ZIP 필수 파일·SHA-512·크기 검사 통과. `test-results/public-release-package.log`.
- 실제 패키지의 PowerShell 실행·취소·저장 후 정상 종료·재실행 복원 E2E 1/1 통과(55.1초). TEMP의 새 프로필 사용. `test-results/e2e/public-release-031/full-exit-result.json`.
- 패키지의 `app-update.yml`이 공개 배포 저장소를 가리킴. ASAR에는 main/preload 번들과 package.json만 있고 소스맵 없음. hostbundle 문서·Windows 구성요소 허용 목록 검사 통과.
- 설치 파일 SHA-256: `445805d6629607d3f6e3f7ba054fbb01d2cef18d3b1ae358194eccb0b4402520`.

## 공개 게시와 실제 다운로드

- 소스 PR #5와 `dev` → `main` PR #6의 Windows checks·PR target branch 통과 후 병합했다. PR #5 CI는 286개 중 275 통과·실패 0·선택 실행 11 생략. [PR #5 검사](https://github.com/bokjk/mongle-terminal/actions/runs/36675871756), [PR #6 검사](https://github.com/bokjk/mongle-terminal/actions/runs/36676453183).
- 소스 태그 `v0.3.1`은 `main` 배포 커밋 `9bc941b6ca4470dd521691e217a07c4362f26076`을 가리킨다. 패키징 후 병합까지 실행 코드·사용자 안내·고지에 추가 변경이 없음을 확인했다.
- 2026-09-30 15:13 KST에 [0.3.1 Release](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.1)를 안정 latest로 공개했다. 첨부는 설치본·ZIP·blockmap·latest.yml·SHA256SUMS 다섯 개다. 설치본은 148,703,597바이트.
- 인증 없는 GitHub latest API 200, 안정 버전 0.3.1 확인. 작은 첨부 세 개는 실제 내려받은 바이트, 설치본·ZIP은 HTTP HEAD 크기와 GitHub 서버 SHA-256을 로컬 파일과 비교해 일치했다. `test-results/public-update/assets.json`.
- 실제 Electron HTTP와 제품의 GuardedNsisUpdater·UpdateController로 공개 GitHub provider를 사용해 설치본 전체 다운로드·내장 SHA-512 검증을 통과했다. 추가 SHA-256도 위 설치본과 일치했고 상태는 `ready`, 진행률 100이었다. 같은 0.3.1 버전은 `idle`·“최신 버전입니다.”로 확인했다. `test-results/public-update/result.json`.
- 이 다운로드 검사는 새 패키지의 `app-update.yml`을 읽고 AppAdapter의 현재 버전만 0.3.0/0.3.1로 지정했다. GitHub 인증 환경변수를 제거했고 TEMP에 다운로드했다. 설치·종료·재실행 호출은 금지했다. **옛 0.3.0 설치본이 새 주소를 스스로 찾았다는 검증은 아니다.**
- 공개 저장소 Git 트리에는 사용자 안내 README만 있고 소스 저장소는 계속 PRIVATE다. 새 공개 저장소는 PUBLIC이며 소스 이력을 복사하지 않았다. 공개 패키지의 host/web/docs 텍스트에서 로컬 작업 경로·GitHub 토큰 패턴을 발견하지 않았다.
- 최초 게시 시 `gh repo view`가 `GH_REPO` 대신 현재 소스 저장소를 선택해 공개 여부 검사에서 중단됐다. 저장소를 모든 명령에 명시하도록 수정한 뒤 재검사·초안 생성·공개 게시를 완료했다. 잘못된 저장소에 파일을 업로드하지 않았다.

전용 Actions secret은 미설정이다. 이번 배포는 유지보수자의 gh 인증으로 완료했으며 사용자 앱은 토큰 없이 업데이트한다. 태그의 Windows release draft 작업은 별도 재빌드 artifact를 생성하고 secret이 없으면 초안 게시를 건너뛴다. 이미 게시한 바이너리를 이 재빌드 파일로 덮어쓰지 않는다.

## 미검증 범위

실제 기존 NSIS 설치본을 신버전으로 교체하는 설치·재실행·기록 복원, 다른 PC의 SmartScreen과 사용자 확인은 별도다. 사용자 실사용 호스트·셸·인증 데이터·Tailscale 설정은 시험을 위해 변경하지 않는다.
