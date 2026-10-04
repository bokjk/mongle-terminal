# 0.3.8 간결한 작업 공간 배포 검증

기준일: 2026-10-02. **0.3.8을 안정 latest로 공개했고 인증 없는 실제 설치본 다운로드·해시 검증을 완료했다.** 소스·공개 README를 커밋·푸시·PR 병합했다. 실사용 NSIS 설치본 교체는 별도다.

## 변경 범위

컴퓨터 선택과 작업 그룹 전환을 36px 상단에 모으고 Windows 제목 표시줄과 통합했다. 사이드바는 212px에서 44px로 접는다. 사용자 피드백에 따라 접기·펼치기 버튼을 왼쪽 맨 위 같은 위치에 배치하고 펼친 상태에는 이름을 표시했다. 기존 셸·탭·분할 배치와 저장된 글자 크기는 유지한다. 저장값 없는 PC는 13px, 모바일은 기존 14px다.

README의 실제 예제 화면·사이드바 사용법·사용자 안내를 갱신했다. 이전 구현과 실제 앱 검사 기록은 [기능 검증](compact-workspace.md)에 있다. 소스와 프로젝트 라이선스의 공개 범위는 유지한다.

## 검증 상태

- 개발 단계의 타입·빌드와 마지막 버튼 위치 변경의 관련 회귀 5/5, 웹 자산을 갱신한 실제 패키지 앱 1/1 통과.
- 0.3.8 타입·빌드·문서 정합성·공백 검사 통과. 전체 회귀 322개 중 307 통과·실패 0·15 생략. 그중 파일 탐색기 UI는 병행 패키징의 웹 재빌드 중 일시적으로 `dist/web/index.html`이 없어 건너뛰었고, 빌드 종료 후 별도 실행해 1/1 통과했다. 나머지 14개는 선택 검사다. GitHub CI의 안정된 순차 실행 결과는 아래 후속 기록으로 구분한다.
- 최종 NSIS·ZIP·blockmap·latest.yml·SHA256SUMS 생성과 내장 네이티브 모듈·아이콘·ZIP 필수 파일·설치본 SHA-512 검증 통과. 웹/호스트·사용자 문서 12개 파일의 내용을 확인하고 ASAR의 main/preload·버전이 빌드 원본과 일치함을 검증했다. 런타임은 바이트 단위로 대조했고 제3자 고지의 Git 체크아웃 CRLF와 생성본 LF 차이는 줄바꿈을 정규화해 내용 일치를 확인했다.
- 최종 0.3.8 패키지에서 접힘 상태·고정 버튼 위치·동일 셸·좁은 창·설정 저장과 정상 종료 취소·저장·종료·복원 2/2 통과했다. 실사용 설치본 교체 검사는 아니다.
- 트레이 E2E의 예전 메뉴 순서 가정(두 번째 항목이 구분선)을 현재 업데이트 메뉴에 맞게 수정했다. 제품 코드 변경 없이 같은 패키지의 실제 Tray·창 숨김/복귀·단일 인스턴스·GUI 종료 후 동일 셸 재연결 1/1을 통과했다. 로그는 `.test-data/release-038-tray.log`, 증거는 `test-results/e2e/release-038-tray`에 있다.
- README 실제 예제 화면을 13px PC·사이드바 펼침/접힘·모바일로 촬영했다. 개인 경로를 포함한 초기 캡처는 거부했고 공용 격리 예제로 재촬영한 이미지들만 사용한다. GitHub GFM 렌더링 1280px/390px에서 이미지 7개 모두 로딩되고 문서 가로 넘침이 없었다. 로컬 링크·이미지 51개를 확인했다.
- 로그는 `.test-data/release-038-regression.log`, `release-038-files.log`, `release-038-package.log`, `release-038-packaged-e2e.log`다. 실제 앱 증거는 `test-results/e2e/compact-workspace`와 `release-038-full-exit`, 패키지 해시는 `test-results/release-038/local-assets.json`에 있다. 생성 로그·프로필은 커밋하지 않는다.
- PR 병합·공개 게시·인증 없는 다운로드 검증을 완료했다. 아래의 최종 영수증과 경로를 따른다.

## CI 타이밍 실패와 검사 보완

최초 배포 PR 검사에서 `terminal-tabs.test.ts`의 탭 드래그 시작 좌표가 null인 실패 1건이 있었다. 같은 head 커밋의 dev push 검사는 308/0/14로 통과했다. 실패 위치는 호스트 revision이 갱신된 직후 새 활성 탭/영역의 DOM 표시를 기다리지 않고 `boundingBox`를 읽던 부분이다. 검사 helper에 실제 source/target의 표시 대기를 추가했고 로컬 관련 검사 1/1을 통과했다. 제품 코드나 타임아웃을 늘려 우회하지 않았다.

배포 PR은 같은 커밋의 두 번째 CI 실행에서 308 통과·실패 0·14 생략으로 완료했다. 최종 통과 기록은 아래 게시 결과에서 구분하며 최초 실패를 숨기지 않는다. 검사 helper 보완은 배포 기록과 함께 후속 PR에 포함하고 배포 바이너리와 구분한다. 최초 실패 로그는 `.test-data/release-038-main-failed.log`, 보완 후 검사는 `.test-data/release-038-drag-readiness.log`다.
- 실제 설치본 교체·Snap·제목 표시줄 끌기·다중 모니터 배율·실물 모바일은 미검증이다. 기존 호스트·셸·인증 데이터·Tailscale을 변경하지 않는다.

최종 GitHub 기능·배포 PR의 회귀는 각각 **322개 중 308 통과·실패 0·선택 실행 14 생략**이다. 초기 로컬 재빌드 중 생략을 포함한 수치와 구분한다.

## PR 병합과 공개 게시

[기능 PR #30](https://github.com/bokjk/mongle-terminal/pull/30)과 [dev → main 배포 PR #31](https://github.com/bokjk/mongle-terminal/pull/31)의 Windows checks·PR target branch 통과 후 병합했다. main 직접 push는 하지 않았다. 소스 태그 `v0.3.8`은 main 병합 커밋 `e9a52ab26e8c195485600804981a0ea0c8a2cf62`를 가리킨다. 패키징한 런타임과 main의 소스가 같은 것을 확인했다.

[공개 README PR #2](https://github.com/bokjk/mongle-terminal-releases/pull/2)를 병합했다. 공개 저장소에는 사용자 안내와 검토한 예제 이미지만 게시했다. 해당 안내 커밋은 `e1b9db3d0e85622176a4d067f5674058bcb2b4bd`다. 소스와 내부 문서·Git 이력을 복사하지 않았다.

[0.3.8 Release](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.8) 공개 시각은 **2026-10-02T10:17:24Z (UTC)**다. 초안 첨부 5개를 검증한 로컬 파일의 이름·크기·서버 SHA-256과 대조한 뒤 latest로 게시했다. 기존 버전 파일은 수정하지 않았다. 공개 뒤 익명 latest API, 작은 첨부 3개의 실제 바이트, 설치본·ZIP의 다운로드 응답과 서버 해시를 확인했다.

## 실제 자동 업데이트 다운로드

기존 0.3.7 패키지의 app-update.yml과 제품의 GuardedNsisUpdater·UpdateController를 실제 Electron에서 사용했다. 인증 환경변수를 제거하고 TEMP 캐시를 격리했다. 설치·호스트 종료·재실행은 금지했으며 autoInstallOnAppQuit은 false였다. 0.3.8 설치본 전체 다운로드 후 ready·진행률 100·내장 SHA-512 및 추가 SHA-256 일치를 확인했다. 같은 0.3.8은 최신 버전 idle 상태였다. 실사용 설치 검사는 아니다.

| 공개 첨부 | 바이트 | SHA-256 |
|---|---:|---|
| `MongleTerminal-Setup-0.3.8-x64.exe` | 148,734,541 | `a5e9e57c704b7e85942038fb9ca28ab60b4943d30ba4ac7f1a1466f06b9c9779` |
| `MongleTerminal-Setup-0.3.8-x64.exe.blockmap` | 154,798 | `3a0c6d90ef27f335a4bd7156c7a1cc4556c980f2996a82a81de50f5e42ab3be3` |
| `MongleTerminal-0.3.8-x64.zip` | 206,177,019 | `9d63a35bcd6b0822224e5d30ed26fb77b76117cfd2e56644d6e203ae436a7d9d` |
| `latest.yml` | 365 | `5d0b2100a320d3143c2ed5a843223d259f6f3e84ceb0746a3ad48705c95e53ab` |
| `SHA256SUMS.txt` | 383 | `84cb2f93efad718f5c0bd3db1eac96f5a4b93ff4e3336272b74820185ca83809` |

공개 증거: `test-results/release-038/draft-verified.json`, `public-verified.json`, `test-results/public-update-038/result.json`. 전용 Actions 게시 secret을 새로 등록하지 않았으며 유지보수자의 gh 인증으로 검증한 로컬 산출물을 게시했다. 태그 워크플로는 같은 소스를 다시 검증·빌드해 artifact로 보존하며 공개한 바이너리를 덮어쓰지 않는다.

최종 GitHub 검사: [기능 PR](https://github.com/bokjk/mongle-terminal/actions/runs/36991336497), [배포 PR 2차](https://github.com/bokjk/mongle-terminal/actions/runs/36992275641/attempts/2), [태그 빌드](https://github.com/bokjk/mongle-terminal/actions/runs/36994350210). 태그 빌드는 공개한 로컬 산출물을 덮어쓰지 않는 별도 재빌드다.
