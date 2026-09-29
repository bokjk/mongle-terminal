# Mongle Terminal 원격 연결·PWA 보안 검토

**권고: Windows 사용자 권한의 PTY 호스트를 세션의 소유자로 두고, 모바일 PWA는 Tailscale Serve의 비공개 HTTPS/WSS를 통해 같은 세션에 붙는다. 앱 자체의 기기 페어링·세션 인증을 추가하며, 첫 출시는 동시 관찰과 단일 제어자를 지원한다.**

확인일: 2026-09-29. 이 메모는 공식 문서·표준·공식 소스 검토와 설계 제안이다. 설치, 로그인, 설정 변경, 포트 공개, 실기기 접속은 수행하지 않았다. 아래 제안값과 프로토콜은 제품 설계 판단이며 벤더가 보장하는 기능이 아니다.

## 1. 연결 구조와 확인된 지원 범위

`모바일 PWA → HTTPS/WSS → Tailscale 네트워크 → Windows Tailscale Serve → http://127.0.0.1:<고정 포트> 앱 게이트웨이 → PTY 호스트 → PowerShell/CMD/WSL/Git Bash`

PC와 휴대폰 모두 Tailscale을 설치하고 같은 tailnet 또는 명시적으로 허용된 관계에 연결한다. Serve는 tailnet 안에 서비스를 제공하고 접근 제어 정책을 적용한다. **Funnel, 공유기 포트 전달, 공인 IP의 셸 엔드포인트는 제품 경로에 넣지 않는다.** HTTPS 인증서는 Serve가 처리하고 앱은 loopback에만 bind한다. 공식 CLI 문서는 로컬 HTTP 프록시와 자동 TLS 종료를 설명한다. [Serve](https://tailscale.com/docs/features/tailscale-serve), [Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)

자체 중계 서버 운영은 필요 없다. 다만 “모든 패킷이 언제나 직접 연결된다”는 의미는 아니다. Tailscale은 직접 연결을 시도하며 실패하면 관리형 DERP를 이용할 수 있다. 해당 경로도 WireGuard 종단 간 암호화가 유지된다. 직접 연결과 DERP의 지연·처리량 차이는 제품의 재접속·출력 제어가 감당해야 한다. [연결 방식](https://tailscale.com/docs/reference/connection-types)

| 항목 | 확인 수준과 결정 |
|---|---|
| Windows Serve | 공식 예제가 Windows를 명시한다. `--bg`는 실행한 콘솔을 닫은 뒤에도 공유를 유지하는 기능이다. 기존 Serve 설정을 덮어쓰지 않도록 설치 시 충돌 검사와 전용 포트/호스트 사용 여부를 검토한다. [Serve 예제](https://tailscale.com/docs/reference/examples/serve) |
| WebSocket 프록시 | 공식 `serve.go`는 Go `httputil.ReverseProxy`를 사용하고 Go 구현은 HTTP 101 업그레이드를 처리한다. **지원 가능성을 뒷받침하는 구현 근거**이며, 모든 Windows·모바일 버전의 장기 연결 보장은 아니다. [Tailscale 소스](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go), [Go 소스](https://go.dev/src/net/http/httputil/reverseproxy.go) |
| 남은 불확실성 | 공식 저장소의 열린 #20882에는 macOS Serve 1.102.2와 Safari/HTTP2 관련 실패 신고가 있다. 신고자의 원인 설명을 검증된 사실이나 Windows 전체 결함으로 확대하지 않는다. 실제 브라우저의 `new WebSocket()`으로 검증한다. [신고 원문](https://github.com/tailscale/tailscale/issues/20882) |
| HTTPS 이름 | `https://<machine>.<tailnet>.ts.net`의 정확한 주소를 사용한다. 인증서 투명성 기록에 FQDN이 남으므로 이름에 민감한 정보를 넣지 않는다. 이것이 셸을 인터넷에 공개한다는 뜻은 아니다. [HTTPS 안내](https://tailscale.com/docs/how-to/set-up-https-certificates) |

출시 판정에는 Windows 빌드, PC/모바일 Tailscale 버전, 브라우저/OS 버전, Serve 설정, 직접/DERP 경로를 기록한다. 이번 검토에서 실제로 테스트한 조합은 **없다**. WebSocket 게이트 실패 시 공개 Funnel로 우회하지 않고 해당 조합의 출시를 보류한다.

## 2. 인증과 신뢰 경계

Tailscale은 네트워크 접근 자격을 제공하고, Mongle은 앱 접근·터미널 권한을 판단한다. Serve는 외부 요청의 동일한 identity header를 지우고 자신이 확인한 사용자 정보를 넣지만, loopback에 직접 연결할 수 있는 로컬 프로세스는 이 헤더를 위조할 수 있다. tagged device는 사용자 헤더가 없고 공유받은 외부 사용자도 헤더를 가질 수 있다. 따라서 **헤더 존재만으로 자동 로그인·자동 제어 권한을 주지 않는다.** [Serve identity headers](https://tailscale.com/docs/features/tailscale-serve#identity-headers)

첫 버전의 제안:

1. **페어링:** PC의 신뢰된 데스크톱 UI에서 페어링 창을 잠시 연다. QR은 정확한 HTTPS 진입 주소를 안내하고, 휴대폰에서 요청한 페어링 코드/기기를 PC에서 확인·승인한다. 일회용 코드의 짧은 만료, 시도 제한, 재사용 거부를 적용한다. 인증 전에는 세션 목록·출력·파일을 반환하지 않는다. Tailscale 사용자 정보는 승인 화면의 보조 정보로 표시한다.
2. **앱 세션:** 승인된 브라우저 인스턴스에 서버가 발급한 불투명 세션을 `__Host-` 접두사, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, Domain 미지정 쿠키로 전달한다. 서버에는 세션 검증값, 승인 시각, 만료, 기기 표시명과 폐기 상태를 둔다. 이 “기기”는 하드웨어 보증이 아닌 페어링된 브라우저 프로필이다. URL query, 로컬 스토리지, 분석 로그에 bearer/JWT를 넣지 않는다. [쿠키 속성](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)
3. **요청 검증:** 정확한 Host 및 HTTPS Origin 허용 목록을 사용한다. 넓은 CORS, Origin 와일드카드, suffix/substring 매칭을 금지한다. 상태 변경 HTTP 요청에 CSRF 토큰을 요구한다. WebSocket은 인증 쿠키와 정확한 Origin을 확인하고, CSRF 검증된 같은 출처 POST가 발급한 짧은 수명의 일회용 연결 ticket을 첫 메시지로 소비한 뒤에만 데이터 전송·명령을 허용한다. 인증 전 연결 수/시간도 제한한다. Origin은 브라우저 공격 방어이며 비브라우저 클라이언트의 신원 증명이 아니다. [RFC 6455 보안](https://datatracker.ietf.org/doc/html/rfc6455#section-10), [OWASP WebSocket](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
4. **권한 폐기:** 기기 해제·앱 로그아웃·세션 만료 시 서버가 관련 WebSocket과 제어권을 즉시 폐기한다. 연결 이후에도 각 input/resize/terminate 명령의 터미널 접근권한과 제어 세대를 검증한다. 요청 크기·빈도·연결 수 상한을 둔다. 로그에는 접속/폐기/제어권 이동 결과를 남기되 입력과 출력 원문·인증값을 기본 수집하지 않는다.
5. **로컬 경로:** 데스크톱 main만 사용자 ACL로 보호된 IPC에서 소유자 비밀을 얻고, sandboxed renderer에는 좁은 명령 IPC만 노출한다. 로컬 UI와 원격 UI는 동일한 세션 모델/메시지 규칙을 사용하되 원격 페어링 쿠키와 로컬 소유자 인증은 분리한다. 임의 loopback 요청, `Tailscale-*` 헤더, Origin 위조만으로 로컬 관리자 권한을 얻을 수 없어야 한다. 같은 Windows 사용자 권한을 이미 탈취한 프로세스까지 격리한다는 보장은 하지 않는다.

## 3. PWA 설치·저장·모바일 수명

정확한 HTTPS 출처 하나에서 앱 셸, manifest, API, WSS를 제공한다. manifest에는 이름, 192/512 아이콘, `start_url`, 안정적인 `id`, `scope`, `display: standalone`을 둔다. 휴대폰에서 PC의 loopback 주소는 PC를 뜻하지 않으므로 `http://100.x.y.z`나 짧은 HTTP 이름을 설치 주소로 쓰지 않는다. PWA 설치 방식은 브라우저마다 다르며 iOS는 공유 메뉴 안내가 필요하다. 설치를 위해 service worker가 반드시 필요한 것은 아니다. [MDN 설치 요건](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable), [Apple 홈 화면 설치](https://support.apple.com/en-lk/guide/iphone/iphea86e5236/ios)

SW를 도입한다면 **버전이 붙은 정적 앱 셸만 명시적으로 캐시**한다. `/api`, 인증·페어링 응답, 세션 목록, PTY 출력/스냅샷, 파일 데이터는 SW runtime cache에서 제외하고 HTTP 응답에도 `Cache-Control: no-store`를 설정한다. Cache API는 HTTP 캐시 헤더를 따르지 않으므로 `no-store`만으로 충분하지 않다. 터미널 내용을 IndexedDB/localStorage에 저장하지 않고, 로그아웃 시 화면 메모리와 민감한 앱 저장소를 정리한다. 오프라인 화면은 연결 상태 안내만 보여주고 명령을 큐에 쌓지 않는다. [MDN Cache](https://developer.mozilla.org/en-US/docs/Web/API/Cache), [W3C Cache 수명](https://www.w3.org/TR/service-workers/#cache-lifetimes)

모바일은 타이머가 멈추거나 페이지가 이벤트 없이 제거될 수 있다. Chrome의 lifecycle 문서는 이를 명시하지만 Safari의 정확한 이벤트 순서까지 보장하지 않는다. SW도 영구 WebSocket 유지 장치로 가정하지 않는다. 페이지 로드·`pageshow`·visible 복귀·네트워크 변화 때 실제 서버 handshake로 상태를 확인하고, 실패하면 jitter를 둔 지수 재시도를 한다. `navigator.onLine`이나 이전의 초록 연결 표시만 믿지 않는다. [Chrome lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api), [WebSocket과 bfcache](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_client_applications#working_with_the_bfcache)

## 4. 재접속과 단일 제어자 프로토콜 제안

PTY는 브라우저 연결과 독립적으로 존속한다. 호스트는 `hostEpoch`, `terminalId`, 단조 증가 출력 `seq`, 제한된 출력 replay buffer, 권위 있는 터미널 상태 스냅샷을 관리한다. 재접속은 새 인증 후 마지막 처리 `seq`를 제출한다. 보관 범위 안이면 이후 출력을 재생하고, 범위를 벗어나면 화면·커서·모드·크기·스냅샷 기준 `seq`를 함께 전송한다. 스냅샷과 이후 출력 사이의 원자적 경계를 보장한다. 중간 ANSI/UTF-8 바이트를 임의로 잘라 이어 붙이지 않는다.

각 터미널은 제어 lease 하나만 허용한다. 관찰자는 출력만 보고 PTY resize를 보내지 않는다. 제어 이전 시 서버가 generation을 증가시키고 기존 generation의 input/resize를 거부한다. 새 제어자의 화면 크기를 적용하고 관찰자는 그 크기를 스크롤·축소해 본다. 휴대폰 키보드·회전 변화는 현재 제어자에게서만 debounce하여 반영한다. 끊긴 제어자의 lease는 짧은 유예 뒤 해제하며, 복귀한 클라이언트는 서버가 부여한 새 권한을 확인해야 입력할 수 있다.

입력에 `clientInputId`와 lease generation을 부여하고 ACK는 “호스트가 PTY 전달을 수락함”까지만 뜻하도록 정의한다. ACK 유실·프로세스 충돌 상황에서 명령이 실행됐는지는 확실하지 않을 수 있다. **재접속 시 미확인 입력을 자동 재전송하지 않는다.** 화면에 “전달 여부 확인 필요”를 표시한다. 연결별 출력 큐와 ACK 창을 제한하고 느린 관찰자는 재동기화한다. 브라우저 WebSocket에는 수신 backpressure가 없고 `bufferedAmount`는 송신 대기량이므로 수신 메모리 제어를 대신하지 못한다. [MDN WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket), [WHATWG WebSocket](https://websockets.spec.whatwg.org/#the-websocket-interface)

## 5. Windows 지속성의 한계와 필수 검증

Tailscale의 Run Unattended는 네트워크 연결을 Windows 사용자 로그아웃과 분리한다. 앱의 사용자 PTY 호스트를 시스템 서비스로 바꾸거나 기존 프로세스를 살아남게 하지는 않는다. 첫 버전은 로그인한 사용자의 호스트 프로세스를 UI 창과 분리하여 UI 닫기·휴대폰 끊김·화면 잠금 중 지속시키되, 로그아웃·재부팅·호스트 종료 뒤 실행 상태 복원은 보장하지 않는다. PC 절전·종료 중에는 원격 연결을 보장하지 않으며 절전 중 작업 진행도 보장하지 않는다. 재시작 시 메타데이터 복원과 살아 있는 PTY 재연결을 구별한다. 시스템 서비스의 Session 0과 대화형 사용자 세션은 별개이고, ConPTY 종료는 연결된 앱에 영향을 준다. [Unattended](https://tailscale.com/docs/how-to/run-unattended), [Microsoft 로그오프](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/logoff), [서비스 Session 0](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services), [ConPTY](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)

출시 전 통과해야 할 시나리오:

1. **접속·설치:** 기록된 Windows/Tailscale 조합에서 iPhone Safari 홈 화면 앱과 Android Chrome 설치 앱 각각 HTTPS 인증서, 실제 WebSocket 업그레이드, 60분 출력·입력·유휴 연결을 확인한다. 직접/DERP 경로와 PC Serve 재시작도 포함한다.
2. **경계:** tailnet 밖, 허용되지 않은 tailnet 사용자, 미페어링 브라우저, 위조 Host/Origin/identity header, 만료·재사용 ticket, CSRF 없는 POST, 폐기 쿠키를 거부한다. loopback 직접 요청으로 권한 상승이 안 됨을 확인한다. LAN에서 앱 포트에 연결되지 않아야 한다.
3. **모바일 복구:** 화면 잠금·앱 전환·브라우저 강제 종료·Wi-Fi↔LTE·Tailscale 단절 뒤 같은 터미널 ID로 복귀한다. 출력 유실/중복, snapshot 경계, replay 범위 초과, 버전 불일치, 호스트 epoch 변경을 시험한다. ACK 직전 단절 뒤 명령이 자동 중복 실행되지 않아야 한다.
4. **제어·부하:** PC/모바일 동시 관찰, 경합하는 제어 요청, 끊긴 옛 제어자의 늦은 input/resize, 한글 IME·붙여넣기·회전·키보드 열기, 대량 출력·느린 모바일에서 제어자 하나와 메모리 상한을 유지한다.
5. **수명·저장:** UI 창 닫기, PC 잠금, 절전/복귀, 사용자 로그아웃, 재부팅을 구별하여 보여준다. SW Cache/IndexedDB/localStorage에 인증값·터미널 원문이 없고, 로그아웃·기기 폐기 후 열린 소켓도 종료되는지 검사한다. 로그아웃·재부팅 뒤 이전 작업을 실행 중으로 표시하지 않는다.
