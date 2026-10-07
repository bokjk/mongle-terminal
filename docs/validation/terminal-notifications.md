# 터미널 목록의 미확인 알림

<!-- release-0.3.15-finalized -->

0.3.15에 공개했다. [최종 배포 검증](public-release-0.3.15.md#0315-final)을 확인한다. 아래 미배포·설치 미실행 문구와 이전 회귀 결과는 기능 구현 당시의 기록이다.

2026-10-07, 미배포 변경. 공개 0.3.14에는 포함되지 않는다.

0.3.15 배포에 포함한다. 아래 내용은 기능 구현 당시 검사이며, 이후 [실제 CLI 알림 검사](cli-notifications.md)에서 Claude·Codex 자체 신호의 표시·해제까지 확인했다. 최종 배포 상태는 [0.3.15 배포 기록](public-release-0.3.15.md)을 따른다.

## 동작

- 호스트의 실제 VT 파서에서 BEL, OSC 9 텍스트, OSC 777 `notify` 신호를 수집한다. OSC를 끝내는 BEL, 현재 폴더·진행률 등 OSC 9 숫자 명령은 알림으로 세지 않는다. 출력 중단·제목·프로세스 종료를 작업 완료로 추측하지 않는다.
- `TerminalInfo.notificationCount`는 해당 generation의 알림 횟수다. 신호의 제목·본문은 보관하거나 실행하지 않는다. 표시 중이 아닌 세션에서도 호스트가 수집하며 상태 갱신은 기존 화면 배치 주기로 합친다. 신호마다 RPC·디스크 쓰기를 추가하지 않는다.
- `PresentationSnapshot.notificationCount`는 직렬화한 화면에 해당하는 횟수다. 클라이언트가 더 최신 상태 이벤트를 먼저 받아도, 렌더링을 마친 화면의 횟수까지만 확인한다. 복원 기록은 이전 알림을 재생하지 않으며 새 generation은 0부터 시작한다.
- 작업 행·탭·그룹·워크트리·모바일 메뉴에 7px 점과 **확인할 알림** 접근성 설명을 표시한다. 점 자체는 클릭 대상이 아니다. 워크트리 선택은 해당 그룹 안의 미확인 세션을 우선 연다.
- 선택한 터미널의 화면이 보이고 앱에 포커스가 있는 상태를 750ms 유지하면 읽음 처리한다. 숨김·설정창·다른 대화상자·모바일 파일 영역·파일 최대화·편집기 포커스·오프라인은 제외한다. 읽음은 호스트 ID/터미널 ID/generation으로 구분하여 로컬에 저장하고 같은 브라우저의 다른 창과 병합한다.

## 디자인 참고

Astra가 Aside로 Mobbin의 공개 미리보기를 직접 확인했다.

- [WeTransfer 파일 목록](https://mobbin.com/explore/screens/1565217a-a7a9-49ad-892e-cdb841cb75ef): 항목 오른쪽의 작은 점.
- [Peanut 알림 목록](https://mobbin.com/explore/screens/e3c13cb1-f9c7-4917-92af-85cefdf7e7e5): 행마다 일관된 점 위치.
- [Nextdoor](https://mobbin.com/explore/screens/2aeb4bc9-a474-4696-92b6-5f1b3994a0a9): 상단 알림 진입점의 종과 배지.

개별 작업에는 점을 선택하고 기존 테마 색상과 행 선택 동작을 유지했다. 공개 정적 이미지만 확인했으며 참고 앱의 실제 읽음 처리나 접근성 구현을 검증한 것은 아니다.

## CLI와 범위

[Claude 공식 문서](https://code.claude.com/docs/en/terminal-config#get-a-terminal-bell-or-notification)는 기타 터미널에서 `preferredNotifChannel: terminal_bell` 설정을 안내한다. [Codex 알림 구현](https://github.com/openai/codex/blob/main/codex-rs/tui/src/notifications/mod.rs)은 BEL/OSC 9를 사용하고, [설정 스키마](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)의 기본 알림 조건은 `unfocused`다. `always` 조건도 제공한다. CLI가 알림을 끄거나 신호를 내보내지 않으면 점은 생기지 않는다. 완료·승인 대기·일반 벨은 같은 확인 표시이며 성공 여부를 구별하지 않는다. 사용자 CLI 설정·인증은 변경하지 않았다.

## 검증

- 타입 검사와 프로덕션 빌드 통과. 기존 대형 청크 경고는 유지된다.
- 전체 React App/TerminalPane를 사용하는 Chrome 알림 검사 6/6 통과: 비활성 탭, 오래된 화면 도착 경합, 재로드 읽음 보존, generation·호스트 분리, 백그라운드·설정창·오프라인 보존, 분할의 다른 터미널, 워크트리 우선 선택, 320px 모바일 점과 메뉴 간격. 호스트는 시험 더블이며 실제 CLI 실행으로 표현하지 않는다.
- 독립 검토에서 같은 boot·generation으로 재연결할 때 이미 폐기한 pane의 표시 캐시를 다시 쓰는 경우를 찾아 수정했다. pane 생성·해제 시 표시 증거를 지우며 영속 읽음 기록은 유지한다. 백그라운드에서 알림 수신 → 연결 해제 → 새 attach 응답 지연 중 점 유지 → 새 화면 수신 후 해제 회귀가 포함된다.
- 엔진·호스트 신규 11개와 기존 관련 41개, 총 52개 통과. 파서 경계, 부정확한 벨 중복 집계 방지, 신호 폭주 상태 통합, 종료·재시작·복원, 기록 없는 종료 세션의 읽음 가능 횟수까지 검사했다. 호스트 신규 검사는 VT를 엔진 경계에 주입하며 ConPTY 전달 검증과 구별한다.
- 실제 `node-pty`/ConPTY DLL로 격리 Node 프로세스가 출력한 BEL·OSC 9·OSC 777가 모두 수신됨을 별도 확인했다. 사용자 셸이나 CLI 완료 응답을 사용한 검사는 아니다.
- 로컬 전체 회귀 **514개 중 497 통과·1 실패·16 선택 생략**. 실패는 `mobile-keyboard.test.ts`의 시험 호스트가 제어권 복구 후 경고문이 사라지며 발생한 25→29행 resize 요청에 응답하지 않은 경우였다. 진단에서 `pendingResize=true`, 포커스 유지, 편집 가능, 이전 입력 유지가 확인됐다. 응답을 제공하고 새 입력이 해당 ACK 뒤에만 한 번 전달되는지 검사하도록 보완했다. 알림 검사와 함께 최종 재검사 **7/7 통과**. 전체 단일 실행을 실패 없이 마쳤다고 표현하지 않는다. 로그: `.test-data/notifications-regression.log`, `.test-data/notifications-mobile-diagnosis.log`, `.test-data/notifications-final-focused.log`.
- 문서 검사 `scripts/release-check.ts`, 타입·프로덕션 빌드 통과. 설치본 교체·공개 배포는 수행하지 않았다.

## 실제 앱과 남은 범위

Astra가 Aside에서 최종 프로덕션 웹앱(`index-CaRDCztF.js`)과 격리된 실제 HostCore/gateway·cmd 셸을 조작했다. 셸 안의 시험 Node 프로그램이 BEL·OSC 9를 출력하면 호스트의 횟수가 1→2→3으로 증가했다. 비활성 T2의 작업 행·탭·그룹·상단 작업 공간에 점이 나타났고, T2를 선택한 뒤 약 759ms에 사라졌다. 설정창을 띄운 동안 새 알림은 1.2초 뒤에도 유지됐으며 창을 닫고 터미널로 돌아오자 해제됐다. DOM에는 **확인할 알림** 이름·설명과 7px 점이 있었다. 증거는 `test-results/terminal-notifications/actual-app/validation.md`, `browser-observations.json`, `host-final.json`에 남겼다. 실제 조작 뷰포트는 1440×900이다. 시험 탭과 호스트는 정상 종료했고 기록한 시험 PID의 잔여 프로세스가 없음을 `cleanup.json`에서 확인했다.

이는 표준 신호를 출력하는 시험 프로그램의 실제 셸→호스트→앱 통합 검사다. Claude·Codex의 모델 응답 완료가 자동 감지됐다는 증거로 사용하지 않는다. 실물 휴대폰·설치 패키지 교체·공개 배포는 검사하지 않았다. Aside에서 다른 탭을 전면으로 옮겼을 때 원래 페이지의 `document.hasFocus()`/visibility가 변하지 않아 실제 창의 백그라운드 전환 검증은 성립하지 않았다. 숨김 조건의 자동 검사는 이 범위와 구분한다.

CLI가 포커스가 없을 때만 신호를 보내도록 설정돼 있다면, 그룹 전환으로 pane이 해제되기 전에 focus-out이 전달됐는지에 따라 CLI의 판단이 달라질 수 있다. Codex의 `always` 설정은 이 조건과 관계없이 신호를 내보내는 공식 옵션이며 사용자 설정을 자동 변경하지 않았다. 모든 CLI 응답의 자동 완료 알림을 보장하지 않는다.
