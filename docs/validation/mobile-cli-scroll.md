# 실제 CLI 연결의 합성 DOM 터치 스크롤 검증

검사일: 2026-10-07. 담당: gpt-6-astra. 최종 웹 번들: `index-c7s--fBY.js`(Aside 페이지가 실제 로드한 script URL 확인). 문서 작성 시 HEAD: `ec5ac59`.

## 확인 범위

**실제 Claude와 Codex 프로세스에 연결된 몽글 웹 UI에서 양방향 스크롤을 확인했다.** 단, 입력은 Aside의 DOM `TouchEvent`이며 `isTrusted: false`다. 사용자 기기인 **삼성 갤럭시·삼성 인터넷 실물폰 검증은 수행하지 않았다. Android 기기 에뮬레이션도 아니다.**

Aside의 공개 REPL에서 `page.touchscreen`, `page.setViewportSize`, `page.context`, `page.emulateMedia`는 제공되지 않았다. 따라서 `context().newCDPSession()`을 통한 trusted touch/Android viewport 설정도 사용할 수 없었다. 별도 Chrome·Playwright 실행으로 우회하지 않았다. 실제 viewport 폭은 1440px였다.

시험은 새 TEMP `MONGLE_DATA_DIR` 두 개(수정 전/수정 후)에서 진행했다. 실제 OwnerPipe 호스트, 표준 기기 연결 코드·승인, loopback 웹 게이트웨이, 실제 설치된 Claude/Codex CLI를 사용했다. 인증 검사를 완화하거나 UI/CLI 응답을 모의 구현하지 않았다. 이전에 만든 합성 LIVE/CX-L 대화만 재개했고 새 모델 요청은 제출하지 않았다. Codex 0.160.0의 업데이트 안내는 Escape로 이번 실행만 건너뛰었으며 설치·전역 설정 변경은 하지 않았다.

## 수정 전

Claude는 alternate 화면이며 mouse tracking `any`, encoding `SGR`였다. 보기 전용에서 합성 세로 터치를 보낸 뒤에도 다음 상태가 유지됐다.

- 표시 범위: `LIVE-263~300`, 전체 렌더링 텍스트 변경 없음
- 호스트 controller 없음, UI `화면을 눌러 입력`
- `document.activeElement`는 `BODY`
- `.xterm-screen`의 `touch-action`은 `pinch-zoom`

이것은 수정 전 실제 UI→실제 CLI 경로의 무반응 관측이다. 물리적인 삼성 터치 이벤트 자체를 재현했다는 뜻은 아니다.

## 최종 수정본

최종 번들을 시험 unpacked 앱의 web 경로에 복사하고 해당 Aside 시험 탭을 새로고침했다. Claude와 Codex의 실제 호스트 프레임에서 둘 다 **alternate + ANY/SGR**를 확인했다. Codex는 업데이트 안내를 벗어나 CX-L 합성 대화가 표시된 상태에서 다시 모드를 확인했다. 따라서 두 CLI 모두 이번 수정의 표준 wheel 전달 경로를 사용했다.

| 사례 | 실제 결과 |
| --- | --- |
| 보기 전용 첫 세로 pan: Claude | 호스트 controller가 시험 브라우저로 바뀌고 `여기서 제어 중` 표시. 편집 입력 포커스 없음 |
| 보기 전용 첫 세로 pan: Codex | 동일하게 정상 제어권 획득. 편집 입력 포커스 없음 |
| Claude 이전 대화 방향 | `LIVE-230~268` → `LIVE-217~255` |
| Claude 최신 대화 방향 | `LIVE-217~255` → `LIVE-238~276` |
| Codex 이전 대화 방향 | `CX-L-265~300` → `CX-L-232~269` |
| Codex 최신 대화 방향 | `CX-L-232~269` → `CX-L-265~300` |
| 보기 전용으로 재접속 후 취소 불가(`cancelable:false`) Claude 터치 | controller 없음 유지, `LIVE-238~276` 및 전체 렌더 텍스트 변경 없음 |
| 스크롤 중 포커스 | 두 CLI 모두 `BODY`, input/textarea 포커스 없음 |
| CSS | `touch-action: pinch-zoom` 유지 |

위쪽/아래쪽은 대화의 이동 방향이다. 손가락이 아래로 이동하면 이전 대화, 위로 이동하면 최신 대화가 보였다. 각 동작 후 별도 조회로 실제 출력 반영을 기다려 읽었으며, 입력 직후의 순간적인 화면을 최종 결과로 쓰지 않았다.

DOM 화면만 움직인 것으로 판단하지 않도록 OwnerPipe에서 실제 호스트 스냅샷도 보존했다. 양방향 사이 Claude seq는 28→30, Codex는 81→83으로 증가했고 각각 snapshot data가 달랐다. 최종 프레임에서도 ANY/SGR와 alternate 화면이 유지됐다.

## 첫 제어권·크기 변경에 대한 해석

보기 전용의 세로 pan으로 제어권을 요청한 뒤, 호스트 크기가 분할 UI에 맞춰 75열로 바뀌는 것을 확인했다. 같은 제스처의 후속 move는 승인 후에 보냈다. 렌더 반영은 비동기이므로 직후 캡처가 그대로라는 이유로 해당 제스처 전체가 취소됐다고 판정하지 않는다. 위 양방향 비교 표의 시작 값은 제어권 획득과 렌더링이 안정된 뒤의 값이다.

이번 직접 검사로는 승인 전 이동이 나중에 재생되지 않는 모든 경합, 이전 frame/RIS/모드 전환 시 gesture 폐기를 독립적으로 증명하지 않았다. 해당 자동 회귀 검사와 이 실제 CLI 연결 검사는 구분해야 한다.

## 직접 확인하지 않은 범위

- 삼성 갤럭시·삼성 인터넷의 실제 손가락 입력, 관성, pinch 확대, OS 키보드 표시/숨김. `BODY` 포커스만으로 휴대폰 키보드 미표시를 실기 통과로 표현하지 않는다.
- Android 모바일 viewport·trusted touch. 현재 Aside API에서는 지원되지 않았다.
- 모바일 보조 Alt/Ctrl 토글 ON 상태. 이번 desktop viewport에는 Alt 버튼이 렌더되지 않았다(`Alt` 버튼 0개). 실제 UI 상태를 조작하거나 mobile 판정을 덮어써서 검증하지 않았다.
- alternate + mouse mode NONE에서의 무입력, normal buffer의 보기 전용 로컬 history, 이전 frame 폐기, 장기 누름 context menu 취소는 이번 실제 CLI 검사에 포함하지 않았다.
- Tailscale Serve, 휴대폰의 실제 네트워크, 재접속 중 모든 경합.

## 증거와 정리

무시된 `.test-data`에 아래 실제 호스트 프레임을 보존했다.

- `mobile-claude-before.json`: 수정 전 Claude
- `mobile-fixed-claude-before.json`, `mobile-fixed-claude-up.json`: 중간 빌드 관측(최종 통과 근거와 구분)
- `mobile-codex-ready.json`: 업데이트 안내를 벗어난 실제 Codex의 모드·합성 대화
- `mobile-final-claude-up.json`, `mobile-final-claude-down.json`
- `mobile-final-codex-up.json`, `mobile-final-codex-down.json`

이번 담당자가 만든 Aside loopback 시험 탭만 닫았다. 수정 전/수정 후 시험 앱·호스트를 각각 정상 종료했고 해당 시험 실행 파일과 TEMP 프로필의 앱/호스트 프로세스가 남지 않았음을 확인했다. 시험용 web index와 host main을 기존 백업으로 복원했으며 SHA-256이 각각 일치했다. 백업은 덮어쓰지 않았다. 해시 이름 web assets는 무시된 시험 디렉터리에만 남는다.

설치 사용자 앱, 실사용 세션·인증, 전역 설정, 실제 Serve를 변경하지 않았다. 이 담당자는 제품 코드·기존 테스트를 수정하지 않았고 커밋·push·배포하지 않았다. 시험 준비 파일과 이 검증 문서만 작성했다.

## 자동 검사와 리뷰

- 제품 코드 `ec5ac59`의 타입 검사·빌드와 Node 터치/레이아웃 27개 검사를 통과했다. Opus 최종 코드 재검토에서 남은 중요 결함은 발견하지 못했다.
- 같은 커밋의 [실제 NSIS 설치·교체·복원 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37502851371)는 통과했다.
- 같은 커밋의 전체 회귀는 후속 커밋으로 취소됐다. 취소 전 새 trusted touch 3개(휠 인코딩, 미지원 모드 무입력, 프레임 보존·실제 경계 취소)는 통과했지만 전체 회귀 완료로 세지 않는다.
- `a24617b`는 프레임 보존 검사 시작 좌표를 실제 텍스트 위로 옮겼다. 제품 코드는 동일하며, 최종 전체 CI 결과는 PR #44 Checks에서 확인한다. 위 합성 DOM 터치의 실제 CLI 검사와 CI의 Chrome Android 에뮬레이션을 구분한다.
