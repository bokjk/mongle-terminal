# 몽글터미널 — 구현 순서와 검증 기준

작성일: 2026-09-29 · 상태: 실행 가능한 구현 계획, 아래 실험/테스트는 아직 수행하지 않음

## 1. 진행 원칙

전체 GUI를 먼저 만든 뒤 세션 유지 가능성을 확인하지 않는다. 가장 실패 비용이 큰 **Windows 독립 실행·상태 복원·모바일 연결**부터 작은 실제 동작으로 확인한다. 단계별 완료 조건을 통과한 뒤 다음 의존 작업을 진행한다. 모바일은 후순위 제품이 아니라 첫 버전의 필수 검증 대상이다.

이 문서는 구현 전에 작성한 설계와 수용 테스트 계획이다. 현재 코드는 저장소에 구현되어 있고, 실제 실행 증거는 [구현·검증 상태](IMPLEMENTATION-STATUS.md)와 docs/validation에 별도 기록한다. 아래 테스트 표는 계획이며 표의 존재가 통과를 뜻하지 않는다.

## 2. 단계별 작업

| 단계 | 작업과 산출물 | 선행조건/완료 기준 |
|---|---|---|
| P0 기술 검증 | 아래 4개 spike와 ADR, 버전/소스/측정 기록 | 실제 패키지·실기기 증거로 핵심 위험 해소. 미통과 영역을 제품 기능으로 약속하지 않음 |
| P1 로컬 세션 기반 | host launcher, 프로필, 단일 PTY, lifecycle, SQLite metadata, 인증된 local transport | GUI 종료/재연결·셸 종료·host 재시작을 구분하고 P0 재현 테스트 유지 |
| P2 데스크톱 작업 공간 | 그룹·split tree·resize·최대화·검색·설정·자동 저장, 정식 입력 bridge | 4–16패널, 그룹 전환, Korean IME, copy/paste, 파일 경로 검증 |
| P3 원격+모바일 | Serve 안내, pairing/revocation, 인증 WS, lease·snapshot/replay, PWA·보조 키 | 두 PC와 Android/iOS 실제 연결·전환·권한 해제 통과 |
| P4 출시 품질 | installer/uninstaller, update compatibility, 기록 제한·진단, 보안·부하·복구 테스트 | 지원 환경 표와 실패/제약 안내, 라이선스 고지, 필수 게이트 전부 통과 |

P2 시각 시안과 P3 모바일 정적 화면은 P0와 병행 가능하나, 미검증 terminal replay/daemon 계약에 의존하는 구현은 확정하지 않는다. 일정은 P0 결과와 실제 지원 환경을 확인한 뒤 산정한다.

## 3. P0 — 가장 먼저 할 네 가지 실험

### P0-A: 패키징된 Windows 프로세스 독립성

- 작은 Electron 창과 별도 번들 Node host, PowerShell PTY 하나만 만든다.
- 셸 PID와 증가하는 출력 번호를 기록한다. 창 닫기, GUI 정상 종료, GUI 강제 종료, 재실행을 반복한다.
- shell PID·작업 상태가 같고 출력 번호가 이어지는지 확인한다. PTY뿐 아니라 HTTP/WS endpoint도 계속 살아 있어야 한다.
- 일반 실행, 시작 메뉴/설치 직후 실행, 부모 프로세스가 job object를 가진 실행 경로를 구분한다.
- host 명시 종료·Windows 로그아웃·재부팅에서는 이전 세션을 running으로 잘못 표시하지 않아야 한다.
- 통과 산출물: 프로세스 트리, 종료 전후 PID/호스트 ID, 로그, 해당 launcher 코드, OS/Node/node-pty 버전, 확인하지 못한 실행 경로 목록.
- local named pipe의 SID 제한·서버 프로세스 신원·nonce 상호 인증을 검증한다. 다른 Windows 사용자가 예상 endpoint를 선점한 환경에서 credential을 노출하지 않고 중단해야 한다.

### P0-B: 터미널 snapshot과 입력 응답 정확성

- 같은 테스트 VT stream을 기존 화면과 새로 attach한 화면에 적용하고 cell·cursor·mode 상태를 비교한다.
- stream의 가능한 경계마다 disconnect: CSI/OSC/DCS/APC 중간, UTF-8 split, combining/wide glyph, alternate screen, saved cursor, scroll region, keyboard mode.
- headless와 두 renderer를 붙여 DSR/DA 질의의 실제 PTY 입력 응답 횟수를 센다. 프로그램이 받은 응답은 하나여야 한다.
- serialize 단독·adapter 보강·대안 engine의 정확성/코드 유지 비용을 비교해 `ADR-003`의 잠정 결정을 확정한다.
- 원래 행·열 크기로 snapshot을 적용한 뒤 resize해야 하며 resize 이벤트도 출력과 일관된 순서로 처리한다.
- 통과 산출물: 실패 stream fixture, 상태 비교 결과, mode coverage 표, 응답 provenance 구현, pending parser 처리 방식, 버전 고정 목록.
- 실패하면 제품 기능 축소를 몰래 하지 않는다. 지원 terminal capability 범위를 명시하거나 mux/renderer 구조를 변경하고 다시 검증한다.

### P0-C: Windows Serve → Android/iOS 실제 WebSocket

- 로컬 최소 HTTPS 웹 UI와 실제 WS echo/순차 출력 연결로 Tailscale Serve 경로를 시험한다.
- Windows host, 다른 PC, Android Chrome, iPhone Safari에서 HTTPS와 WS를 확인한다. 모바일 홈 화면 실행도 별도로 확인한다.
- 60분 active/idle, 화면 잠금/복귀, Wi-Fi↔모바일 데이터, Tailscale off/on, host GUI 종료를 확인한다.
- 직접/DERP 경로를 기록하고, 직접 경로만 확인했으면 DERP는 미검증으로 표시한다.
- 검증 목적으로 기존 Serve/Funnel·ACL 설정을 덮어쓰지 않는다. 전용 테스트 endpoint와 장치를 사용한다.
- 통과 산출물: 기기·OS·브라우저·Tailscale 버전, Serve 설정, 인증서/upgrade 성공, reconnect 횟수, 불안정 조합의 재현 절차.

### P0-D: 한글·입력·네이티브 배포

- Windows IME와 Android/iOS 한글 키보드에서 조합·수정·붙여넣기·Enter·Ctrl+C를 확인한다.
- PowerShell 5.1/설치된 7, CMD, 설치된 WSL/Git Bash에 공백·한글 경로와 실제 인수 배열을 전달한다.
- 개발 도구가 없는 Windows 환경에서 번들 Node/node-pty/SQLite가 실행되는지 확인한다.
- 동시에 한글 조합/resize/네트워크 끊김이 일어날 때 문자 중복이나 의도하지 않은 명령 제출이 없어야 한다.
- 통과 산출물: 입력 녹화 또는 단계 기록, 입력 byte/event fixture, 패키지 파일·라이선스 목록, VM/실기기 환경.

## 4. 작업 분해와 의존성

| 작업 | 모듈 | 시작 가능한 구체 범위 | 의존 |
|---|---|---|---|
| W01 | protocol | ID/epoch/schema, lifecycle과 오류 코드, version handshake | 요구 문서 |
| W02 | host launcher | instance lock, owner credential, readiness, process detach | P0-A |
| W03 | shell profiles | 설치 탐지·인수·cwd 검증, 표시명, 없는 셸 오류 | P0-D |
| W04 | terminal adapter | response authority, state coverage, snapshot fence | P0-B |
| W05 | storage | migration, group/layout CAS, session tombstone, 기록 상한 | W01 |
| W06 | host manager | PTY 생성/종료, emulator, stream·queues, last-client detach | W02–05 |
| W07 | desktop UI | host/group/pane navigation와 split tree 조작 | W01, W06; 시안 병행 가능 |
| W08 | authentication | pairing approval, session cookie, CSRF, WS ticket, revocation | W01–02 |
| W09 | remote transport | private Serve 진단, URL/host identity, retries | P0-C, W06, W08 |
| W10 | mobile UI | single pane view, IME, special keys, viewport, PWA | P0-D, W07, W09 |
| W11 | control/reconnect | lease CAS, input dedupe/uncertain, replay/snapshot | W04, W06, W08 |
| W12 | release | installer, updates, source notices, tests/diagnostics | W07–11 |

W08과 W11이 통과하기 전 원격 shell 제어를 공개 테스트 대상으로 배포하지 않는다. 각 작업은 담당 모듈을 정하고 같은 파일의 동시 수정을 피한다. 시각 UI와 host protocol은 공유 schema를 기준으로 연결한다.

## 5. 기능 수용 테스트

모든 표의 상태는 **계획됨/미실행**이다. 성공 기준을 만족하는 로그·영상·프로세스 정보·state 비교가 있어야 PASS로 바꾼다. 실행 환경이 없으면 SKIP 사유와 미지원 범위를 기록한다.

| ID | 실제 시나리오 | 기대 결과/증거 | 요구 |
|---|---|---|---|
| T01 | 새 설치 후 PowerShell·CMD 각각 열고 명령·Ctrl+C·exit | shell 식별/PID 정상, 종료 상태 구분 | R03 |
| T02 | 설치된 WSL/Git Bash 및 한글·공백 폴더에서 열기 | 올바른 OS 경로/argv, 없는 프로필은 오류 | R03 |
| T03 | 그룹 3개, 비대칭 4분할·resize·자리교환·최대화 복귀 | 각 leaf가 원래 session을 가리키고 배치 저장 | R02 |
| T04 | GUI 창 닫기 후 다른 PC/모바일에서 접속 | 동일 PID·terminalId, output 이어짐, gateway 생존 | R04–07 |
| T05 | GUI 강제 종료 후 재실행 | host/PTY 영향 없음, 기존 세션 복원 | R04 |
| T06 | host 강제 종료 후 GUI 재시작 | 이전 세션 interrupted, 임의 자동 명령 재실행 없음 | D05 |
| T07 | Windows 잠금·절전·로그아웃·재부팅 각각 | 각각의 보장 범위에 맞는 상태/기록, 거짓 running 없음 | R04 |
| T08 | 그룹/패널 전환 중 고빈도 출력 | 숨겨진 세션 실행 유지, 최근 화면과 순서 정확 | R02/04 |
| T09 | CSI/OSC/DCS/UTF 경계마다 재연결 fixture | 기준 화면과 cell/cursor/mode 일치, 문자 손실 없음 | R04/06 |
| T10 | 전체 화면 CLI의 alternate screen 진입·이탈 중 접속 | 기존 화면·scrollback·mode 복원 | R04/06 |
| T11 | host+PC+mobile 상태에서 DSR/DA 질의 | PTY 응답 한 번, observer/replay side effect 없음 | R06/07 |
| T12 | PC와 모바일이 동시에 제어권 요청·이전 | terminal별 제어자 1개, 옛 epoch 입력/resize 거부 | D03 |
| T13 | 모바일 관찰·회전·키보드 열기 | 관찰자의 변경으로 PC PTY 크기가 바뀌지 않음 | R07 |
| T14 | 모바일 회전/IME 중 제어 획득 후 PC 복귀 | lease 이전→resize fence→화면 ACK 이후만 입력, 분할 트리 유지 | R07/D03 |
| T15 | Wi-Fi↔LTE, 비행기모드, Tailscale 끊김 후 복구 | 동일 generation에 재연결 또는 종료 명확 표시 | R06/07 |
| T16 | 브라우저 refresh/강제 종료 뒤 attach | 기존 client 상태를 가정하지 않고 snapshot부터 | R07 |
| T17 | 입력 ACK 직전 연결 끊김; 안전한 counter fixture 사용 | 자동 재전송 0회, 중복 명령 없음, 전달불명 표시 | R06/07 |
| T18 | replay ring 범위를 넘도록 접속 중단 | 깨진 suffix 대신 snapshot 재동기화 | R06/07 |
| T19 | 느린 모바일에 대량 출력, 다른 PC는 정상 | 느린 client만 resync, queue 상한, 다른 세션 반응 유지 | R06/07 |
| T20 | 한글 조합 중 Enter/Backspace·패널 이동·paste | 조합 정확, 중복 제출/글자 유실 없음 | R03/07 |
| T21 | Android/iOS 일반 브라우저 및 PWA 실행 | 연결·보조키·선택·paste·화면 복귀 각각 정상 | R07 |
| T22 | 내보낸 설정을 다른 host에 적용 | credential/기록 미포함, 원격 경로를 자동 실행 안 함 | R05 |
| T23 | 원격 host A 실패 시 host B/local 존재 | 다른 host에서 임의 셸을 생성하지 않음 | R05/06 |
| T24 | 실행 중 그룹 삭제/패널 종료/전체 종료 | 대상 수 확인, 명시한 session만 종료, 이웃 유지 | R02/04 |

## 6. 보안·복구·배포 게이트

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| S01 | 인증 없는 HTTP/WS, LAN 직접 port 접근 | 세션/출력 노출 없음, non-loopback listener 없음 |
| S02 | 위조 Tailscale header·Host·Origin, CSRF 누락 | owner 권한·제어·pairing 우회 불가 |
| S03 | 코드 만료·5회 실패·ticket 재사용·폐기 cookie; 폐기 직후 crash/restart | 모두 거부, 열린 연결 종료, 재시작 후 폐기 credential 부활 없음 |
| S04 | 승인 전 pairing consume·PC 승인 취소·동시 consume | 승인 전 session 발급 없음, 코드 1회만 소비 |
| S05 | XSS 문자열 title·OSC52·악성 URL·과대 frame | 텍스트 처리, 자동 명령/클립보드 변경 없음, 한도 적용 |
| S06 | SW Cache/IndexedDB/localStorage·로그 조사 | auth/PTY 내용 저장 없음(PC 의도된 transcript 제외) |
| S07 | expired lease·hostBoot 변경·타 host terminal ID 입력 | 잘못된 상태/대상에 제어권 전달 안 함 |
| S08 | DB 쓰기 도중 프로세스 종료·디스크 부족·파일 손상 | transactional metadata, 최근 백업/오류, 기록 장애와 실행 장애 구분 |
| S09 | N host 실행 중 N+1 설치·major 불일치·migration 실패 | 구 GUI로 작업 관리 가능, 교체 보류, writer 종료/독점 lock/일관 backup 후 migration, 실패 롤백 |
| S10 | 신규 설치/삭제/재설치·사용자별 실행 | 시스템 Node 비의존, 다른 사용자/기존 Serve 설정 보존 |
| S11 | 두 host 동시 시작·stale PID 파일·다른 사용자의 pipe/port 선점 | 하나의 실제 host만 실행, 서버 신원 검증 실패 시 secret 미전송, 다른 PID를 임의 종료 안 함 |
| S12 | ConPTY 시작 직후/대량 출력 중 종료 반복 | hang·handle 누수·미종료 PTY가 없는지 확인; 분리된 자식의 한계 명시 |

## 7. 성능 목표와 측정 조건

다음은 제품 목표다. 이번 설계 작업에서 측정한 결과가 아니다.

| 항목 | 초기 목표 | 측정 조건 |
|---|---|---|
| 로컬 키 입력→화면 | p95 50ms 이하 | 기준 Windows PC, 부하 없는 shell echo, IME 별도 |
| 원격 키 입력→화면 | 네트워크 왕복 지연 + 앱 처리 p95 100ms 이하 | 직접/DERP, 기기/네트워크별 기록 |
| 재연결 | 네트워크 안정·인증 유효 시 일반 snapshot 3초 이내 목표 | 4개 session, snapshot 총 크기·회선 상태 기록 |
| 지속 동작 | 8시간 동작 중 queue 무제한 증가/host 중단 없음 | 8 sessions, active/idle/output 혼합 |
| 과부하 | 16 visible/32 live 제한까지 오류 대신 명확한 부하 관리 | RSS/CPU·queue·input latency, 60초 출력 폭주 후 회복 |
| 저장 복구 | 기록된 checkpoint 손실 범위를 초과한 상태 손상 없음 | 강제 종료/디스크 부족 fixture |

낮은 메모리 사용량은 측정 후 예산을 정한다. Electron과 headless emulator를 사용하면서 근거 없이 '초경량'을 약속하지 않는다. 성능 목표를 못 맞추면 세션 수·history·render 전략을 조정하고 수치를 다시 공개한다.

## 8. 릴리스 및 증거 형식

`docs/validation/YYYY-MM-DD-<scenario>.md`에 다음을 기록한다: 빌드/commit, OS·브라우저·Tailscale·Node·native addon 버전, 준비 조건, 수행 단계, 기대/실제 결과, PID/ID 및 개인정보를 제거한 로그, 스크린샷/영상 경로, PASS/FAIL/SKIP, 남은 제약.

출시 시 포함할 문서는 설치/모바일 연결, 창 닫기와 작업 종료의 차이, 절전·로그아웃·재부팅 한계, 데이터 저장/삭제 위치, 원격 권한 해제, 문제 진단, 제3자 라이선스다. 설치파일의 publisher 서명과 업데이트 무결성을 확인하며 인증서 구입·배포 계정·공개 배포는 구현 후 별도 결정한다.

## 9. 요구 추적과 출시 판정

R01은 이름/패키지 문서, R02는 T03/T08/T24, R03은 T01/T02/T20, R04는 T04–T11, R05는 T22/T23, R06은 T04/T09–T19, R07은 T13–T21, R08은 P0-C/S01–S04/S10, R09는 의존성/기능 범위 검토로 추적한다.

**출시 보류 조건:** 살아 있는 세션 유실, 입력 중복 전송, 미승인 셸 제어, 복원 화면 상태 불일치, 정상 GUI 종료로 host/gateway 종료, 실제 모바일 필수 환경 미검증. 디자인 문서의 완성과 이 검증의 통과는 별개다.
