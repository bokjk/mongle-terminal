# 기여 PR 대상 브랜치 정책

2026-09-29. 기여 PR을 `dev`로만 받고 `main`은 이 저장소의 `dev` → `main` 배포 PR만 받도록 한 설정과 검증 기록이다. 저장소 공개 범위와 라이선스는 바꾸지 않았다.

## 적용한 설정

- GitHub 기본 브랜치를 `main`에서 `dev`로 바꿨다. 새 PR과 clone의 기본 대상이 `dev`가 된다.
- [PR target policy](../../.github/workflows/pr-target.yml)는 `pull_request_target`으로 실행한다. PR의 코드를 받거나 실행하지 않고, 기본 브랜치의 [정책 스크립트](../../scripts/pr-target.ts) 하나만 체크아웃해 실행한다. `main` 등 다른 대상으로 연 PR은 `dev`로 옮기고 같은 실행에서 `dev` 규칙으로 판정한다. 결과는 PR 최신 커밋의 **PR target branch** 상태와 PR당 하나의 안내 코멘트로 남긴다.
- 브랜치 이름은 `<종류>/<설명>` 규칙을 따른다. 규칙과 예외(이 저장소의 `main` → `dev` 역병합, `dev` → `main` 배포 PR)는 [기여 안내](../../CONTRIBUTING.md#브랜치와-pr-대상)에 있다.
- [Contribution checks](../../.github/workflows/ci.yml)의 push 대상에 `dev`를 추가했다. 문서만 바뀐 push는 건너뛰고 PR은 항상 검사한다.
- 서버 측 병합 차단 규칙은 [.github/rulesets](../../.github/rulesets/)와 [적용 스크립트](../../scripts/apply-branch-rules.ts)로 정의만 했다. 비공개 무료 요금제에서 ruleset API가 `403: Upgrade to GitHub Pro or make this repository public`을 반환해 적용하지 않았다.

## 검증

| 검사 | 결과 |
|---|---|
| 로컬 회귀 | 정책 18 + 기여 검사 9 + 배포 문서 3 = **30/30 통과**, 타입 검사, 워크플로 YAML 파싱. 스텁 HTTP 서버로 대상 이동 → `dev` 판정 → 코멘트 갱신 → 상태 기록 요청 순서 확인 |
| GitHub 배포 PR #1 (`dev` → `main`) | PR target policy 통과(7초). PR 최신 커밋에 **PR target branch** = success, “유지보수자의 dev → main 배포 PR입니다.” 허용된 PR이라 안내 코멘트 없음. **Windows checks** 통과(6분 2초) 후 병합(49f361e) |
| GitHub 시험 PR #2 (`test/pr-target-smoke` → `main`) | 대상이 **`dev`로 자동 이동**. github-actions 안내 코멘트 1개, **PR target branch** = success. Windows checks는 시험 본문이 PR 양식을 따르지 않아 기여 검사 단계에서 41초 만에 실패(의도한 거절). 확인 후 PR을 닫고 원격·로컬 임시 브랜치를 삭제 |

GitHub 기본 토큰으로 PR 대상 변경·코멘트 작성·커밋 상태 기록이 모두 동작함을 실제 실행으로 확인했다.

## 확인하지 않은 범위

- ruleset 적용과 필수 검사에 의한 병합 차단. `integration_id`(15368), 저장소 관리자 역할 `actor_id`(5), `pull_request` 규칙 값은 공개 전환 후 `--dry-run`과 실제 적용 응답으로 확인한다.
- `main`·`dev` 브랜치나 이름 규칙 위반 브랜치에서 연 PR의 실제 GitHub 실패 표시. 로컬 스텁 검사로만 확인했다.
- 외부 fork에서 연 PR. 비공개 저장소라 fork 기여가 없다.
