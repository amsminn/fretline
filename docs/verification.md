# 도움말·호환성 설명의 검증

이 문서는 [user-guide.md](user-guide.md), [compatibility.md](compatibility.md), [shortcuts.md](shortcuts.md)와
앱 내 도움말(`src/renderer/help/`)이 실제 제품과 어긋나지 않도록 무엇이 자동으로 검사되는지 적는다.
QA 실행 방법 전반은 [qa.md](qa.md)에 있다.

## 단일 출처

| 내용 | 출처 | 소비자 |
| --- | --- | --- |
| 명령 이름·메뉴·키 | `src/renderer/commands/catalog.ts`, `keymap.ts` | 네이티브 메뉴, 명령 팔레트, 툴바, 도움말 단축키 탭, `docs/shortcuts.md` |
| 도움말 본문·호환성 표 | `src/renderer/help/content.ts` | 도움말 대화상자. 이 문서들의 프로즈는 같은 사실을 설명한다 |
| 열린 파일의 실제 상태 | `src/adapters/alphatab/compatibility.ts` (지원 / 미지원 / 검증 안 됨) | 호환성 배지·보고서 |

`docs/shortcuts.md`는 손으로 쓰지 않는다. `shortcutsMarkdown()` 출력이며 테스트가 파일과 생성 결과의 일치를 검사한다.

## 자동 검사

`bun run test -- tests/ui/help.test.tsx`:

- 도움말 본문이 참조하는 모든 명령 ID가 카탈로그에 존재한다.
- 도움말의 명령 링크를 누르면 등록된 핸들러가 실제로 실행되고 대화상자가 닫힌다. 핸들러가 없는 명령 링크는 비활성이다.
- 단축키 탭의 행 수와 키는 카탈로그·키맵에서 생성한 값과 같다(손으로 복사한 표 없음).
- `docs/shortcuts.md`가 생성기 출력과 바이트 단위로 같다.
- 도움말 본문과 네 문서에 호환·지원 정도를 비율이나 전체 보장으로 적은 문구가 없다(정규식 검사).
- 도움말 메뉴 명령 `help.guide` / `help.shortcuts` / `help.compatibility`가 해당 탭을 연다.

`bun run qa:electron`(빌드된 앱, 숨김 창):

| 케이스 | 확인하는 것 | 증거 |
| --- | --- | --- |
| `help-shortcut-discovery` | 도움말 메뉴에서 열기 → 단축키 탭에서 "반복" 검색 → 링크로 `sound.loop` 실행(실제 반복 상태 변경) → 사용 설명서에서 `file.export.gp` 링크로 실제 내보내기 대화상자 열기 | `qa-evidence/32/happy/electron` |
| `help-offline-limits` | 렌더러를 오프라인으로 전환한 뒤 도움말 세 탭이 모두 내장 내용으로 읽히고, 호환성 탭에 지원·미지원·검증 안 됨·앱 기본값 항목이 있으며 외부 요청이 없다 | `qa-evidence/32/failure/electron` |

## 문서를 바꿀 때

1. 동작이 바뀌면 `content.ts`와 해당 `.md`를 함께 고친다.
2. 명령이나 키를 바꾸면 `docs/shortcuts.md`를 다시 생성한다(명령은 파일 머리에 있다).
3. 새 "지원" 주장은 그 동작을 실행하는 QA 케이스나 테스트가 있을 때만 적는다. 없으면 "검증 안 됨"으로 둔다.
