# Claude 자동 연동과 작업 상태

2026-10-07. **구현·관련 검증 완료, 미배포.** 공개 0.3.15의 BEL/OSC 미확인 알림과 구분한다.

## 구현

- Windows 네이티브 Claude Code 2.1.292 이상을 확인한 실행부에서 사용자 설정에 몽글의 관리 훅을 병합한다. 다른 설정·훅을 유지하고 수정 전 파일을 백업한다. 잘못된 JSON, 훅 비활성화, 심볼릭 링크, 중복 설치 잠금에는 덮어쓰지 않는다.
- 공식 command exec form으로 프로그램과 인수를 따로 전달한다. 훅 입력의 명령이나 경로를 실행하지 않으며 대화·transcript 파일을 읽지 않는다. 상태·세션 구분 해시만 `terminalSequence`의 OSC777로 전달한다.
- 새 몽글 셸마다 임의 토큰을 부여한다. 다른 앱에서는 훅이 아무 출력 없이 종료한다. 라이브 VT 파서에서 토큰과 세션을 검사해 상태를 갱신한다. 저장된 화면의 재생은 상태·알림을 발생시키지 않는다.
- working/completed/attention/error는 Claude의 명시적 훅 이벤트에서만 정한다. 출력 정지, 창 제목, 경과 시간으로 완료를 추정하지 않는다. completed는 성공 보장이 아닌 응답 종료다.
- 상태와 읽음은 별도다. 완료·확인·오류 전환에서 기존 notificationCount를 올리고 화면이 실제로 제시됐을 때만 읽음 처리한다. 세션 교체·셸 프롬프트·호스트 재시작에는 이전 작업 상태를 지운다. 실제 전달된 단독 Esc/Ctrl+C 중단 키에서는 관찰 상태를 초기화하며 완료를 만들어내지 않는다.
- 병렬 도구의 승인 요청은 도구 이름·정규화 입력의 SHA256으로 구분한다. 원문은 전달하지 않는다. 다른 도구의 종료가 아직 대기 중인 요청 표시를 지우지 않는다. 공식 PermissionRequest에는 tool_use_id가 없어 동일 이름·동일 입력 요청은 모두 종료될 때까지 확인 요청을 보수적으로 유지한다.
- 자동 설치는 기존 사용자 훅을 유지하며 앱/ZIP 삭제 후에도 경로가 깨지지 않도록 동봉 Node와 해당 라이선스를 설정 폴더에 보존한다. 다른 터미널에서는 토큰이 없어 즉시 종료한다.

## 참고 자료

- [Claude 훅의 exec form](https://code.claude.com/docs/en/hooks#exec-form-and-shell-form): 셸 문자열 해석 없이 실행 파일과 인수를 전달한다.
- [Claude terminalSequence](https://code.claude.com/docs/en/hooks#emit-terminal-notifications): 공식 훅 출력으로 인터랙티브 터미널에 OSC를 전달한다. 비대화형 실행에서는 전달하지 않는다.
- [Orca 연동 서비스](https://github.com/stablyai/orca/blob/main/src/main/claude/hook-service.ts)와 [기존 설정 병합](https://github.com/stablyai/orca/blob/main/src/main/claude/hook-settings.ts): 기존 훅을 보존하는 관리 항목 설치 구조를 참고했다. 코드를 복사하지 않았다.
- Astra가 Aside로 Mobbin 공개 스크린샷을 직접 확인했다. [Better Stack Incident Dashboard](https://mobbin.com/explore/screens/1e6425c6-9e2f-43b7-a041-cc6ac778be50)의 Ongoing 상태 점과 완료 체크/미완료 원, [Front Status Displayed](https://mobbin.com/explore/screens/b701a2e5-bd01-4443-b9fb-33e4886e28ff)의 Open/Later/Done 아이콘·라벨 배치를 참고한다. 몽글에는 같은 위치의 상태 아이콘과 확인 요청 아이콘과 한글 라벨을 적용하고 색은 보조로 쓴다. 로그인 없는 정적 스크린샷 확인이며 Mobbin 예시의 애니메이션·실제 제품 동작을 시험한 것은 아니다.

## 초기 후보 검증

아래 초기 후보는 완료 체크를 유지하던 UI다. 0.3.16에서는 작업 중 맥동·읽기 전 완료 종·읽은 뒤 표시 해제로 변경하며 최종 검증은 [0.3.16 배포 기록](public-release-0.3.16.md)에 구분한다.

- 최종 타입 검사와 프로덕션 빌드 통과. 상태 UI 자동 회귀 10/10 통과 후, 좁은 사이드바를 아이콘·툴팁으로 조정한 최종 화면/입력 재검사 **24/24 통과**. 모바일 전환 목록은 아이콘과 라벨을 함께 표시한다.
- 엔진·호스트·셸·설치·복원·종료 영향 검사 179개 중 **178 통과·0 실패·1 선택 생략**. 이후 독립 검토의 중단 키·병렬 승인 요청 경계를 보완하고 해당 엔진·설치·실제 ConPTY·입력 큐 검사 **25/25 재통과**. 연속 Esc/Ctrl+C는 큐 병합에서 별도 이벤트 경계를 유지하며 같은 도구 입력의 병렬 실행도 시험한다. 호스트·실제 TerminalPane 입력/제어권 검사 **31/31 통과**. 결과는 중복을 포함하므로 합산하지 않는다.
- Astra가 별도 TEMP 데이터의 실제 Electron 몽글 앱에서 Claude 2.1.292 응답 1회를 실행했다. 실행부의 자동 훅 파일 생성, `working → completed`, notificationCount `0 → 1`을 확인했다. 개인 설정 보호를 위해 생성된 시험 설정을 `--settings`로 전달했으므로 실사용 사용자 설정 파일에 설치한 결과로 표현하지 않는다.
- 독립 Opus 검토에서 찾은 중단 키 병합·동일 입력 병렬 요청을 보완했다. 후속 읽기 전용 검토에서 해당 변경의 추가 중요 결함은 발견하지 못했다.
- 최종 `--dir` 패키지 생성 통과. 동봉 Node 24.21.0의 네이티브 의존성 로딩과 실행 파일 아이콘을 확인했다. Windows 서명·NSIS 설치·공개 배포 검사와 구분한다.
- Astra가 최종 `release-claude-status-final/win-unpacked/MongleTerminal.exe`를 실제 네이티브 화면에서 조작했다. 실제 Claude 2.1.292 응답의 작업 중 아이콘 → 완료 체크, 미확인 테두리 → 터미널 선택 후 테두리 해제·체크 유지, 좁은 사이드바의 아이콘 전용 표시를 확인했다. 렌더러 DOM을 조작하거나 상태를 합성해서 이 결과를 만든 것이 아니다.
- 시험 앱·호스트 정상 종료와 잔류 프로세스 0개를 확인했다. 기존 사용자 앱은 계속 실행 중이며 인증·설정·작업을 변경하지 않았다. 로컬 증거는 `test-results/claude-task-status/`의 `report.json`, `final-working.png`, `final-completed-unread.png`, `final-completed-read.png`, `cleanup-verification.json`, `final-dist-sha256.json`에 보존한다. 개인 경로가 포함된 시험 출력은 저장소에 넣지 않는다.
- 최종 패키지 host `main.cjs` SHA256: `0efa7a2840b68e4f8c874e3bdd70ceefcadd533e0ce70cea47984de870428cb6`; web `index.html`: `4fb4c57eda8074593e6147452b8fa6ae738771423622cee2d7a569ce15aaa72c`.

## 남은 범위

Windows 네이티브 Claude 대화형 실행이 대상이다. WSL·SSH 내부 자동 설치, 비대화형 실행, 모든 CLI 버전·프로젝트 정책, 실물 휴대폰은 검증하지 않았다. Esc 중단·병렬 승인·확인 요청·오류·설정 도움말은 자동 검사로 확인했으며 이번 네이티브 실기에서 각각 조작한 것은 아니다. 실제 CLI 시작과 질문 제출 시 비차단 Python 훅 오류가 함께 나타났으나 출처는 확정하지 않았다. 몽글 훅은 보존 Node로 실행되고 실제 상태 전달은 성공했으며 다른 훅을 수정하지 않았다. 사용자 설치본 교체·새 버전 공개 배포는 하지 않았다.
