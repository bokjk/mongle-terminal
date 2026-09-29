# 제3자 소프트웨어 고지

이 문서는 `scripts/notices.ts`가 lockfile과 실제 설치된 production 의존성 메타데이터에서 생성합니다. 의존성 고지 원문은 연결된 파일에 수정 없이 보존합니다. 몽글터미널 자체의 공개 라이선스는 아직 결정하지 않았으며 `private`/`UNLICENSED`입니다. 아래 라이선스를 앱 자체의 라이선스로 해석하지 않습니다.

## 포함 구성요소

| 구성요소 | 버전 | 라이선스 메타데이터 | 고지 원문 |
|---|---|---|---|
| @xterm/addon-fit | 0.11.0 | MIT | [LICENSE](licenses/xterm__addon-fit0.11.0/LICENSE) |
| @xterm/addon-search | 0.16.0 | MIT | [LICENSE](licenses/xterm__addon-search0.16.0/LICENSE) |
| @xterm/addon-serialize | 0.14.0 | MIT | [LICENSE](licenses/xterm__addon-serialize0.14.0/LICENSE) |
| @xterm/headless | 6.0.0 | MIT | [LICENSE](licenses/xterm__headless6.0.0/LICENSE) |
| @xterm/xterm | 6.0.0 | MIT | [LICENSE](licenses/xterm__xterm6.0.0/LICENSE) |
| argparse | 2.0.1 | Python-2.0 | [LICENSE](licenses/argparse2.0.1/LICENSE) |
| builder-util-runtime | 9.7.0 | MIT | [LICENSE](licenses/builder-util-runtime9.7.0/LICENSE) |
| debug | 4.4.3 | MIT | [LICENSE](licenses/debug4.4.3/LICENSE) |
| electron-updater | 6.8.9 | MIT | [LICENSE](licenses/electron-updater6.8.9/LICENSE) |
| semver | 7.7.4 | ISC | [LICENSE](licenses/semver7.7.4/LICENSE) |
| fs-extra | 10.1.0 | MIT | [LICENSE](licenses/fs-extra10.1.0/LICENSE) |
| graceful-fs | 4.2.11 | ISC | [LICENSE](licenses/graceful-fs4.2.11/LICENSE) |
| js-yaml | 4.3.2 | MIT | [LICENSE](licenses/js-yaml4.3.2/LICENSE) |
| jsonfile | 6.2.1 | MIT | [LICENSE](licenses/jsonfile6.2.1/LICENSE) |
| lazy-val | 1.0.5 | MIT | [package.json](licenses/lazy-val1.0.5/package.json) · [NOTICE.txt](licenses/lazy-val1.0.5/NOTICE.txt) |
| lodash.escaperegexp | 4.1.2 | MIT | [LICENSE](licenses/lodash.escaperegexp4.1.2/LICENSE) |
| lodash.isequal | 4.5.0 | MIT | [LICENSE](licenses/lodash.isequal4.5.0/LICENSE) |
| lucide-react | 1.48.0 | ISC | [LICENSE](licenses/lucide-react1.48.0/LICENSE) |
| ms | 2.1.3 | MIT | [license.md](licenses/ms2.1.3/license.md) |
| node-addon-api | 7.1.1 | MIT | [LICENSE.md](licenses/node-addon-api7.1.1/LICENSE.md) |
| node-pty | 1.1.0 | MIT | [LICENSE](licenses/node-pty1.1.0/LICENSE) · [LICENSE](licenses/node-pty1.1.0/deps/winpty/LICENSE) |
| qrcode.react | 4.2.0 | ISC AND MIT (bundled qrcodegen) | [LICENSE](licenses/qrcode.react4.2.0/LICENSE) · [qrcodegen-LICENSE](licenses/qrcode.react4.2.0/qrcodegen-LICENSE) |
| react | 19.3.0 | MIT | [LICENSE](licenses/react19.3.0/LICENSE) |
| react-dom | 19.3.0 | MIT | [LICENSE](licenses/react-dom19.3.0/LICENSE) |
| sax | 1.6.1 | BlueOak-1.0.0 | [LICENSE.md](licenses/sax1.6.1/LICENSE.md) |
| scheduler | 0.28.0 | MIT | [LICENSE](licenses/scheduler0.28.0/LICENSE) |
| tiny-typed-emitter | 2.1.0 | MIT | [LICENSE](licenses/tiny-typed-emitter2.1.0/LICENSE) |
| universalify | 2.0.1 | MIT | [LICENSE](licenses/universalify2.0.1/LICENSE) |
| ws | 8.22.0 | MIT | [LICENSE](licenses/ws8.22.0/LICENSE) |
| zod | 3.25.76 | MIT | [LICENSE](licenses/zod3.25.76/LICENSE) |
| Electron / Chromium runtime | 44.4.5 | MIT and bundled third-party licenses | [LICENSE](licenses/electron-44.4.5/LICENSE) · [LICENSES.chromium.html](licenses/electron-44.4.5/LICENSES.chromium.html) |
| Node.js independent host runtime | v24.18.0 | Node.js MIT and bundled third-party licenses | [LICENSE](licenses/node-v24.18.0/LICENSE) |
| Microsoft.Windows.Console.ConPTY / OpenConsole | 1.23.251008001 | MIT plus upstream notices (conservative superset) | [LICENSE](licenses/conpty-1.23.251008001/LICENSE) · [NOTICE.md](licenses/conpty-1.23.251008001/NOTICE.md) · [Microsoft.Windows.Console.ConPTY.nuspec](licenses/conpty-1.23.251008001/Microsoft.Windows.Console.ConPTY.nuspec) |

Production 직접·전이 의존성 30개와 별도 런타임 고지를 수집했습니다. 번들링 과정에서 제거된 코드에 대한 고지가 포함될 수 있습니다. 빌드 도구 자체는 배포하지 않는 범위에서 제외하며, Electron/Chromium은 개발 의존성에 선언되어도 실제 앱에 들어가므로 별도로 포함합니다. `node-addon-api`와 node-pty의 winpty 고지 역시 실제 설치 패키지에서 보존합니다.

## 바이너리와 출처

Electron의 `LICENSES.chromium.html`과 Node 설치본의 `LICENSE`는 각각 런타임에 포함된 여러 구성요소의 고지를 담고 있습니다. 런타임 버전이나 빌드 원본이 바뀌면 해당 배포물의 원문으로 다시 생성해야 합니다.

ConPTY와 OpenConsole은 [Microsoft 공식 릴리스 v1.23.12811.0](https://github.com/microsoft/terminal/releases/tag/v1.23.12811.0)의 `1.23.251008001` 패키지를 사용합니다. npm node-pty x64 바이너리와 원본 nupkg 파일의 SHA-256을 대조했습니다. nupkg는 MIT 메타데이터만 포함하므로 [고정 소스 커밋](https://github.com/microsoft/terminal/tree/96f13a15deed0f2a0e4fc5e8a66847b51c0e78db)의 LICENSE와 NOTICE를 보존합니다. NOTICE는 상위 Windows Terminal 프로젝트의 넓은 고지 목록입니다. 목록의 모든 구성요소가 이 ConPTY 바이너리에 포함되었다고 단정하지 않습니다.

xterm 어댑터는 xterm.js 6.0.0 내부 구조에 의존하는 몽글 코드입니다. xterm 원본 고지를 유지하며 업스트림 패키지 버전 변경 시 관련 검증이 필요합니다.

[생성 명세와 무결성 값](licenses/manifest.json)에 각 패키지 출처, npm 무결성 값, 고정된 ConPTY 출처와 누락 사항을 기록합니다. 전체 `docs/licenses`와 이 문서를 배포물에 함께 포함해야 합니다.

## 생성 검증

고정한 수집 기준에서 누락·버전·바이너리 불일치를 발견하지 않았습니다. 이는 자동 수집 검사 결과이며 별도 법률 검토를 뜻하지 않습니다.

## 별도 원문 파일이 없는 의존성

lazy-val 1.0.5는 npm 원본과 고정 소스 커밋에 별도 LICENSE 파일이 없습니다. 원래 package.json의 MIT·저자 선언을 그대로 보존하고, 해당 선언이 가리키는 표준 MIT 조건을 별도로 표시해 동봉했습니다. 이를 업스트림 LICENSE 원문을 확보한 것으로 표현하지 않습니다. 원문 메타데이터와 안내의 해시를 고정해 버전·내용 변경 시 재검토하도록 검사합니다.
