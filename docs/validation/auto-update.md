# 자동 업데이트 검증

기준: 2026-09-29, 소스 0.2.0, Windows x64. 공개 배포나 기존 사용 중인 0.1.0 앱 교체를 수행한 기록은 아니다.

후속 [원격 연결 복구](remote-recovery.md) 작업에서 개발 PC의 압축 실행본에 0.2.0을 수동 적용했다. 아래 검사는 그보다 먼저 수행한 업데이트 구현 검증이며 NSIS 자동 교체 시험과 구분한다.

## 구현

- NSIS 설치 시에만 만드는 표식으로 설치본을 구분한다. 개발·ZIP 실행본은 수동 교체를 안내한다. GitHub `bokjk/mongle-terminal`의 안정 버전을 확인하고 자동 다운로드하며, 앱 종료 시 자동 설치는 비활성화했다.
- 설정·앱 메뉴·트레이에서 상태를 확인하고 설치를 선택한다. 현재 PC의 인증된 로컬 호스트에 연결해 사용자 확인, 정상 저장·종료, 프로세스 종료와 상태 파일 제거를 모두 확인한 후 설치한다. 일반 완전 종료와 같은 컨트롤러를 공유하여 중복 종료를 막는다.
- 명시적 확인 이후 silent NSIS 설치와 강제 재실행 옵션을 사용한다. 설치 시작 오류가 발생하면 예약된 앱 종료를 취소하고 오프라인 상태로 전환해 사용자가 다시 연결할 수 있게 한다. 기존 사용자 호스트와 원격 PC는 테스트를 위해 종료하지 않는다.
- 공개 배포 전에는 일반 설치본에 제공할 공개 Release가 없다. 사용자 토큰을 포함하지 않으며 저장소 공개 범위와 자체 라이선스는 변경하지 않았다.

## 실제 수행

업데이트·완전 종료 수명주기 단위 검사 42개가 통과했다. 자동 다운로드와 설치의 분리, 취소, 중복 요청, 저장·인증 실패, 설치 준비 중 오류, 종료 대기, 타이머 해제, 민감한 오류 정보 비노출을 확인했다. UI 검사 2개는 실제 브라우저에서 업데이트 상태·진행률·재시도·설치 경고·구형 브리지·브라우저 안내를 확인했으며 업데이트 브리지 응답은 시험용 값이다.

`tests/e2e/updates-download.test.ts`는 실제 Electron, production UpdateController와 electron-updater HTTP 전송을 사용한다. 임시 로컬 HTTP 서버의 메타데이터와 시험 파일을 받아 **정상 SHA-512 다운로드 완료**, **손상 파일 ERR_CHECKSUM_MISMATCH 거부**, **기본 렌더러 네트워크 차단 유지**, **다운로드 중 종료·설치 콜백 0회**를 확인했다. 1/1 통과, 시험 Electron 종료 확인. 사용자 데이터·캐시는 임시 폴더에 격리하며 시험 파일을 실행하지 않는다. 로컬 증거: `test-results/e2e/updates-download/result.json`.

격리된 실제 Electron 시작 폴더 회귀 검사도 1/1 통과했다. 실제 PowerShell 시작 폴더·분할 상속·취소·잘못된 경로·원격 화면 구분을 포함한다.

실제 NSIS 드라이버의 설치 시작 경로에 실행 실패를 주입한 검사 6/6도 통과했다. 설치 파일은 실행하지 않고, 비동기 실행 오류 후 예약 종료 차단·같은 이벤트 루프 재시도·중복 설치 방지·종료 직전 취소·설치 파일 부재 후 재시도를 확인했다. 코드 검토에서 발견한 설치 후 미재실행과 실패 후 연결 표시 문제를 수정했다.

전체 회귀 검사 최초 실행은 174개 중 169 통과·2 실패·3 생략이었다. 두 실패는 포커스 보고가 입력과 같은 RPC에 포함되는 경우와 비동기 Ctrl+C 도착 전 단정하는 테스트 가정 때문이었다. 정확한 포커스 보고만 분리하고 실제 호스트 입력을 기다리도록 테스트를 수정한 뒤 두 UI 검사 모두 재검증 통과했다. 입력의 최종 일치·중복·누락·불확실 입력 재전송 검사는 유지했고 제품 코드는 변경하지 않았다. 최종 확인된 테스트 집합은 **171 통과·3 생략**이며, 수정 후 전체를 한 번 더 실행한 결과로 표현하지 않는다. 생략은 조건부 아이콘 비교 2개와 별도 GJC 캡처 재생 1개이며 현재 패키지 아이콘은 패키징 단계에서 따로 검증했다. 로그: `test-results/auto-update-full-suite.log`, `test-results/auto-update-ui-retest.log`. 최종 타입 검사와 `git diff --check`도 통과했다.

## 패키지

`release-autoupdate/`에 0.2.0 NSIS 설치본·ZIP·`latest.yml`·설치본 `.blockmap`·`SHA256SUMS.txt`를 생성했다. 패키징은 명시적으로 게시를 비활성화한다. 설치본 크기 149,354,747바이트와 SHA-512가 `latest.yml`에 일치하며, 배포 파일 네 개의 SHA-256도 생성·확인했다. 설치본 SHA-256: `1665de0565e269595339ca081708f7629da08fa84c69f76fa1c2abedcfe58400`.

압축 전 앱과 ZIP에는 NSIS 설치 표식이 없고, `app-update.yml`은 토큰 없이 GitHub `bokjk/mongle-terminal`의 latest 채널을 지정한다. 패키지 내부에서 독립 Node와 네이티브 터미널 의존성을 로드했고, ZIP 필수 파일과 EXE 아이콘 검사도 통과했다. 제3자 고지는 production 의존성 29개와 런타임을 포함한 32개 항목이며, lazy-val의 별도 LICENSE 부재와 선언 기반 고지 방식을 구분해 기록했다.

생성한 `win-unpacked/MongleTerminal.exe`를 격리 실행한 업데이트 데스크톱 E2E도 1/1 통과했다. 실제 preload IPC가 버전 0.2.0과 수동 업데이트 대상을 반환하고, 설치 요청을 거부하면서 기존 시험 호스트 PID·bootId를 유지하는지 확인했다. 네이티브 메뉴·비활성 설치 항목·설정의 앱 업데이트 화면을 검증했으며 시험 호스트와 Electron의 정상 종료를 확인했다. 증거: `test-results/e2e/update-desktop/result.json`과 같은 폴더의 스크린샷.

## 재현

```powershell
npm run build
npm run typecheck
node --import tsx --test tests/platform/updater.test.ts tests/platform/full-exit.test.ts tests/platform/release-check.test.ts tests/platform/updater-driver.test.ts
$env:MONGLE_E2E_UPDATES = '1'
node --import tsx --test tests/e2e/updates-download.test.ts
node --import tsx scripts/release-check.ts
node --import tsx scripts/package.ts --output release-autoupdate
```

## 미검증 범위

공개 GitHub Release의 실제 검색·다운로드, GitHub Actions 실행, 기존 NSIS 설치본에서 새 버전 설치·재실행·기록 복원까지의 전체 경로, 코드 서명 검증은 아직 수행하지 않았다. 단위 검사와 로컬 파일 다운로드를 그 검증으로 대체하지 않는다. 사용 중인 호스트에 영향 없이 가능한 검증을 우선했으며, 실제 설치 교체 시험은 별도의 Windows 시험 환경에서 수행해야 한다.
