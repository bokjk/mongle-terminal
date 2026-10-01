# 0.3.6 Git 변경 보기 배포 검증

기준일: 2026-10-01. 파일/Git 전환·변경 목록·트리 상태 표시를 **0.3.6 Windows 미리보기 배포로 준비한다.** 공개 게시와 실사용 앱 교체는 아직 완료하지 않았다. 기존 0.3.5 공개 파일을 덮어쓰지 않는다.

기능 [PR #23](https://github.com/bokjk/mongle-terminal/pull/23)의 최신 커밋 `774d55fa84d5aee507d7fb2d2ed5a5dfe653079f`에서 Windows checks·PR target branch가 통과했고 dev에 병합했다. [기능 CI](https://github.com/bokjk/mongle-terminal/actions/runs/36827058113)의 기본 회귀는 **307개 중 296 통과·실패 0·선택 실행 11 생략**했다. 실제 Git·HostCore·Chrome·WebSocket 관련 검사 26/26 및 격리 개발·패키지 Electron의 조작 범위는 [Git 탐색기 검증](git-file-explorer.md)에 기록했다.

버전·잠금 파일·README·USER-GUIDE·CHANGELOG·RELEASING을 0.3.6으로 맞추고 미배포 변경을 실제 날짜가 있는 0.3.6 항목으로 옮겼다. 배포 준비·dev → main PR 검사·태그·패키지·공개 게시·인증 없는 업데이트 다운로드는 각각 실제 완료 뒤 기록한다.

## 배포 전 확인

- 타입 검사와 공통 웹·호스트·Electron 빌드 통과. 별도 `release-public-0-3-6`에 NSIS·ZIP·blockmap·latest.yml·SHA256SUMS를 생성했고 동봉 Node/네이티브 모듈·아이콘·ZIP 필수 파일·메타데이터·체크섬을 확인했다. `test-results/release-036-package.log`.
- 실제 **0.3.6 패키지 + OwnerPipe + cmd + Git**에서 파일/Git 전환·색/문자/폴더 점·그룹·삭제 스테이징 후 재생성 미리보기·자동 갱신·명령 입력을 통과했다. 같은 호스트·셸 PID/generation·분할 배치·인덱스를 유지했고 시험 호스트는 정상 종료했다. `test-results/e2e/public-release-036-git/result.json`.
- 실제 패키지의 취소·저장 후 정상 종료·재실행 복원 **1/1 통과**(45.0초). `test-results/e2e/public-release-036/full-exit-result.json`.
- 패키지 포함 텍스트 52개의 개인 경로·토큰 패턴과 허용 목록 검사가 통과했다. 내부 검증 문서·소스맵·개발용 C# 파일을 제외했고 패키지 호스트가 빌드와 일치했다. `test-results/release-036/package-content.json`.
- README의 데스크톱·모바일 화면을 0.3.6으로 촬영했고 실제 패키지의 파일/Git 패널 캡처도 추가했다. 다섯 이미지를 직접 확인했다. 예시 테스트 2개·모바일 에뮬레이션·실제 OwnerPipe 앱을 구분한다. [촬영 조건](../assets/screenshots.md).

실사용 호스트·셸·인증 데이터·Tailscale 설정을 유지한다. 사용자가 보고 있는 Git 미리보기는 별도 샘플 프로필과 개발 검증 패키지이며 0.3.6 설치로 교체하지 않는다. 실제 NSIS 설치·재실행·실물 모바일·다른 PC 연결은 별도다.
