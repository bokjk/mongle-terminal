# 터미널 탭과 상단 공간 검증

검증일: 2026-10-01 · 소스 버전: 0.3.3 · 작업 브랜치: `codex/terminal-tabs` · **미배포 소스 변경**

## 변경 범위

PC의 그룹 내 터미널을 상단 탭으로 표시한다. 탭 보기는 선택한 터미널을 전체 영역에 표시하고, 분할 보기는 기존 배치를 유지한다. 처음에는 기존 분할 보기를 사용하며, 선택한 방식은 `mongle.view.<hostId>.<groupId>` 로컬 설정에 저장한다. 보기 전환은 호스트의 배치를 변경하지 않는다.

상단은 78px에서 44px로 줄였다. 터미널 추가는 + 아이콘이며 파일 탐색기·설정·보기 전환을 같은 줄에 배치했다. 패널 제목줄은 38px에서 32px로, PC 좌우 바깥 여백은 18px에서 6px로 줄였다. 모바일의 60px 상단과 기존 패널 전환·화면 넓게·44px 터치 대상은 유지한다.

PC에서 탭·분할·최대화 전환은 같은 `SplitTree`의 터미널 인스턴스를 유지한다. 숨긴 패널은 표시 크기를 호스트에 전송하지 않으며, 처음부터 숨겨진 패널은 자동으로 제어권을 얻지 않는다. 탭 전환은 선택만 바꾸고 다른 기기의 제어권을 가져오지 않는다. 탭 X·탭에서 Delete는 기존 종료 확인 절차를 사용한다.

## 직접 수행한 검사

| 검사 | 결과와 범위 |
|---|---|
| `npm.cmd run typecheck` | 통과 |
| `npm.cmd run build` | 웹·호스트·Electron 번들 빌드 통과. 기존 500KB 이상 웹 번들 경고는 남아 있음 |
| `tests/ui/terminal-tabs.test.ts` | Chrome + 실제 HostCore + 명령 프롬프트 통과. 시험 셸이 개인 PowerShell 기록을 읽거나 쓰지 않도록 cmd.exe 사용 |
| 기존 관련 회귀 5개 파일 | 파일 탐색기·컴퓨터 선택·모바일 표시·드래그·실제 PowerShell 작업 공간 총 8개 검사 통과 |
| `node --import tsx --test --test-concurrency=1 tests/**/*.test.ts` | 전체 293개 중 281 통과·Windows Job 샌드박스 제한 1 실패·선택 실행 11 생략. 약 241초. 새 탭 회귀도 포함해 통과 |
| 실패 항목 별도 재검증 | `--test-name-pattern 'independent bundled Node survives parent kill-on-close Job' tests/platform/lifecycle.test.ts`를 제한 밖에서 실행해 1/1 통과. 전체 검사를 제한 밖에서 다시 실행한 결과로 표현하지 않음 |
| `node --import tsx scripts/release-check.ts` | 0.3.3 버전·배포 문서 검사 통과 |
| `git diff --check` | 통과 |

새 탭 회귀에서 직접 확인한 동작:

1. 상단 실제 높이 44px, 1380px 화면에서 단일 터미널 너비 1100px 이상. 탭 클릭·방향키·Home·End·Ctrl+Tab·Ctrl+Shift+Tab, 단축키의 셸 입력 누출 없음.
2. 전환 전후 같은 xterm DOM 인스턴스·셸 PID·generation·상태·분할 배치. 시험 셸 변수 `TAB_PROOF` 유지와 명령 입력의 단일 전달. 보기 전환 중 attach·detach·제어권 재획득 없음.
3. 그룹·호스트 전환과 새로고침 후 컴퓨터·그룹별 보기 기억. 다른 기기가 제어하는 터미널의 탭을 선택해도 그 기기의 제어권 유지.
4. + 클릭으로 새 셸 하나만 생성, 닫기 취소 시 유지·확인 시 종료. 탭 보기에서 분할 선택 취소 시 보기 유지, 생성 완료 시 분할 보기로 전환.
5. 701px PC의 긴 이름·탭 가로 스크롤·문서 가로 넘침 없음, 파일 탐색기 접근, 밝은/어두운 테마, 390px 모바일 단일 패널·전환 메뉴와 + 버튼 44px 이상.

로컬 증거는 `test-results/ui/terminal-tabs/`에 생성한다: `result.json`, `compact-header.png`, `desktop-tabs-dark.png`, `desktop-tabs-light.png`, `desktop-split-dark.png`, `full-regression.log`, `lifecycle-retest.log`. 캡처는 시험용 그룹·셸과 `C:\Windows` 경로만 사용한다. 시험 호스트는 `%TEMP%\mongle-tabs-*`에 격리하고 검사 종료 시 닫고 삭제한다. 전체 회귀 실행의 앱 데이터 경로도 `.test-data/terminal-tabs-full`로 명시한다. 기존 검사가 자동 갱신한 추적 중인 `artifacts/ui` 이미지 4개는 이 작업에 포함하지 않고 원래 버전으로 복구한다.

최초 새 회귀 실패는 시험 연결을 등록하기 전에 호스트 요청을 보낸 `NOT_CONNECTED`였으며 연결 순서를 수정했다. cmd.exe로 시험 셸을 분리한 뒤에는 호스트 재연결의 화면 동기화가 끝나기 전에 원격 제어권을 가져와 검사가 경합했으며, 현재 창의 제어 준비를 확인한 뒤 원격 기기의 제어권을 얻도록 순서를 수정했다. 모두 시험 코드의 준비 순서 수정이고 인증 검사나 제품의 제어권 정책은 완화하지 않았다.

## 적용·미검증 범위

이 기록은 빌드한 공통 웹 UI를 Chrome에서 실제 셸과 연결한 결과다. 기존 PowerShell/ConPTY 입력·드래그·불확실 입력 검사도 함께 통과했으며 실제 사용자의 호스트·세션·인증 데이터와 Tailscale Serve는 변경하지 않았다.

기존 설치 앱에 파일을 적용하지 않았고 버전·설치본·공개 Release를 변경하지 않았다. 이 변경의 패키지 Electron E2E, NSIS 설치·제거, 사용자 화면 확인, 실물 휴대폰과 실제 Tailscale 연결은 아직 검증하지 않았다. 기본 회귀의 선택 실행 E2E 생략을 해당 영역의 통과로 표현하지 않는다.
