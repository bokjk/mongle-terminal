# PDF 제보: 붙여넣기 포커스와 Git Bash 파일 경로

2026-10-07. 미배포. 첨부 PDF 4쪽을 텍스트 추출과 페이지 이미지로 확인했다. 제보 원문과 개인 경로가 보이는 첨부 이미지는 저장소에 넣지 않는다.

## 재현과 수정

1. 여러 줄 붙여넣기 확인창은 공통 모달의 첫 포커스 가능 요소인 닫기 버튼을 선택했다. 수정 전 실제 React App 검사에서 붙여넣기 버튼 `toBeFocused`가 실패했다. 붙여넣기 확인에만 명시적 초기 포커스를 지정했다. 종료·삭제 확인의 기본 포커스는 바꾸지 않는다.
2. Git Bash의 `$PWD`는 MSYS 경로다. Windows 호스트가 `/c/...` 또는 `/tmp/...`를 그대로 파일 API에 넘기면서 다른 위치로 해석했다. 기존 실제 셸 검사는 Bash에만 `realpath` 비교를 생략하고 있었다. 생략을 제거한 수정 전 검사에서 `ENOENT`로 재현됐다.
3. Bash 프롬프트가 `pwd -W`로 Windows 경로를 보고하고, 이를 지원하지 않는 Unix Bash는 `pwd`로 대체한다. 드라이브 문자만 치환하지 않으므로 `/tmp` 등 마운트도 셸이 해석한다. 프로필 파일·현재 작업·파일 읽기 접근 제한은 변경하지 않는다. 새 셸부터 적용한다.

## UI 참고

Astra가 Aside에서 [v0 Confirmation Modal](https://mobbin.com/explore/screens/ada15519-9196-412f-8ce5-895f52f88bc0)의 하단 오른쪽 주요 동작과 왼쪽 취소 버튼, [Krea AI 확인창](https://mobbin.com/explore/screens/b847ca06-8ac8-4c1c-aa7f-b459f9efd24b)의 결과 설명·동작 구분을 직접 확인했다. 기존 미리보기·붙여넣기/취소 배치를 유지한다. 정적 이미지로 키보드 포커스를 검증한 것이 아니며, 붙여넣기 최초 포커스는 사용자 요구에 따른 판단이다.

## 검사

- 실제 PowerShell 7·Windows PowerShell·CMD·Git Bash: 시작 경로와 한글·공백 폴더 이동, 파일 목록·미리보기·Git 상태 RPC를 포함한 현재 경로 검사 **6/6 통과**.
- 셸 프로필·파일 보호·Claude 상태 영향 검사 **17/17 통과**.
- 붙여넣기 초기 포커스·Enter 승인·Esc/취소·Tab 순환과 제어권 회귀 **13/13 통과**. 취소에서 제어권 획득·터미널 입력 0, 승인에서 한 번 전달을 확인했다.
- 타입 검사·빌드·문서 검사·디렉터리 패키징 통과. 독립 Opus 읽기 전용 검토에서 두 수정의 중요한 신규 결함은 발견하지 못했다.
- Astra가 `release-pdf-bugs/win-unpacked/MongleTerminal.exe`의 실제 네이티브 창에서 Git Bash 시작 폴더 목록·파일 열기, 한글·공백 폴더 `cd` 뒤 목록·미리보기·Git 표시를 확인했다. 실제 클립보드의 무해한 두 줄 텍스트로 확인창을 열고, Enter만 눌러 한 번 붙여넣기, Esc/취소에서 입력하지 않음을 확인했다. 실제 셸에서는 bracketed paste로 삽입된 내용을 시험 후 취소했으며, 명령 실행 성공을 주장하는 검사가 아니다.
- 실기 증거는 개인 경로를 포함하므로 커밋하지 않는 `test-results/pdf-bugs/`에 보존한다. `gitbash-initial-file-list.png`, `gitbash-child-preview.png`, `gitbash-child-git.png`, `paste-initial-focus.png`, `paste-enter-frame.json`, `paste-esc-result.json` 등이다.
- 실기 후 클립보드를 복원하고 시험 앱·호스트를 정상 종료했다. 잔류 프로세스 0개이며 기존 사용자 앱은 유지했다. `report.json`, `clipboard-restoration.json`, `cleanup-verification.json`에 결과를 기록했다.
- 최종 패키지 host `main.cjs` SHA256: `fdd8df7b82f7c749625a10a97e5f1db17ac8aec9cb2d5059b7917a624318df56`; web `index.html`: `6b6c229ebac8ba5770be9c6a7f03cd51473eeca3624f88f5b853f4ffdc2a4b03`.
- 사용자 설치본 교체·공개 배포는 하지 않았다. 개인 셸 초기화 파일이 프롬프트 훅을 덮어쓰는 모든 환경과 실물 모바일은 이번 검증 범위가 아니다.
