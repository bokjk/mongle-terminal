# 0.3.17 공개 배포 검증

**공개 완료.** [최종 결과](#final)를 따른다. 아래 준비 기록은 당시 이력이다.

## 변경 범위

- 사이드바 업데이트 알림, 실제 다운로드 진행률, 설치 준비 단계와 NSIS 설치 진행 창, 설치 후 자동 재실행.
- 연동으로 수집한 Claude·Codex의 정확한 대화를 정상 종료·업데이트 후 재개. 처음 이 기능을 받는 업데이트에서 과거 대화 ID를 소급 수집하지 않는다.
- Codex는 PowerShell·CLI 0.160.0 이상과 사용자의 최초 관리 훅 신뢰가 필요하다. CLI 자체 업데이트·로그인·신뢰 안내는 자동 승인하지 않는다.
- README·변경 이력·사용자 안내·배포 문서와 버전을 0.3.17로 정리한다. 의존성·라이선스·저장소 공개 범위는 바꾸지 않는다.

## 개발 단계 근거

[업데이트 화면·설치 진행 구현](auto-update.md#업데이트-알림과-설치-진행-표시), [대화 재개 검증](agent-session-restore.md)을 따른다. 실제 개발 앱의 Claude 재개와 Codex 정상 신뢰→대화 A 재개→새 대화 B 수집→B 재개→종료 후 재실행 방지를 확인했다. 복원·연동 재검사 35/35와 기존 수명 주기 검사 62/62는 실제 설치 파일 교체 검증과 구분한다.

## 배포 전 검사

일회성 GitHub 호스팅 Windows에서 기존 사용자 설치본을 건드리지 않고 실제 설치·교체·자동 재실행·작업 복원을 검사한다. 새 검증 코드, PR·최종 태그·패키지·공개 다운로드 결과는 수행한 뒤 기록한다. 실패·생략한 검사를 통과로 표시하지 않는다.

### 첫 설치 검사 실패

[개발 PR #57의 첫 설치 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37653559192)는 0.3.16 설치·앱 실행·두 셸 생성·정상 완전 종료 후 후보 설치 파일의 종료 코드 0까지 확인했으나, 표시된 새 앱의 `--updated` 자동 실행 증거를 찾지 못해 실패했다. 진행 창 증거와 앱 재실행 증거는 별도이며, 이 실패를 배포 성공으로 취급하지 않는다. 후속 수정과 재검사 결과를 함께 기록한다.

[첫 전체 회귀](https://github.com/bokjk/mongle-terminal/actions/runs/37653559477)는 568개 중 552 통과·1 실패·15 선택 생략이었다. 네이티브 검사는 별도로 2/2 통과했다. UI 검사 한 곳이 기능 변경 전의 “대화도 복원되지 않는다”는 문구를 기다려 실패했으며, 현재의 정확한 대화 재개와 진행 중 작업·미저장 내용·이전 요청 재전송의 제외 안내를 함께 확인하도록 수정했다. 후속 전체 CI 결과와 구분한다.

### 두 번째 설치 검사와 경로 보완

[두 번째 설치 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37655780401)도 자동 재실행 창을 찾지 못해 실패했다. Windows의 짧은 경로를 정규화했지만 해결되지 않았다. 원본 관찰에는 표시된 NSIS 진행 막대 한 건이 남았다. 설치 템플릿을 검토해 표시형 설치의 `instFilesPre`가 기존 사용자 지정 `application` 경로에 앱 이름을 덧붙이는 코드를 확인했다. 업데이트에서만 이 경로 보정을 건너뛰도록 수정했다. 실제 교체·자동 재실행 해결 여부는 후속 hosted CI에서 확인한다. 실패 시 프로세스·세션·창·설치 파일 증거도 제한된 분량으로 남기며 판정이나 종료 대상의 범위를 넓히지 않는다.

### 세 번째 검사의 기존 앱 시작 대기

[세 번째 설치 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37658025555)는 0.3.16 설치 뒤 소유자 연결이 먼저 준비되고 `host-info.json`은 아직 없는 시점에 읽어 실패했다. 후보 업데이트 단계는 실행되지 않았다. 호스트 시작 코드의 준비 순서를 확인했으며, 시험 코드가 상태·시작 파일·인증된 호스트 신원을 함께 기다리도록 보완한다. 실패 정리도 실제 실행한 버전으로 연결해야 한다. 이 실패로 앞선 설치 경로 수정의 효과를 판정하지 않는다.

### 네 번째 검사의 부분 통과

[네 번째 설치 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37659722797)는 기존 앱 준비, 표시된 NSIS 진행 막대, 기존 경로의 `--updated` 자동 재실행, 설치 payload 일치와 작업 공간 자동 복원을 확인했다. 이후 시험용 Claude 연동 상태가 `unavailable`여서 중단했으며, 후속 대화 ID 복원은 실행하지 않았다. 실패 정리의 네이티브 메뉴 조작도 확인창을 찾지 못했다. 시험 CLI 검색 환경과 종료 조작을 보완하고 재검사하며, 부분 통과를 전체 설치 검사 성공으로 표시하지 않는다.

[같은 커밋의 전체 회귀](https://github.com/bokjk/mongle-terminal/actions/runs/37659723004)는 572개 중 556 통과·1 실패·15 생략, 네이티브 2/2였다. 실제 Windows 짧은 경로 검사의 PowerShell 보조 코드 컴파일이 10초 제한을 넘겼다. 해당 보조 프로세스의 제한 시간을 30초로 늘리며 경로 신원·다른 파일 거부 검증은 유지한다.

### 다섯 번째 검사의 종료 메뉴 자동화

[다섯 번째 설치 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37661812533)에서는 설치·자동 재실행·payload·작업 공간 복원에 이어 시험용 Claude·Codex 연동과 네 개 대화 ID 저장까지 진행했다. 재설치 전 정상 종료 단계에서 네이티브 메뉴와 UI Automation의 메뉴 항목을 찾지 못해 실패했다. 기존 PATH 폴더에 배치한 시험 CLI는 실제 패키지의 버전 검색에서 인식됐으며 기존 파일·레지스트리·PATH 값은 바꾸지 않았다. 두 번째 설치와 정확한 대화 재개 검증은 아직 완료하지 않았다.

Electron 44.4.5의 [창 생성 코드](https://github.com/electron/electron/blob/v44.4.5/shell/browser/native_window.cc#L97)와 [메뉴 코드](https://github.com/electron/electron/blob/v44.4.5/shell/browser/ui/views/root_view.cc#L50)를 확인했다. 현재 `titleBarStyle: hidden` 창에는 상단 메뉴를 만들지 않으므로 Alt 키로도 열 수 없다. 시험 종료 조작은 제품이 실제 제공하는 트레이 메뉴를 사용하도록 보완한다.

### 여섯 번째 검사의 hosted 트레이 노출

[여섯 번째 설치 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37663993603)에서도 설치·재실행·작업 공간 복원·대화 ID 저장 뒤 정상 종료 자동화가 실패했다. hosted Windows의 `Shell_TrayWnd`는 UI Automation에 아이콘 버튼을 노출하지 않았다. Electron 44.4.5의 [트레이 콜백](https://github.com/electron/electron/blob/v44.4.5/shell/browser/ui/win/notify_icon_host.cc#L231), [아이콘 ID 초기값](https://github.com/electron/electron/blob/v44.4.5/shell/browser/ui/win/notify_icon_host.h#L46), [메뉴 열기 구현](https://github.com/electron/electron/blob/v44.4.5/shell/browser/ui/win/notify_icon.cc#L65)을 확인했다. 대상 앱의 트레이 이벤트로 실제 메뉴를 열고 실제 종료 항목과 확인창을 조작하는 검사 경로를 보완한다. 이 경로는 Explorer 아이콘의 물리적 우클릭 검증과 구분한다.

<a id="final"></a>

## 최종 공개 결과

**0.3.17 공개 배포 완료(2026-10-08):** [공개 릴리스](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.17). [개발 PR](https://github.com/bokjk/mongle-terminal/actions/runs/37665849941) 560 통과·0 실패·15 생략, [배포 PR](https://github.com/bokjk/mongle-terminal/actions/runs/37668564841) 560 통과·0 실패·15 생략, [최종 태그](https://github.com/bokjk/mongle-terminal/actions/runs/37670435649) 561 통과·0 실패·14 생략. 네이티브 2/2, [실제 NSIS 업데이트·자동 재실행·복원](https://github.com/bokjk/mongle-terminal/actions/runs/37670435649), 최종 설치 payload 일치, 공개 첨부 5개 익명 전체 다운로드·해시, 실제 Electron updater의 0.3.16→0.3.17 다운로드와 동일 버전 최신 상태 확인을 통과했다. 이전 공개 릴리스는 보존했다.

- 게시 시각(UTC): 2026-10-07T19:18:23Z
- 소스 태그: [v0.3.17](https://github.com/bokjk/mongle-terminal/tree/v0.3.17)
- main SHA: `805d34f20390c3bd7492ea1507eebc87e1d48e5a`
- PR: [개발 #57](https://github.com/bokjk/mongle-terminal/pull/57), [배포 #58](https://github.com/bokjk/mongle-terminal/pull/58)
- 공개 안내: [배포 README #10](https://github.com/bokjk/mongle-terminal-releases/pull/10)

최신 head·base의 필수 검사와 독립 검토 후 CONTRIBUTING에 따른 소유자 PR 병합 경로를 사용했다. 검증된 최종 태그 산출물의 동일 바이트를 공개했다.

### 실제 설치 검사 범위

0.3.16에서 후보로 legacy silent 업데이트 인수를 전달해도 실제 진행 막대가 표시됐고 설치본이 자동으로 다시 열렸다. 이어 같은 후보를 재설치해 새 표시형 업데이트 인수와 Claude 2개·Codex 2개 시험 대화의 정확한 ID 복원을 검증했다. 설치 파일·app.asar·전체 hostbundle이 후보와 일치했고 시험 프로세스는 정상 종료했다. 설치 검사의 CLI는 인증이나 모델을 사용하지 않는 시험 대역이며, 실제 Claude·Codex 검증은 [개발 앱 기록](agent-session-restore.md)을 따른다. 실제 사용자 설치본·인증·작업은 변경하지 않았다.

hosted Windows의 두 정상 종료는 검증된 Electron 트레이 콜백으로 실제 메뉴를 열고 종료 항목과 확인창을 조작했다. Explorer 알림 영역 아이콘을 물리적으로 우클릭한 검증은 아니다.

### 공개 파일

| 파일 | 바이트 | SHA-256 |
|---|---:|---|
| MongleTerminal-Setup-0.3.17-x64.exe | 161291455 | `4edc2225d52b5e9b0f8d842ba90eadd2a35dd81d97b2caa3b743ded893e17137` |
| MongleTerminal-Setup-0.3.17-x64.exe.blockmap | 167975 | `913a931985e4f38896fa66fe2e7e29df165186418ef396ea5ea9fc1ab480daeb` |
| MongleTerminal-0.3.17-x64.zip | 209332466 | `8979e23708ec905afc29a9f14335fb74970a24f6d91f5d8cf229dc789cae6d5a` |
| latest.yml | 368 | `964ec791a596beb0c541f0c3d38b890fc012d98c1347bb6c4b0deafaca567f19` |
| SHA256SUMS.txt | 386 | `d00c5522ee8453cae84943106d34e4dbe077ce88faca284791c7cc13ab1fff64` |

### 검증 영수증

개인 경로를 포함할 수 있는 원본은 커밋하지 않고 SHA-256을 기록한다.

| 검사 | JSON SHA-256 |
|---|---|
| ci-verification | `9c51fa80e9161fa7bb5b6c2f7f46020095a8189de7f1de5d66acfd5ff30a78b9` |
| artifact-verification | `7004559addaec9e8970307e1f5581f80edd8b831940e490f9b406714aa826926` |
| draft-verification | `98e9ba63aee59d31fc53af0379d8efdfee2ef3700978560d7f3269ba5354fac8` |
| public-downloads | `f7f8eae9eeeb05f4466a36e946cc9d4c921c90bdcad7e57407c1203510f07ecb` |
| public-updater | `b210cbf9dc0e657bf4e050ef500e346656a68d96727a52645aa6f929a5c0a27f` |
| installed-payload-match | `53ddfed79546fbc3cea64943927501efc1c63098ac5cea62f2668433cfe92b27` |
| previous-public-preservation | `ab90c897ea30610360e30b0798e2be74858edd1f07a2c2d196324adb6fb97107` |

공개 업데이트 다운로드 검사는 현재 제품 updater에 격리 버전 어댑터를 사용했으며 설치를 실행하지 않았다. 실제 설치 교체는 위 일회성 Windows 검사와 구분한다. OS 재부팅·모든 CLI 버전·WSL·실물 모바일의 전체 조합은 검증하지 않았다.
