# 0.3.11 공개 배포 검증

## 준비와 기능 검사

2026-10-05. **0.3.11 공개 배포와 익명 다운로드 검증을 완료했다.** 파일 편집·마크다운, 미저장 종료 보호, 읽기 요청 취소·성능 보완과 NSIS 압축 호환성 수정을 포함한다. 아래에 준비·검사·실제 게시 결과를 구분해 기록한다.

- 기능 PR: [#38](https://github.com/bokjk/mongle-terminal/pull/38), head `e5dc131e52d29b51f9689a216914105e22af3229`.
- [기능 Windows checks](https://github.com/bokjk/mongle-terminal/actions/runs/37268615602): 전체 423개 중 408 통과·실패 0·선택 실행 15 생략. 별도 네이티브 클립보드·업데이트 브리지 2/2 통과.
- [실제 설치 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37268506904): 공개 0.3.8 NSIS 설치 → 실제 호스트와 cmd 두 개 → 정상 완전 종료 → 0.3.11 NSIS 교체 → 자동 작업 복원 → 정상 종료·시험 프로세스 정리 통과.
- 설치된 app.asar와 hostbundle 496개 전체의 경로·SHA-256이 패키지 원본과 일치했다. 누락·추가·변경 0개, 같은 작업 정보와 문서 유지, 새 bootId·셸 PID, `cleanedUp: true`였다.
- 기능 PR은 `02e65cb1dfe798be14375b266c27b35e2edd3091`로 dev에 병합했다. [배포 PR #39](https://github.com/bokjk/mongle-terminal/pull/39)의 검사·태그·실제 공개 결과는 아래에 추가한다.

## 설치 누락 원인과 수정

최신 7-Zip은 node-pty에 포함된 ARM64 바이너리 6개를 ARM64 필터로 압축했다. NSIS의 nsis7z 플러그인은 이 필터를 풀지 못해 해당 파일만 누락했다. x64 파일은 일치했지만 전체 파일 일치 검사에서 배포를 중단했다. 최신 7-Zip 추출은 495/495, 동일 NSIS 플러그인은 489/495여서 압축 해제기 차이를 재현했다.

패키징에 BCJ 필터를 명시한 뒤 같은 NSIS 플러그인이 495/495를 정확히 복원했고, 독립 Windows의 실제 NSIS 설치도 496/496을 복원했다. 두 환경의 런타임/고지 구성 차이에 따른 총수 차이이며, 각 원본 패키지 대비 모든 파일을 검사했다. 검증 예외를 추가하거나 누락을 무시하지 않았다. [상세 조사](file-editor-release-audit.md).

## 실제 앱·백신 검사 범위

앞선 로컬 수정 후보에서 실제 Electron file URL의 Markdown Worker·미리보기·한글 저장·미저장 종료/업데이트 보호·정상 종료와 복원·Git 삭제 후 재생성 파일 열기를 확인했다. 알약 2.5(2026-10-05 엔진)의 후보 지정 폴더 정밀검사는 15,915개·1분 5초·탐지 0이었다. 해당 로컬 후보와 아래 최종 태그 artifact의 검사를 구분한다.

알약 기본 검사에 임시 파일 삭제 단계가 있으므로 활성 TEMP 시험 프로필과 동시에 검사하지 않는다. 사용자 호스트·셸·인증 파일·Tailscale Serve는 시험을 위해 변경하지 않는다. 최종 공개 설치본 검사는 별도로 기록한다.

## 남은 범위

실사용 설치본을 이 PC에서 교체하거나 OS를 재부팅하지 않았다. 실제 휴대폰, 모든 WSL·물리 IME 조합은 별도 범위다. 실제 설치 검사는 폐기 가능한 GitHub 호스팅 Windows에서 수행하며 확인창 응답은 자동화하므로 NSIS 마법사 전체 수동 조작과 구분한다. 코드 서명·소스 공개 범위·라이선스는 변경하지 않는다.

## 배포 PR과 소스 태그

[배포 PR #39](https://github.com/bokjk/mongle-terminal/pull/39)의 [Windows checks](https://github.com/bokjk/mongle-terminal/actions/runs/37269339073)는 전체 423개 중 408 통과·실패 0·선택 15 생략, 별도 네이티브 2/2 통과·생략 0이었다. dev push 검사도 통과했다. [실제 NSIS 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37269338903)는 전체 hostbundle 496개 일치·자동 복원·프로세스 정리까지 다시 통과했다.

배포 PR을 main의 `84d549d4644f6901f3563c1a94a23254c6b15cbf`로 병합하고 동일 커밋에 `v0.3.11` 태그를 생성·push했다. 기존 태그를 덮어쓰지 않았다. 태그 패키지 검사와 공개 여부는 후속 기록으로 구분한다.

## 공식 태그 검사

[태그 작업 37270115908](https://github.com/bokjk/mongle-terminal/actions/runs/37270115908)은 전체 423개 중 **409 통과·실패 0·선택 실행 14 생략**이었다. 실제 Electron 다운로드·손상 설치 파일 거부 검사를 포함했다. 최종 EXE의 네이티브 클립보드·업데이트 브리지는 **2/2 통과·생략 0**, 실제 NSIS 0.3.8 → 0.3.11 교체·전체 파일 일치·작업 복원·정리도 통과했다. 최종 설치본 SHA-256은 `b8bc5cc9f629f79b9fba793f8b6a3a5a63c7976f7603fe99e4dc2acbcd1be0a6`이다.

`windows-release` artifact ID는 `11328022882`, archive 364,426,586바이트, GitHub SHA-256 `6e8e10c7f6b68ae0449497e437f82be820ad7cc5842560020f1f475309f1f543`이다. 태그 설치 결과의 hostbundle은 496개·SHA-256 `f6c70e21b38e6275c17b4dac3dccc270f599672b1bc94f7d54906a05dfaf3fbb`, app.asar는 `ef17e51d2538c54bca9b2bca1dea7ffacb77363e7b06f010eb93b709cac81df7`이었다. 원시 결과는 커밋하지 않는 `test-results/release-0311`에 보존한다.

Actions의 `RELEASE_REPO_TOKEN`은 미설정이므로 자동 초안 생성만 건너뛰었다. 검증된 동일 artifact를 기존 인증을 이용한 게시 스크립트로 올리는 기존 절차를 사용하며, 새 토큰이나 보안 제외를 만들지 않는다.

## 내려받은 최종 산출물

Artifact archive의 전체 바이트와 GitHub SHA-256 일치를 확인한 뒤 풀었다. 동봉 체크섬·latest.yml의 버전/파일명/크기/SHA-512·Release 본문을 검사했다. ZIP을 실제로 풀어 CRC를 확인했으며 571개 파일 중 hostbundle 496개와 app.asar가 태그의 실제 설치 검사 원본과 일치했다.

| 파일 | 바이트 | SHA-256 |
|---|---:|---|
| `MongleTerminal-Setup-0.3.11-x64.exe` | 157926089 | `b8bc5cc9f629f79b9fba793f8b6a3a5a63c7976f7603fe99e4dc2acbcd1be0a6` |
| `MongleTerminal-Setup-0.3.11-x64.exe.blockmap` | 163971 | `96f6a589f4b1d59c09bfbf3263ab0f2f8e0efecae60fc2ad6fc7d6b7e0d12777` |
| `MongleTerminal-0.3.11-x64.zip` | 207124780 | `71311b0e9d13a9bc149bdd9aaef32816b7f31a4b372d27ed4a46b0324b322f82` |
| `latest.yml` | 368 | `9b5cd5dd844c523030fc5bc703c6d9fd11ce1204bdfad8864f8da782b1eb85f5` |
| `SHA256SUMS.txt` | 386 | `436cdf5ab85ed5b1741d9e6a165ac57709427c1c9299346771c477651f19a370` |

## 최종 백신 검사와 공개

공식 artifact의 설치 파일·ZIP·풀어놓은 패키지를 포함한 지정 폴더를 알약 2.5의 2026-10-05 엔진으로 검사했다. **15,837개·2분 26초·탐지 0개**였고, 지정 폴더 및 unpacked/locales/resources 검사 완료 로그를 확인했다. 백신 제외·보안 설정·격리 항목을 바꾸지 않았다. 검사 후 풀어놓은 571개 전체 파일과 공개 첨부의 해시가 그대로였다.

초안 첨부 5개의 이름·크기·GitHub SHA-256·본문을 검증한 뒤 [0.3.11 Release](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.11)를 **2026-10-05T06:24:06Z (UTC)**에 공개했다. Release ID는 `403418805`, draft/prerelease는 false이며 최신 안정 채널이다. [공개 README PR #4](https://github.com/bokjk/mongle-terminal-releases/pull/4)는 `f876cc6a7f04eeedde3bc1f303ca29e43d7007b6`으로 병합했다. 공개 저장소 태그는 이 안내 커밋을 가리키며 비공개 소스의 빌드 태그와 구분한다. 기존 0.3.10 첨부의 ID·크기·해시는 유지됐다.

## 공개 다운로드와 실제 업데이트 확인

공개 첨부 5개를 모두 인증 없이 전체 다운로드해 원본 artifact의 크기·SHA-256과 일치함을 확인했다. 설치본은 157,926,089바이트, ZIP은 207,124,780바이트 전체를 받았다. `test-results/release-0311/public-downloads.json`에 실제 결과가 있다.

격리된 실제 Electron에서 **태그와 같은 현재 업데이트 코드·현재 버전 0.3.10 지정·최종 패키지의 공개 GitHub 설정**으로 0.3.11 설치본 전체를 인증 없이 다운로드했다. ready·진행률 100%와 SHA-256 일치를 확인했고, 현재 버전을 0.3.11로 지정한 별도 확인은 idle·최신 버전입니다.였다. 오류는 없고 `installerExecuted: false`다. `public-updater.json`에 결과를 기록했다. 기존 설치본의 실행 코드를 통한 실제 자동 교체와는 구분하며, 이 PC의 설치본과 사용자 호스트를 바꾸지 않았다.
