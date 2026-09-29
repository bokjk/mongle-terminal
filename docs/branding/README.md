# 몽글터미널 캐릭터 아이콘

몽글 데스크톱 펫과 한 제품군임을 보여 주면서 작업표시줄에서 터미널을 구분하도록, 대표 캐릭터 보영(Boyo)의 얼굴과 `>_` 터미널 화면을 결합했다.

## 원본과 제작

- 원본 PNG: `apps/web/public/mongle-terminal-icon.png`.
- 제작: 2026-09-29, Codex 내장 `image_gen` 도구. CLI/API 키 경로는 사용하지 않았다.
- 정체성 참조: `E:/other_dev/on_desk/assets/sprites/soft/happy-done/frame-00.png`. `on_desk/tools/make-icon.js`가 기존 몽글 앱 아이콘으로 사용하는 대표 캐릭터다.
- 구도 참조: `E:/other_dev/on_desk/assets/sprites/soft/working/frame-02.png`.
- 캐릭터 원본은 읽기만 했으며 `on_desk` 파일은 변경하지 않았다.
- 원본 저작물 표기는 `on_desk/NOTICE.md`의 Mongle artwork에 따른다. 몽글터미널 자체와 이 파생 자산에 새로운 공개 라이선스를 부여하지 않는다.

최종 생성 프롬프트는 [icon-prompt.md](icon-prompt.md)에 보존한다. 투명 배경과 캐릭터·터미널 외곽을 유지하며, 기계적인 크기 변환으로 Windows ICO와 웹 아이콘을 만든다.

작은 아이콘에서도 얼굴과 터미널 기호가 읽히도록 큰 얼굴, 큰 귀, 대비가 높은 `>_`를 사용했다. 아이콘 적용·배포·실행 결과는 [검증 문서](../validation/branding.md)에 기록한다.
