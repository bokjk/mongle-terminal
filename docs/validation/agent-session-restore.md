# 업데이트 후 Claude·Codex 대화 재개

2026-10-07 개발, 2026-10-08 Codex 실제 앱 추가 검증. 미배포 작업이며 버전 변경·공개 배포·사용자 설치본 교체는 포함하지 않는다.

## 문제와 복원 경계

기존 업데이트는 작업 공간을 저장하고 실행부와 PTY를 종료한다. 다음 시작에서 같은 패널에 새 셸과 이전 출력은 복원하지만, Claude·Codex의 대화 연결은 사용자가 직접 재개해야 했다.

이번 변경의 목표는 각 패널에 연결된 정확한 CLI 대화 ID를 이용해 해당 대화를 다시 여는 것이다. 프로세스 메모리·진행 중 도구·셸 변수의 보존이나 이전 사용자 프롬프트의 재전송은 별개이며 자동으로 수행하지 않는다. 같은 폴더의 최신 대화를 추측해 선택하지 않는다.

## 확인한 CLI 계약

- 설치된 Codex CLI `0.160.0`의 `codex resume --help`: `codex resume <SESSION_ID>`로 특정 대화를 재개하며 뒤의 프롬프트는 선택 항목이다.
- 설치된 Claude Code `2.1.292`의 `claude --help`: `claude --resume <session-id>`를 지원한다. [공식 CLI 안내](https://code.claude.com/docs/en/cli-reference#cli-flags).
- [Claude 훅 안내](https://code.claude.com/docs/en/hooks#emit-terminal-notifications): `terminalSequence`는 대화형 터미널에 한해 허용된 OSC 신호를 전달한다. 기존 몽글 연동은 셸별 토큰을 검사한다.
- [Codex 훅 안내](https://learn.chatgpt.com/docs/hooks): 세션 ID와 작업 폴더를 제공하지만 비관리 훅은 신뢰 검토가 필요하다. 자동 복원을 위해 이 신뢰 검사를 우회하지 않는다.
- [Codex 알림 안내](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications): `notify`의 응답 완료 이벤트에는 `thread-id`와 `cwd`가 있다. 초기 세션 시작 이벤트와 같은 것으로 취급하지 않는다.

## 검증 기록

### 지원 조건과 남은 제한

- Claude는 기존 Windows 네이티브 자동 연동이 준비되고 정확한 ID·폴더가 수집된 대화를 대상으로 한다. 훅을 차단했거나 수집 전에 종료한 대화는 복원할 수 없다. WSL은 대상이 아니다.
- Codex는 CLI 0.160.0 이상, PowerShell에서 몽글이 제공하는 `codex` 함수로 시작한 대화가 대상이다. 대화형 실행·`resume`·`fork`에 `--no-daemon`을 적용해 다른 창의 공유 실행부와 대화 정보가 섞이지 않게 한다. 기존 사용자 `codex` 함수·별칭은 덮어쓰지 않는다.
- Codex 관리 훅 등록은 신뢰 완료를 뜻하지 않는다. 사용자가 Codex의 `/hooks`에서 몽글터미널 훅을 검토·신뢰한 뒤 Codex를 다시 시작해야 한다. 제품의 설치 코드는 `config.toml`의 신뢰 상태, 인증, 기존 알림 설정을 변경하지 않는다. CLI 0.160.0의 정상 신뢰 절차를 거친 실제 재개 결과는 아래 추가 검증에 기록한다.
- Codex의 cmd·Git Bash·WSL 실행, 실행 파일의 절대 경로 직접 호출, 기존 사용자 함수·별칭을 통한 실행, 원격 실행은 자동 수집 대상이 아니다. Codex 설정 폴더에 공백·지원하지 않는 특수 문자가 있으면 훅을 설치하지 않고 사용 불가로 안내한다. 한 셸 안에서 CLI를 겹쳐 실행하는 경우는 지원하지 않는다.
- 모델 명령에서 Codex를 중첩 실행하는 경우 래퍼의 `CODEX_THREAD_ID` 검사는 있지만, 모델이 실행 파일을 직접 호출하며 수집 환경을 상속하는 경우는 실기 미검증이다. 중첩 실행의 정확한 대화 귀속을 보장하지 않는다.
- 이 기능은 실행 중인 프로세스를 보존하지 않는다. CLI 실행 옵션·임시 `--settings`·모델 선택·권한 옵션·셸 변수·진행 중 도구는 재현하지 않는다. 각 CLI의 기본 설정으로 정확한 대화를 다시 열며 이전 요청은 재전송하지 않는다.
- 이번 기능 이전 실행부에는 ID가 없으므로 첫 업데이트에서 이전 대화를 소급 복구할 수 없다. 새 실행부가 연동으로 식별한 대화부터 적용한다. CLI를 종료하고 셸로 돌아온 대화, 명시적으로 종료·삭제·새 셸로 다시 연 패널은 재개하지 않는다.
- 대화 ID·작업 폴더는 호스트 내부 메타데이터에만 넣으며 상태 응답·설정 내보내기에서 제외한다. 화면에 표시된 재개 명령·CLI 출력에는 기존 화면 공유·기록 규칙이 적용된다.

### 수행 범위

UI 안내는 기존 설정·종료 확인 위치를 유지한다. Aside에서 [Mobbin Status Dot](https://mobbin.com/explore/web/ui-elements/status-dot)의 Better Stack Incident Dashboard와 Front Inbox Email Thread 공개 미리보기를 직접 확인했다. 작업 목록 옆의 작은 상태 안내와 대화 영역을 함께 유지하는 방식을 참고했으며, 이 변경에서는 별도 복원 화면이나 필수 모달을 추가하지 않는다. 기존 업데이트·완전 종료 안내에서 대화 재개와 진행 중 작업의 복구를 구분한다.

공통 복원·Claude 구현 시점의 검사:

- 타입 검사와 웹·호스트·데스크톱 빌드 통과.
- 호스트·터미널 비브라우저 25개 파일 검사: **220/220 통과**.
- 개인정보·동일 폴더의 두 대화·명시적 새 셸·메타데이터/화면 저장 실패: **5/5 통과**. 실제 HostCore·SQLite·VT를 쓰고 자식 실행 파일과 입력만 시험 대역으로 바꾼 검사이며, 실제 CLI 성공을 뜻하지 않는다.
- 독립 비브라우저 회귀 52개 파일: **417개 중 414 통과·0 실패·3 선택 생략**. `MONGLE_DATA_DIR`는 격리 폴더로 지정했고, Windows 시험 프로세스에만 실행 정책을 지정했다. Codex 연동 최종 변경 전 결과다.
- 처음 회귀 목록의 Windows 경로 구분자 차이로 브라우저 제외가 적용되지 않아 해당 실행은 중단했다. 이후 파일 내용을 직접 검사해 목록을 만들었다. 중단한 실행을 전체 검사 통과로 집계하지 않는다.

로컬 증거는 `test-results/agent-resume-nonbrowser-files.json`, `agent-resume-nonbrowser-regression.log`, `agent-resume-nonbrowser.log`, `agent-resume-build.log`에 있다. 개인 경로나 시험 프로필이 포함될 수 있어 배포·커밋하지 않는다.

최종 코드의 추가 검사:

- 타입·빌드·배포 문서 정합성 검사 통과. 버전은 `0.3.16` 그대로다.
- HostCore·종료·저장소·작업 공간 및 화면 기록 복원 **62/62 통과**. 로그: `agent-resume-final-lifecycle.log`.
- 세션 수집·비공개 저장·입력 취소·Codex 연동·셸 검사에서 **36개 중 35 통과·1 실패** 후 시험 환경을 수정했다. Windows의 `PATH`/`Path` 중복 때문에 가짜 CLI 경로가 제외된 시험 코드 문제로, PATH 키를 하나로 만들고 실행 정책과 무관한 시험용 `.cmd`를 사용했다. 제품 변경 없이 해당 Codex 검사 **7/7 재검사 통과**. 로그: `agent-resume-final-tests.log`, `agent-resume-codex-retest.log`. 이 7개는 실제 Codex 로그인·신뢰·대화 재개의 성공을 뜻하지 않는다.
- 2026-10-08 복원 입력·비공개 저장·Claude/Codex 연동·셸 프로필·대화 ID의 6개 파일을 묶어 다시 실행해 **35/35 통과·생략 0**을 확인했다. 로그: `agent-resume-final-recheck.log`. 위 36개 묶음에 포함됐던 별도 Claude 상태 PTY 검사 1개는 이번 재실행에 포함하지 않았다.
- 실제 앱에서 처음 발견한 복원 실패를 수정했다. 화면 연결 때의 포커스 보고를 사용자의 입력으로 취급해 대기 중 재개 명령을 취소하던 문제다. 포커스·마우스·장치 보고는 제외하고 실제 키 입력은 재개 의도와 함께 취소한다. 첫 프롬프트 전에 다시 종료해도 정확한 대화 ID를 새 세대에 보존하는 회귀도 추가했다.
- 디렉터리 패키징·Node 네이티브 모듈·실행 파일 아이콘 검증 통과. 최초 실행은 시스템 Node 설치 폴더의 LICENSE 누락으로 중단했다. 같은 Node `24.11.1`과 기존 라이선스가 있는 프로젝트 `runtime/node.exe`로 다시 실행해 통과했다. 로그: `agent-resume-package-retry.log`. 설치 파일 실행·사용자 설치본 교체·공개 배포를 수행한 것은 아니다.
- 독립 읽기 전용 검토에서 확인된 재개 의도 유실 문제를 수정했고, 최종 core 및 main/pipe 연결 검토에서 추가로 확정된 P1/P2는 없었다.

실제 Electron 개발 앱의 최종 Claude 재검사에서 정확한 UUID의 `claude --resume`가 실행되어 기존 시험 대화가 다시 열린 것을 확인했다. Astra가 실제 창을 관찰했고 호스트·터미널 식별, SQLite의 대화 ID와 실행 결과를 함께 대조했다. 최종 호스트 SHA-256은 `61916EB8BC7446AF16D29E51E0E0F57F1BD0947E8964E802F02604B8C05B79D4`다. 로컬 증거는 `test-results/agent-resume-desktop/final-build-sha256.json`, `final-claude-resumed.png`, `frame-final-resumed.json`, `final-resumed-sqlite.json`이다. 이전 실패 이력과 구분한다.

CLI 종료 후 셸로 돌아온 상태의 추가 부팅에서는 재개 정보가 비어 있고 새 셸만 열리는 것도 확인했다(`final-negative-sqlite.json`, `frame-final-negative.json`, `final-negative.png`). 원하지 않는 대화를 다음 부팅에 다시 여는 동작과 구분한다.

실제 설정·앱 업데이트·도움말의 복원 경계 안내도 확인했으며 시험 앱·호스트·셸은 식별값을 대조해 정상 종료했다. `FINAL-QA-RESULT.md`, `final-assertions.json`, `final-complete-cleanup.json`에 결과를 남겼다. 로컬 스크린샷·시험 대화·경로 정보는 커밋하거나 배포하지 않는다.

Claude 최초 수집은 인증 정보를 복사하지 않고 격리된 `--settings` 훅으로 실제 응답을 받은 시험이다. 정상 사용자 설정에 관리 훅이 설치된 환경에서 재개 후 새 훅 보고까지 다시 수집하는 Claude 연속 재개는 별도 검증 대상이다. Codex 조사 중 신뢰 검사를 우회한 격리 탐색 실행은 지원·실기 성공 근거에서 제외하며, 제품에는 신뢰 우회 코드가 없다. 실제 NSIS 업데이트 교체·전체 브라우저 회귀·공개 배포는 수행하지 않았다.

### 2026-10-08 Codex 정상 신뢰·연속 재개 추가 검증

Astra가 실제 Electron 개발 앱에서 Codex CLI `0.160.0`을 조작·관찰했다. 몽글 데이터와 작업 폴더는 `%TEMP%` 아래에 격리하고, 기존 ChatGPT 로그인을 정상 경로로 사용했다. 인증 파일을 복사하거나 `CODEX_HOME`을 다른 사용자 프로필로 바꾸지 않았다. 호스트 빌드 해시는 위 Claude 최종 검사와 같다.

사용자가 명시적으로 승인한 몽글 `SessionStart`·`SessionEnd` 훅 두 개만 Codex `/hooks` 상세 화면에서 신뢰했다. 다른 플러그인 훅이나 프로젝트 권한은 변경하지 않았다. 이는 검증 중 사용자의 신뢰 승인이지 제품의 자동 신뢰 처리가 아니다.

- 무해한 한 줄 응답을 요청한 대화 A에서 정확한 UUID·작업 폴더가 수집됐다.
- 앱과 실행부를 정상 종료하고 같은 격리 데이터로 시작하자 새 터미널 generation에서 `__MongleCodex resume <A UUID>`가 자동 실행됐다. 실제 Codex 화면에 A의 기존 응답이 다시 열렸다.
- 복원된 Codex에서 `/new`로 대화 B를 만들고 한 줄 응답을 받자, 같은 터미널 generation의 저장된 UUID가 A에서 B로 바뀌었다. 이전 메타데이터의 단순 보존뿐 아니라 새 훅 보고가 다시 수집되는 것을 확인했다.
- 다시 정상 종료·시작한 새 generation에서 B의 정확한 UUID로 자동 재개됐고 실제 B 응답이 열렸다. 재개를 위해 사용자가 `resume` 명령을 입력하거나 이전 요청을 재전송하지 않았다.
- `/exit`로 Codex를 끝내고 셸로 돌아오자 저장된 대화 정보가 비었다. 다음 부팅에서도 비어 있는 상태를 유지하고 일반 PowerShell만 열렸다. 시험 앱·실행부·셸은 식별값을 대조한 정상 종료로 모두 종료됐다.

Codex 자체의 `0.160.1` 업데이트 안내는 시험 중 건너뛰었다. 몽글의 자동 재개 명령 실행과 CLI 자체의 업데이트·로그인·신뢰 안내는 별개이며, CLI가 요구하는 조작을 자동 승인하지 않는다. CLI 버전은 교체하지 않았다. `/new` 직후에는 기존 ID가 남았고 새 요청 처리가 시작된 뒤 B ID가 수집됐다. 화면의 경고 1개는 기존 `network_access` 설정을 Codex가 무시한다는 안내였으며 해당 설정은 변경하지 않았다.

로컬 증거는 `test-results/codex-resume-desktop/`의 `trust-approved.json`, `a-response-sqlite.json`, `a-resumed-sqlite.json`, `frame-a-resumed.json`, `a-resumed.png`, `b-response-sqlite.json`, `b-resumed-sqlite.json`, `frame-b-resumed.json`, `b-resumed.png`다. 대화 UUID·개인 경로·스크린샷은 커밋·배포하지 않는다. 이 결과는 실제 설치 프로그램으로 앱을 교체한 종단간 업데이트 성공과 구분한다.

종료 후 재실행 방지와 정리 증거는 `exited-sqlite.json`, `negative-sqlite.json`, `frame-negative.json`, `negative.png`, `complete-cleanup.json`이다. 부모 검토에서도 A/B의 정확한 ID 일치, 재시작마다 generation 변경, 같은 generation에서 A→B ID 교체, 새 Codex 전체화면의 실제 응답, 종료 뒤 메타데이터 제거를 별도로 대조했다.

검증 후 이번에 추가한 두 신뢰 section만 현재 `config.toml`에서 제거하고 다른 설정은 보존했다. 관리 훅 파일은 설치 당시 해시가 바뀌지 않았음을 확인한 뒤 원래 `hooks.json` 해시로 복원하고, 새 관리 스크립트를 제거했다. 인증·사용자 대화 기록은 건드리지 않았다. 자동 생성된 설정 백업과 해시 이름의 Node 런타임 캐시는 보수적으로 남겼으며 활성 훅이나 신뢰 항목은 남기지 않았다. `hook-cleanup.json`에 정리 범위를 기록했다.

최종 로컬 보고서는 `FINAL-QA-RESULT.md`, 교차 검사 결과는 `assertions.json`에 있다. 두 무해한 시험 대화는 Codex의 정상 대화 저장소에 남겼다.
