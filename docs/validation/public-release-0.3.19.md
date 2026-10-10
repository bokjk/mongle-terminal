# 0.3.19 공개 배포 검증

**공개 완료.** [최종 결과](#final)를 따른다. 아래 준비 기록은 당시 이력이다.

## 변경 범위

- 연결된 기기의 새 기기 승인: 이미 승인된 휴대폰·PC가 **설정 → 원격 연결 → 새 기기 연결**에서 연결 코드를 만들고, 자신이 접속한 원격 주소로 들어온 요청을 승인하거나 거절한다. 원격 접속 켜기·끄기와 연결한 기기 목록·해제는 계속 대상 PC에서만 한다.
- 승인 출처 표시: 대상 PC의 연결한 기기 목록에 다른 기기가 승인한 경우 "○○에서 승인"을 표시한다. 이전 데이터베이스에는 시작할 때 승인 기록 열을 추가한다.
- 연결 코드와 승인 대기 요청의 남은 시간 표시, 만료된 코드 숨김, 휴대폰의 거절·승인 버튼 배치, 연결 화면의 메뉴 이름을 고친다. 이 기능을 알리지 않는 이전 버전 호스트에서는 기존 안내만 보인다.
- 독립 코드 검토 반영: 연결 코드를 만든 기기마다 따로 유지해 다른 화면의 코드가 말없이 무효가 되지 않게 하고, 응답의 호스트 시각으로 기기 시계 차이를 보정해 유효한 코드·요청을 감추지 않는다.
- README·변경 이력·사용자 안내·배포 문서와 버전을 0.3.19로 정리한다. 의존성·라이선스·저장소 공개 범위는 바꾸지 않는다.

## 개발 단계 근거

[구현과 검증 기록](remote-device-approval.md)을 따른다. 타입·빌드, 보안 시험 24/24, 설정 화면 시험 3/3, 로컬 전체 회귀 591개 중 574 통과·1 실패·16 생략을 확인했다. 로컬 실패 1개는 이 PC의 PowerShell 실행 정책이 배포 스크립트 시험을 막은 환경 문제이며 원격 Windows 검사에서는 실패가 없었다. 아스트라의 격리 실제 앱·브라우저 검증에서 PC→휴대폰→새 기기 승인, 거절 후 미연결, 승인 출처 표시, 남은 시간 감소, 390px 버튼 배치를 확인했다. 기능 커밋 `9fa4d2f`의 [개발 PR #63 Windows 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37949120307)와 [실제 NSIS 업그레이드·복원 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37949120074), 검증 기록 커밋 `f740162`의 [Windows 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37966972468)(591개 중 576 통과·0 실패·15 생략, 네이티브 2/2)와 [실제 NSIS 업그레이드·복원 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37966972413)도 통과했다. 실제 Tailscale HTTPS·실물 휴대폰·두 PC 간 등록과 앱 전체의 정식 메뉴 종료는 확인하지 않았다.

독립 코드 검토(GitHub Codex 자동 검토와 아스트라)의 P2 지적 2건, 다른 기기 코드 무효화와 기기 시계 차이로 인한 코드·요청 숨김을 고쳤다. 재검토의 P3 1건(네트워크 지연이 고르지 않을 때 유효한 요청을 몇 초 일찍 숨김)도 고쳤다. 보안 25/25, 설정 화면 3/3, 시계 보정 단위 시험 1/1, 타입 검사를 다시 통과했고 새 시험이 수정 전 코드에서 실패함을 확인했다. [검토와 수정](remote-device-approval.md#독립-코드-검토와-수정-2026-10-10).

## 배포 전 검사

수정 커밋의 PR 검사, 배포 PR·최종 태그 검사, 패키지와 공개 다운로드 결과는 수행한 뒤 기록한다. 실패·생략한 검사를 통과로 표시하지 않는다. 사용자 설치본·인증·작업은 변경하지 않는다.

<a id="final"></a>

## 최종 공개 결과

**0.3.19 공개 배포 완료(2026-10-10):** [공개 릴리스](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.19). [개발 PR](https://github.com/bokjk/mongle-terminal/actions/runs/37972987987) 578 통과·0 실패·15 생략, [배포 PR](https://github.com/bokjk/mongle-terminal/actions/runs/37975660051) 578 통과·0 실패·15 생략, [최종 태그](https://github.com/bokjk/mongle-terminal/actions/runs/37977246026) 579 통과·0 실패·14 생략. 네이티브 2/2, [실제 NSIS 업데이트·자동 재실행·복원](https://github.com/bokjk/mongle-terminal/actions/runs/37977246026), 최종 설치 payload 일치, 공개 첨부 5개 익명 전체 다운로드·해시, 실제 Electron updater의 0.3.18→0.3.19 다운로드와 동일 버전 최신 상태 확인을 통과했다. 이전 공개 릴리스는 보존했다.

- 게시 시각(UTC): 2026-10-09T19:24:01Z
- 소스 태그: [v0.3.19](https://github.com/bokjk/mongle-terminal/tree/v0.3.19)
- main SHA: `6d1dccc89e2328290a713f50f85f2a741101d9e6`
- PR: [개발 #63](https://github.com/bokjk/mongle-terminal/pull/63), [배포 #64](https://github.com/bokjk/mongle-terminal/pull/64)
- 공개 안내: [배포 README #12](https://github.com/bokjk/mongle-terminal-releases/pull/12)

최신 head·base의 필수 검사와 독립 검토 후 CONTRIBUTING에 따른 소유자 PR 병합 경로를 사용했다. 검증된 최종 태그 산출물의 동일 바이트를 공개했다.

### 실제 설치 검사 범위

공개 0.3.16에서 후보로 legacy silent 업데이트 인수를 전달해도 실제 진행 막대가 표시됐고 설치본이 자동으로 다시 열렸다. 이어 같은 후보를 재설치해 새 표시형 업데이트 인수와 Claude 2개·Codex 2개 시험 대화의 정확한 ID 복원을 검증했다. 설치 파일·app.asar·전체 hostbundle이 후보와 일치했고 시험 프로세스는 정상 종료했다. 설치 검사의 CLI는 인증이나 모델을 사용하지 않는 시험 대역이다. 이번 원격 기기 승인의 실제 앱·브라우저 검증과 독립 코드 검토는 [구현과 검증 기록](remote-device-approval.md)을 따른다. 실제 사용자 설치본·인증·작업은 변경하지 않았다.

hosted Windows의 두 정상 종료는 검증된 Electron 트레이 콜백으로 실제 메뉴를 열고 종료 항목과 확인창을 조작했다. Explorer 알림 영역 아이콘을 물리적으로 우클릭한 검증은 아니다.

### 공개 파일

| 파일 | 바이트 | SHA-256 |
|---|---:|---|
| MongleTerminal-Setup-0.3.19-x64.exe | 161296115 | `53ae2331e9e7a2a5af86b463c7e0d249691acd4105e6329da72998cc7afef67e` |
| MongleTerminal-Setup-0.3.19-x64.exe.blockmap | 168106 | `bbbf92d76849fd4d530dec9302c9838b6ea45d09e2793e5631a635d6886d34af` |
| MongleTerminal-0.3.19-x64.zip | 209337850 | `d4ae864c821b3880418c1cb0a88bf90a38ec4589cd7b9c12129d1d97e5631a3c` |
| latest.yml | 368 | `3105aa92ab946b6d50ce12dc30c42f4425c0f4a92ee61c2184507ac0073d00e5` |
| SHA256SUMS.txt | 386 | `b7ddaaeff966a9fcb6d9e2286f99f268c9483bb1ca363300a0e9742291bcc3e9` |

### 검증 영수증

개인 경로를 포함할 수 있는 원본은 커밋하지 않고 SHA-256을 기록한다.

| 검사 | JSON SHA-256 |
|---|---|
| ci-verification | `cc691716d8cead41dedcaf0ab2eb2392935d770c2fbfa1c023291c537b80d2d8` |
| artifact-verification | `cdb34b50dee9ae32f7dc219ffa6fb24b814ccd913f220477eb5d2d5d1388f78b` |
| draft-verification | `9a7224efdd3161703ddae1c0a7888ac1bbf6418c659fabf5ec27beb6440bf6a8` |
| public-downloads | `8b342e80f9c238ae751010d330937d4d550b016b76c7e9fcd18e028ffcda43e4` |
| public-updater | `57f674224d0fddb1cd36044365256c81a1ed25a829af97f72282661f5fceaa4a` |
| installed-payload-match | `60b7360c6aa1caec7cae4ea3ed85101bcddcdbb0baa94151ecddf39fd8639965` |
| previous-public-preservation | `2c49eb54ac2132ccb95a2c32fabcda0662d9c653f19c26075f4382fd1c6f100f` |

공개 업데이트 다운로드 검사는 현재 제품 updater에 격리 버전 어댑터를 사용했으며 설치를 실행하지 않았다. 실제 설치 교체는 위 일회성 Windows 검사와 구분한다. OS 재부팅·모든 CLI 버전·WSL·실물 모바일의 전체 조합은 검증하지 않았다.
