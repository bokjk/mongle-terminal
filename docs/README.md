# 몽글터미널 문서

사용자는 [사용자 안내](USER-GUIDE.md), 기여자는 [기여 절차](../CONTRIBUTING.md)에서 시작하세요. [보안 제보](../SECURITY.md), [생성 폴더 정리 기준](WORKSPACE-HYGIENE.md), [README 이미지 출처](assets/README.md)도 함께 관리합니다.

## 초기 설계와 조사

**Windows에서 그룹별 분할 터미널을 사용하고, 앱 창을 닫아도 작업을 유지하며, 다른 PC·휴대폰에서 Tailscale로 같은 세션에 접속하는 앱을 설계했다.**

작성일: **2026-09-29** · 문서 버전: **v0.1** · 초기 설계·조사 기록

현재 앱의 실행 방법은 [사용자 안내](USER-GUIDE.md), 구현과 실제 검증 결과는 [구현·검증 상태](IMPLEMENTATION-STATUS.md)를 기준으로 확인한다. 아래 01–06 문서는 구현 전에 작성한 설계 기준이며 미실행 표시를 최종 검증 결과로 해석하지 않는다.

버전별 변경은 [변경 이력](../CHANGELOG.md), 설치본·자동 업데이트와 Release 절차는 [배포 안내](RELEASING.md), 0.3.7 워크트리·입력·탭 개선의 준비 및 배포 결과는 [0.3.7 배포 검증](validation/public-release-0.3.7.md), 이전 파일/Git 보기 배포는 [0.3.6 배포 검증](validation/public-release-0.3.6.md)에 기록한다. 초기 업데이트 구현 검증은 [자동 업데이트 검증](validation/auto-update.md)을 확인한다.

## 문서 읽는 순서

| 문서 | 확인할 내용 |
|---|---|
| [01. 요구사항과 사용 흐름](01-requirements-and-ux.md) | 확정 범위, 그룹·분할 동작, 모바일, 창 닫기/재부팅의 차이 |
| [02. 시스템 설계](02-architecture.md) | 실행 구조, 기술 선택, 데이터·프로토콜, 재접속·입력·업데이트 |
| [03. 원격과 보안](03-security-and-remote.md) | Tailscale 연결, 기기 승인, 인증, PWA, 데이터 저장 |
| [04. 구현 순서와 검증](04-implementation-and-validation.md) | P0 실험 4개, 작업 의존성, 기능 24개·보안/복구 12개 시나리오 |
| [05. 오픈소스 비교](05-open-source-comparison.md) | Herdr·Paseo·Orca·Wave·Tabby·WezTerm 비교와 적용 결정 |
| [06. 검토 및 현재 검증 상태](06-review-and-status.md) | 설계 검토에서 발견한 사항, 수정 결과, 미검증 범위 |
| [07. 워크트리 기능 설계안](07-worktrees-design.md) | 워크트리 기능의 설계 기준: 프로젝트 등록, 선택적 터미널 생성, 클릭 시 포커스, 저장·복구·삭제 |

## 정한 방향

- **기본은 터미널:** PowerShell·CMD, 설치된 WSL/Git Bash. CLI는 사용자가 직접 실행하며 별도 AI 채팅/agent 연동은 만들지 않는다.
- **그룹과 분할:** 호스트를 선택하고 왼쪽 그룹, 오른쪽 가변 분할 패널을 사용한다. 그룹별 배치는 자동 저장한다.
- **작업 유지:** GUI와 별도로 PTY 및 원격 endpoint를 소유하는 host를 실행한다. GUI 종료와 터미널 종료를 구분한다.
- **모바일 포함:** 첫 버전에 Android/iOS 모바일 웹/PWA를 포함한다. 휴대폰에도 Tailscale이 필요하다.
- **원격:** 자체 중계 서버를 운영하지 않고 private Tailscale Serve와 앱 기기 승인을 사용한다.

## 가장 중요한 기술 결정

우선 검증할 조합은 **Electron + React/TypeScript + 별도 Node 호스트 + node-pty/ConPTY + xterm.js**다. 데스크톱과 모바일은 UI/프로토콜을 공유한다. 다만 xterm 화면 직렬화만으로 모든 parser/mode 상태가 복원되는 것은 아니므로, 재접속 정확성과 자동 terminal response 중복을 초기 실험에서 해결한 뒤 확정한다.

컴퓨터 재부팅·사용자 로그아웃·host 자체 장애를 넘어서 기존 프로세스가 유지된다고 약속하지 않는다. 그 경우에는 저장된 배치·폴더·출력을 보여주고 새 셸임을 구분한다. 임의 명령을 자동 재실행하지 않는다.

## 구현을 시작할 때

[P0 실험](04-implementation-and-validation.md#3-p0--가장-먼저-할-네-가지-실험)부터 진행한다: Windows 프로세스 독립성, terminal snapshot/입력 정확성, 실제 모바일 Tailscale WebSocket, 한글 입력/패키징. 필수 실험 실패 시 해당 기술 결정을 다시 검토한다. 전체 UI를 먼저 완성한 뒤 핵심 연결 문제를 발견하는 순서를 피한다.

사용자가 결정한 범위와 설계자가 제안한 기본값은 [요구 표](01-requirements-and-ux.md#2-확정한-요구와-제안-기본값)에 구분했다. 지원 OS 확대나 협업 등 추가 기능은 현재 요구가 아니며 별도 변경으로 취급한다.

## 근거 원문

[앱 연구 메모](research/research-reference-apps.md) · [터미널 엔진 연구 메모](research/research-engines.md) · [원격/PWA 연구 메모](research/research-remote.md)

연구 메모에는 고정 commit 링크와 공식 문서를 남겼다. 소스 확인은 기능 안정성 실기 검증과 다르다. 나중에 문서가 바뀌어도 어떤 근거로 결정했는지 추적할 수 있도록 조사일과 commit을 유지한다.
