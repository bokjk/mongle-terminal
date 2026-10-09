# 0.3.18 공개 배포 검증

**공개 완료.** [최종 결과](#final)를 따른다. 아래 준비 기록은 당시 이력이다.

## 변경 범위

- 작업 상태 표시 재설계: 작업 중에는 빙글 도는 고리, 확인하지 않은 응답 완료·알림은 작은 점, 확인 요청은 물음표 말풍선, 오류는 느낌표 원으로 표시한다. 모션 줄이기 설정에서는 고리가 멈춘다.
- Claude 상태 오표시 수정: 메뉴만 닫은 Esc 뒤 완료 알림 유실, 수동 거절·질문 답변 뒤 확인 요청 잔류, 작업 중 보낸 메시지의 두 번째 완료 알림 누락, 대화 압축의 상태 초기화를 고친다. 미리 선택된 승인을 Enter로 고른 도구는 실행되는 동안 작업 중으로 표시한다.
- 접힌 사이드바·모바일의 터미널 전환 버튼은 보고 있지 않은 터미널의 상태만 요약한다. Codex는 작업 중 상태를 보내지 않으므로 진행 표시는 Claude에만 나타난다.
- README·변경 이력·사용자 안내·배포 문서와 버전을 0.3.18로 정리한다. 의존성·라이선스·저장소 공개 범위는 바꾸지 않는다.

## 개발 단계 근거

[재현·수정·검증 기록](agent-status-indicator.md)을 따른다. 실제 Claude 2.1.294·Codex 0.161.0의 수정 전후 재현, 타입·빌드, 전체 회귀 586개 중 570 통과·0 실패·16 생략, 아스트라의 격리 실제 앱 검증 2회를 통과했다. 기능 커밋 `8448e68`의 [개발 PR #60 Windows 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37815605800)와 [실제 NSIS 업그레이드·복원 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37815606141)도 통과했다. 700px 이하 모바일 배치와 최종 호스트 빌드의 글자 입력 처리는 실제 앱에서 확인하지 않았다.

## 배포 전 검사

배포 준비 커밋의 PR 검사, 배포 PR·최종 태그 검사, 패키지와 공개 다운로드 결과는 수행한 뒤 기록한다. 실패·생략한 검사를 통과로 표시하지 않는다. 사용자 설치본·인증·작업은 변경하지 않는다.

<a id="final"></a>

## 최종 공개 결과

**0.3.18 공개 배포 완료(2026-10-09):** [공개 릴리스](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.18). [개발 PR](https://github.com/bokjk/mongle-terminal/actions/runs/37927666529) 571 통과·0 실패·15 생략, [배포 PR](https://github.com/bokjk/mongle-terminal/actions/runs/37929284456) 571 통과·0 실패·15 생략, [최종 태그](https://github.com/bokjk/mongle-terminal/actions/runs/37930788731) 572 통과·0 실패·14 생략. 네이티브 2/2, [실제 NSIS 업데이트·자동 재실행·복원](https://github.com/bokjk/mongle-terminal/actions/runs/37930788731), 최종 설치 payload 일치, 공개 첨부 5개 익명 전체 다운로드·해시, 실제 Electron updater의 0.3.17→0.3.18 다운로드와 동일 버전 최신 상태 확인을 통과했다. 이전 공개 릴리스는 보존했다.

- 게시 시각(UTC): 2026-10-09T12:53:48Z
- 소스 태그: [v0.3.18](https://github.com/bokjk/mongle-terminal/tree/v0.3.18)
- main SHA: `d9e8c5715a65dc6b190da6cc5782fec23ffbee35`
- PR: [개발 #60](https://github.com/bokjk/mongle-terminal/pull/60), [배포 #61](https://github.com/bokjk/mongle-terminal/pull/61)
- 공개 안내: [배포 README #11](https://github.com/bokjk/mongle-terminal-releases/pull/11)

최신 head·base의 필수 검사와 독립 검토 후 CONTRIBUTING에 따른 소유자 PR 병합 경로를 사용했다. 검증된 최종 태그 산출물의 동일 바이트를 공개했다.

### 실제 설치 검사 범위

공개 0.3.16에서 후보로 legacy silent 업데이트 인수를 전달해도 실제 진행 막대가 표시됐고 설치본이 자동으로 다시 열렸다. 이어 같은 후보를 재설치해 새 표시형 업데이트 인수와 Claude 2개·Codex 2개 시험 대화의 정확한 ID 복원을 검증했다. 설치 파일·app.asar·전체 hostbundle이 후보와 일치했고 시험 프로세스는 정상 종료했다. 설치 검사의 CLI는 인증이나 모델을 사용하지 않는 시험 대역이다. 이번 작업 상태 표시의 실제 Claude·Codex 검증은 [재현·수정·검증 기록](agent-status-indicator.md)을 따른다. 실제 사용자 설치본·인증·작업은 변경하지 않았다.

hosted Windows의 두 정상 종료는 검증된 Electron 트레이 콜백으로 실제 메뉴를 열고 종료 항목과 확인창을 조작했다. Explorer 알림 영역 아이콘을 물리적으로 우클릭한 검증은 아니다.

### 공개 파일

| 파일 | 바이트 | SHA-256 |
|---|---:|---|
| MongleTerminal-Setup-0.3.18-x64.exe | 161294124 | `f6809dc03b74326af398a74c53393a7d03b1c931f00f621019616006d627856d` |
| MongleTerminal-Setup-0.3.18-x64.exe.blockmap | 167982 | `b4c46088f68e6f02e3924f7d917ff8eacb021d16a537d9566430b80832c05568` |
| MongleTerminal-0.3.18-x64.zip | 209335686 | `2bcad11a2ae4fa8dff9838043960b8059c7fd8702b8d7259bcde0ffbd6e91ad3` |
| latest.yml | 368 | `63710a17ab086b9a0cfb56532edf6503d8a17963eb7f2fa7c86ffeea5653e8f4` |
| SHA256SUMS.txt | 386 | `aec6dffee0a229b78c436835add47c63e3b117ab2094fffb4c9336c9175e8519` |

### 검증 영수증

개인 경로를 포함할 수 있는 원본은 커밋하지 않고 SHA-256을 기록한다.

| 검사 | JSON SHA-256 |
|---|---|
| ci-verification | `3152d09faa99ec941ef57d2820093934028a41319c0d09c3807f2169f65509d0` |
| artifact-verification | `c52e96a5869913150e1a846d8fccdb900bd7b8a62bc0347c1037f5b4c4ec1cf6` |
| draft-verification | `831665544bd04f79b64c334d67255f9e67983ecbca437de944c65a0cdd68ac2d` |
| public-downloads | `aaf282975020b32a03436613f76308c879ecfd0163d6e1bc79925f0604a654da` |
| public-updater | `3274ff6f40de8a78b4127eec010af8c3d2482b58a7762834f1507bc98f81dcfa` |
| installed-payload-match | `3181c520cdb3b82c5c5747b3a9d003e2d13b88a524ce7eb0de03960f06760550` |
| previous-public-preservation | `bc77b9ff4ed53ea7a56cac2d4f5366ec7b21c7c371b820dbbd2aa436a83c7e04` |

공개 업데이트 다운로드 검사는 현재 제품 updater에 격리 버전 어댑터를 사용했으며 설치를 실행하지 않았다. 실제 설치 교체는 위 일회성 Windows 검사와 구분한다. OS 재부팅·모든 CLI 버전·WSL·실물 모바일의 전체 조합은 검증하지 않았다.
