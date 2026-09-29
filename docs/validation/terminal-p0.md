# 터미널 상태 어댑터 P0 검증

검증일: 2026-09-29. Node v24.18.0, Windows, `@xterm/headless`/`@xterm/xterm` 6.0.0, `@xterm/addon-serialize` 0.14.0 고정.

## 결정과 구현 범위

호스트 `TerminalEngine` 하나만 PTY의 원시 출력을 소비하고 DSR/DA/DCS 응답을 작성한다. 클라이언트는 **완결된 presentation frame만 받으며 원시 PTY 후속 데이터를 섞지 않는다.** 따라서 접속 순간 CSI, OSC, DCS, UTF-8 문자열이 중간에서 끊어져 있어도 호스트 내부 파서가 나머지를 계속 처리한다. serializer를 완전한 프로세스/파서 체크포인트로 취급하지 않는다.

- `packages/terminal/engine.ts`: 순서 있는 write/resize/snapshot 큐, 라이브 화면 직렬화, 최근 출력 상한, 호스트 색/문자 크기 질의 응답.
- `packages/terminal/browser.ts`: 완전한 화면 적용, 적용 완료 fence, 입력/관찰 상태, 붙여넣기/보조키, 조합 중 화면 교체 지연, 현재 프레임 하나와 최신 대기 프레임 하나로 제한.
- `packages/terminal/pinned-xterm.ts`: 버전 의존적인 private API 사용을 한곳에 격리. 지원하지 않는 내부 모양이면 입력을 켜지 않는다.

`snapshot()`은 Promise를 반환한다. 이전 write/resize가 실제 처리된 뒤 생성한다. 선택 사항 `maxBytes`는 JSON UTF-8 크기 기준이며 기본 1.5 MiB다. 초과하면 오래된 스크롤백만 줄여 `historyTruncated`와 `historyLinesIncluded`를 알린다. 호스트의 라이브 기록과 현재 화면은 지우지 않는다. 현재 화면만으로도 예산을 넘으면 전체 화면에 `oversized: true`를 붙여 반환하며, 전송 계층이 별도 hard limit을 다뤄야 한다. 화면 셀을 잘라 정상 프레임으로 내보내지 않는다.

`clearHistory()`는 스크롤백만 지운다. 공개 `xterm.clear()`는 커서행 이외의 현재 화면을 지우므로 사용하지 않았다. 직접 trim할 때도 대기 중 VT 파서와 현재 화면/커서를 유지한다.

## 입력과 자동 응답

공개 `onData`만으로 자동 응답과 사용자 입력을 구분할 수 없다. 고정한 6.0.0의 `CoreService.triggerDataEvent(data, wasUserInput)` 경계에서 **사용자 입력만 렌더러 외부로 통과**시킨다. 데이터 문자열 패턴으로 응답을 추측하지 않는다. 화면 적용 중에는 `disableStdin`을 켜지 않아 비동기 쓰기 사이의 키를 버리지 않는다. `disableStdin`은 제어권 유무에만 따른다.

기본/X10 마우스는 `onBinary` 및 `encoding: 'binary'`로 구분하고, SGR 마우스는 UTF-8 데이터로 전달한다. 포커스 이벤트는 실제 textarea focus/blur에 따라 명시적으로 전송한다. 모바일 보조 방향키는 `sendKey()`를 사용해 application cursor mode를 따른다.

프레임 적용은 입력 mode를 동기적으로 먼저 맞춘다. origin/scroll region 등 호스트 파서 상태를 클라이언트에 강제로 복원하지 않는다. 클라이언트는 후속 raw VT를 파싱하지 않으므로 화면 표시와 키 인코딩에 필요한 상태만 받는다.

IME composition 중에는 이전 그림을 유지하며 최신 프레임 하나만 기다린다. `compositionend` 직후에는 xterm의 0ms 지연 commit이 끝난 다음 프레임 교체를 재개한다. 제어권 해제 시 조합 중 입력은 자동 전송하지 않는다.

## 실제 수행한 검증

명령:

```powershell
node --import tsx --test tests/terminal/*.test.ts
npx tsc --noEmit --pretty false
node --import tsx tests/terminal/benchmark.ts
```

자동 검증: **17개 테스트 통과**, 실패/건너뜀 없음. 개별 테스트 내부의 모든 바이트 분할 위치 반복을 포함한다.

| 범위 | 결과 |
|---|---|
| CSI/truecolor, OSC title, DCS 상태 질의, 한글/emoji/결합 문자 UTF-8 | 모든 바이트 경계에 중간 프레임을 끼운 뒤 화면·셀색·폭·커서 비교 통과 |
| alternate screen, origin/scroll region, cursor/style, normal 화면 복귀 | 호스트와 렌더러 상태 비교 통과 |
| DSR/DA/DCS/색상/문자 크기 질의 | 호스트 응답만 발생, 반복 프레임 및 클라이언트에 직접 넣은 질의에서도 렌더러 응답 누출 없음 |
| 비동기 프레임 중 타이핑·Ctrl-C·bracketed paste·SGR 및 binary mouse | 입력 보존, mode/encoding 유지, 관찰 입력 차단 통과 |
| write/resize/snapshot 경쟁, 기록 지우기 | fence 순서, 모든 현재행 보존, 미완료 CSI 이어받기 통과 |
| 3,000행 truecolor 출력 | 1.5 MiB 내 스크롤백 축소, 현재 화면 보존, 호스트 기록·파서 무변경 통과 |
| 현재 화면이 byte 예산 초과 | `oversized` 명시, 화면 셀 전체 보존 통과 |
| IME 앞 1,000개 프레임 | 최신 한 개 대기 슬롯과 공통 완료 Promise 사용, 최신 화면 적용 전 ACK 완료 없음 |
| 실제 Chrome의 DOM/키 입력 | 5ms 간격 프레임 중 모든 입력 글자, application ArrowUp, Ctrl-C, 한글 `insertText`, 선택 유지, 합성 compositionend 지연 commit 통과 |

Chrome 검사는 설치된 Chrome을 Playwright 전용 headless 프로필로 실행한다. 사용자 프로필이나 로그인 세션을 열지 않는다. Chrome이 없는 다른 환경에서는 이 하나의 검사가 이유를 표시하며 건너뛴다.

검증 중 발견·수정한 결함:

1. SerializeAddon이 normal 화면 끝에 active rendition을 복원한 채 alternate 화면에 진입해, 손대지 않은 alternate 셀까지 배경색이 칠해졌다. canonical 진입 경계에서 SGR을 초기화하고 회귀 검증했다.
2. xterm의 창 질의 handler에는 별도 `windowOptions` 허용이 필요했다. 문자 geometry 질의만 허용하고 host가 한 번 답한다.
3. 비동기 frame 중 stdin 차단과 IME commit 이전 reset이 입력 유실을 만들 수 있었다. provenance 경계 및 composition 완료 순서로 해결했다.

## 측정치와 한계

동일 PC에서 100열×30행, 고정된 한글/ASCII 샘플, 8회 snapshot 측정값이다. 네트워크·브라우저 전체 지연이나 성능 보장이 아니다.

| 출력 행 수 | 프레임 bytes | 중앙값 ms | 최댓값 ms |
|---:|---:|---:|---:|
| 100 | 9,338 | 1.34 | 6.47 |
| 1,000 | 89,439 | 6.29 | 6.90 |
| 5,000 | 449,440 | 24.56 | 38.96 |

재현 스크립트가 현재 코드를 다시 측정한다. 반복 full frame은 delta 방식보다 비용이 크다. 호스트는 프레임 주기를 제한하고, 연결별 한 장의 미확인 프레임과 최신 대기 프레임만 유지해야 한다.

선택 영역과 스크롤 위치는 가능한 범위에서 보존한다. 기록 축소/재배치로 선택 좌표 아래 문자열이 달라지면 선택을 해제한다. exact line identity를 사용하는 mux 수준의 스크롤 보존은 제공하지 않는다. 검색 장식은 클라이언트 검색 addon의 수명 정책에 따른다.

호스트 테마 질의는 고정된 색을 답한다. 동적인 앱 전체 palette 변경, OSC 52 clipboard, Sixel/Kitty 이미지, 모든 확장 키보드 프로토콜을 지원한다고 주장하지 않는다. OSC 52는 호스트에서 소비하며 브라우저 클립보드를 변경하지 않는다. 서버/클라이언트는 기본 xterm Unicode 폭 제공자를 동일하게 사용한다.

아직 이 P0만으로 확인하지 않은 것: Windows 실제 OS 한글 IME의 모든 조합 순서, Android/iOS 실기 키보드, 다양한 TUI 전체 호환성, 60분 WAN 연결, 패키지 프로세스 생존. 해당 검증은 통합/배포 검증 문서에서 따로 다룬다.

## 근거

- 설치된 npm 패키지의 정확한 버전 및 integrity: 프로젝트 `package-lock.json`.
- 실제 검사한 소스: 배포물 `node_modules/@xterm/headless/lib-headless/xterm-headless.js.map`, `node_modules/@xterm/xterm/lib/xterm.js.map`의 CoreService, CoreMouseService, InputHandler, CompositionHelper, Clipboard, ParserApi.
- [xterm.js 6.0.0 CoreService](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/common/services/CoreService.ts), [SerializeAddon](https://github.com/xtermjs/xterm.js/blob/6.0.0/addons/addon-serialize/src/SerializeAddon.ts), [MIT 라이선스](https://github.com/xtermjs/xterm.js/blob/6.0.0/LICENSE).

소스의 기능 존재와 실행 검증을 구분한다. 위 표는 이 프로젝트의 실제 테스트 결과이고, 이 문서 밖의 모든 터미널 조합까지 검증했다는 뜻이 아니다.
