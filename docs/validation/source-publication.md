# 소스 공개 전환

2026-10-07 사용자 승인으로 `bokjk/mongle-terminal`을 private에서 public으로 변경하고 API의 `private: false`, `visibility: public`을 확인했다. 설치 파일과 자동 업데이트 주소는 `bokjk/mongle-terminal-releases`를 유지한다. 프로젝트 라이선스와 결제 설정은 변경하지 않았다.

## 공개 전 확인

- 공식 체크섬을 대조한 Gitleaks 8.30.1로 로컬 전체 Git 참조의 이력을 검사했다. 전체 151커밋 중 도구가 스캔한 비병합 커밋은 105개, 텍스트 약 24.45MB이며 탐지는 0건이다.
- 기존 Actions 333회분 로그를 모두 읽기 전용으로 다운로드했다(HTTP 200). 압축 해제한 텍스트 약 15.51MB와 PR 본문·댓글 약 496.64KB도 같은 도구에서 탐지 0건이다.
- 독립 검토가 이력의 텍스트 blob 1,126개, UI 캡처 19개 및 현재 문서 이미지 6종을 확인했다. 실제 tailnet 기기 주소·개인 대화 출력을 발견하지 못했다. Git 작성자 이메일, 로컬 개발 경로와 과거 bootId는 이력에 남아 있으며 인증 비밀과 구분한다.
- 자동 탐지 0건은 모든 형태의 민감정보 부재를 보증하지 않는다. 비밀 원문이나 전체 점검 로그는 이 문서에 복사하지 않는다.

## GitHub 설정

- Private vulnerability reporting 활성화와 `enabled: true`를 확인했다. 접수 주소는 SECURITY.md에 안내했다.
- dev ruleset 24617240, main ruleset 24617242를 active로 생성했다. 정의된 필수 검사·최신 base·삭제/강제 push 방지와 관리자 우회 대상이 API에 반영됐다.
- 외부 기여 PR 실행 승인 설정은 `first_time_contributors`다. PR 코드는 읽기 권한 검사에서만 실행하고 쓰기 권한 정책 작업은 신뢰된 기본 브랜치의 스크립트만 실행한다.
- 공개 후 실제 CI 재개·병합·새 설치본 공개는 각 PR과 배포 기록에서 별도로 확인한다. 공개 전환 자체를 배포 완료로 표현하지 않는다.
- 인증 헤더나 토큰 없이 저장소 API와 dev README 원문이 HTTP 200으로 열리고, 기존 배포 저장소의 latest 다운로드 링크가 유지됨을 확인했다.
