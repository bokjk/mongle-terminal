# 생성 폴더 정리 기준

소스와 사용자 작업을 보존하면서, 재생성 가능한 이전 빌드만 정리합니다. **폴더 이름이 `release-*`라는 이유만으로 일괄 삭제하지 않습니다.** 해당 폴더에서 실제 앱이나 시험 프로세스가 실행 중인지 먼저 확인합니다.

## 폴더별 보존 기준

| 경로 | 기준 |
|---|---|
| `.git`, `.github`, `apps`, `packages`, `platform`, `scripts`, `tests`, `docs`, `artifacts` | 소스·설정·문서·의도적으로 추적한 자산. 정리 대상 아님 |
| `release` | 현재 이 개발 PC의 실제 앱 실행 폴더. 실행 중 삭제·이동·덮어쓰기 금지 |
| `node_modules`, `runtime`, `dist` | 현재 개발·실행·검사에 필요. 의존성 재설치나 재빌드 계획이 있는 경우에만 정리 |
| `release-candidate`, `release-stage`, 이전 `release-*` | 앱·검사·패키징 프로세스가 사용하지 않고 필요한 결과를 보관했으면 삭제 가능 |
| `.test-data`, `test-results` | 격리된 시험 데이터·검증 근거. 작업별로 살펴보고 필요한 기록을 보존한 뒤 정리 |
| `.backups` | 제한된 복구용 파일. Git 제외. 보관 목적과 복원 대상이 명확한 최신 세트만 유지 |

`%LOCALAPPDATA%\MongleTerminal`은 사용자 데이터이며 프로젝트 청소 대상이 아닙니다. MSIX 개발 도구의 가상화된 AppData도 무분별하게 합치거나 삭제하지 않습니다.

## 앞으로 빌드할 때

기능마다 새 `release-기능명` 폴더를 늘리는 대신 하나의 후보 출력 경로를 재사용합니다.

```powershell
node --import tsx scripts/package.ts --output release-candidate
```

기존 후보를 사용하는 시험 프로세스가 있으면 먼저 해당 시험 앱을 정상 종료하세요. 실사용 앱은 종료하지 않습니다. 검증한 로그·체크섬과 필요한 산출물을 보존한 뒤 이전 후보·staging을 정리할 수 있습니다. 현재 실행본에 적용하는 작업은 [배포 안내](RELEASING.md)의 저장·종료·교체 절차를 따릅니다.

삭제 전에는 대상의 **실제 절대 경로가 프로젝트 안에 있는지**, junction·심볼릭 링크가 없는지, Git 추적 파일이나 실행 프로세스가 참조하지 않는지 확인합니다. Windows에서는 확인한 경로를 PowerShell의 `-LiteralPath`로 직접 처리하며 다른 셸에 삭제 명령을 전달하지 않습니다.

## 2026-09-29 정리 기록

기능별 이전 배포본 11개, 중간 복사본 `release-stage`, 이전 터치 입력 백업 1개를 정리했습니다. 총 **13개 폴더, 11,518,062,819바이트(약 10.73 GiB)**입니다. 실제 앱의 GUI·호스트·PowerShell 프로세스가 그대로 유지됨을 전후 확인했습니다.

삭제한 이전 배포본은 `release-branding`, `release-tray`, `release-pane-drag`, `release-full-exit`, `release-start-folder`, `release-gjc-flicker`, `release-clipboard`, `release-streaming-flicker`, `release-autoupdate`, `release-remote-recovery`, `release-tap-control`입니다. 이전 입력 전환 웹 백업은 빠진 참조 자산을 보완하고 `.backups/web-before-input-handoff`로 모았습니다. 이 백업은 **직전 웹 화면용이며 전체 앱이나 사용자 데이터 백업이 아닙니다.**

기존 검증 문서의 위 산출물 경로는 **당시 검사 이력**입니다. 오래된 로컬 바이너리는 이번에 삭제했고, 소스·문서·검증 로그와 현재 실행본은 보존했습니다. 공개 배포 전에는 현재 소스로 다시 패키징해야 합니다. 로컬 상세 증거는 Git에서 제외한 `test-results/repository-refresh/cleanup.json`에 있습니다.
