# 현재 Tailscale 환경 검증

2026-09-29 08:34 KST, **사용자 Serve 승인 후 같은 Windows PC의 실제 Tailscale HTTPS·WSS 연결 시험을 통과했다.** 결과는 `serve-result.json`의 `status: PASS`에 기록했다.

격리된 데이터 폴더의 몽글 호스트에서 private Serve를 활성화하고 실제 HTTPS 주소로 호스트 식별자를 확인했다. 이어 기기 연결 요청, 로컬 소유자 승인, 인증 쿠키 발급, CSRF와 단일 사용 WebSocket 티켓, WSS 인증과 `state.get`의 호스트 식별자 일치를 검증했다. 인증서 검증을 우회하지 않았다.

격리 시험 후에는 시험용 원격 인증을 폐기하고 임시 Serve 경로 및 호스트를 종료했다. `cleanup.serveRemoved: true`였고 별도 CLI 확인에서도 `tailscale serve status --json`이 기존 설정과 같은 `{}`였다. 이후 사용자의 휴대폰 접속 요청에 따라 사용자용 호스트와 private Serve를 다시 실행했으며, 현재 실제 세션과 접속 주소를 유지하고 있다.

초기에는 Windows Tailscale이 Running·Self Online으로 정상 로그인되어 있었지만 `/f/serve?node=…`의 최초 사용 승인이 필요했다. 필요한 것은 프로그램 재로그인이 아니라 Serve·HTTPS 사용 승인이었다. 사용자가 승인한 뒤 해당 단계는 통과했다. 첫 HTTPS 요청은 `fetch failed`였고 바로 다음 재검증은 전 과정 통과했다. 첫 요청 실패의 원인은 확정하지 않았다. 현재 검증 스크립트는 후속 진단을 위해 HTTPS 요청 시간 제한과 하위 오류 정보를 기록한다.

사용자는 실제 휴대폰에서 승인 후 접속했음을 확인했다. 이어 키보드가 열렸다 닫히는 문제를 보고해 입력 포커스·화면 크기 동기화를 수정했다. 08:57 KST에 기존 호스트와 PowerShell을 재시작하지 않고 웹 수정본을 배포했으며, 이후 사용자가 Android 삼성 인터넷에서 정상 동작을 확인했다. 자세한 검증 범위는 [모바일 키보드 수정](mobile-keyboard.md)에 기록한다.

공개 Funnel은 사용하지 않았다. 한 휴대폰의 사용자 확인은 Android/iPhone 전체 호환성, Wi-Fi와 모바일 데이터 전환, 60분 active/idle·8시간 지속 시험의 성공을 뜻하지 않는다. 브라우저의 쿠키 처리와 모바일 크기 화면·입력·재접속은 별도 UI/E2E 시험에 기록한다.

09:31 KST에는 PowerShell의 이전 출력에 대한 터치 스크롤 수정본을 같은 호스트에 무중단 적용했다. 이후 사용자가 Android 삼성 인터넷에서 **“스크롤 잘 됨”**으로 확인했다. [모바일 스크롤 기록](mobile-scroll.md)
