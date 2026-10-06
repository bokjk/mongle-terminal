# 0.3.12 공개 배포 검증

## 배포 준비

2026-10-06. **0.3.12 공개 배포와 익명 다운로드 검증을 완료했다.** PDF 보기와 출력 갱신 중 드래그 자동 스크롤 수정을 포함한다. 아래에 준비 단계와 실제 검사·게시 결과를 구분한다.

PDF는 오른쪽 파일 탭의 읽기 전용 보기, 페이지 이동·배율·너비 맞춤·텍스트 선택·암호 입력을 제공한다. 파일당 8 MiB, PDF 탭 4개, 기존 인증·경로 제한과 64 KiB 분할 전송을 적용한다. 드래그 선택은 화면 갱신 사이에도 자동 스크롤 예정 시각을 유지한다.

## 로컬 검증

- [PDF 검증](pdf-preview.md): 관련 기존 회귀 31개와 추가 실제 WebSocket 8 MiB 전송/취소/승인 취소 및 Electron HTTPS 전송 2개 통과. Electron file URL의 한글·암호·CID/CMap·기본 글꼴·6 MiB 이미지 문서를 확인했다. 패키지 실행부의 OwnerPipe 원문 일치·정상 종료, NSIS 내부 payload·ZIP·압축 해제본의 웹 자산 197개 일치를 확인했다.
- [드래그 선택 검증](terminal-drag-scroll.md): 관련 회귀 55개, Aside 실제 TerminalPane과 시험용 전송·클립보드 경계의 한글·영문 120줄 선택/복사 요청 일치와 마우스 해제 통과.
- 위 로컬 패키지는 0.3.11 버전명을 사용한 격리 시험 후보이며 기존 공개 0.3.11 산출물을 변경하지 않았다. 게시에는 새 0.3.12 태그 작업의 검증된 artifact만 사용한다.
- 실사용 프로필·호스트·셸·인증 정보·Tailscale Serve를 변경하지 않았다.

## 남은 범위

물리 휴대폰/터치 키보드, 실제 외부 Tailscale 네트워크, 모든 PDF 글꼴·압축 형식과 Claude/Codex 화면 재그리기 유형은 전수 검증하지 않았다. 실제 설치 교체는 GitHub 호스팅 Windows에서 수행했으며 이 PC의 사용자 설치본을 교체하지 않는다. 코드 서명과 저장소 공개 범위·라이선스는 변경하지 않는다.

## 첫 CI와 시험 경로 수정

[기능 PR #41](https://github.com/bokjk/mongle-terminal/pull/41)의 첫 [Windows 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37422464358)는 432개 중 416 통과·1 실패·15 선택 생략이었다. 새 PDF WebSocket 시험이 셸 생성에는 TEMP의 원래 표기를 쓰고 RPC에는 realpath 표기를 보내 GitHub Windows의 짧은 경로 별칭에서 FILES_ROOT_CHANGED로 거부됐다. 두 입력에 같은 정규 경로를 사용하도록 시험 준비를 수정했다. 제품의 인증·현재 폴더 검사는 완화하지 않았으며 수정 후 전체 CI를 다시 실행한다.

같은 후보의 [실제 NSIS 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37422464361)는 0.3.8 → 0.3.12 설치 교체·작업 복원·정상 정리까지 통과했다. app.asar와 hostbundle 전체 694개가 원본과 일치했고 누락·추가·변경은 모두 0개였다. 최종 게시 파일은 별도 태그 검사 산출물을 사용한다.


## 최종 PR·태그 검사

기능 PR #41의 [수정 후 Windows 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37423563866)는 전체 432개 중 417 통과·실패 0·선택 15 생략, 별도 네이티브 2/2였다. [실제 설치 재검사](https://github.com/bokjk/mongle-terminal/actions/runs/37423563730)도 정상 교체·복원·정리와 파일 일치를 통과했다. dev 병합은 `a4a60f5b302db80e2bfa9d327e4542bbdb3ecc4c`다.

[배포 PR #42](https://github.com/bokjk/mongle-terminal/pull/42)의 [Windows 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37424591342)도 417 통과·실패 0·선택 15 생략과 네이티브 2/2를 통과했다. main 병합 `c594f2e7ea53c40cbec1cb450472726efe5e15e0`에 `v0.3.12` 태그를 push했다. main 직접 push나 기존 태그 교체는 하지 않았다.

[최종 태그 작업](https://github.com/bokjk/mongle-terminal/actions/runs/37425585366)은 전체 432개 중 418 통과·실패 0·선택 14 생략이었다. 실제 Electron 다운로드/손상 파일 거부를 포함하며 최종 EXE 네이티브 클립보드·업데이트 브리지는 2/2, 실제 NSIS 0.3.8 → 0.3.12 교체·작업 복원·정상 정리도 통과했다. 설치된 app.asar와 hostbundle 694개가 원본과 일치했다.

## 산출물과 공개

검증한 태그의 windows-release artifact를 내려받아 체크섬·latest.yml의 버전/크기/SHA-512·변경 이력 본문을 확인했다. ZIP의 app.asar와 hostbundle 694개는 태그 설치 결과와 해시가 같았고 PDF 자산 186개를 포함했다.

Artifact ID는 `11395263974`이며 GitHub가 보고한 archive 크기는 368,447,260바이트다. Actions의 `RELEASE_REPO_TOKEN`은 미설정이어서 자동 초안 생성만 건너뛰었고, 동일 artifact를 기존 인증과 `scripts/publish-release.ps1`로 초안에 올렸다. 이번 최종 산출물의 별도 알약 정밀검사는 수행하지 않았으며 이전 0.3.11의 백신 검사 결과를 이번 버전의 검사로 간주하지 않는다.

| 파일 | 바이트 | SHA-256 |
|---|---:|---|
| `MongleTerminal-Setup-0.3.12-x64.exe` | 159825329 | `fc91348a02eefc007b1046a0dca5e08b1bb86d3ac0641ead4b8a46f924a260f6` |
| `MongleTerminal-Setup-0.3.12-x64.exe.blockmap` | 165762 | `d7e3c65644b56e07801b8ebdac0be30a252b79a0341e16c84c44d22d9c142cab` |
| `MongleTerminal-0.3.12-x64.zip` | 209308393 | `cd2102310d1940eb625d1929b4c0dceee3b5b9a300ec7261f23644ef536d23ee` |
| `latest.yml` | 368 | `69fe492a50f6d81e271d9c79332f078bb148068f44549e71c890262a657a5e24` |
| `SHA256SUMS.txt` | 386 | `d1872a01963e5624b62109c434d86481baa09e494bee7889e754000715e269d4` |

[공개 0.3.12 Release](https://github.com/bokjk/mongle-terminal-releases/releases/tag/v0.3.12)를 **2026-10-06T07:07:19Z (UTC)**에 게시했다. Release ID는 `404416392`, draft/prerelease는 false이며 최신 안정 채널이다. 초안 첨부 5개를 대조한 뒤 게시했으며 기존 0.3.11 첨부의 ID·크기·해시는 유지됐다. [공개 README PR #5](https://github.com/bokjk/mongle-terminal-releases/pull/5)는 사용자 안내만 포함한다. 비공개 소스나 개발 기록을 공개 저장소로 복사하지 않았다.

공개 첨부 5개를 인증 없이 끝까지 다운로드해 태그 artifact의 크기·SHA-256과 대조했다. 격리된 실제 Electron에서 현재 제품 업데이트 코드·최종 패키지의 공개 설정·현재 버전 0.3.11 지정으로 0.3.12 설치본 전체 다운로드와 ready/100%/해시 일치를 확인했다. 0.3.12 지정은 idle·최신 버전 상태였다. 다운로드 검사는 설치를 실행하지 않았고 이 PC의 실사용 앱을 교체하지 않았다. 원시 결과는 커밋하지 않는 test-results/release-0312에 보존했다.
