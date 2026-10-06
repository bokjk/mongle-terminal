# 0.3.12 공개 배포 검증

## 배포 준비

2026-10-06. PDF 보기와 출력 갱신 중 드래그 자동 스크롤 수정의 배포 후보다. 현재 공개 버전은 0.3.11이며 PR·태그 검사와 게시 결과는 수행 후 아래에 기록한다.

PDF는 오른쪽 파일 탭의 읽기 전용 보기, 페이지 이동·배율·너비 맞춤·텍스트 선택·암호 입력을 제공한다. 파일당 8 MiB, PDF 탭 4개, 기존 인증·경로 제한과 64 KiB 분할 전송을 적용한다. 드래그 선택은 화면 갱신 사이에도 자동 스크롤 예정 시각을 유지한다.

## 로컬 검증

- [PDF 검증](pdf-preview.md): 관련 기존 회귀 31개와 추가 실제 WebSocket 8 MiB 전송/취소/승인 취소 및 Electron HTTPS 전송 2개 통과. Electron file URL의 한글·암호·CID/CMap·기본 글꼴·6 MiB 이미지 문서를 확인했다. 패키지 실행부의 OwnerPipe 원문 일치·정상 종료, NSIS 내부 payload·ZIP·압축 해제본의 웹 자산 197개 일치를 확인했다.
- [드래그 선택 검증](terminal-drag-scroll.md): 관련 회귀 55개, Aside 실제 TerminalPane과 시험용 전송·클립보드 경계의 한글·영문 120줄 선택/복사 요청 일치와 마우스 해제 통과.
- 위 로컬 패키지는 0.3.11 버전명을 사용한 격리 시험 후보이며 기존 공개 0.3.11 산출물을 변경하지 않았다. 게시에는 새 0.3.12 태그 작업의 검증된 artifact만 사용한다.
- 실사용 프로필·호스트·셸·인증 정보·Tailscale Serve를 변경하지 않았다.

## 남은 범위

물리 휴대폰/터치 키보드, 실제 외부 Tailscale 네트워크, 모든 PDF 글꼴·압축 형식과 Claude/Codex 화면 재그리기 유형은 전수 검증하지 않았다. 실제 설치 교체는 GitHub 호스팅 Windows에서 수행할 예정이며 이 PC의 사용자 설치본을 교체하지 않는다. 코드 서명과 저장소 공개 범위·라이선스는 변경하지 않는다.

## 첫 CI와 시험 경로 수정

[기능 PR #41](https://github.com/bokjk/mongle-terminal/pull/41)의 첫 [Windows 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37422464358)는 432개 중 416 통과·1 실패·15 선택 생략이었다. 새 PDF WebSocket 시험이 셸 생성에는 TEMP의 원래 표기를 쓰고 RPC에는 realpath 표기를 보내 GitHub Windows의 짧은 경로 별칭에서 FILES_ROOT_CHANGED로 거부됐다. 두 입력에 같은 정규 경로를 사용하도록 시험 준비를 수정했다. 제품의 인증·현재 폴더 검사는 완화하지 않았으며 수정 후 전체 CI를 다시 실행한다.

같은 후보의 [실제 NSIS 검사](https://github.com/bokjk/mongle-terminal/actions/runs/37422464361)는 0.3.8 → 0.3.12 설치 교체·작업 복원·정상 정리까지 통과했다. app.asar와 hostbundle 전체 694개가 원본과 일치했고 누락·추가·변경은 모두 0개였다. 최종 게시 파일은 별도 태그 검사 산출물을 사용한다.
