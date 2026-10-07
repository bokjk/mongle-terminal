# 자동 업데이트 검증

> 업데이트 알림·설치 진행 표시는 0.3.17에 공개했다. [최종 설치·배포 검증](public-release-0.3.17.md#final)을 따른다. 아래 미배포·이전 후보 설명은 당시 이력이다.

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

## 업데이트 알림과 설치 진행 표시

기준: 2026-10-07, 소스 0.3.16 기반 미배포 변경(브랜치 `codex/update-notice-progress`). 사용자 제보: 업데이트를 받으려면 설정에 들어가야 했고, 설치 중에는 화면 없이 멈춘 것처럼 보였다.

### 디자인 참고

Mobbin의 [Progress Indicator](https://mobbin.com/explore/web/ui-elements/progress-indicator) 공개 페이지를 Aside로 열어 실제 화면을 확인했다. Better Stack Incident Dashboard는 어두운 사이드 내비게이션과 콘텐츠 안의 작은 진행 체크리스트를, Databricks Install App은 상단의 3단계(Configure resources → Review authorizations → Add metadata)와 현재 단계 강조를 보여 준다. 몽글터미널에는 별도 마법사를 만들지 않고 기존 사이드바 하단에 지속 카드와 접힌 사이드바 배지를 두었다. 다운로드는 실제 진행률 막대, 설치 준비는 Databricks식 단계 목록(현재 단계 spinner)으로 표시하며 비율을 지어내지 않는다.

### 구현

- 자동 확인(30초·6시간)과 자동 다운로드 정책은 그대로다. 앱 전체가 업데이트 IPC를 한 번만 구독하는 공유 저장소(`apps/web/src/update-store.ts`)를 두어 사이드바 카드와 설정 화면이 같은 상태·중복 클릭 방지를 공유한다.
- `UpdateState.phase`는 `confirming`(확인 창), `saving`(사용자가 확인한 뒤 저장·로컬 호스트 종료), `launching`(종료 barrier 통과 후 설치 프로그램 실행)이다. 각 단계는 실제 수명주기 사건에서만 바뀐다. 미저장 파일 차단, 사용자 확인, 인증된 로컬 호스트 정상 종료 barrier는 그대로다.
- 카드는 다운로드·준비·설치 중·버전이 있는 오류에서 표시하고, 오류에는 **다시 확인** 버튼을 둔다. 연결이 끊겨 설정을 열 수 없을 때도 카드는 남는다. 접힌 배지는 사이드바를 펼쳐 카드를 보여 주며 직접 설치하지 않는다. 카드의 **업데이트 설정**은 설정의 앱 업데이트 탭을 연다. 준비 완료 OS 알림 문구도 사이드바 버튼을 안내한다.
- 앱은 설치 파일을 `--updated --force-run`으로 실행한다(`/S` 제거). `GuardedNsisUpdater`는 driver 기본값과 무관하게 `--force-run`을 넘긴다.
- `platform/windows/installer.nsh`: 두 플래그가 모두 있으면 (1) `customInit`에서 silent 요청을 일반 창으로 전환해 0.3.16 이하 앱의 `/S` 요청도 진행 막대를 보이게 하고, (2) `customInstallMode`로 기존 설치 범위를 유지하며 설치 모드 페이지를 건너뛰고, (3) `customFinishPage`의 사전 함수에서 중단 없이 끝났으면 StdUtils `ExecShellAsUser`로 앱을 다시 실행하고 완료 페이지를 건너뛴다. 실행 결과가 `ok`/`fallback`이 아니면 안내 메시지와 완료 페이지를 유지한다. 조건 밖의 일반 설치와 silent 설치, `scripts/package.ts`의 `runAfterFinish: false`는 바꾸지 않았다.

### 실제 수행

- 타입 검사, `npm run build` 통과.
- 업데이트 관련 비브라우저 검사 57/57 통과: `tests/platform/updater.test.ts`(단계 보고·취소 시 단계 해제·늦은 보고 무시·설치 인자 `(false, true)` 포함), `updater-driver.test.ts`(실제 NSIS driver의 `--updated --force-run` 인자, driver 기본 재실행값과 무관), 새 `update-store.test.ts`(단일 구독·공유 busy·느린 초기 응답 무시·dispose 뒤 이전 브리지 응답 무시·미지원 브리지), `full-exit.test.ts`, `release-check.test.ts`. 모두 테스트 더블 driver/bridge이며 설치 파일을 실행하지 않는다.
- `tests/ui/updates.test.ts`는 공유 저장소에 맞게 단언 설명을 갱신했으며, 이 작업에서 브라우저 실행은 하지 않았다(AGENTS 규칙에 따라 브라우저 검증은 Aside 담당).
- 사전 회귀(제품 변경 전, 브라우저·updater/full-exit/release-check 제외 350개): 344 통과·3 실패·3 생략. 실패 3개는 샌드박스 접근 거부(JobHarness), PowerShell 실행 정책, Electron GPU 환경 원인이며 샌드박스 밖에서 프로세스 한정 `PSExecutionPolicyPreference=Bypass`로 lifecycle/publish-release/remote-transport 5/5 재검사 통과. 최종 확인 집합 347 통과·3 생략이며 전체 한 번 통과로 표현하지 않는다. 로그: `test-results/update-review-regression.log`, `test-results/update-review-regression-retest.log`.
- 최종 독립 검토에서도 타입 검사, 관련 검사 57/57, 릴리스 문서 검사, `git diff --check`를 확인했다. PR 본문 초안을 `checkContribution` 함수로 검사하여 필수 양식·문서 영향 오류가 없음을 확인했다. GitHub CLI 인증이 없어 원격 PR·CI는 실행하지 않았다.
- Aside에서 모의 업데이트 브리지를 연결한 실제 React 구성 요소를 조작했다. 다운로드 37%와 progress 값, 사이드바·설정의 동기화, 구독 1회·설치 요청 1회, 확인·저장 단계, 오류의 직접 재시도 및 접힌 배지로 카드 펼치기를 확인했다. 로컬 하네스: `test-results/update-notice-aside.mjs`. 공개 Release나 실제 설치를 사용한 검사는 아니다.
- Astra가 별도 TEMP 프로필에서 실제 개발 Electron renderer/preload와 실제 격리 호스트를 사용해 위 알림 카드·업데이트 탭 바로 열기·접기/펼치기·설치 버튼·3단계·오류 재시도를 sky로 확인했다. 업데이트 IPC만 모의 구현으로 바꿨고 최신 renderer를 다시 불러왔다. main 프로세스는 최초 실행본이므로 최종 main 수명주기 실기로 계산하지 않는다. 설치 요청과 재확인 요청은 각 1회이며 빠른 중복 클릭 실기는 아니다. 기본 사이드바 폭에서 잘림은 관찰하지 않았다. 로컬 상세 기록: `test-results/update-notice-desktop/QA-RESULT.md`. 스크린샷에는 로컬 계정 경로가 있어 공개 자료에 포함하지 않는다.
- 시험 Electron과 호스트 모두 정상 종료했다. 인증된 시험 호스트의 hostId·bootId 일치를 확인한 뒤 종료했으며 실사용 세션·인증·원격 설정은 변경하지 않았다. 로컬 종료 증거: `test-results/update-notice-desktop/cleanup.json`.

### 최종 패키지 검증

`runtime/node.exe --import tsx scripts/package.ts --output release-update-notice-final`로 최종 NSIS 설치본·ZIP·blockmap·latest.yml·SHA256SUMS.txt를 만들었다. 마지막 플래그 조건 수정을 포함한 NSIS 컴파일, 설치본 메타데이터·체크섬, EXE 아이콘 7개 프레임, ZIP 네이티브 필수 파일 7개(전체 996개 항목)를 검증했다. 독립 Node v24.11.1에서 네이티브 모듈 로드도 통과했다. 시스템 Node 옆 LICENSE 누락으로 첫 패키징은 실패했으며, 같은 버전의 기존 검증 라이선스를 갖춘 작업 폴더의 Node로 재실행했다. 생성 과정의 무관한 고지·라이선스 차이는 커밋하지 않았다. 로그: `test-results/update-notice-package-final.log`.

이 산출물은 버전을 올리지 않은 0.3.16 기반 개발 검증본이며 공개 배포본을 교체하지 않았다. 패키징은 `publish: never`로 수행했다.

### 미검증 범위

실제 구버전(0.3.16) 설치본에서 새 설치본으로의 교체, NSIS 진행 창 표시, 앱 재실행, 실패 시 안내는 이 PC에서 실행하지 않았다(`verify-installed-upgrade.ts`는 일회용 GitHub runner 전용). 공개 Release 조회·다운로드, 실제 네이티브 설치 확인/취소와 저장·종료 장벽을 포함하는 새 전체 경로, 테마별·최소 창 크기·키보드 탐색·실행 중 터미널 부하 상태의 실기는 미검증이다. 저장·종료 보호는 관련 자동 검사로 확인했으며 모의 업데이트 화면 검증을 실제 설치 성공으로 간주하지 않는다. 전체 브라우저 회귀·GitHub CI·공개 배포는 하지 않았다.
