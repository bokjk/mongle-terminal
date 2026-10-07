# 0.3.16 공개 배포 검증

**공개 완료.** [최종 결과](#final)를 따른다. 아래 사전 검증은 당시 기록이다.

## 변경 범위

- Windows Claude 자동 훅 연결과 작업 중 맥동, 확인 전까지 유지되는 완료 종.
- 여러 줄 붙여넣기 확인창의 붙여넣기 버튼 초기 포커스와 Enter 확인.
- Git Bash의 현재 Windows 경로 전달과 파일 보기·Git 경로 복구.
- README, 사용자 안내, 변경 기록, 배포·검증 문서 갱신. 버전은 0.3.16이며 새 의존성은 없다.

## 사전 검증

[Claude 구현 검증](claude-task-status.md), [PDF 버그 재현과 네이티브 검사](pdf-bug-report.md)에 수정별 검사와 제약을 기록했다. 초기 후보에서 확인한 상태 아이콘은 최종 맥동·종 UI와 구분하며, 최종 UI·전체 회귀·PR·태그·공개 파일 검증 결과는 실제 통과 후 이 문서에 추가한다.

실사용 앱·호스트·Claude 설정을 변경하지 않고 격리된 시험 데이터로 검사한다. 공개 버전 검증은 CI 산출물과 공개 파일 해시, 이전 릴리스 보존, 자동 업데이트 다운로드를 포함한다.

## 0.3.16 최종 로컬 후보

타입 검사·프로덕션 빌드·문서 검사·디렉터리 패키징과 최종 상태 UI 10/10을 통과했다. 독립 Opus 검토에서 추가 중요 결함은 발견하지 못했으며 설치본 사용자 안내의 상대 검증 링크를 공개 소스 링크로 보완했다.

Astra가 실제 `release-0316-native/win-unpacked/MongleTerminal.exe`에서 Claude 2.1.292를 한 번 실행했다. 작업 중 원형 아이콘의 밝기 변화, 배경 탭·그룹·사이드바의 완료 종, 해당 터미널 선택 후 최신 출력이 표시되면 종이 사라지는 동작과 설정 도움말의 자동 연동 준비 상태를 확인했다. 정확한 2초 주기는 네이티브에서 별도 계측하지 않았으며 CSS와 자동 검사로 확인했다.

시험 앱·호스트를 정상 종료하고 잔류 0개, 기존 사용자 앱 유지·실사용 설정 미변경을 확인했다. 자동 생성된 격리 Claude 설정을 `--settings`로 전달했으며 사용자 인증 파일은 복사하지 않았다. 기존 비차단 Python 훅 오류가 함께 표시됐지만 출처는 확정하지 않았고 다른 훅은 변경하지 않았다. 실기에서 확인 요청·오류·중단을 각각 조작한 결과는 아니며 해당 경계는 자동 검사 범위다.

로컬 증거: `test-results/release-0316/native-status/report.json`과 스크린샷·상태·정리 기록. 시험 EXE SHA-256 `accde6e0b7312c9ac5f4c89965df39fa5bd7a7aa964fb282a824f48a393788b9`, app.asar `6e5e0abdfa1ad2f18354efb246e4e1fdb71e3d808a126e5f53bf9828b43c42c3`. 이후 사용자 안내의 링크만 수정했으며 최종 공개 파일은 별도 CI 산출물 검증을 따른다.

전체 로컬 회귀는 530개 중 **514 통과·0 실패·16 선택 생략**(약 459초). 생략 항목은 선택형 네이티브·설치 E2E 등이며 PR·최종 태그의 해당 검사 결과와 구분한다. PowerShell 실행 정책은 시험 프로세스에만 Bypass로 지정했다. 로그는 로컬 .test-data/release-0316-regression.log에 보존한다.

<a id="final"></a>

## 최종 공개 결과

**0.3.16 공개 배포 완료(2026-10-07):** [공개 릴리스](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.16). [개발 PR](https://github.com/bokjk/mongle-terminal/actions/runs/37607711852) 515 통과·0 실패·15 생략, [배포 PR](https://github.com/bokjk/mongle-terminal/actions/runs/37609087111) 515 통과·0 실패·15 생략, [최종 태그](https://github.com/bokjk/mongle-terminal/actions/runs/37610464864) 516 통과·0 실패·14 생략. 네이티브 2/2, [실제 NSIS 교체·복원](https://github.com/bokjk/mongle-terminal/actions/runs/37609087141), 최종 설치 payload 일치, 공개 첨부 5개 익명 다운로드·해시, 실제 Electron updater의 0.3.15→0.3.16 다운로드와 동일 버전 최신 상태 확인을 통과했다. 이전 공개 릴리스는 보존했다.

- 게시 시각(UTC): 2026-10-07T11:15:27Z
- 소스 태그: [v0.3.16](https://github.com/bokjk/mongle-terminal/tree/v0.3.16)
- main SHA: `258d51858e23e0c1cd2d34f364b12d61ac2418da`
- PR: [개발 #54](https://github.com/bokjk/mongle-terminal/pull/54), [배포 #55](https://github.com/bokjk/mongle-terminal/pull/55)
- 공개 안내: https://github.com/bokjk/mongle-terminal-releases/pull/9

동일 태그의 필수 검사를 통과한 CI 산출물을 배포했다. 소유자 작성 PR은 최신 head·base 검사와 독립 검토를 확인한 뒤 CONTRIBUTING에 따라 PR 병합에만 관리자 권한을 사용했다.

### 공개 파일

| 파일 | 바이트 | SHA-256 |
|---|---:|---|
| MongleTerminal-Setup-0.3.16-x64.exe | 161282464 | `b67a0ac89058bd44344455f3c4371cf231be3ff0f98785529bd4d760870acdaa` |
| MongleTerminal-Setup-0.3.16-x64.exe.blockmap | 167985 | `9c38f9c5c1db2ae96167db36f840ee3caae150da9bc6be4b22d2154b8a4cfcee` |
| MongleTerminal-0.3.16-x64.zip | 209321823 | `63851f11aa198559ab34d3f78be77a002b40c6c25de809c5a42d2dead9a1ccf9` |
| latest.yml | 368 | `2655c5f8714c43e6484f73a5786fc14e1dd766d49678785e55ac0532f841da4b` |
| SHA256SUMS.txt | 386 | `2c0149f467b94c33e2c4fd09ff80a9273127110c2e05ee28c928d45a1733d8f0` |

### 검증 영수증

원본은 개인 경로가 포함될 수 있어 커밋하지 않고 SHA-256을 기록한다.

| 검사 | JSON SHA-256 |
|---|---|
| artifact-verification | `d40a4310f5b5920339897fea75bcec932aa26e59d247bda112a955f2656868be` |
| draft-verification | `8c596622d3595b314c164504824d0362f4e374c51c8022f035c341f47708a74a` |
| public-downloads | `74b77fa169a8291f2767fb2a4eef37aed4f25a206271d4d01bdfa9b2f72328c8` |
| public-updater | `216f43a4eab6160363e18ebd01504503f40cddb79684110ff48c833d8775d53d` |
| installed-payload-match | `697eac5b36164f9e0607f1f1f5ea29e15fbe2bdf8348a7b244e2c18554c70d03` |
| previous-public-preservation | `6514a32a8fcc9c4eb812978022f616433a6683d8f15ca3b31565a5b308732fc6` |

### 범위

업데이트 검사는 현재 제품 updater에 격리된 버전 어댑터를 사용했으며 구버전 사용자 설치본의 실행으로 표현하지 않는다. 실사용 앱·인증·작업을 변경하지 않았다. Claude 실기 검증은 Windows 2.1.292 기준이며 WSL·SSH·모든 CLI 버전·실물 모바일은 별도 범위다.
