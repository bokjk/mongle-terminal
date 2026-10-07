# 0.3.14 공개 배포 검증

> 공개 완료. [최종 증거](#0314-final)를 따른다. 아래 준비·오류·재시도 기록은 당시 이력으로 보존한다.

## 배포 준비

2026-10-07. CLI 드래그·Shift 자동 복사와 모바일 전체화면 스크롤을 0.3.14로 공개 준비한다. 현재 공개는 0.3.12이며 게시·익명 다운로드 검증 전에는 완료로 표시하지 않는다.

## 기능과 이전 검사

제품 코드는 [0.3.13 태그 검사](public-release-0.3.13.md)의 회귀 456 통과·0 실패·14 선택 생략, 별도 네이티브 2/2 및 실제 NSIS 교체·작업 복원을 통과했다. [Claude 실제 앱](claude-native-selection.md), [Codex 실제 앱](codex-native-selection.md), [Chrome 모바일 실제 CLI 연결](mobile-cli-scroll.md)의 검증 범위를 유지한다. 새 0.3.14 PR과 태그에서 다시 확인한다.

## 배포 보존 수정

공개 소스 대응의 로컬 전체 보존·probe 흐름 30개를 통과했다. public/private 저장소의 비공개 초안 보존 성공, 다른 저장소·불일치 visibility·게시된 릴리스·다른 실행 혼합 거부를 실제 PowerShell 스크립트와 모의 API 경계에서 확인했다. 타입 검사와 두 workflow의 actionlint도 통과했다. 모의 검사는 실제 Actions 토큰 조회 결과를 대신하지 않는다.

0.3.13은 제품 검사 후 파일 보존에 실패해 공개하지 않았다. 자동화 토큰에서 REST 목록에 draft가 누락되는 알려진 사례를 확인해 GraphQL로 초안을 찾고 ID 기반 REST 응답을 대조한다. 생성 직후 아직 보이지 않는 경우만 제한 재조회한다. API 오류·published 릴리스·다른 실행의 초안은 계속 거부한다. 필수 검사와 보존 실패는 여전히 배포를 중단한다. 기존 소스 태그와 실패한 비공개 초안은 조사 이력으로 유지한다.

## 게시 전 확인

기능 PR과 dev→main 배포 PR의 Windows·실제 설치·대상 정책을 확인한 뒤 최종 태그를 만든다. 태그의 필수 회귀·패키징·네이티브·NSIS 교체·복원과 동일 파일 보존을 확인한다. 공개 첨부 5개·변경 이력·latest.yml의 버전·크기·해시를 검증하고 게시 뒤 익명 전체 다운로드와 실제 Electron 업데이트 다운로드를 검사한다.

## 남은 검증 범위

모바일 기준은 사용자와 합의한 Chrome 에뮬레이션이다. 실물 갤럭시·삼성 인터넷·OS 키보드·외부 Tailscale 네트워크는 전수 검사하지 않았다. Claude의 Jump to bottom 안내에 가린 글자 복사 누락은 허용된 제약으로 남는다. 실사용 앱·세션·인증·Tailscale Serve를 변경하지 않으며 라이선스·코드 서명 상태를 유지한다. 소스는 후속 사용자 승인으로 공개했고 배포 전용 저장소는 유지한다.

실제 CI 토큰의 읽기 전용 초안 조회 검사를 별도로 실행한 뒤 태그를 생성한다. 개인 토큰을 CI secret에 복제하지 않는다. 참고: [GitHub CLI 보고](https://github.com/cli/cli/issues/5252).

## Actions 예산으로 실행 차단

아래는 소스 공개 전의 차단 이력이다. 2026-10-07 공개 전환 뒤 PR #48의 Linux 검사와 Windows 작업이 실제 시작됐음을 확인했다. [공개 점검 기록](source-publication.md). 0.3.14 후보에는 공개 저장소에서도 지정된 비공개 초안만 보존하도록 범위 검사를 보완하며, 이전 비공개 저장소 상태를 무조건 요구하던 조건을 제거한다. 기존 초안의 태그·SHA·실행·해시 검증 및 게시된 릴리스 거부는 유지한다.

수정 PR #47의 제품/보존 코드 `807d98f2287a6fd4ca06b90173ce2dd2731f320a`에서 로컬 전체 보존 흐름 20개(기존 회귀에 포함되는 wrapper 1개), 타입·버전/문서·diff 검사를 통과했다. 별도 코드 리뷰에서 추가 blocker를 발견하지 못했다. 개인 인증으로 GraphQL의 기존 비공개 draft ID·태그·상태 조회는 확인했으나 CI job-token probe는 아직 실행하지 못했다.

GitHub [Windows 검사 37521930313](https://github.com/bokjk/mongle-terminal/actions/runs/37521930313)는 단계가 하나도 시작되지 않았고 `The job was not started because an Actions budget is preventing further use.`라는 annotation으로 실패했다. 같은 커밋의 실제 설치 검사와 대상 정책, 별도 수동 실행도 같은 시점에 실행 전 실패했다. 이 결과를 제품 테스트 실패나 새 버전 CI 통과로 해석하지 않는다.

0.3.14 태그·공개 Release는 아직 만들지 않았다. 현재 공개 버전은 0.3.12다. [공개 README PR #7](https://github.com/bokjk/mongle-terminal-releases/pull/7)은 draft이며 공개 확인 뒤 병합한다. 예산 설정이나 결제 수단·저장소 공개 범위를 변경하지 않았다. 예산 한도 해제 후 현재 PR의 필수 Windows·설치·대상 정책, 실제 job-token 조회 probe, dev→main 배포 PR과 최종 태그·공개 다운로드 검증을 완료해야 한다.

<!-- release-0.3.14-finalized -->
<a id="0314-final"></a>

## 최종 공개 결과

공개 소스의 실제 Actions 토큰으로 기존 초안을 읽는 [조회 전용 검사 37552799663](https://github.com/bokjk/mongle-terminal/actions/runs/37552799663)도 통과했다. GraphQL·REST의 ID/태그/draft/본문 일치와 파일 목록 조회를 확인했다. 최종 빌드는 artifact 보존에 성공했으므로 대체 초안 보존 경로로 파일을 게시하지 않았다.

**0.3.14 공개 배포 완료(2026-10-07):** [공개 릴리스](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.14). [PR 검사 37552799912](https://github.com/bokjk/mongle-terminal/actions/runs/37552799912): 460 통과·실패 0·15 생략. [최종 태그 검사 37553799324](https://github.com/bokjk/mongle-terminal/actions/runs/37553799324): 461 통과·실패 0·14 생략. [설치 교체 검사 37552799928](https://github.com/bokjk/mongle-terminal/actions/runs/37552799928)와 설치 payload 일치, 공개 첨부 5개 전체 다운로드·해시, Electron 업데이트 다운로드 검증을 통과했다. 이전 공개 릴리스 파일은 유지했다.

- 게시 시각(UTC): 2026-10-07T01:05:38Z
- 실제 main SHA: `56d8426243502f37a8bfca356abebf0dfbc17831`
- 태그: [v0.3.14](https://github.com/bokjk/mongle-terminal/tree/v0.3.14)
- 공개 README: [PR](https://github.com/bokjk/mongle-terminal-releases/pull/7)
- 이전 공개 릴리스 변경 없음: 확인

모든 필수 검사를 통과한 windows-release artifact의 동일 파일을 공개했다.

### 공개 첨부 해시

| 파일 | 바이트 | SHA-256 |
|---|---:|---|
| MongleTerminal-Setup-0.3.14-x64.exe | 161272360 | `a23fd799c11ffb8c8fee4b180d07b19e6856415239c207c8c499f39d9676ecf2` |
| MongleTerminal-Setup-0.3.14-x64.exe.blockmap | 167968 | `6c0ac670669282939345fc458e59def00b6fb0a6500eade561e5bafea6a96fff` |
| MongleTerminal-0.3.14-x64.zip | 209310001 | `1bdd28158e437e7f5bd2d57e078be3582c05824068a94fac7ae36492cd638128` |
| latest.yml | 368 | `572fea3eabadf9c747b4026011e8af628c92d50a45a6db87341d19dc03cea13b` |
| SHA256SUMS.txt | 386 | `96f2cf817bad8015dc389302554cc0fd6d077c10a0096a84f8557f2a8a7ed521` |

### 최종 검증 영수증

다음 JSON은 로컬 검사 영수증이다. 원본의 개인 경로·프로세스 정보는 문서에 복제하지 않고 SHA-256만 기록한다.

| 검사 | 결과 | 원본 JSON SHA-256 |
|---|---|---|
| artifact-verification | 통과 | `f84af7be236356f76b6a3c628e79cd59b162911441c8b5b6491069526452f8f7` |
| draft-verification | 통과 | `9276690593403eb245effda1956653d2a6935c3627973922650b7cd34b9c3ef8` |
| public-downloads | 통과 | `06c5b35e8a04ed8ffc546ad9bf61acb133082a5d9f2c556e0cf192567a0a1bac` |
| public-updater | 통과 | `aa3bf5ee16499f27db7cb88099370e49ed511c3b317df900bb751f5cee015576` |
| installed-payload-match | 통과 | `857e33c4c2dcfb6aa70671946efd2aa6d7c848f0a6d3791eb17577d8bc32af70` |

### 확인 범위와 남은 제약

모바일은 Chrome의 화면·trusted touch 에뮬레이션과 실제 Claude·Codex PTY 연결을 검증했다. 실물 휴대폰·삼성 인터넷·OS 키보드·외부 Tailscale 네트워크 검증으로 표현하지 않는다. Claude의 Jump to bottom 안내가 가린 글자의 복사 누락은 사용자에게 설명하고 허용된 알려진 제약으로 남는다. 사용 중인 설치본의 자동 교체·모든 CLI 버전의 검증을 뜻하지 않는다.

소스는 사용자 승인으로 공개했으며 라이선스·코드 서명 상태는 유지한다. 위 CI 설치 검사는 격리 러너에서 수행한 결과이며 실사용 설치본 교체로 표현하지 않는다.
