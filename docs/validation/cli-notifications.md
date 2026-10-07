# 실제 Claude·Codex CLI 알림 검증

2026-10-07, Astra가 Aside MCP repl로 격리 몽글터미널 웹 앱을 직접 조작했다. 세션 한정 알림 설정에서 **실제 모델 응답 → CLI 자체 알림 신호 → 비활성 목록·탭·그룹 점 → 선택 후 읽음 해제**를 두 CLI 모두 확인했다. Claude의 신호는 응답 직후가 아닌 유휴 지연 뒤에 도착했다.

## 환경과 방법

- 설치 버전: Claude Code **2.1.292**, Codex CLI **0.160.0**. 실행 파일의 로컬 version/help로 확인.
- 실제 로드한 제품 번들: **index-CaRDCztF.js**, Aside viewport 1440×900.
- 새 격리 데이터의 HostCore, 정상 loopback 게이트웨이·기기 페어링, 실제 cmd/ConPTY 셸을 사용했다. 관찰용 탭과 Claude/Codex 탭을 같은 그룹에 두었다.
- 각 CLI에 도구를 쓰지 말고 CLAUDE-NOTIFY-OK 또는 CODEX-NOTIFY-OK만 답하라는 요청을 **한 번씩** 보냈다. 화면에 각 답변과 완료 표시를 확인했다. 추가 모델 요청은 보내지 않았다.
- 실제 CLI의 stdout을 받는 PTY에 읽기 전용 VT 관측기를 연결했다. 알림 종류·시각만 기록하고 OSC 본문은 보존하지 않았다. 신호를 직접 출력하거나 UI 알림 상태를 변경하지 않았다.
- UI는 snapshot과 실제 탭 클릭으로 검사했고 DOM MutationObserver로 점 표시·해제 시각을 보조 기록했다. 캔버스 응답 텍스트는 실제 호스트 presentation snapshot을 읽기 전용으로 복원해 확인했다. 스크린샷은 저장하지 않았다.

## 세션 설정

Claude는 시험 폴더의 JSON에 {"preferredNotifChannel":"terminal_bell"}만 작성하고 --settings <시험 JSON>으로 전달했다. --safe-mode --tools "" --no-chrome --strict-mcp-config --mcp-config <빈 MCP JSON> --session-id <새 UUID> --effort low를 사용했다. 자동 업데이트를 이 프로세스에서만 비활성화했다. 기존 인증은 CLI의 정상 경로로 사용했으며 인증 파일을 읽어 출력하거나 복사하지 않았다.

Codex는 다음 옵션을 이 실행에만 적용했다.

    codex.cmd --no-daemon --sandbox read-only --ask-for-approval never -c tui.notifications=true -c tui.notification_method=osc9 -c tui.notification_condition=always -c check_for_update_on_startup=false -c history.persistence=none "<시험 요청>"

두 CLI 모두 별도 로그인 없이 응답했다. 사용자 전역 설정·인증을 편집하지 않았고, 기존 세션을 재개하지 않았다. 기본 모델 선택을 유지했다. 화면상 Claude는 Opus 5.5 low, Codex는 GPT-6-Astra ultra였다.

## 결과

| CLI | 실제 응답·신호 | 비활성 점 | 선택 후 해제 |
|---|---|---|---|
| Claude 2.1.292 | CLAUDE-NOTIFY-OK와 완료 표시. CLI 시작 후 약63.2초에 **BEL 1회**, host notificationCount 0→1 | Codex 탭을 보고 있을 때 Claude 목록 오른쪽·탭·그룹·상단 작업 공간에 점4개 | 선택 변화 이후 약766ms에 점0개; 1.1초 후에도0개 |
| Codex 0.160.0 | CODEX-NOTIFY-OK와 완료 표시. **OSC9 1회**, host notificationCount 0→1 | 관찰용 탭을 보고 있을 때 Codex 목록 오른쪽·탭·그룹·상단 작업 공간에 점4개 | 선택 변화 이후 약769ms에 점0개; 1.1초 후에도0개 |

관측 시각은 다음과 같다. 지연은 관측값이며 타이머 정밀도 보장이 아니다.

| 사건 | Unix milliseconds |
|---|---:|
| Claude 실행 요청 | 1791355364849 |
| Codex 실행 요청 | 1791355374036 |
| Codex OSC9 수신 | 1791355384527 |
| Codex 점 표시 | 1791355384575 |
| Codex 선택 / 점 해제 | 1791355420654 / 1791355421423 |
| Claude BEL 수신 | 1791355428062 |
| Claude 점 표시 | 1791355428152 |
| Claude 선택 / 점 해제 | 1791355455110 / 1791355455876 |

## 판정 범위와 한계

- **지정한 세션 설정에서 통과**했다. Claude의 기본 auto, Codex의 기본 unfocused 조건은 이번에 별도 실행하지 않았다. 기본 설정으로 모든 터미널에서 항상 점이 뜬다는 결론이 아니다.
- Claude는 짧은 응답을 마친 뒤 유휴 지연을 거쳐 알림을 보냈다. 응답 완료의 정확한 시각을 별도로 계측하지 않았으므로 “완료 정확히60초 후”라고 단정하지 않는다. 즉시 완료 알림으로 안내하면 안 된다.
- 몽글의 점은 CLI가 보낸 알림 신호 표시다. 성공·실패·승인 대기·유휴 알림을 구별하는 작업 완료 판정이 아니다.
- 이번 범위는 Windows 실제 CLI + 제품 웹 UI다. Electron 앱의 OS blur, 휴대폰/PWA, 재부팅·재연결, 다른 CLI 버전이나 알림 설정은 이 결과로 검증했다고 보지 않는다.
- 실제 신호 종류를 확인한 뒤 정상 UI 표시·해제를 검사했으며, 기존 표준 escape fixture 시험을 실제 CLI 시험으로 대체 표기하지 않았다.

## 증거와 정리

커밋 제외 시험 자료는 test-results/terminal-notifications/actual-cli/에 있다.

- claude-response.json, codex-response.json: 실제 응답과 완료 표시, 모드·호스트 알림 카운트.
- host-final.json: 실제 CLI 실행 시각, BEL/OSC9 관측과 terminal generation·PID·notificationCount.
- browser-observations.json: 최종 번들, 비활성 점 표시, 선택·해제, focus/visibility 기록.
- processes-before-cleanup.json, cleanup.json: 시험 프로세스 목록과 종료 검증.

Claude는 /exit 후 cmd 프롬프트 복귀를 확인했다. Codex는 /exit 문자열이 입력란에 남아 자체 종료가 확인되지 않았으므로, 두 CLI 모두 자체 종료됐다고 기록하지 않는다. 이후 시험 HostCore의 정상 shutdown으로 게이트웨이·셸·자식 프로세스를 정리했다. 호스트 exit code0, 시험 탭0개, 기록한 시험 프로세스26개 모두 잔여0개를 확인했다. 사용자 기존 호스트·셸·설정·인증·Tailscale Serve는 변경하지 않았다.
