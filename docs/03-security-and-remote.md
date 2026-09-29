# 몽글터미널 — Tailscale 연결·인증·모바일 설계

작성일: 2026-09-29 · 상태: 구현 전 설계안 v0.1

## 1. 연결 결정

첫 버전은 **PC와 휴대폰에 설치된 Tailscale**을 사용한다. 실행 PC가 웹 화면과 터미널 API를 제공하고, private Tailscale Serve가 HTTPS/WSS를 loopback으로 전달한다. 몽글터미널의 별도 중앙 계정·작업 서버·릴레이 서버를 운영하지 않는다. 각 설치 사용자는 자신의 네트워크와 승인한 기기만 연결한다.

가능하면 기기 간 직접 연결이 사용되고 환경상 불가능하면 Tailscale 관리형 중계가 사용될 수 있다. 'Tailscale 사용 = 항상 P2P'라고 표시하지 않는다. 기본 UI는 연결 여부와 호스트를 보여주고, 직접/중계 및 지연 정보는 진단에서 확인한다. 연결 경로가 바뀌어도 터미널 ID와 세션은 바뀌지 않는다. [공식 연결 방식](https://tailscale.com/docs/reference/connection-types)

### 비용 기록 — 2026-09-29 확인

| 구분 | 현재 공식 안내 |
|---|---|
| 개인·비상업 Personal | 무료, 최대 6명, user device 수 무제한 |
| 업무용 Standard | 사용자당 월 USD 8 |
| 몽글 자체 중계 서버 | 이 설계에서는 운영하지 않음 |

사용자 기기와 tagged resource 한도는 다르며 실제 적용 플랜·과금은 사용자의 Tailscale 계약에 따른다. 무료를 회사 업무에 적용할 수 있다고 가정하지 않는다. 기존 레거시 플랜은 다를 수 있다. [요금 및 용도 구분](https://tailscale.com/pricing)

## 2. 온보딩

### 실행할 PC

1. 앱 설치 후 로컬 터미널을 바로 사용한다. 원격을 켜지 않아도 기본 기능은 동작한다.
2. '원격 접속 켜기'에서 Tailscale 설치·연결 상태를 확인한다. 설치/로그인은 Tailscale의 공식 흐름을 사용한다.
3. 기존 Serve 설정과 포트 충돌을 읽어서 확인한다. 기존 서비스를 일괄 reset하거나 덮어쓰지 않는다. 이 앱의 전용 endpoint를 선택한다.
4. private Serve를 통해 정확한 HTTPS 주소를 제공한다. 새 인증서/Serve 설정에 필요한 Tailscale 동의 화면은 사용자에게 표시한다.
5. '기기 연결'에서 일회용 코드를 만들고 접속할 기기를 승인한다.

### 접속할 PC/휴대폰

1. Tailscale 네트워크에 연결한다. 모바일 웹 자체는 VPN을 대신하지 않는다.
2. PC가 보여준 정확한 HTTPS 주소/QR로 진입한다. QR에는 장기 token을 넣지 않는다.
3. 일회용 코드를 입력해 연결을 요청하고 PC에서 기기명과 요청을 확인한다.
4. 인증 완료 후 그룹과 기존 터미널을 표시한다. 필요하면 홈 화면에 PWA를 추가한다.
5. 이후에는 승인한 브라우저 프로필/데스크톱의 유효한 세션으로 연결한다. 승인이 해제되거나 세션이 만료되면 다시 연결한다.

페어링 상태는 `pending → approved/rejected → claimed/expired`다. 코드를 맞혀도 pending 요청만 만들며 인증 쿠키는 발급하지 않는다. PC 승인 이후 원래 요청자가 256bit 난수 requester secret으로 claim해야만 쿠키를 받는다. 코드는 pending 요청 생성 시 단일 소비되고, secret은 해당 요청 상태 확인/claim에만 사용하며 URL·localStorage가 아닌 메모리에 둔다. 새로고침으로 secret을 잃으면 새 요청을 시작한다. 승인 전·거절 후·만료 후·중복 claim은 모두 거부한다.

제안 초기값: pairing window 3분, 코드 단일 사용, 암호학적 난수 8자리 이상(혼동 문자 제외), 코드당 실패 5회 후 폐기, 연결/IP별 rate limit. 앱 세션은 30일 절대 만료를 기본안으로 하며 짧은 WS ticket은 30초·한 번만 사용한다. 실제 수명은 UX/보안 검토로 조정 가능하다. 기기 식별은 하드웨어 보증이 아니라 페어링된 클라이언트 프로필임을 명시한다.

## 3. 신뢰 경계

Tailscale 네트워크 접근만으로 모든 터미널을 자동 제어하게 하지 않는다. v1의 승인 단위는 해당 host의 소유자 기기이며, 기기별/그룹별 동료 권한 모델은 후속 범위다. 페어링된 기기는 그 호스트의 일반 사용자 권한으로 셸을 사용할 수 있으므로 연결 요청을 PC에서 명확히 표시한다.

| 경계 | 설계 |
|---|---|
| 외부 네트워크 → Tailscale | tailnet 접근 정책을 따름. Funnel/public listener/공유기 포트 개방을 자동 설정하지 않음 |
| Serve → loopback gateway | gateway는 `127.0.0.1`로 한정. Host/Origin 정확 비교, 인증 전 데이터 미노출 |
| 로컬 main → host | 사용자 SID 전용 named pipe 및 서버 SID/프로세스 검증·nonce 상호 인증. owner secret은 HTTP로 전송하지 않음 |
| 원격 → host | 앱 pairing에서 발급한 세션을 검증. Tailscale identity header는 보조 정보이며 단독 인증 근거로 쓰지 않음 |
| renderer → main/host | Electron sandbox+context isolation, Node integration 비활성. schema에 있는 명령만 노출 |
| 셸 출력 → UI | 신뢰되지 않은 텍스트/VT 데이터. DOM 삽입·임의 링크 실행·클립보드 변경 방지 |

Serve가 identity header를 넣더라도 loopback에 접근하는 로컬 프로세스는 같은 이름의 헤더를 만들 수 있다. 따라서 헤더만으로 owner API나 pairing 생성 권한을 주지 않는다. 같은 Windows 사용자 권한 자체를 탈취한 악성 프로그램, OS 관리자/물리적 접근까지 이 앱이 격리한다고 보장하지 않는다. [Serve identity header 설명](https://tailscale.com/docs/features/tailscale-serve#identity-headers)

## 4. 인증과 API 세부 규칙

### 원격 브라우저

- 불투명 앱 세션을 Secure·HttpOnly·SameSite=Strict 쿠키로 발급한다. host-only, 명확한 만료와 폐기 상태를 사용한다. `__Host-` 규약을 사용할 경우 Path=/ 및 Domain 미지정 조건을 지킨다.
- 원격 UI·API·WSS는 같은 HTTPS origin으로 제공한다. 불특정 origin CORS, 임의 URL proxy, token query parameter를 사용하지 않는다.
- 상태를 바꾸는 HTTP 요청에 세션별 CSRF token을 검증한다. WebSocket upgrade에는 유효한 cookie와 허용한 정확한 Origin/Host를 요구한다.
- 아직 앱 세션이 없는 pairing bootstrap은 별도 규칙이다. 정확한 HTTPS Origin/Host·JSON content type·일회용 코드·rate limit을 요구하고, status/claim에는 원래 요청자 secret을 추가 검증한다. 일반 form POST나 기존 cookie만으로 pairing을 완료할 수 없고, 최종 권한은 로컬 PC 승인 후에만 발급한다.
- 인증된 CSRF POST로 WS ticket을 발급하고 첫 frame에서 소비한다. 그 전에는 출력·세션 목록·제어 명령을 허용하지 않고 짧은 timeout 후 닫는다.
- Origin은 브라우저 공격 경계일 뿐, 값을 직접 보낼 수 있는 native client의 신원 증명이 아니다.
- 다른 앱과 같은 origin에 신뢰되지 않은 콘텐츠를 호스팅하지 않는다. 쿠키는 포트로 격리되지 않으므로 Serve endpoint 구성과 호스트명 공유도 검토한다.

### 데스크톱

로컬 renderer에는 장기 owner secret을 전달하지 않는다. main과 host는 사용자 SID로 제한한 named pipe를 통해 서버 신원 확인 및 nonce 기반 상호 인증을 수행한다. 다른 사용자가 예상 pipe/port를 선점했다면 인증을 중단하고 secret 원문을 보내지 않는다. HTTP gateway에서는 owner 인증을 받지 않는다. named pipe 보안 API는 P0-A에서 구현·패키징 검증한다. preload의 제한된 메시지 interface로 terminal input·resize·목록 등의 기능만 제공한다. 요청에 있는 hostId를 등록된 연결에 매핑하고 renderer가 임의 URL/파일/실행 프로그램을 main에게 전달하지 못하게 한다.

원격 데스크톱도 해당 host에 pairing을 거치며 host별 cookie/credential 저장 영역을 분리한다. 원격 HTML을 Electron의 권한 있는 창에서 실행하지 않고 번들된 공용 UI와 인증 transport를 사용한다. 서버 identity가 변경되었을 때 기존 credential을 다른 host에 자동 전송하지 않는다.

### 모든 연결

기기 해제·로그아웃·만료 시 연결된 소켓과 제어권을 즉시 폐기한다. 인증 발급/폐기는 layout debounce와 분리된 영속 transaction이며 성공 응답 전에 commit한다. 저장에 실패하면 해제 성공으로 표시하지 않고 해당 연결을 fail-closed 처리한다. 기기 해제 직후 host가 crash해도 재시작 후 폐기 credential을 수용하면 안 된다. input/resize/terminate 때마다 인증·terminal scope·lease epoch를 검증한다. payload 크기·연결 수·pairing 시도 한도를 둔다. 명령과 경로를 shell string으로 합치지 않는다.

외부 URL은 http/https allowlist와 사용자 동작을 요구하고 `javascript:`, `file:`, 임의 앱 protocol을 자동 실행하지 않는다. xterm 출력 title/OSC를 앱 제어 채널로 취급하지 않는다. 과도한 escape payload, 로그 폭주, 비정상 Unicode 입력이 무한 메모리 사용으로 이어지지 않게 제한한다.

## 5. PWA 저장 및 모바일 복구

PWA는 홈 화면에서 여는 모바일 웹이다. 설치 방식은 iOS/Android 브라우저에 따라 다르므로 네이티브 앱과 완전히 같은 동작을 약속하지 않는다. 인증된 Serve의 HTTPS 주소를 start_url로 사용한다. [PWA 설치 조건](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)

서비스 워커가 있다면 이름/버전이 정해진 정적 JS·CSS·아이콘만 allowlist로 캐시한다. API, pairing/auth 응답, terminal output/snapshot, 사용자 파일을 runtime cache에 넣지 않는다. HTTP `Cache-Control: no-store`도 설정하지만 Cache API는 이를 자동 준수하지 않으므로 라우팅 단계에서 제외해야 한다. 터미널 이력은 휴대폰 localStorage/IndexedDB에 저장하지 않는다. [Cache API](https://developer.mozilla.org/en-US/docs/Web/API/Cache)

모바일은 background에서 타이머와 WebSocket이 중지되거나 페이지가 제거될 수 있다. 서버 세션은 별도로 유지하고 visible/pageshow/네트워크 복귀 시 실제 handshake로 재연결한다. `navigator.onLine`만으로 연결됨을 판단하지 않는다. retry는 0.5초부터 최대 30초까지 지수 backoff+jitter, 사용자 수동 재시도 제공을 제안한다. 인증 오류와 버전 오류는 무한 자동 재시도하지 않는다.

오프라인 상태에서는 입력을 차단하고 명령을 큐에 저장하지 않는다. 미확인 입력의 자동 재전송, offline background sync를 통한 명령 실행은 없다. 다시 연결되면 출력부터 동기화하고 제어권을 새로 확인한다. 앱 셸 업데이트도 실행 중인 화면을 임의 reload하지 않고 사용자가 재열기 할 때 적용한다.

## 6. 기록 및 진단

사용자가 원하는 '다시 열었을 때 이전 출력'을 위해 제한된 기록을 PC에 저장한다. 이 기록에는 사용자가 셸에 출력한 정보가 포함될 수 있다. 입력 keystroke 별도 로깅, 환경변수 전체 dump, 세션 인증값 로깅은 하지 않는다. 기록 보관 끄기/지우기, 용량 상한, 저장 실패 상태를 제공한다.

진단 내보내기의 기본 내용은 앱/host/OS/브라우저/Tailscale 버전, protocol version, 오류 코드, 연결/재연결 시각, 직접/중계 여부, 큐 한도 초과 횟수다. 실제 명령·출력·사용자 경로·토큰은 기본 제외한다. 자세한 진단을 켤 때도 민감한 데이터 취급 범위를 표시한다.

## 7. 원격 출시 게이트

- Windows 호스트에서 실제 Safari/Chrome `new WebSocket()` 연결, 60분 active/idle, 재연결을 확인한다. 소스에 WebSocket 처리가 있다는 사실만으로 통과 처리하지 않는다.
- Android Chrome과 iPhone Safari의 일반 탭 및 홈 화면 실행을 각각 검증한다. 기기가 없으면 미검증으로 남기고 해당 플랫폼 지원 완료를 주장하지 않는다.
- 직접 연결과 가능한 경우 DERP 환경, Wi-Fi↔모바일 데이터, Tailscale off/on, 브라우저 강제 종료를 확인한다.
- 미승인 브라우저·폐기된 쿠키·잘못된 Origin/Host·CSRF 누락·ticket 재사용·위조 identity header 요청을 거부한다.
- 기존 Serve 설정 보존, 앱을 닫은 뒤에도 PTY **및 gateway** 유지, 다른 LAN 기기에서 loopback API에 접근 불가를 확인한다.

공식 저장소의 Safari/Serve 문제 신고는 연구 메모에 구분해 기록했다. 재현 확인 전 모든 버전의 결함으로 일반화하지 않는다. 실패 시 공개 endpoint로 우회하지 않고 지원 조합 또는 gateway 구성을 다시 검증한다.

## 8. 주요 근거

[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve), [Serve 예제](https://tailscale.com/docs/reference/examples/serve), [Run Unattended](https://tailscale.com/docs/how-to/run-unattended), [WebSocket 보안 기준](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html).

상세한 소스 확인·제약·미검증 사항은 [원격 연구 메모](research/research-remote.md)를 참조한다. 현재 실제 네트워크/설정 변경은 하지 않았다.
