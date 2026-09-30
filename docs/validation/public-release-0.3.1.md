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

GitHub PR 검사와 공개 게시 후 인증 없는 다운로드 검증은 후속 단계다. 전용 Actions secret은 미설정이며 이번 배포는 유지보수자의 로그인된 gh로 진행한다.

## 미검증 범위

실제 기존 NSIS 설치본을 신버전으로 교체하는 설치·재실행·기록 복원, 다른 PC의 SmartScreen과 사용자 확인은 별도다. 사용자 실사용 호스트·셸·인증 데이터·Tailscale 설정은 시험을 위해 변경하지 않는다.
