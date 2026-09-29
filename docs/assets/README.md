# README 이미지와 구성

README에는 몽글 캐릭터와 실제 앱의 데모 화면을 사용합니다. 타 제품의 스크린샷·로고·문구는 복사하지 않습니다.

| 자산 | 출처 |
|---|---|
| `apps/web/public/icon-512.png` | 기존 몽글터미널 아이콘. 원본과 캐릭터 권리는 [브랜딩 기록](../branding/README.md)에 보존 |
| `desktop.png` | 격리된 HostCore·Windows 셸·공통 웹 UI로 촬영한 데스크톱 크기 화면 |
| `mobile.png` | 같은 데모의 모바일 크기 브라우저 화면. 실물 휴대폰 캡처가 아님 |
| `status.svg` | 외부 이미지 서비스 없이 표시하는 플랫폼·미리보기·원격 연결 배지 |

화면의 프로젝트·출력은 README용 예시입니다. 사용자 호스트·프로필·Tailscale을 사용하지 않습니다. 이미지의 예시 테스트 결과를 프로젝트 전체의 테스트 결과로 해석하지 않습니다. 캡처 후 픽셀을 수정해 기능이나 검증 결과를 꾸미지 않습니다.

## 다시 촬영하기

Windows, Node.js 24, Chrome과 빌드한 웹 파일이 필요합니다.

```powershell
npm.cmd run build
node --import tsx scripts/capture-readme.ts
```

격리 경로, 임시 드라이브와 촬영 조건은 [캡처 스크립트](../../scripts/capture-readme.ts)와 [촬영 기록](screenshots.md)에 명시합니다. 촬영이 끝난 후 이미지에 개인 경로·인증 정보·연결 주소·예상하지 않은 오류가 없는지 직접 확인하세요.

## 구성 참고

2026-09-29에 [Ghostty README](https://github.com/ghostty-org/ghostty/blob/main/README.md)의 간결한 소개·빠른 문서 연결과 [WezTerm README](https://github.com/wezterm/wezterm)의 실제 화면 중심 소개 구성을 참고했습니다. 몽글터미널의 문장, 캐릭터, 기능 설명과 캡처는 이 프로젝트를 위해 구성했습니다.

플랫폼·미리보기·Tailscale 배지는 정적 표시이며 CI 통과나 공개 배포를 의미하지 않습니다. 프로젝트와 이미지에 새 공개 라이선스를 부여하지 않습니다.
