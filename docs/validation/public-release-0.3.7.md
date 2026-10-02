# 0.3.7 워크트리·입력·탭 개선 배포 검증

기준일: 2026-10-02. 현재는 배포 준비 단계이며 공개 게시 완료와 구분한다.

## 범위

터미널 폴더 기준 워크트리, 선택적 터미널 열기, 기본 배지와 두 줄 목록, 일반 터미널 선택·이름 변경, 탭 앞뒤 이동, Windows Codex CLI와 한글 조합 후 Shift+Enter를 포함한다. 앞선 개발 검증은 [워크트리](worktrees.md), [터미널 문맥](terminal-context.md), [후속 개선](worktree-tabs-ime.md)에 보존한다.

버전·잠금 파일·README·CHANGELOG·사용자 안내·배포 안내를 0.3.7로 맞췄다. README 참고 원문과 적용 판단은 [이미지·구성 기록](../assets/README.md)에 기록한다. 데모는 개인 정보 없는 격리 저장소·실제 Windows 셸과 공통 UI로 촬영한다.

## 수행 기록

- 타입 검사와 웹·호스트·Electron 빌드 통과. 기존 웹 번들 500 kB 안내가 남는다.
- 전체 회귀 **321개 중 308 통과·실패 0·선택 실행 13 생략**. `.test-data/release-037-regression.log`.
- 별도 `release-public-0-3-7`에 NSIS·ZIP·blockmap·latest.yml·SHA256SUMS 생성. 동봉 Node v24.18.0·네이티브 의존성·아이콘·ZIP 필수 파일·설치 파일 SHA-512와 첨부 SHA-256 검사 통과. `.test-data/release-037-package.log`.
- 실제 **0.3.7 패키지·OwnerPipe·Git·ConPTY**의 워크트리 생성/선택/메뉴/GUI 재연결/승인된 모바일 웹, 탭 분리→앞뒤 재병합→순서 변경에서 PID·generation 보존 통과. `test-results/e2e/worktrees-packaged/result.json`.
- 같은 패키지의 **PowerShell 7 + Codex CLI 0.160.0**에서 영문 Shift+Enter, Chromium IME 조합 확정 직후 한글 줄바꿈, Codex 종료 후 일반 Enter 검증 통과. 프롬프트 전송·외부 모델 호출 없음. `test-results/e2e/codex-keyboard-powershell-default-packaged/result.json`.
- 같은 패키지의 완전 종료 취소·저장·정상 종료·자동 복원 검사 통과. 워크트리·키보드·수명주기 선택 실행은 **3/3 통과**. `.test-data/release-037-packaged-e2e.log`.
- README 로컬 링크·이미지 49개 검사, PC 1280px·모바일 390px 렌더링에서 이미지 6개 정상 로딩·페이지 가로 넘침 없음. `test-results/repository-refresh/preview.json`. 격리 데모의 최신 화면을 직접 확인했고 공개 저장소용 README에서도 내부 문서 링크를 제거했다.
- GitHub PR 검사·공개 게시·인증 없는 다운로드 검증은 아직 진행 전이다.

## 남은 범위

실사용 NSIS 설치본 교체·OS 재부팅·실물 모바일·Windows 물리 IME의 모든 조합은 별도다. 실사용 호스트·셸·인증 데이터·Tailscale 설정을 변경하지 않는다.

## CI에서 발견한 경로 표기 차이

첫 PR 검사에서 321개 중 306 통과·2 실패·13 생략이었다. GitHub Windows TEMP의 `RUNNER~1` 표기와 Git이 반환하는 긴 경로가 달라 새 탭 및 대상 저장소 검사가 실패했다. 셸의 시작 경로는 보존하고 `projects.attach`와 새 터미널의 워크트리 연결·생성 중 삭제 보호 비교에만 실제 위치를 사용하도록 수정했다. 경로 비교 테스트도 실제 위치를 대조하고, 다른 저장소를 가리키는 디렉터리 별칭에서 새 탭을 만들 때 올바른 작업에 연결되는 회귀 조건을 추가했다. 이 변경 뒤 패키지는 다시 생성하며 위 패키지 검증은 재검증 전까지 이전 후보 결과이다.

앞선 후보의 CMD + Codex 입력 추가 검사는 1/1 통과했다. GitHub GFM 렌더러의 README도 PC·모바일 이미지 6개와 가로 넘침 없음을 확인했다.

경로 보완 뒤 타입 검사·빌드와 실제 Git·호스트·Chrome 워크트리 회귀 **7/7 통과**. `.test-data/release-037-path-regression.log`.
