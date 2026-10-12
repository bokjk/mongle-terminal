# 휴대폰 알림 구현과 검증

기준: 2026-10-12, Windows x64, 0.3.21 공개(브랜치 `feat/phone-notifications`). 공개 검증은 [0.3.21 배포 검증](public-release-0.3.21.md#final)을 따른다. 사용자 요청: Claude·Codex의 질문·권한 요청과 새 기기 연결 요청을 휴대폰으로 받되, 계속 보내지 않도록 PC 앞에 없을 때만 보낸다. 기준은 사용자가 승인한 "Windows 화면 잠금 또는 5분 동안 키보드·마우스 입력 없음"이다. 응답 완료는 보내지 않는다.

## 동작

- 휴대폰 브라우저(또는 홈 화면 앱)의 **설정 → 원격 연결 → 이 기기로 알림 받기 → 알림 켜기**가 브라우저 알림 권한을 묻고 Web Push 구독을 만든 뒤 PC 호스트에 등록한다. **시험 알림 보내기**는 조건 없이 바로 보낸다. **알림 끄기**는 PC와 브라우저의 구독을 모두 지운다.
- 호스트는 터미널이 `attention`(Claude: 권한 요청·질문, Codex: `PermissionRequest`·`request_user_input`. 미배포 변경부터 `PermissionRequest`는 Codex가 승인 창을 띄운 경우만)에 들어갈 때와 새 기기 연결 요청이 들어올 때 보낼 요청을 만든다. 터미널이 다른 상태로 바뀌거나, 연결 요청이 결정·만료되면 지운다.
- 보낼 요청과 구독한 기기가 있으면, 어느 기기도 이 PC의 몽글 화면을 보고 있지 않고(닫은 지 5분 이상) PC가 자리 비움일 때 기기마다 한 번 보낸다. PC 앞에 있으면 5분 무입력이 가능해지는 시각(최대 1분 간격, 잠금 확인용)에 다시 본다. 실패하면 30초 간격으로 세 번까지 시도하고, 404·410이면 구독을 지운다.
- 알림을 누르면 `/?terminal=<id>` 또는 `/?open=pairing`이 열리고, 웹 화면이 그 터미널을 고르거나 설정의 원격 연결 탭을 연다. 이미 열린 창이 있으면 그 창을 앞으로 가져와 같은 동작을 한다. 화면을 다시 보면 표시된 알림을 닫는다.
- PC 앱은 다른 PC에 연결해 있으면 창이 보이고 최소화되지 않았으며 최근 1분 안에 입력이 있을 때 그 PC에 '보는 중'을 알린다.

## 디자인 참고

2026-10-12 Aside로 Mobbin 공개 페이지를 직접 열어 확인했다(로그인 없이 보이는 범위).

- [Enabling notifications on The Atlantic Magazine](https://mobbin.com/explore/flows/e284e015-3565-4532-a324-e6eec247ad4c): 설정의 **Notifications** 묶음에 행 하나와 켜기 스위치만 둔다.
- [Permission 화면 모음](https://mobbin.com/explore/mobile/screens/permission): Turo의 "Stay up to date"는 허용하면 받을 알림을 목록으로 보여 주고 **Allow notifications** 버튼 하나를 둔다. Citizen은 실제 알림 모양의 예시를 보여 준 뒤 계속을 누르게 한다. Nextdoor·Ubank는 이유 한 줄과 **Enable notifications / Not now**를 둔다. 모두 시스템 권한 창보다 먼저 이유를 설명한다.

적용: 별도 온보딩 창 없이 기존 설정의 원격 연결 탭에 구역 하나를 더했다. Turo처럼 받을 알림 두 가지를 목록으로, Citizen처럼 실제 알림 모양의 예시 카드(PC 이름과 예시 문구)를 보여 주고, 보내는 조건과 담기는 내용을 한 문단으로 밝혔다. 주 버튼 **알림 켜기**를 눌러야 브라우저 권한 창이 뜬다. 켠 뒤에는 The Atlantic처럼 상태 한 줄과 **시험 알림 보내기**·**알림 끄기**만 남긴다. 차단됐으면 사이트 설정 안내와 **다시 확인**을 보여 준다. PC 앱에는 연결한 기기 목록에 "알림 받음"과 휴대폰에서 켜는 위치 안내만 더했다.

## 구현

| 위치 | 내용 |
|---|---|
| `packages/host/web-push.ts` | RFC 8291 aes128gcm 암호화, RFC 8292 VAPID ES256 서명, 구독 검사(https·공개 도메인·기본 포트, P-256 점·16바이트 auth), 리디렉션 없는 전송·404/410 판정. `node:crypto`만 쓴다. |
| `packages/host/push-notifier.ts` | 보낼 요청 관리, 화면 보는 중·PC 자리 비움 판정, 기기별 1회 전송, 재시도, 시험 알림 |
| `packages/host/presence.ts`, `platform/windows/OwnerPipe.cs` | `OwnerPipe.exe presence`: 세션 잠금(`WTSSessionInfoEx`)과 마지막 입력 뒤 시간(`GetLastInputInfo`)만 JSON으로 출력. 세션 ID가 현재 프로세스와 같을 때만 값을 믿는다. |
| `packages/auth/store.ts` | `push_subscriptions` 표, VAPID 키 보관, 기기 해제·원격 주소 변경 시 삭제, `devices.list`의 알림 여부 |
| `packages/host/gateway.ts` | 기기별 `push.*`·`presence.update` 처리(core 미전달), 연결 요청 알림, 보는 중 판정 |
| `packages/host/core.ts`, `packages/host/main.ts` | 상태 방송을 알림에 전달, `notifications.push` 기능 표시, 격리 프로필 전용 `MONGLE_TEST_PC_PRESENCE` |
| `apps/web/public/sw.js` | push 표시와 알림 클릭만 처리. fetch 처리기·Cache API 없음 |
| `apps/web/src/PushSettings.tsx`, `push.ts`, `use-push.ts`, `App.tsx`, `Settings.tsx` | 설정 화면, 구독·해제, 화면 표시 보고, 알림 클릭 이동, PC 앱의 알림 받음 표시 |
| `apps/desktop/main.ts` | 다른 PC에 연결한 PC 앱의 보는 중 보고(`powerMonitor`) |

보안 설계와 남는 한계는 [보안 문서](../03-security-and-remote.md#휴대폰-알림web-push--2026-10-12-추가)에 적었다.

## 자동 검사

- 타입 검사, `npm run build`(`dist/web/sw.js` 포함) 통과.
- `tests/host/web-push.test.ts` 5/5: RFC 8291 예제(5절·부록 A)와 바이트 단위 일치(144바이트. 예제 요청의 `Content-Length: 145`와 달리 예제 본문은 144바이트다), 메시지마다 새 키·salt, 다른 브라우저 복호화 실패, VAPID 서명을 공개 키로 검증, 구독 주소·키 거부 11가지, 전송 헤더와 404·410·429·네트워크 오류 판정.
- `tests/host/push-notifier.test.ts` 9/9: 이름만 담은 요청 1회 전송, PC 앞에 있을 때 보류 후 자리를 비우면 전송, 답한 요청 미전송, 완료·오류·작업 중·종료된 터미널 미전송, 구독이 없으면 PC 상태를 읽지 않음, 화면을 닫은 뒤 5분 보류, 연결 요청의 주소별 대상·결정·만료, 410 구독 삭제와 세 번 재시도, 시험 알림 오류 안내, 종료.
- `tests/host/presence.test.ts` 3/3: 잠금·다른 세션·5분 무입력 판정, 조회 실패 시 전송 쪽 판단, 실제 `OwnerPipe.exe presence` 출력 형식. 이 PC에서 직접 실행한 출력은 `{"session":"active","locked":false,"idleMs":159875}` 형식이었다(입력 내용 없음).
- 보안 32/32(게이트웨이 신규 3, 인증 저장소 신규 2): [인증·원격 게이트웨이 검증](security.md).
- `tests/ui/push-settings.test.ts` 1/1(Chrome, 모의 Push API): 설명·예시, 버튼을 눌러야 권한 창, 이 PC 키로 `userVisibleOnly` 구독, 호스트 등록 형식, 시험 알림 성공·실패 안내, 끄기, 차단 안내와 다시 확인, 기능이 없는 PC에서 숨김, 지원하지 않는 브라우저·iPhone 안내, PC 앱에서 숨김, 390·320px 가로 넘침 없음.
- 격리한 `MONGLE_DATA_DIR`의 전체 회귀 647개 중 629 통과·1 실패·17 생략. 실패 1개는 이 PC의 PowerShell 실행 정책이 배포 스크립트 시험을 막은 기존 환경 문제다.

## 실제 확인

2026-10-12 아스트라가 격리 시험 앱(`MONGLE_TEST_PC_PRESENCE=away`)과 Aside로 확인했다. 시험 빌드는 `ec1917d`이고, 공개한 0.3.21과는 알림 전송 요청에서 `Topic` 머리글을 뺀 것과 문서만 다르다. 기록은 커밋하지 않는 `test-results/phone-notifications-live/`에 있다.

- 확인한 것: 시험 호스트가 제공한 실제 화면의 원격 연결 탭에 **이 기기로 알림 받기** 구역이 나왔다. 받을 알림 두 가지, PC 이름과 `작업 · PowerShell: Claude가 확인을 기다리고 있습니다.`가 든 알림 예시, 자리 비움과 5분 조건, 출력·연결 코드를 담지 않고 응답 완료는 알리지 않는다는 설명이 보였다. PC 앱의 연결 기기 목록 위에는 휴대폰 알림 설정 안내가 보였다.
- 확인하지 못한 것: 시험 탭 두 개에서 **알림 켜기**를 눌렀지만 조작할 수 있는 브라우저 알림 권한 창을 찾지 못했다. 버튼은 회전 표시와 함께 1분 넘게 기다렸고, 상태 문구는 꺼짐 그대로였으며 오류 문구는 없었다. 정리 전에 격리 인증 DB에서 구독 개수만 읽기 전용으로 세어 0건임을 확인했다(주소·키는 읽지 않음). 그래서 구독 등록, 시험 알림 수신, 확인 요청·새 기기 연결 알림, 알림을 눌렀을 때의 이동, 화면을 닫은 뒤 5분 보류, PC 앱의 **알림 받음** 표시는 확인하지 못했다. Aside 실행 환경 때문인지 제품 문제인지 단정하지 않으며, 실물 휴대폰에서 다시 확인한다.
- 같은 시험에서 실제 Codex의 승인·거절·중단·질문 표시를 확인했다. [Codex 작업 상태 기록](codex-status.md#동기-훅-실제-확인-2026-10-12)에 적었다.

## 확인하지 않은 범위

- 0.3.21에서는 Codex가 같은 차례에서 함께 실행한 도구가 먼저 끝나면 아직 승인을 기다리는 요청의 알림이 빠질 수 있었고, Codex 자동 검토가 처리하는 요청에도 알림이 나갔다. 둘 다 [Codex 작업 상태 기록](codex-status.md#동시-실행과-자동-검토)대로 고쳤다(미배포). 실제 Codex와 휴대폰 수신으로는 아직 확인하지 않았다.
- 실물 휴대폰(Android Chrome·삼성 인터넷, iPhone 홈 화면 앱)에서 알림 허용·구독·수신과 알림을 눌렀을 때의 이동. 실제 원격 주소(Tailscale HTTPS)는 사용자의 실행 PC에만 있어, 사용자가 PC를 0.3.21로 업데이트한 뒤 사용자 휴대폰에서 확인한다.
- 브라우저가 알림 권한 요청에 답하지 않으면 **알림 켜기**가 다른 안내 없이 계속 기다린다(Aside에서 관찰). 실물 휴대폰에서도 권한 창이 보이지 않는 경우가 있는지 확인한 뒤 안내 문구를 넣을지 정한다.
- 실제 Windows 잠금 상태의 판정(PC를 잠그지 않았다). 잠금 판정은 문서화된 API와 세션 ID 검사로 구현했고, 이 PC의 잠금 해제 상태 출력만 확인했다.
