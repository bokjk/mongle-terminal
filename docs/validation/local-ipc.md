# Windows 로컬 소유자 연결 검증

검증일: 2026-09-29. 구현 파일: `packages/local-ipc/index.ts`, `platform/windows/OwnerPipe.cs`.

## 구현한 경계

- Electron main과 Node 호스트는 각자 같은 설치 경로의 `OwnerPipe.exe`를 실행한다. renderer나 HTTP 서버에는 소유자 비밀키가 전달되지 않는다.
- C# helper가 데이터 디렉터리와 `owner.secret`의 소유자를 현재 Windows SID로 확인한다. 디렉터리를 처음 만들 때 보호된 SID 전용 DACL을 함께 지정하며, 기존 디렉터리는 소유자 확인 후 DACL을 제한한다. 비밀키 파일은 `CreateNew`와 보호된 SID 전용 DACL로 원자적으로 만들고, 길이 32바이트 및 ACL을 검증한다. 상위 경로와 파일의 reparse point를 거부한다.
- 명명 파이프도 현재 SID만 허용한다. `PIPE_REJECT_REMOTE_CLIENTS`로 SMB 경유 연결을 차단하며, 첫 파이프는 `FILE_FLAG_FIRST_PIPE_INSTANCE`로 선점 충돌을 거부한다. SID 제한 mutex는 동일 디렉터리의 이중 서버 실행을 차단한다.
- helper의 실제 OS 부모 PID와 SID를 검증한 뒤 `owner-host.lock`을 공유 불가로 열고 파일 핸들을 Node 부모에게 복제한다. helper가 강제 종료·예외·입력 EOF로 종료되어도 부모 프로세스의 핸들이 남아 두 번째 호스트의 동일 저장소 진입을 막는다. 부모가 상속된 stdio로 명시적인 `stop`을 보낸 정상 종료와 준비 완료 알림 이전의 시작 실패에만 부모의 복제 핸들을 닫는다.
- 양쪽 helper는 커널이 알려 준 peer PID의 Windows SID와 실행 이미지의 전체 경로를 확인한다. 이후 32바이트 난수 두 개, 양쪽 PID, 파이프 이름, 프로토콜 버전, 역할을 포함하는 HMAC-SHA256 challenge/response를 상호 검증한다. 완료 응답에는 새 연결 ID도 묶인다. 과거 연결의 proof를 그대로 재사용할 수 없다.
- 클라이언트 요청은 최대 128 KiB JSON, 호스트 화면/응답은 최대 16 MiB JSON이다. 네이티브 프레임, base64 stdio 행(23 MiB), 프레임 대기열(24 MiB), Node 쓰기 대기열(32 MiB), helper stdout 대기열(64 MiB) 모두 상한이 있다. 연결당 처리 중인 RPC는 최대 64개, 파이프는 최대 15개 인증/진행 연결과 대기 인스턴스 1개를 허용한다.
- 인증 읽기는 단계별 5초 제한이며, 비밀키/proof/payload를 오류 로그에 출력하지 않는다. 앱 프로토콜 데이터는 인증 이후에만 전달한다. helper 종료 시 대기 중인 요청을 거부하고 연결을 닫는다.
- 새 디렉터리/종료된 호스트는 `NO_HOST`, 인증·ACL 오류는 `AUTH_FAILED`, 사용 중인 파이프의 연결 제한은 `HOST_BUSY`, 살아 있는 호스트의 저장소 잠금은 `HOST_ALREADY_RUNNING`으로 구분한다. 인증 실패를 새 호스트 실행의 근거로 사용하면 안 된다. 서버의 큰 출력이 대기열 상한을 넘으면 해당 화면 연결을 해제하고 공유 helper를 유지한다.

## 실제 실행한 검사

실행 명령: `node --import tsx --test tests/platform/local-ipc.test.ts`

결과: **7개 테스트 통과, 실패 0개, 건너뜀 0개**. Windows x64, Node 24.18.0, Windows 기본 .NET Framework C# 컴파일러로 네이티브 helper를 실제 빌드하고 실행했다.

| 검사 | 실제 확인 결과 |
|---|---|
| 요청·이벤트·동시 연결 | 한국어/이모지 요청, 초기 알림, 오류 응답, 12개 동시 RPC, 다른 연결 ID, 한 클라이언트 종료 후 다른 연결 계속 사용 통과 |
| 큰 화면과 입력 상한 | 16 MiB보다 1 KiB 작은 응답 본문 전달 통과, 128 KiB 초과 입력 요청 거부 후 정상 요청 계속 처리 |
| 저장소 ACL | 현재 SID 하나만 있는 디렉터리/비밀키 DACL과 상속 차단을 Windows ACL API로 확인, 비밀키 32바이트 확인 |
| 인증 거부 | 서버 시작 후 키 파일 변조 시 클라이언트 인증 실패, 같은 SID의 `node.exe` 직접 파이프 접속 거부, 두 경우 owner RPC 미도달 |
| 종료·중복 실행 | 이중 서버 실행 거부, 호스트 종료 시 응답 대기 중인 호출 거부 |
| 시작 오류 구분 | 아직 초기화하지 않은 디렉터리와 정상 종료 후 디렉터리 모두 `NO_HOST` 반환 |
| helper 단독 강제 종료 | helper를 강제 종료하고 Node 부모를 살려 둔 상태에서 새 호스트가 `HOST_ALREADY_RUNNING`으로 거부됨. 부모 종료 후 새 호스트 시작 가능, 정상 종료 후 같은 부모에서 반복 시작도 가능 |
| helper EOF·예외 종료 | stdin EOF와 잘못된 JSON 명령으로 helper를 각각 종료해도 부모가 살아 있는 동안 두 번째 호스트가 차단됨. 부모 종료 후 재시작 가능 |
| 준비 완료 전 시작 실패 | 같은 이름의 파이프를 먼저 점유해 helper 시작을 실패시켜도 부모 핸들이 남지 않음. 충돌 제거 후 같은 Node 부모에서 정상 시작 가능 |

`tsc --noEmit --pretty false`도 검사 시점에 오류 없이 통과했다. 전체 앱의 이후 병렬 변경은 별도 전체 검사 대상이다.

## 배포와 남은 검증

개발 모드 `ensureHelper()`는 저장소의 C# 소스가 새로워졌으면 기본 .NET Framework 컴파일러로 빌드하고 exe 절대 경로를 반환한다. 패키지는 빌드된 exe를 포함하고 `MONGLE_OWNER_HELPER`에 설치된 helper 경로를 지정한다. 이 변수는 실행 파일 위치이며 인증 비밀이 아니다. Node와 Electron이 서로 다른 설치 경로의 helper를 쓰면 실행 이미지 확인에 실패하므로 실행 중인 세션에 대한 업그레이드 정책은 별도로 지켜야 한다.

이 경계는 **다른 Windows 계정과 원격 네트워크 클라이언트**로부터 owner 채널을 보호한다. 같은 Windows 계정의 악성 프로그램이나 관리자가 이미 계정을 장악한 경우까지 보호하는 sandbox는 아니다. 다른 실제 Windows 계정 로그인 및 다른 PC의 SMB 공격 검사는 이번에 실행하지 않았다. nonce 재사용 방지는 구현을 검토했으며 네트워크 패킷 재주입 실험은 하지 않았다. helper 장애 시 호스트는 종료 절차를 수행해야 하며, 부모가 종료하기 전에는 중복 호스트를 실행할 수 없다.

공식 API 근거: [CreateNamedPipe의 보안 및 로컬 접속 옵션](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipea), [NamedPipeServerStream](https://learn.microsoft.com/en-us/dotnet/api/system.io.pipes.namedpipeserverstream), [서버 PID 확인](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid), [.NET 파일 생성과 ACL](https://github.com/microsoft/referencesource/blob/main/mscorlib/system/io/filestream.cs).
