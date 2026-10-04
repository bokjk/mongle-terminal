# 알약 탐지와 아이콘 빌드 교체

2026-10-05 · 소스 버전 0.3.8의 미배포 개발 변경. 지정 파일 검사와 빌드 검증이며 전체 PC 또는 공개 설치본의 악성코드 검사 결과가 아니다.

## 실제 확인

- 알약 이벤트: 2026-10-04 22:48:24에 `Gen:Variant.MSILHeracles.252490` 실시간 탐지, 22:52:25에 같은 탐지명 제외 추가. 과거 이벤트에는 파일 경로가 없었다.
- 사용자 승인 후 해당 탐지명 제외 항목 하나만 삭제·적용했다. 나머지 제외와 실시간 감시는 변경하지 않았다.
- 탐색기에서 `platform/windows`의 `HostLauncher.exe`, `IconBuilder.exe`, `OwnerPipe.exe`만 선택해 **알약으로 검사하기**를 실행했다. 검사 3개·탐지 1개·2초로 완료했다.
- 상세 트리의 전체 경로에서 탐지 파일이 `platform/windows/IconBuilder.exe`임을 확인했다. 나머지 두 파일은 이번 검사에서 탐지되지 않았다.
- 자동 치료 없이 결과를 확인하고 종료했다. 검사 직후 세 파일의 SHA-256은 검사 전과 동일했다. 샘플이나 소스를 외부 업체에 업로드하지 않았다.

| 검사 파일 | SHA-256 | 이번 검사 |
|---|---|---|
| HostLauncher.exe | `1d3d489176acf70028331e17b40128103c029a89e1f10e1e0928a342f38d2f2e` | 탐지 없음 |
| IconBuilder.exe | `0d856ee3532f9d19c71e15e53f597fc9f4bf43bda688a2fe41498ccaa94040bc` | 위 탐지명으로 탐지 |
| OwnerPipe.exe | `238fe9ea406c8408a8a79069f83166f2726897828870191a7e97428c0d39283c` | 탐지 없음 |

## 판단의 근거와 한계

기존 C# 소스는 PNG를 축소해 ICO와 웹 PNG를 저장하는 도구다. 정상 Microsoft 서명이 확인된 시스템 C# 컴파일러로 같은 소스를 다시 컴파일했다. 원본과 재컴파일 파일은 48바이트가 달랐으며, COFF 타임스탬프·모듈 GUID·컴파일러 생성 타입명에 포함된 동일 GUID 차이를 정규화하면 일치했다. 비교 과정에서 두 EXE를 실행하지 않았다. 원본 소스 해시는 `e608792061b68146bd2eec2017711abcd1840451fb25252aea9dffa818da8e0a`다.

이는 알려진 소스의 빌드 결과와 일치한다는 근거이며 백신 업체가 오탐으로 확정한 결과는 아니다. [알약 공식 오탐 안내](https://www.estsecurity.com/enterprise/support/faq/view/30)에 따른 업체 판정은 받지 않았다. 원본 파일과 비교용 EXE의 정리·격리는 별도 사용자 승인 범위로 다룬다. 원본을 보존하면 해당 파일의 탐지는 남을 수 있다.

로컬 상세 증거는 커밋하지 않는 `.test-data/antivirus-triage.json`, `.test-data/av-compare/result.json`에 있다. 문서에는 사용자 경로, 다른 탐지 제외 항목, 실제 터미널 출력이나 인증 정보를 기록하지 않는다.

## 수정

- `IconBuilder.cs`와 이를 컴파일·실행하던 빌드 경로를 제거했다. 기존 생성 EXE를 이름만 바꾸거나 탐지 제외로 통과시키지 않는다.
- `scripts/build-icons.ts`가 빌드 전용 `sharp` 0.35.5(Apache-2.0)를 이용해 같은 원본 PNG를 읽는다. [공식 resize API](https://sharp.pixelplumbing.com/api-resize/)의 Lanczos3 축소를 사용한다.
- Windows 16·24·32·48·64·128·256px PNG 프레임을 포함한 ICO, 웹 32·192·512px PNG를 만든다. RGBA 투명도를 유지한다. 축소 알고리즘 변경으로 생성 이미지의 바이트와 해시는 달라진다.
- 개발 의존성은 잠금 파일에 고정했다. 이미지 생성은 `scripts/build.ts`에만 연결하며 데스크톱 실행 코드에는 포함하지 않는다. 기존에도 `IconBuilder.exe`는 배포용 허용 목록에 없었다.
- `sharp`와 libvips, 이전 아이콘 생성 EXE는 새 패키지에 들어가지 않는다. production 고지 항목은 158개로 유지되며 라이선스 manifest의 lockfile 해시만 갱신한다.

## 검증

| 범위 | 결과 |
|---|---|
| TypeScript | `npm.cmd run typecheck` 통과 |
| 아이콘 생성·PE 리소스 검사 | `icon-build.test.ts`, `windows-icon.test.ts` 12/12 통과. 투명/불투명 픽셀, PNG 디코딩, ICO 크기·오프셋, 같은 시각의 원본 교체, 잘못된 원본 거부, 새 EXE 일치·이전 EXE 불일치 포함 |
| 호스트 수명주기 | `lifecycle.test.ts` 3/3 통과. 최초 샌드박스 실행의 Job 권한 오류를 샌드박스 밖의 격리 시험으로 재확인 |
| 전체 빌드·디렉터리 패키지 | 검사 제외 해제 상태에서 `runtime/node.exe --import tsx scripts/package.ts --dir --output release-icon-build-test` 통과 |
| 패키지 네이티브 모듈 | 번들 Node v24.11.1에서 node-pty/ConPTY 로드 통과 |
| 패키지 아이콘 | 실제 EXE의 7개 PNG 리소스와 생성 ICO 바이트 일치 |
| 이미지 표시 | 생성된 192px PNG를 열어 기존 캐릭터와 투명 배경 확인 |
| 배포 문서 | `node --import tsx scripts/release-check.ts` 통과 |

시스템 Node 옆에 LICENSE가 없어 첫 패키징의 고지 검사가 실패했다. 프로젝트의 LICENSE 동봉 Node로 재실행했고, 중간 manifest 쓰기 오류 후 고지 재생성 및 패키징을 완료했다. 고지 오류는 최종 결과에 남지 않는다.

새 ICO SHA-256: `91e9df0f806b305f87d047fe64fc26c5a25128b58e1bde1a15689cd3e9b78f20`.

새 테스트 EXE SHA-256: `8fb6e9775953fec212441e1b655626f6ad559a9318bb8075cf8baf987a7ece82`.

전체 CI·NSIS 설치·공개 배포·새 패키지 전체 백신 검사는 이번에 수행하지 않았다. 기존 설치본·사용자 호스트·셸·Tailscale·인증 데이터는 변경하지 않았다. 아이콘 생성 스크립트는 백신 설정을 변경하지 않으며, 다른 파일이나 다른 백신에서 탐지가 없다는 보장으로 해석하지 않는다.
