# 0.3.20 공개 배포 검증

**공개 완료.** [최종 결과](#final)를 따른다. 아래 준비 기록은 당시 이력이다.

## 변경 범위

- 휴대폰 컴퓨터 전환: 데스크톱 앱이 아닌 브라우저 화면에서 메뉴 맨 위의 컴퓨터 이름을 누르면 **컴퓨터 전환** 창이 열린다. 지금 연 PC의 호스트가 같은 Tailscale 사용자의 온라인 Windows 기기에 몽글 원격 포트의 공개 상태 확인(`GET /health`)만 요청해 다른 몽글 PC를 찾고, 인증된 기기에만 `computers.list`로 알려 준다. PC를 고르면 그 PC 주소로 이동하며, 그 PC가 이 브라우저의 승인을 다시 확인한다.
- 주소로 추가: 목록에 없는 PC는 https `*.ts.net` 주소로 추가한다. 추가한 주소는 그 브라우저의 해당 PC 주소에만 최대 20개까지 저장한다.
- 원격 설정과 찾기가 같은 Tailscale 실행 코드를 쓰도록 나누고 공용 창 컴포넌트를 분리한다. 원격 설정의 동작은 바꾸지 않는다.
- README·변경 이력·사용자 안내·배포 문서와 버전을 0.3.20으로 정리한다. 의존성·라이선스·저장소 공개 범위는 바꾸지 않는다.

## 개발 단계 근거

[구현과 검증 기록](mobile-computer-switcher.md)을 따른다. 타입·빌드, 찾기 규칙 5/5, 보안 시험 26/26, 화면 시험 2/2(3회 연속), 로컬 전체 회귀 600개 중 584 통과·0 실패·16 생략을 확인했다. 이 PC의 실제 Tailscale을 읽기 전용으로 확인해 같은 계정의 다른 몽글 PC 1대를 찾았다. 아스트라의 독립 검토 지적 2건과 재검토에서 찾은 1건을 고쳤고, 마지막 수정의 읽기 전용 재검토에서는 남은 지적이 없었다. 격리 실제 앱·브라우저 확인에서 연결 승인, 다른 PC 찾기, 주소 추가·삭제, Esc 닫기, 다른 PC의 HTTPS 연결 화면으로 이동, Electron의 기존 컴퓨터 선택 메뉴를 확인했다. 마지막 기능 커밋 `a010cac`의 [개발 PR #66 Windows 검사](https://github.com/bokjk/mongle-terminal/actions/runs/38055486578)(601개 중 586 통과·0 실패·15 생략)와 [실제 NSIS 업그레이드·복원 검사](https://github.com/bokjk/mongle-terminal/actions/runs/38055486602)도 통과했다. 실물 휴대폰에서 두 PC 사이를 오가는 흐름, 실제 브라우저의 휴대폰 폭, 홈 화면 앱에서 다른 주소로 넘어갈 때, Tailscale 접근 규칙으로 막힌 환경은 확인하지 않았다.

## 배포 전 검사

배포 준비 커밋의 PR 검사, 배포 PR·최종 태그 검사, 패키지와 공개 다운로드 결과는 수행한 뒤 기록한다. 실패·생략한 검사를 통과로 표시하지 않는다. 사용자 설치본·인증·작업은 변경하지 않는다.

<a id="final"></a>

## 최종 공개 결과

**0.3.20 공개 배포 완료(2026-10-11):** [공개 릴리스](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.20). [개발 PR](https://github.com/bokjk/mongle-terminal/actions/runs/38058353171) 586 통과·0 실패·15 생략, [배포 PR](https://github.com/bokjk/mongle-terminal/actions/runs/38059276715) 586 통과·0 실패·15 생략, [최종 태그](https://github.com/bokjk/mongle-terminal/actions/runs/38060102492) 587 통과·0 실패·14 생략. 네이티브 2/2, [실제 NSIS 업데이트·자동 재실행·복원](https://github.com/bokjk/mongle-terminal/actions/runs/38060102492), 최종 설치 payload 일치, 공개 첨부 5개 익명 전체 다운로드·해시, 실제 Electron updater의 0.3.19→0.3.20 다운로드와 동일 버전 최신 상태 확인을 통과했다. 이전 공개 릴리스는 보존했다.

- 게시 시각(UTC): 2026-10-10T15:00:31Z
- 소스 태그: [v0.3.20](https://github.com/bokjk/mongle-terminal/tree/v0.3.20)
- main SHA: `352f5b6048e057ff52442c8c1b7a43ecea906990`
- PR: [개발 #66](https://github.com/bokjk/mongle-terminal/pull/66), [배포 #67](https://github.com/bokjk/mongle-terminal/pull/67)
- 공개 안내: [배포 README #13](https://github.com/bokjk/mongle-terminal-releases/pull/13)

최신 head·base의 필수 검사와 독립 검토 후 CONTRIBUTING에 따른 소유자 PR 병합 경로를 사용했다. 검증된 최종 태그 산출물의 동일 바이트를 공개했다.

### 실제 설치 검사 범위

공개 0.3.16에서 후보로 legacy silent 업데이트 인수를 전달해도 실제 진행 막대가 표시됐고 설치본이 자동으로 다시 열렸다. 이어 같은 후보를 재설치해 새 표시형 업데이트 인수와 Claude 2개·Codex 2개 시험 대화의 정확한 ID 복원을 검증했다. 설치 파일·app.asar·전체 hostbundle이 후보와 일치했고 시험 프로세스는 정상 종료했다. 설치 검사의 CLI는 인증이나 모델을 사용하지 않는 시험 대역이다. 이번 휴대폰 컴퓨터 전환의 실제 앱·브라우저 검증과 독립 코드 검토는 [구현과 검증 기록](mobile-computer-switcher.md)을 따른다. 실제 사용자 설치본·인증·작업은 변경하지 않았다.

hosted Windows의 두 정상 종료는 검증된 Electron 트레이 콜백으로 실제 메뉴를 열고 종료 항목과 확인창을 조작했다. Explorer 알림 영역 아이콘을 물리적으로 우클릭한 검증은 아니다.

### 공개 파일

| 파일 | 바이트 | SHA-256 |
|---|---:|---|
| MongleTerminal-Setup-0.3.20-x64.exe | 161299853 | `a2a7d67ed3ddd557eac012830ded41dc783e8170e12e482ae32e3aca75fa6d4b` |
| MongleTerminal-Setup-0.3.20-x64.exe.blockmap | 168034 | `c74871646cb75f0d5dd2c2e4a8f4868781057fdfe01913df18a73a14cd95148a` |
| MongleTerminal-0.3.20-x64.zip | 209342713 | `835321ac3b950e0dc955a330a675e85a164fa287756a081a7631cbd741eb84cc` |
| latest.yml | 368 | `ff5b95983d32d00f2a6b4e47c8dbe64aca876bbd5ac585bd65b9b82377a3d8c3` |
| SHA256SUMS.txt | 386 | `4cf8121bcc22d8567d29ae64229556197dc1336c2a51e89a3b342c4b83e034ec` |

### 검증 영수증

개인 경로를 포함할 수 있는 원본은 커밋하지 않고 SHA-256을 기록한다.

| 검사 | JSON SHA-256 |
|---|---|
| ci-verification | `94a8ce8f0f17baabde69458c2f9bb89b1a97d3a29d89d6bbf1d74878227ea2d9` |
| artifact-verification | `b7082b93cee9798956d5eab3ad07c87a5c7b21f57f8157249056a0dd5bbe7a19` |
| draft-verification | `7f099ed0b814cdca50d5642f731957e794c8330280fa310f60f90ffce3e8142a` |
| public-downloads | `532a420e1adeb94f8d2827df366d3858751d7ac3656fa2d7c6f11f21bd04bc4b` |
| public-updater | `8f4342073932480e2178f80df34f6729e39eec740c1d9705134fa1fbe7a350c5` |
| installed-payload-match | `c392dfb639f88393f663d3b16b104de2ebcee7ebb52be1a4b013ee4948883b2d` |
| previous-public-preservation | `407df9bc5bd37ad1c52df6731f1295c331583c5f60e5eb273ea25aabe0994fd7` |

공개 업데이트 다운로드 검사는 현재 제품 updater에 격리 버전 어댑터를 사용했으며 설치를 실행하지 않았다. 실제 설치 교체는 위 일회성 Windows 검사와 구분한다. OS 재부팅·모든 CLI 버전·WSL·실물 모바일의 전체 조합은 검증하지 않았다.
