# 모바일 키보드 닫힘 수정

2026-09-29, 사용자가 실제 휴대폰에서 연결에 성공한 뒤 키보드가 열렸다 닫히는 현상을 보고했다. 사용 환경은 **Android의 삼성 인터넷**으로 확인했다. 브라우저 버전과 키보드 앱은 아직 확인하지 않았으며, 삼성 인터넷을 쓴다는 사실만으로 삼성 키보드를 사용한다고 가정하지 않는다. 수정 웹 자산은 08:57 KST에 실행 중인 호스트에 적용했다. 이후 사용자가 **“잘되는데”**라고 정상 동작을 확인하고 모바일 화면에 더 많은 텍스트가 보이도록 개선을 요청했다. 실물 키보드 수정은 사용자 확인을 받았으며, 모든 언어·키보드 앱 조합의 호환성 검증을 뜻하지 않는다.

## 원인과 수정

xterm 6의 `disableStdin`은 숨겨진 입력 textarea의 `readOnly`를 변경한다. 기존 코드는 모바일 키보드로 화면 높이가 변할 때 터미널 크기와 화면 ACK를 동기화하며 `disableStdin`을 설정했다. 입력란의 편집 상태 변경이 소프트 키보드를 닫고 다시 화면 높이를 바꾸는 경로를 만들었다.

- `BrowserPresentationAdapter.setInputEnabled(false, {preserveKeyboard:true})`는 임시 동기화 중 실제 전송만 차단하고 입력란과 포커스를 유지한다. 제어권 상실·연결 종료·입력 결과 불확실 시에는 기존 강한 차단을 유지한다.
- 차단 중 입력은 저장하거나 나중에 재전송하지 않는다. 차단을 걸친 지연 IME 커밋과 keyCode 229 입력도 폐기한다.
- 명시적 제어 버튼의 클릭 안에서 즉시 포커스한다. 이미 제어 중이면 제어권을 다시 발급하지 않는다. 화면 크기 변경 요청을 직렬화하며 해당 화면 ACK가 성공한 후 입력을 재개한다.
- 모바일 레이아웃은 측정한 visualViewport 높이를 사용한다. 키보드 버튼과 보조 키를 누를 때 입력 포커스를 빼앗지 않는다.

## 확인한 범위

- 터미널 테스트 **18/18 통과**: Chrome 모바일 에뮬레이션에서 화면 크기 변경·12회 스냅샷 중 textarea 교체·blur·readOnly 변경 없음, 재개 후 입력, 지연 IME 입력 미재전송과 새 한글 조합 확인.
- 실제 Chrome의 모바일 UI 회귀 검사 통과: 신뢰된 클릭 내 포커스, 제어권·화면 ACK 전 입력 차단, 크기 변경 중 포커스 유지, ACK 후 정상 입력, 보조 키, 불확실 입력 잠금 및 명시적 복구, 늦은 resize 응답 이후 제어권 우회 없음. 이 검사는 응답 시점을 제어하는 모의 호스트를 사용한다.
- 기존 실제 HostCore + Chrome UI 검사 통과: 입력, 불확실 입력 잠금, 제어권 재획득, 분할·크기 변경, 같은 셸 PID로 새로고침, 모바일 패널 전환.
- TypeScript 검사와 Vite 웹 빌드 통과. 두 독립 코드 검토에서 수정이 필요한 결함을 찾지 못했다.
- 수정 웹 자산을 적용한 최종 E 드라이브의 실제 Electron 배포본 E2E **30.72초 통과**. 별도 시험 호스트에서 셸 입력·분할·제어권 이전·앱 종료 후 같은 PID와 변수 복원·모바일 Chrome 입력과 새로고침을 확인했다. 시험 호스트만 종료했으며 사용자 기본 세션은 유지했다. [E2E 기록](e2e.md)

브라우저 에뮬레이션은 휴대폰 OS 소프트 키보드 표시 자체를 재현하지 않는다. 위 자동 검사와 별도로, 실제 Android 삼성 인터넷에서의 수정 후 동작은 사용자 응답으로 확인했다.

## 실행 중 배포 검증

웹 파일만 교체하고 이전 해시 이름의 자산을 남겨 기존 페이지의 로딩을 방해하지 않았다. 실제 Tailscale HTTPS 주소에서 새 HTML과 JS/CSS 바이트가 개발 빌드와 일치함을 확인했다. 호스트 PID **6400**, bootId와 PowerShell PID **14060**은 유지되었다. 다시 페어링하거나 호스트를 재시작하지 않았다.

증거: `test-results/mobile-keyboard-hot-update.json`, `test-results/mobile-keyboard-live-check.json`.

재검사:

```powershell
node --import tsx --test tests/terminal/browser.test.ts tests/terminal/engine.test.ts
node --import tsx --test tests/ui/mobile-keyboard.test.ts tests/ui/workspace.test.ts
npm run typecheck
```
