# 인증·원격 게이트웨이 구현 검증

검증일: 2026-09-29. 범위: Node 24의 실제 loopback HTTP/WebSocket, 실제 SQLite 파일. Tailscale Serve의 헤더 전달은 테스트에서 모사했으며 실기기/TLS 연결 시험과 구분한다.

## 구현

- `packages/host/gateway.ts`: `127.0.0.1` 전용 HTTP/static/WS 게이트웨이. 정확한 Host·Origin 검사, POST JSON·CSRF, 원격 HTTPS 쿠키, 첫 프레임의 단일 사용 WS ticket, 요청/연결/출력 큐 상한을 적용했다. owner 메서드는 HTTP 및 원격 WS에서 호출할 수 없다. 2026-10-09부터 승인된 원격 WS 세션은 자기 origin의 요청에 한해 `pairing.create/list/approve/reject`만 게이트웨이에서 처리한다([원격 기기 승인](remote-device-approval.md)).
- `packages/auth/store.ts`: 별도 `auth.sqlite`의 WAL + `synchronous=FULL` 트랜잭션. 성공 응답 전에 페어링 코드 소비, 승인, claim, 기기 폐기를 commit한다. 세션 token·requester secret·페어링 code 원문을 저장하거나 로그에 출력하지 않는다.
- 페어링 코드는 혼동 문자를 제외한 10자리 난수, 3분 수명·1회 사용이다. 코드는 pending 요청만 만들고, 로컬 owner 승인과 원래 요청자의 256bit secret이 모두 있어야 세션을 발급한다. 틀린 코드 추측 5회는 DB에 누적한다.
- 세션은 30일 절대 만료, WS ticket은 30초 단일 사용이다. 원격 세션은 정확한 origin에 묶이며 원격 주소 변경/비활성화 시 기존 주소의 세션·승인 대기 요청을 영속 폐기한다. 기기 폐기와 로그아웃은 연결 및 core 제어권을 즉시 해제한다. core는 작업 큐 실행 시점에도 연결을 다시 검사한다.
- 네트워크 및 renderer에는 owner credential을 받는 API가 없다. ownerRequest는 로컬 IPC 호스트 코드가 직접 호출하는 내부 함수다. 로컬 IPC 신원 확인의 검증 범위는 데스크톱/플랫폼 문서에 별도 기록한다.

## 쿠키와 서비스 워커

HTTPS 원격에서는 `__Host-mongle; Secure; HttpOnly; SameSite=Strict; Path=/`를 사용한다. loopback 개발·로컬 브라우저에만 `http://127.0.0.1:<실제 포트>`와 별도 `mongle_loopback` 비 Secure 쿠키를 허용한다. `localhost`, 다른 loopback 표기, 임의 IP·origin은 허용하지 않는다. 이 예외를 LAN HTTP 제공으로 확대하지 않는다.

쿠키는 포트로 격리되지 않으므로 같은 호스트명에 신뢰하지 않는 서비스를 함께 제공하면 안 된다. `remote.configure`는 `.ts.net` HTTPS origin 설정만 저장한다. 실제 Tailscale Serve 생성/해제 및 기존 설정 보존은 별도 플랫폼 모듈의 책임이다.

API와 정적 응답은 `no-store` 및 기본 CSP를 제공한다. 터미널 화면/출력/세션 인증을 브라우저 localStorage에 기록하지 않는 것은 클라이언트 구현에서 보장해야 한다. 이 게이트웨이 자체는 서비스 워커를 생성하거나 Cache API를 호출하지 않는다. 사용자 자산 이외의 임의 파일, 경로 이탈 및 외부 경로로 향하는 심볼릭 링크는 static 파일로 제공하지 않는다.

## 실행한 검사

명령: `npx tsx --test tests/security/*.test.ts`.

실행 결과: 기본 16개 전체 실행 통과 후 추가 경계 3개를 별도 실행해 통과했다. 총 19개이며 HTTP/WS 14개, SQLite 5개를 포함한다. 추가 항목은 `npx tsx --test --test-name-pattern="payload bounds|malicious authenticated|pairing-create rate" tests/security/gateway.test.ts`로 재현할 수 있다.

| 경계 | 확인한 결과 |
|---|---|
| 페어링 | 승인 전 claim, 틀린 secret, 거절된 요청, 만료, 코드/claim 재사용 차단 |
| 브라우저 요청 | 틀린 Host·Origin·CSRF 차단, 위조 Tailscale identity header로 인증 우회 불가 |
| WebSocket | 첫 프레임 ticket 없이는 core 미연결, 재사용·다른 기기 ticket 차단, owner RPC가 core에 전달되지 않음 |
| 폐기 | 기기 해제·로그아웃 직후 live socket 종료·core.disconnect, SQLite 재시작 후에도 폐기 유지 |
| 주소 변경 | HTTPS Secure 쿠키 및 origin 귀속, 이전 주소 비활성화 시 기존 세션/승인 폐기 |
| 정적 제공 | webRoot 밖 접근·encoded traversal 차단, API no-store |
| 한도/비정상 입력 | 16KiB 초과 HTTP 413, 128KiB 초과 WS 차단·core 1회 해제, 비정상 JSON/바이너리/owner 위조 필드 차단, 요청 홍수 및 11번째 분당 페어링 생성 제한 |
| 다른 몽글 PC 찾기 (2026-10-10) | 승인된 기기의 `computers.list`를 게이트웨이가 처리하고 core에 전달하지 않음, `refresh` 외 매개변수(접속 대상 지정) 거부, 기기당 분당 30회, 검색을 기다리는 동안 같은 연결의 다른 요청 응답, 검색 기능이 없는 게이트웨이는 찾을 수 없음으로 응답 |
| 원격 기기 승인 (2026-10-09) | 승인된 기기의 코드 생성·조회·승인·거절, 다른 origin 요청 조회·결정 차단, 승인 기기 기록·이전 DB 열 추가, `devices.*`·`remote.*`·`pairing.status` 계속 차단, core 미전달, 발급자별 코드 유지(다른 기기 코드 무효화 방지)와 모든 코드에 실패 횟수 누적, 응답의 호스트 시각 |

검증 파일: `tests/security/auth-store.test.ts`, `tests/security/gateway.test.ts`. 관련 파일의 strict TypeScript 검사도 통과했다.

2026-10-09 원격 기기 승인 추가 후 `node --import tsx --test --test-concurrency=1 tests/security/gateway.test.ts tests/security/auth-store.test.ts` 24/24 통과(신규 4개 포함). 2026-10-10 독립 코드 검토 지적을 고친 뒤 25/25 통과(발급자별 코드 시험 1개 추가, 이전 DB 시험에 코드 발급자 열 추가 확인, 게이트웨이 시험에 PC 코드 유지와 응답 시각 확인). 2026-10-10 다른 몽글 PC 찾기 추가 후 26/26 통과(신규 1개). 찾기 규칙은 `tests/host/computers.test.ts` 5/5로 따로 확인했다(16대씩 동시 확인, 같은 사용자의 온라인 Windows 기기만 대상, 포트 순서·자기 자신 제외·캐시, Tailscale 오류 메시지, 몽글 health 형식·Host 헤더·자격 증명 없음·시간 제한).

## 남은 실기 검증 및 경계

실제 Tailscale HTTPS/Serve, Android Chrome, iPhone Safari, 홈 화면 PWA, Wi-Fi↔모바일 전환 및 60분 연결 유지 시험은 이 테스트에 포함되지 않는다. mocked core를 사용한 인증 시험이므로 실제 터미널 프로그램의 지속 실행/제어권 수명 검증은 통합 시험에서 따로 수행한다.

저장 실패 시 폐기 성공을 응답하지 않으며 해당 기기를 현재 호스트 실행 동안 차단한다. 저장 장치가 쓰기를 거부한 채 프로세스가 비정상 종료되면 미완료 폐기가 재시작 후 영속되었다고 보장하지 않는다. 30일 만료는 SQLite 시계 제어로 시험했으며 실제 30일 대기 시험은 수행하지 않았다. 세션 만료 타이머는 Node 최대 타이머 길이에 맞춰 재설정하고 요청·송신 시마다 유효성을 다시 검사한다.
