# 몽글터미널

**그룹과 분할 화면으로 작업을 정리하고, 다른 기기에서 같은 터미널에 이어서 접속하는 Windows 앱입니다.** PowerShell·명령 프롬프트와 설치된 Git Bash·WSL을 사용합니다. Codex 같은 프로그램은 터미널에서 직접 실행합니다.

현재 버전은 `0.1.0` Windows 미리보기입니다. 자동 검사와 실제 앱의 완전 종료·재실행 후 작업 공간 복원 검증을 통과했습니다. Tailscale로 연결한 Android 삼성 인터넷에서 키보드 입력과 이전 출력 스크롤도 확인했습니다. PC 재부팅 자체는 시험하지 않았습니다. 배포 결과와 검증 범위는 [구현·검증 상태](docs/IMPLEMENTATION-STATUS.md)를 확인하세요. 초기 설계와 오픈소스 분석은 `docs/01-...`부터 이어지는 문서에 보존합니다.

## 실행

개발 환경은 Windows 11 x64와 Node.js 24 LTS입니다. 배포본에는 별도 Node 실행부를 포함하므로 배포본 사용자는 Node.js를 설치할 필요가 없습니다.

```powershell
npm.cmd ci
node node_modules/node-pty/scripts/prebuild.js
node node_modules/node-pty/scripts/post-install.js
node node_modules/esbuild/install.js
node node_modules/electron/install.js
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd start
```

위 준비 단계는 고정된 의존성의 공식 설치 스크립트를 실행합니다. npm이 의존성 설치 스크립트를 차단하거나 Electron 바이너리를 자동으로 내려받지 않은 경우에도 네이티브 런타임을 준비합니다. 최초 다운로드에는 인터넷 연결이 필요합니다.

`npm.cmd run dev`는 빌드 후 데스크톱 앱을 실행합니다. `npm.cmd run package`는 `release/`에 설치 프로그램 `MongleTerminal-Setup-0.1.0-x64.exe`와 압축 배포본 `MongleTerminal-0.1.0-x64.zip`을 생성하도록 구성되어 있습니다. `release/win-unpacked/MongleTerminal.exe`는 압축 전 실행 파일입니다. 실제 산출물과 검증 상태는 [구현·검증 상태](docs/IMPLEMENTATION-STATUS.md)를 확인하세요. `npm.cmd run host`는 개발용 실행이며, 명령을 실행한 터미널을 닫아도 작업이 유지되는 배포 경로의 검증을 대신하지 않습니다.

## 동작

- 왼쪽 위에서 컴퓨터를 선택하고, 아래에서 그 컴퓨터의 그룹을 선택합니다.
- 오른쪽 터미널을 좌우·상하로 나누고 크기를 조절합니다. 그룹 전환은 실행 중인 셸을 종료하지 않습니다.
- 앱 창을 닫아도 별도 백그라운드 실행부가 살아 있으면 셸은 계속 실행됩니다. 터미널 종료나 모든 작업 종료는 프로세스를 실제로 끝냅니다.
- 원격 접속은 Tailscale 사설 네트워크와 몽글 기기 승인을 함께 사용합니다. 모바일은 브라우저와 홈 화면에 추가한 웹 앱으로 이용합니다.
- 트레이와 상단 메뉴의 **완전 종료…**는 현재 컴퓨터의 셸과 백그라운드 실행부까지 종료합니다. 다시 실행하면 그룹·분할·선택 패널과 보관을 허용한 출력 기록을 복원하고 저장된 시작 폴더에서 새 셸을 엽니다. 이전 명령이나 AI 대화를 자동으로 재개하지는 않습니다.

[사용자 안내](docs/USER-GUIDE.md)에는 첫 실행, 원격 연결, 제어권, 데이터 보관과 문제 해결 방법을 정리했습니다.

## 구조와 라이선스

`apps/desktop`은 Electron 창, `apps/web`은 PC·모바일 공통 화면, `packages/host`는 셸과 연결을 유지하는 독립 실행부입니다. `packages/terminal`은 xterm 화면과 입력의 동기화를 담당합니다. xterm 내부 API에 의존하는 어댑터가 있으므로 관련 패키지의 정확한 버전을 함께 유지하고 터미널 회귀 검증 후 변경합니다.

몽글터미널 자체 코드의 공개 라이선스는 아직 정하지 않았습니다. `private`/`UNLICENSED` 상태이며 의존 패키지의 MIT·ISC 라이선스가 앱 자체의 사용 허가를 뜻하지 않습니다. 사용한 구성요소와 고지 원문은 [제3자 고지](docs/THIRD-PARTY-NOTICES.md)를 확인하세요.
