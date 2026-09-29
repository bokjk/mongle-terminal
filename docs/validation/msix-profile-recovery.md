# MSIX 설정 폴더 분리로 인한 원격 연결 복구

2026-09-29, Windows x64. 사용자가 실제 앱에서 원격 접속 켜기를 눌러도 기존 HTTPS 연결을 몽글 전용으로 확인하지 못한다는 오류가 계속 발생했다. 앞선 검사 환경의 성공을 실제 사용자 앱의 성공으로 전달한 검증 오류였다.

## 확인된 원인

Codex의 MSIX 실행 맥락에서는 `%LOCALAPPDATA%/MongleTerminal` 파일이 Codex 패키지의 `LocalCache/Local/MongleTerminal`로 리디렉션됐다. 탐색기에서 실행한 몽글터미널은 실제 사용자 AppData를 사용했다. 같은 경로 문자열이어도 서로 다른 인증 키·호스트 DB·원격 관리 기록을 읽었다. 이는 Microsoft가 설명하는 [MSIX 파일 시스템 가상화](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)의 동작과 일치한다.

- `fsutil hardlink list`에서 검사 환경의 `owner.secret`, `gateway-port.json`, `remote-serve.json`이 Codex 패키지 LocalCache 파일로 확인됐다.
- 독립 WMI 파일 정보에서는 실제 AppData의 키 생성 시각이 달랐고, 실제 `remote-serve.json`은 없었다. 키 내용은 출력하거나 복사하지 않았다.
- 패키지 리디렉션을 상속하지 않는 숨김 진단 프로세스로 실제 앱의 정상 owner IPC 인증에 성공했다. 실제 gateway 포트와 readiness·`host.info`·`state.get`의 hostId·bootId가 일치했고 원격 접속은 꺼진 상태였다.
- Tailscale에는 검사 환경에서 만든 이전 단일 HTTPS 경로가 남았고 그 대상 포트는 더 이상 열려 있지 않았다. 실제 앱에는 해당 경로의 관리 기록이 없어 자동 인수를 거부했다. 앱의 출처 확인 검사가 실패한 것이며, 다른 서비스를 무조건 덮어쓰도록 완화할 문제가 아니었다.

## 복구 원칙

이전 몽글 관리 기록과 현재 Tailscale 경로가 정확히 일치하고 다른 웹 서비스가 같은 DNS를 공유하지 않는지 먼저 확인한다. 대상이 더 이상 실행 중이지 않으며 실제 호스트가 별도로 인증된 경우에만 **원격 경로 관리 기록 한 파일**을 실제 프로필에 복원한다. 기존 파일이 생겼으면 덮어쓰지 않는다.

이후 실제 호스트의 `remote.enable`을 사용하여 기존 경로의 내부 대상 포트만 바꾸고 실제 프로필에 주소를 저장한다. 소유자 인증 키, 기기 승인 DB, 터미널 DB, 과거 gateway 포트는 복사하지 않는다. Tailscale 전체 초기화나 실제 호스트·셸 종료는 사용하지 않는다.

앞선 `remote-recovery.md`의 HTTPS 성공은 Codex 맥락에서 실행했던 호스트에 대한 결과였다. 실제 사용자가 탐색기로 다시 실행한 앱까지 검증한 결과로 해석하면 안 된다. 이번 실제 프로필 기준 결과는 아래에 별도로 기록한다.

## 실제 복구 결과

실제 사용자 앱을 켜둔 상태에서 복구했다. 검증된 과거 관리 기록만 실제 프로필에 `wx`로 새로 만들고 정상 소유자 RPC의 `remote.enable`을 사용했다. 이후 실제 관리 기록은 현재 게이트웨이 대상으로 저장됐다.

- 실제 사용자 호스트의 owner IPC 인증·readiness·hostId·bootId 일치 확인.
- 복구 프로세스 종료 후 새 진단 프로세스로 다시 인증해 실제 프로필의 현재 gateway 포트·복원된 원격 관리 기록·원격 켜짐 상태가 유지되는지 확인.
- Tailscale 전후 JSON을 비교하여 기존 HTTPS `/`의 내부 Proxy만 바뀐 것을 확인. 다른 경로 추가·제거, 전체 초기화, Funnel 활성화 없음.
- `remote.enable`을 두 번 호출해 동일 주소 반환·설정 불변·`remote.status.enabled=true` 확인.
- 인증서 검증을 유지한 HTTPS `/health` 응답 200. 실제 로컬 호스트의 hostId·bootId와 일치.
- HTTPS에서 받은 HTML·JS·CSS의 SHA-256이 QR이 포함된 최신 웹 빌드와 일치. 기기 승인 없는 `/v1/state` 접근은 401 유지.
- GUI와 호스트를 종료하지 않았고, 실행 중인 PowerShell 1개의 ID·PID·상태와 호스트 bootId 유지. 소유자 키 파일의 생성·수정 시각도 그대로였으며 키·DB에 대한 쓰기 작업은 없었다.

실행 증거는 `.test-data/remote-qr/repair-real-owner.ts`와 `test-results/remote-qr/real-repair-before.json`, `real-repair-result.json`, `real-owner-probe.json`이다. 개인 호스트 이름과 식별자가 있는 자료는 커밋하지 않는다. 실제 휴대폰 카메라 스캔과 연결 승인은 별도 사용자 확인 대상이다.

재발 방지를 위해 AGENTS와 README에 시험 데이터 격리, MSIX 파일 리디렉션 확인, 실제 프로필 인증 후 복구 원칙을 추가했다. 일반 설치 앱의 인증·경로 소유권 검사는 완화하지 않았다.
