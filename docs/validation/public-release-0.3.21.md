# 0.3.21 공개 배포 검증

**공개 완료.** [최종 결과](#final)를 따른다. 아래 준비 기록은 당시 이력이다.

## 변경 범위

- 휴대폰 알림: 휴대폰 브라우저(또는 홈 화면 앱)에서 켜면, PC가 잠겨 있거나 5분 넘게 입력이 없고 어느 기기에서도 그 PC의 몽글 화면을 5분 안에 보지 않았을 때 Claude·Codex의 확인 요청과 새 기기 연결 요청을 Web Push로 보낸다. 요청마다 기기당 한 번, 이름만 담는다. RFC 8291·8292를 `node:crypto`로 구현했고 새 의존성은 없다.
- 한 번에 최신 버전으로 업데이트: 받아 둔 업데이트가 있어도 새 버전 확인을 계속하고, 설치 직전 **최신 버전 확인** 단계에서 한 번 더 확인해 더 새로운 버전으로 설치한다.
- Codex 작업 상태: PowerShell에서 `codex`로 시작한 Codex의 작업 중·확인 요청·응답 완료를 Claude처럼 표시한다. Codex CLI 0.162.0 이상에서 관리 훅 6개를 더 등록하므로, 업데이트 뒤 Codex `/hooks`에서 새 몽글터미널 훅을 신뢰해야 한다.
- PC 앱의 찾은 PC 추가: 컴퓨터 추가 창에서 같은 Tailscale의 다른 몽글 PC를 골라 바로 등록·연결한다. 창을 닫으면 연 버튼으로 초점이 돌아간다.
- README·변경 이력·사용자 안내·배포 문서와 버전을 0.3.21로 정리한다. 의존성·라이선스·저장소 공개 범위는 바꾸지 않는다.

## 개발 단계 근거

[휴대폰 알림](phone-notifications.md), [업데이트](auto-update.md#늦게-설치해도-최신-버전으로), [Codex 작업 상태](codex-status.md), [PC 앱 컴퓨터 추가](desktop-computer-picker.md) 기록을 따른다. 타입·빌드, 휴대폰 알림 시험(웹 푸시 5/5·알림 판정 9/9·PC 상태 3/3·설정 화면 1/1), 보안 32/32, 업데이트 28/28과 실제 electron-updater E2E 1/1, 격리한 `MONGLE_DATA_DIR`의 전체 회귀 647개 중 629 통과·1 실패·17 생략(실패는 기존 PowerShell 실행 정책 환경 문제)을 확인했다. 휴대폰 알림의 실제 앱·브라우저 확인은 알림 설정 화면 표시까지 했고, 브라우저 알림 권한 단계에서 사용자 승인을 기다리며 멈춰 구독·수신·요청 알림은 공개 전에 확인하지 못했다. 실물 휴대폰 수신은 사용자 PC의 실제 원격 주소가 필요해 배포 뒤 확인한다.

## 배포 안내에 넣을 내용

- Codex 작업 상태는 업데이트 뒤 Codex `/hooks`에서 새 몽글터미널 훅을 신뢰해야 동작한다.
- 휴대폰 알림은 PC를 업데이트한 뒤 휴대폰 화면을 새로 고치고 **설정 → 원격 연결 → 이 기기로 알림 받기**에서 PC마다 켠다.

## 배포 전 검사

배포 준비 커밋의 PR 검사, 배포 PR·최종 태그 검사, 패키지와 공개 다운로드 결과는 수행한 뒤 기록한다. 실패·생략한 검사를 통과로 표시하지 않는다. 사용자 설치본·인증·작업은 변경하지 않는다.

<a id="final"></a>

## 최종 공개 결과

**0.3.21 공개 배포 완료(2026-10-12):** [공개 릴리스](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.21). [개발 PR](https://github.com/bokjk/mongle-terminal/actions/runs/38167940259) 631 통과·0 실패·16 생략, [배포 PR](https://github.com/bokjk/mongle-terminal/actions/runs/38169593348) 631 통과·0 실패·16 생략, [최종 태그](https://github.com/bokjk/mongle-terminal/actions/runs/38170846352) 633 통과·0 실패·14 생략. 네이티브 2/2, [실제 NSIS 업데이트·자동 재실행·복원](https://github.com/bokjk/mongle-terminal/actions/runs/38170846352), 최종 설치 payload 일치, 공개 첨부 5개 익명 전체 다운로드·해시, 실제 Electron updater의 0.3.20→0.3.21 다운로드와 동일 버전 최신 상태 확인을 통과했다. 이전 공개 릴리스는 보존했다.

- 게시 시각(UTC): 2026-10-11T20:30:56Z
- 소스 태그: [v0.3.21](https://github.com/bokjk/mongle-terminal/tree/v0.3.21)
- main SHA: `2e0c34b44ed6348cddf27318752409698f49c4d4`
- PR: [개발 #69](https://github.com/bokjk/mongle-terminal/pull/69), [배포 #70](https://github.com/bokjk/mongle-terminal/pull/70)
- 공개 안내: [배포 README #14](https://github.com/bokjk/mongle-terminal-releases/pull/14)

최신 head·base의 필수 검사와 독립 검토 후 CONTRIBUTING에 따른 소유자 PR 병합 경로를 사용했다. 검증된 최종 태그 산출물의 동일 바이트를 공개했다.

### 실제 설치 검사 범위

공개 0.3.16에서 후보로 legacy silent 업데이트 인수를 전달해도 실제 진행 막대가 표시됐고 설치본이 자동으로 다시 열렸다. 이어 같은 후보를 재설치해 새 표시형 업데이트 인수와 Claude 2개·Codex 2개 시험 대화의 정확한 ID 복원을 검증했다. 설치 파일·app.asar·전체 hostbundle이 후보와 일치했고 시험 프로세스는 정상 종료했다. 설치 검사의 CLI는 인증이나 모델을 사용하지 않는 시험 대역이다. 이번 휴대폰 알림·업데이트·Codex 작업 상태·찾은 PC 추가의 실제 앱·브라우저 검증과 독립 코드 검토는 [휴대폰 알림](phone-notifications.md)·[업데이트](auto-update.md#늦게-설치해도-최신-버전으로)·[Codex 작업 상태](codex-status.md)·[PC 앱 컴퓨터 추가](desktop-computer-picker.md) 기록을 따른다. 실제 사용자 설치본·인증·작업은 변경하지 않았다.

hosted Windows의 두 정상 종료는 검증된 Electron 트레이 콜백으로 실제 메뉴를 열고 종료 항목과 확인창을 조작했다. Explorer 알림 영역 아이콘을 물리적으로 우클릭한 검증은 아니다.

### 공개 파일

| 파일 | 바이트 | SHA-256 |
|---|---:|---|
| MongleTerminal-Setup-0.3.21-x64.exe | 161314777 | `352020b99ac938a8b3bfa14e14ed4ca5bceec7cb5c65a1ba91b6ef836b7c3bab` |
| MongleTerminal-Setup-0.3.21-x64.exe.blockmap | 168119 | `0abee925058fe68a46747e1dded0c71c8593e3c348a8e8f42f099e0cec427e5b` |
| MongleTerminal-0.3.21-x64.zip | 209360120 | `ae4f0f7c22de3f78935d8e68952819081f90716745428fa0ebb3f102cb995b18` |
| latest.yml | 368 | `7285baf9693d30c5767b5e95265212eb613d1b2f1dcaf7ea56a768b65407d11a` |
| SHA256SUMS.txt | 386 | `48149dcd8caac0ac6893be4861f44e58d2b99b1a53deaf78c8aba3a3315d8ef0` |

### 검증 영수증

개인 경로를 포함할 수 있는 원본은 커밋하지 않고 SHA-256을 기록한다.

| 검사 | JSON SHA-256 |
|---|---|
| ci-verification | `133ee4a6d93edb7e64ce275c1189a16619ef0f0148b40965e488465ad9936f07` |
| artifact-verification | `b8fb54fb0d961fd946de651ceb004417214087cb14f8e185293e028d18c1e50a` |
| draft-verification | `9185ae902802f7d377019714164552471821d5bf894042d98bc1686ff8b25830` |
| public-downloads | `2432a977e888f5c1e7ab6e8fdc3c0e8e6649e81a308acbf637a2c215299ebb9d` |
| public-updater | `ceb32c54c397c35c5c10029ca834a6ad1e6122654b798890c8caf233bb6ea719` |
| installed-payload-match | `a2a389adf603c3d9bcab74e4311e83a8aa57b852950243f2dc1780e7eb0de5a7` |
| previous-public-preservation | `5745865feecbfab5e84874c8fc4ae992b9eb2090fb9d8da54e485d397b96cc8f` |

공개 업데이트 다운로드 검사는 현재 제품 updater에 격리 버전 어댑터를 사용했으며 설치를 실행하지 않았다. 실제 설치 교체는 위 일회성 Windows 검사와 구분한다. OS 재부팅·모든 CLI 버전·WSL·실물 모바일의 전체 조합은 검증하지 않았다.
