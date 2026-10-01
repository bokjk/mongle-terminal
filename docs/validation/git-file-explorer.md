# 파일·Git 전환과 변경 상태 검증

기준일: 2026-10-01. `codex/git-file-explorer`의 구현을 [PR #23](https://github.com/bokjk/mongle-terminal/pull/23)으로 dev에 병합했고 **0.3.6 배포 준비에 포함했다.** 공개 게시 상태는 [0.3.6 배포 검증](public-release-0.3.6.md)과 구분한다. 기존 0.3.5 공개 산출물을 덮어쓰거나 실사용 설치본을 자동 교체하지 않는다.

## 설계와 참고

Mobbin의 [Databricks 편집기](https://mobbin.com/explore/screens/dfea709f-3245-4e15-983f-f76b96001f2c)를 앱 내 브라우저에서 직접 열고 화면을 확인했다. 좁은 패널 안의 탭 전환·선택 상태·보조 정보의 위계를 참고했다. Mobbin 참고 범위는 패널 구성이며, Git 상태·이름 변경·충돌은 [Git 공식 porcelain v2 명세](https://git-scm.com/docs/git-status#_porcelain_format_version_2)에 맞춰 구현했다.

- 기존 탐색기 제목줄 안에서 파일/Git을 전환하고 Git 옆에 변경 파일 개수를 표시한다. 별도 상단 도구줄이나 새 패널을 추가하지 않는다.
- Git 목록은 충돌·스테이징됨·작업 폴더 변경·새 파일로 나눈다. 같은 파일의 스테이징·추가 수정 또는 스테이징된 삭제·다시 만든 새 파일은 각각 표시하며 전체 개수는 중복 없이 센다. 다시 만든 파일은 삭제 그룹에서도 현재 내용을 미리 볼 수 있다.
- 수정은 황갈색 M, 추가·새 파일은 초록색 A/?, 삭제·충돌은 빨간색 D/U, 이름 변경은 보라색 R로 표현한다. 색과 문자·도움말·접근성 설명을 함께 제공한다. 변경된 하위 항목이 있는 폴더에는 점을 표시한다.
- 브랜치·경로·이름 변경·현재 파일 읽기 전용 미리보기와 저장소 없음·Git 없음·오류·변경 없음 상태를 구분한다. 선택한 터미널의 현재 폴더 범위를 유지한다.

## 구현 범위

인증된 공용 RPC에 `git.status`와 `git.read` capability를 추가했다. 기존 `files.read`와 함께 호스트에서 처리하며 구버전 호스트에는 파일 보기만 표시한다. 연결·hostId·bootId·generation·현재 cwd를 I/O 전후에 확인하고 터미널 제어권·입력 큐와 분리한다. 연결당 2개·전체 8개 읽기 한도를 사용하며 UI의 폴더·미리보기·Git 요청도 동시에 2개까지 처리한다.

Git은 셸 없이 고정 인자로 실행한다. [공식 백그라운드 조회 안내](https://git-scm.com/docs/git-status#_background_refresh)에 따라 선택적 잠금을 끄고, fsmonitor hook·사용자 GIT 환경변수·지연 fetch를 사용하지 않는다. 인덱스·설정·커밋은 수정하지 않는다. Git 메타데이터의 UNC 연결·앱 데이터 연결과 파일 범위 이탈을 거부한다. 현재 폴더 밖이나 인증·세션 데이터 항목은 결과에서 제외한다.

NUL 구분 porcelain v2로 한글·공백·이름 변경을 파싱하고 스테이징/작업 폴더 상태를 보존한다. 최대 1,000개·출력 2 MiB·각 명령 10초로 제한한다. Git 조회 오류를 깨끗한 저장소로 표시하지 않는다. 서브모듈 내부 미커밋 내용은 상위 목록에서 제외한다.

화면이 열려 있고 보이면 5초 간격·화면 복귀 시 상태를 확인한다. 실제 상태가 달라질 때 트리를 갱신하고 펼친 폴더를 유지한다. 호스트·터미널·현재 폴더가 바뀌면 이전 결과를 버린다. Git 파일 선택도 기존 64 KiB 읽기 전용 미리보기를 사용하며 스테이징된 내용의 diff·커밋·스테이징·복원 UI는 제공하지 않는다.

## 실제 수행

- 타입·공통 웹·호스트·데스크톱 빌드 통과.
- 최종 코드의 실제 Git·HostCore·Chrome·WebSocket 관련 검사 **26/26 통과**, 실패·건너뜀 없음. Git 실행 파일 없음, 첫 프레임 인증과 삭제 스테이징 후 재생성도 포함한다. 관련 로그: `test-results/git-explorer-final-regression.log`.
- 실제 저장소에서 수정·스테이징 후 추가 수정·추가·삭제·한글 이름 변경·새 파일·충돌·깨끗한 저장소·하위 폴더 범위·worktree·detached HEAD·초기 브랜치를 확인했다. 인덱스 SHA-256 불변과 fsmonitor 미실행, 개인 데이터·UNC 연결 거부·1,000개 한도도 검사했다.
- Chrome에서 키보드 탭 전환·파일 색/문자/폴더 점·중복 상태 그룹·HTML 미실행·삭제 미리보기 안내·자동 갱신·펼친 폴더 유지·늦은 응답 폐기·구버전 capability 호환·같은 셸 PID 유지를 확인했다. 밝은 테마의 상태 글자 대비는 모든 표시에서 **4.5:1 이상**이었다. 390px 화면에서 가로 넘침이 없음을 확인했다. `test-results/git-explorer/result.json`과 화면 4개를 직접 확인했다.
- 실제 **개발 Electron + OwnerPipe + cmd + Git**으로 파일/Git 전환·트리 상태·그룹 목록·미리보기·실제 명령 입력·자동 갱신을 확인했다. 같은 hostId·bootId·셸 PID·generation·분할 배치·Git 인덱스를 유지했고 시험 호스트는 정상 종료했다. `test-results/git-explorer/electron/result.json`과 실제 패널 캡처를 확인했다.
- 최종 코드를 `release-git-explorer-dev`에 로컬 패키징했다. NSIS·ZIP·동봉 Node/네이티브 모듈·실행 파일 아이콘·업데이트 메타데이터와 체크섬 검사를 통과했다. `scripts/package.ts --output release-git-explorer-dev`는 공개 업로드 없이 실행했다.
- **실제 패키지 `win-unpacked/MongleTerminal.exe` + OwnerPipe + cmd + Git**에서 위 조작과 삭제 스테이징 후 재생성 파일의 현재 미리보기를 통과했다. `app.isPackaged=true`, 같은 호스트·셸·배치·인덱스, 페이지 오류 0개와 시험 호스트 정상 종료를 확인했다. `test-results/git-explorer/packaged/result.json` 및 실제 패널 캡처 3개를 직접 확인했다.

전체 기본 회귀는 **307개 중 295 통과·1 실패·11 선택 실행 건너뜀**이었다. 실패한 Windows kill-on-close Job 검사는 샌드박스에서 호스트 시작 접근 거부가 발생했으며, `tests/platform/lifecycle.test.ts`만 샌드박스 밖에서 다시 실행해 **3/3 통과**했다. 이후 삭제 스테이징·재생성 보완은 위 26개 관련 검사로 다시 확인했다. 로그: `test-results/git-explorer-full-suite.log`, `test-results/git-explorer-lifecycle.log`.

기능 [PR 검사](https://github.com/bokjk/mongle-terminal/actions/runs/36827058113)의 **Windows checks / PR target branch**가 통과했다. 전체 회귀는 307개 중 296 통과·실패 0·선택 실행 11 생략했다. 시험 저장소·호스트·셸·개인 데이터는 TEMP에 격리했고 실사용 호스트·인증 정보·Tailscale 설정은 변경하지 않았다. 생성 화면·로그는 로컬 `test-results`에 보관하며 커밋하지 않는다. 위 구현 초기 개발 검증 패키지는 0.3.5 소스 버전이었으며 공개 0.3.5 산출물은 교체하지 않았다. 0.3.6 패키지·게시 결과는 배포 검증에서 구분한다.

## 남은 범위

공개 배포·실사용 앱 적용·NSIS 실제 설치·사용자 화면 확인·실물 모바일·다른 PC Tailscale 연결은 별도다. 원격 인증 전달 검사는 테스트 더블과 실제 로컬 HostCore의 원격 기기 맥락 검사를 구분한다. 브라우저 화면 검사는 테스트 데스크톱 바인딩으로 실제 HostCore에 연결했고, 실제 OwnerPipe는 별도 개발·패키지 Electron에서 검증했다.
