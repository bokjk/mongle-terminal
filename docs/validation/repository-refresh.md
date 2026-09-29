# README·기여 준비·작업 폴더 정리

2026-09-29, Windows x64. 사용자 요청에 따라 불필요한 생성 폴더를 정리하고 README와 향후 공개 기여 절차를 준비했다. 앱 기능, 사용자 인증·프로필·세션, 저장소 공개 범위와 라이선스는 변경하지 않았다.

## 완료한 변경

- README를 기존 몽글 아이콘, 로컬 배지, 실제 격리 데모의 데스크톱·모바일 화면과 기능·사용·개발 흐름으로 재구성했다. 상세 업데이트·개발 설명은 접을 수 있게 구성했다.
- `CONTRIBUTING.md`, `SECURITY.md`, PR·이슈 양식, CODEOWNERS, 일반 PR·main push용 Windows CI와 PR 본문·문서 영향 검사를 추가했다. `AGENTS.md`도 같은 기여 기준을 가리킨다.
- 오래된 생성 폴더 13개에서 11,518,062,819바이트(약 11.52 GB / 10.73 GiB)를 정리했다. 실제 절대 경로·Git 추적 여부·reparse point·실행 프로세스 참조를 확인한 뒤 PowerShell `-LiteralPath`로 삭제했다.
- 최신 웹 복구 파일은 누락된 참조 자산을 현재 실행본에서 보완하고 `.backups/web-before-input-handoff`에 보관했다. 앱·호스트·PowerShell이 같은 프로세스로 유지됨을 확인했다. `.test-data`·`test-results`의 기존 증거와 `release`·`runtime`·`dist`·`node_modules`는 보존했다.

## 실제 검증 결과

| 검사 | 결과와 범위 |
|---|---|
| 기여 검사 회귀 | **9/9 통과**. 빈 양식·확인 누락·변경 분류·필요 문서, 셸 비실행 입력 검증, 실제 격리 Git 저장소의 필수 문서 삭제 거부 |
| 타입·배포 문서 | **통과**. `npm run typecheck`, `node --import tsx scripts/release-check.ts`, `git diff --check` |
| Workflow·양식 | YAML 4개 파싱, PR 본문 수정 이벤트, 읽기 권한·체크아웃 자격 증명 비보존, `pull_request_target` 부재 확인. 독립 읽기 전용 검토에서 필수 수정 없음 |
| 이미지 재생성 | 실제 격리 HostCore·PowerShell·공통 UI 캡처 성공. 예시 Node 테스트 2개는 데모 출력이며 제품 회귀 검사 수에 포함하지 않음. 이미지 직접 검수, 개인 경로·주소·인증 정보 노출 없음. 임시 셸·매핑 정리 확인 |
| README 표시 | 로컬 Markdown 렌더러와 Chrome으로 1280px·390px 화면 확인. 로컬 이미지 4개 로드, 문서 전체 가로 넘침 없음. 문서 링크·이미지 파일 존재 검사 통과. GitHub 실제 렌더링과는 구분 |
| 실사용 작업 보존 | 정리 전후 현재 GUI·호스트·PowerShell PID와 시작 시각 일치. 실행 폴더와 사용자 데이터 미변경 |

앱 코드는 바꾸지 않았으므로 기존 전체 제품 회귀·패키징을 반복하지 않았다. 현재 빌드된 UI로 촬영한 캡처와 새 기여 검사·타입 검사를 구분한다. 자세한 이미지 조건은 [촬영 기록](../assets/screenshots.md), 폴더별 삭제·보존 기준은 [정리 기록](../WORKSPACE-HYGIENE.md)에 있다.

로컬 증거는 Git에서 제외한 `test-results/repository-refresh/cleanup.json`, `preview.json`, `readme-desktop.png`, `readme-mobile.png`에 있다. README 미리보기는 GitHub 스타일을 참고한 로컬 확인 화면이다.

## 아직 적용되지 않은 부분

새 CI 파일의 GitHub Actions 실행은 아직 수행하지 않았다. PR 양식·기여 검사는 저장소에 반영되어야 새 PR에서 사용된다. 현재 비공개 저장소의 브랜치 보호 조회는 GitHub에서 **403: 요금제 업그레이드 또는 공개 저장소 필요**를 반환했다. 따라서 필수 검사·소유자 승인으로 병합을 막는 서버 설정은 적용하지 않았다. 공개 전환 또는 지원 요금제에서 [기여 안내](../../CONTRIBUTING.md)의 설정을 적용하고 실제 차단을 확인해야 한다.

저장소를 공개하거나 프로젝트 라이선스를 추가하지 않았고, 배포 태그·Release도 생성하지 않았다. 이전 패키징 폴더는 검사 당시 이력으로 남으며 공개 배포 전 현재 소스에서 다시 만들어야 한다.
