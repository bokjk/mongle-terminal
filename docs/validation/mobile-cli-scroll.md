# 실제 CLI 연결의 모바일 터치 스크롤 검증

최초 Aside 합성 DOM 터치 검사와, 사용자가 Chrome 기준을 승인한 뒤 수행한 [Chrome 모바일 trusted touch 추가 검사](#chrome-모바일-trusted-touch-추가-검증)를 구분해 기록한다. 아래 최초 검사에서 미확인으로 적은 Android viewport·trusted touch·모바일 보조키는 마지막 절의 추가 결과를 함께 참고한다.

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
- `a24617b`는 프레임 보존 검사 시작 좌표를 실제 텍스트 위로 옮겼다. 제품 코드는 동일하며 최종 전체 CI 결과는 아래에 기록한다. 위 합성 DOM 터치의 실제 CLI 검사와 CI의 Chrome Android 에뮬레이션을 구분한다.

최종 검사 커밋 `1677690`은 [전체 Windows 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37504040757)에서 회귀 467개 중 **452 통과·실패 0·선택 15 생략**, 별도 네이티브 클립보드·업데이트 브리지 **2/2**, 타입·빌드·배포 문서 검사를 통과했다. 새 trusted touch 3개와 글자 위 시작·프레임 갱신 검사도 통과했다. [실제 NSIS 교체·복원](https://github.com/bokjk/mongle-terminal/actions/runs/37504040812)은 app.asar 및 hostbundle 694개 파일 일치(누락·추가·변경 0)와 작업 자동 복원을 확인했다. 이것은 격리 CI 후보 검사이며 공개 배포 또는 실물 삼성 인터넷 검증이 아니다.

## Chrome 모바일 trusted touch 추가 검증

2026-10-07, gpt-6-astra가 사용자의 “크롬기준으로해줘도돼” 승인에 따라 전용 Chrome 세션에서 추가 검사했다. **실제 Claude·Codex에 연결한 모바일 몽글 UI에서 trusted touch 양방향 스크롤을 확인했다.** 이번 완료 기준은 Chrome 모바일 에뮬레이션이며 삼성 갤럭시·삼성 인터넷 실물 검사는 수행하지 않았다.

### 환경과 관찰 방법

- Playwright CLI의 별도 Chrome 프로필을 사용했다. 실제 브라우저 버전은 `154.0.8037.93`, 모바일 프리셋 UA는 Android 16 / Pixel 10 / Chrome `155.0.8059.12`다. UA와 실행 브라우저 버전은 다르다.
- viewport `360×732`, DPR `3`, `navigator.maxTouchPoints=1`. 몽글 모바일 보조키 UI가 실제 렌더됐다. 최종 제품 웹 번들 `index-c7s--fBY.js` 로드를 확인했다. 제품 코드는 `ec5ac59`와 동일한 수정본이다.
- 새 TEMP `MONGLE_DATA_DIR`, 실제 OwnerPipe 호스트와 loopback 게이트웨이, 표준 기기 연결·승인을 사용했다. 기존 합성 대화를 실제 Claude·Codex 프로세스에서 재개했다. UI/CLI 응답을 모의 구현하거나 새 모델 요청을 보내지 않았다.
- CLI `run-code`에서 CDP `Input.dispatchTouchEvent`로 터미널 글자 영역을 세로로 움직였다. 각 제스처의 touchstart 1개·touchmove 10개·touchend 1개, 총 12개 모두 페이지에서 **`isTrusted: true`**로 관측됐다. DOM `dispatchEvent(new TouchEvent(...))` 방식과 구분된다.
- 페이지의 이벤트·포커스와 원래 전송을 그대로 호출하는 WebSocket 관찰기로 `control.acquire` 및 `terminal.input`을 기록했다. 화면의 합성 행 번호 변화와 실제 호스트 프레임도 대조했다. 두 CLI 모두 alternate 화면과 **ANY/SGR** 모드였다.

### 실제 결과

표의 범위는 화면에 보이는 `LIVE`/`CX-L` 행 머리글 기준이다. 좁은 화면에서는 한 논리 행이 여러 화면 줄로 감긴다.

| 사례 | 시작 → 종료 | 입력·포커스 관측 |
| --- | --- | --- |
| Claude 보기 전용 첫 pan | `LIVE-263~300` → `LIVE-292~300` | 제어권 획득, `38열×26행` 크기 요청. SGR wheel 0개, `BODY` 유지 |
| Claude 이전 대화 방향 | `LIVE-292~300` → `LIVE-276~284` | SGR wheel 10개, `BODY` 유지 |
| Claude 최신 대화 방향 | `LIVE-276~284` → `LIVE-292~300` | SGR wheel 10개, `BODY` 유지 |
| Codex 보기 전용 첫 pan | `CX-L-265~300` → `CX-L-296~300` | 제어권 획득, `38열×26행` 크기 요청. SGR wheel 0개, 기존 `BUTTON` 포커스 유지 |
| Codex 이전 대화 방향 | `CX-L-296~300` → `CX-L-286~291` | SGR wheel 10개, 기존 `BUTTON` 포커스 유지 |
| Codex 최신 대화 방향 | `CX-L-286~291` → `CX-L-296~300` | SGR wheel 10개, 기존 `BUTTON` 포커스 유지 |
| Codex 모바일 Ctrl·Alt 모두 ON, 이전 방향 | `CX-L-296~300` → `CX-L-286~291` | SGR wheel 10개, 바이트 변형 없음 |
| Codex 모바일 Ctrl·Alt 모두 ON, 최신 방향 | `CX-L-286~291` → `CX-L-296~300` | SGR wheel 10개, 바이트 변형 없음 |

첫 pan 두 건에서 관측한 `terminal.input`은 focus-out 시퀀스 `ESC [ O` 한 개씩이며 SGR wheel은 없었다. 첫 화면 범위 변화는 제어권 획득에 따른 크기 변경이므로 스크롤 성공으로 세지 않았다. 크기가 안정된 다음 pan부터 양방향 이동을 확인했다. 최종 호스트 크기는 자동 맞춤 후 `39열×26행`이었다. 따라서 최초 접속의 첫 pan에서 크기가 바뀌면 다음 swipe가 필요할 수 있다는 실제 동작도 확인했다.

보조키는 실제 모바일 Ctrl·Alt 버튼을 클릭하고 둘 다 `[pressed]`인 snapshot을 보존했다. 이 상태의 두 Codex pan에서 전송된 20개 입력 모두 `ESC [ < 64/65 ; 열 ; 행 M` 형태의 표준 SGR wheel이었다. 추가 Alt ESC 접두사나 Ctrl 변형이 없었다. Claude의 보조키 ON 조합까지 추가 검사한 것은 아니다.

모든 8개 제스처에서 `focusin` 발생 0개였으며 input/textarea로 포커스가 이동하지 않았다. Claude는 `BODY`, Codex는 터미널 전환·보조키 조작 후의 `BUTTON`에 머물렀다. `.xterm-screen`의 `touch-action: pinch-zoom`도 유지됐다. 이는 브라우저 포커스와 CSS 관측이며 실물 OS 키보드나 pinch 동작 검증을 뜻하지 않는다.

### 추가 검사의 한계와 증거

실물 휴대폰의 손가락·관성·OS 키보드·삼성 인터넷·휴대폰 네트워크는 검사하지 않았다. 모든 재접속/승인 경합, RIS·이전 프레임 폐기, 미지원 mouse mode NONE, normal buffer의 보기 전용 history는 이번 실제 CLI Chrome 검사에 추가하지 않았다. 첫 크기 변경 중 wheel 미전송 관측과 해당 조건의 전체 자동 회귀 검증은 구분한다.

무시된 `output/playwright/chrome-mobile-cli/`에 다음 원본 관찰 결과를 보존했다.

- `chrome-meta.json`: 실제 Chrome 버전, 모바일 프리셋 UA·viewport·최종 웹 번들
- `claude-first-pan.json`, `claude-older.json`, `claude-newer.json`
- `codex-first-pan.json`, `codex-older.json`, `codex-newer.json`
- `modifiers-on.txt`, `codex-modifiers-older.json`, `codex-modifiers-newer.json`
- `.playwright-cli/`의 모바일 화면 snapshot 및 초기 실제 viewport screenshot

실제 호스트 프레임은 `.test-data/chrome-claude-frame.json`, `.test-data/chrome-codex-before-frame.json`, `.test-data/chrome-codex-final-frame.json`에 보존했다. 계측 준비 파일은 `.test-data/chrome-mobile-*.js`이며 제품 코드에 포함하지 않았다.

### 추가 검사 정리 완료

전용 Chrome 세션을 닫고 시험 앱·OwnerPipe 호스트를 정상 종료했다. 이번 시험 실행 파일·TEMP 프로필·두 합성 CLI 세션의 남은 프로세스가 0개이며 전용 Chrome 세션 프로세스도 종료됐음을 확인했다. 시험 unpacked의 web index와 host main을 기존 `native-original-index.html`, `native-original-host-main.cjs`로 복원하고 각각 SHA-256 일치를 확인했다. 기존 백업은 덮어쓰지 않았다.

설치 사용자 앱·실사용 세션·인증·Serve·전역 설정을 변경하지 않았다. 제품 코드 수정·커밋·push·배포 없이 추가 검증과 이 문서 기록을 완료했다.
