# Fretline design foundation

Fretline의 모든 화면은 `src/renderer/styles/tokens.css`의 토큰과 `src/renderer/ui/`의 primitive만 사용한다. 이 문서는 토큰 표와 값의 이유를 담는다. 값을 바꾸려면 `tokens.css`만 수정하고 `bun run lint:tokens && bun run test -- tests/ui/tokens.test.ts`를 통과시킨다.

## 계층

| 계층 | 위치 | 사용 범위 |
| --- | --- | --- |
| Primitive ramp | `tokens.css` `:root` 상단 (`--neutral-*`, `--blue-*`, `--red-*`, `--amber-*`, `--green-*`, `--track-bright-*`, `--track-deep-*`) | 화면 코드에서 직접 사용 금지 |
| Semantic token | `tokens.css` `:root`(dark 기본) 와 `:root[data-theme="light"]` | primitive와 화면이 참조하는 유일한 이름 |
| Component token | 없음 | 필요할 때만 추가 (현재 cva variant가 semantic utility를 조합) |
| Tailwind utility | `@theme inline` 매핑 | `bg-panel`, `text-muted`, `border-border-strong`, `h-control-default` 등 |

Tailwind 기본 팔레트·타입 스케일·radius·shadow는 `--color-*: initial` 등으로 제거했다. 따라서 `bg-slate-900` 같은 클래스는 CSS를 만들지 않으며 `lint:tokens`도 거부한다.

## Semantic color tokens

| Token | Dark | Light | 용도와 이유 |
| --- | --- | --- | --- |
| `bg-app` | neutral-950 `#17181b` | neutral-150 `#ececef` | 창 바탕. 어두운 중립 chrome; 가장 뒤 |
| `bg-toolbar` | neutral-850 | neutral-100 | 상단 툴바(56px). 바탕보다 한 단계 밝아 영역 경계가 테두리 없이 읽힘 |
| `bg-panel` | neutral-900 | neutral-50 | 팔레트/검사기/Global View 패널 |
| `bg-panel-raised` | neutral-800 | neutral-0 | 팝오버·메뉴·툴팁·카드 표면 |
| `bg-input` | neutral-975 | neutral-0 | 입력 필드 안쪽. dark에서는 패널보다 어둡게 파여 보임 |
| `bg-hover` / `bg-pressed` | neutral-750 / 700 | neutral-200 / 250 | 모든 primitive의 hover/pressed 상태 |
| `paper` / `paper-ink` / `paper-staff` | `#ffffff` / `#111111` / `#4b4b4b` | 동일 | 악보 종이는 두 테마 모두 흰 종이·검은 잉크(인쇄 결과와 동일). 토큰으로 분리해 종이 테마는 나중에 바꿀 수 있음 |
| `fg-default` / `fg-muted` / `fg-subtle` | neutral-150 / 300 / 400 | neutral-950 / 600 / 550 | 본문·보조·힌트 텍스트. 모든 chrome 표면에서 4.5:1 이상(subtle은 정지 표면 기준) |
| `fg-on-accent` | neutral-0 | neutral-0 | accent 위 텍스트. accent 값이 4.5:1을 만족하도록 선택 |
| `border-default` / `border-strong` | neutral-500 / 450 | neutral-450 / 550 | 테두리 3:1 규칙 때문에 일반 UI보다 밝음. 입력·패널·바탕 위에서 3:1 |
| `accent` / `accent-hover` / `accent-active` | blue-500 `#2a6fdc` / 600 / 700 | 동일 | GP의 파란 선택·활성 색. hover가 어두워지는 이유: 흰 텍스트 4.5:1 유지 |
| `selection-fill` | blue-500 25% | 동일 | 드래그 선택 채움(반투명). 종이 위 잉크 4.5:1 유지 |
| `selection-edge` | blue-500 | 동일 | 선택 경계·resize 핸들. 종이 대비 3:1 |
| `playback-cursor` | red-500 | red-600 | 재생 커서. 파란 선택과 구별되는 유일한 빨강 |
| `loop-range` | blue-500 15% | 동일 | 반복 구간 배경 |
| `focus-ring` | blue-400 | blue-500 | 2px outline, 항상 표시. 종이·패널 모두 3:1 |
| `danger` / `warning` / `success` | red-400 / amber-400 / green-400 | red-600 / amber-700 / green-700 | 상태 텍스트, 패널 위 4.5:1 |
| `lcd-bg` / `lcd-fg` | green-950 / green-300 | 동일 | 툴바 LCD(템포·위치). 테마와 무관한 장비 느낌 |
| `track-1`…`track-12` | bright set | deep set | 트랙 색. dark에선 밝은 12색, light에선 깊은 12색으로 바꿔 패널 위 3:1 유지 |
| `shadow-popover` / `shadow-dialog` | 검정 45%/60% + 1px 테두리 | 18%/28% | 그림자는 팝오버·대화상자에만 |

## 글꼴

| Token | 값 | 이유 |
| --- | --- | --- |
| `--font-ui` | Inter Variable, Noto Sans KR Variable, system-ui | 라틴은 Inter, 한글은 Noto Sans KR로 폴백. 둘 다 OFL, `@fontsource-variable`에서 로컬 번들 |
| `--font-mono` | JetBrains Mono Variable | 숫자·LCD·단축키. `tnum` 활성 |
| `--text-2xs…xl` | 11/12/13/14/16/20px (line-height 14/16/18/20/22/26) | 기본 UI 12px, 촘촘한 데스크톱 밀도 |

JetBrains Mono는 latin·latin-ext 서브셋만 `@font-face`로 선언한다. 패키지 `index.css`의 cyrillic-ext 서브셋(2 KB)은 Vite가 `data:` URL로 인라인하여 main 프로세스 CSP(`font-src 'self'`)에 막히기 때문이다. `tests/ui/tokens.test.ts`가 모든 폰트 파일이 4096바이트 인라인 한계보다 큰지 검사한다.

## 밀도·radius·motion

| Token | 값 | 이유 |
| --- | --- | --- |
| `--grid` | 4px | 모든 간격은 4의 배수 (Tailwind spacing 기본 단위) |
| `--control-compact` / `default` / `toolbar` | 22 / 26 / 32px | 검사기 필드 / 일반 / 툴바 버튼 |
| `--icon-sm` / `--icon-md` | 16 / 20px | 버튼 안 / 툴바 |
| `--area-toolbar` / `tabs` / `palette` / `inspector` / `global-view` | 56 / 28 / 220 / 260 / 190px | 1440x900 기준 6영역 초기 크기(resizable) |
| `--radius-sm` / `md` / `lg` | 2 / 4 / 6px | 체크박스 / 컨트롤 / 팝오버·대화상자 |
| `--motion-duration` / `--motion-ease` | 120ms / ease-out | 색·opacity 전환. `prefers-reduced-motion`에서 0으로 |
| `--focus-ring-width` / `offset` | 2 / 1px | 항상 보이는 키보드 포커스 |
| `--disabled-opacity` | 0.45 | 모든 primitive의 disabled |

## 상태 규칙

모든 primitive는 default / hover / pressed(active) / focus-visible / disabled를 정의한다(`src/renderer/ui/control.ts`의 `controlBase`). Toggle·Tab·Checkbox·Switch는 추가로 selected(`data-state=on|checked|active`)를 accent로 표시한다. Specimen(`#/specimen`)에서는 `.spec-hover`, `.spec-active`, `.spec-focus-visible` 래퍼가 `@custom-variant`로 강제한다.

## Primitive

`radix-ui` 1.8.1 + `class-variance-authority` + `tailwind-merge`(`src/renderer/lib/cn.ts`). radix 직접 import는 `src/renderer/ui/` 안에서만 허용된다.

Button, IconButton(툴팁+단축키), ToggleButton/ToggleGroup, Input, NumberField(화살표·Shift×10·Home/End·clamp), Select, Slider, Knob(pan; role=slider, 세로 드래그, 더블클릭 중앙), Checkbox, Switch, Tabs, Tooltip(`shortcut`), Popover, DropdownMenu, ContextMenu, Dialog, Separator, ScrollArea, Toast.

ScrollArea는 radix 대신 네이티브 overflow와 `theme.css`의 테마 스크롤바를 쓴다. radix ScrollArea는 인라인 `<style>`을 주입하는데 main 프로세스 CSP `style-src 'self'`가 이를 막기 때문이다.

## Specimen과 검사

- `#/specimen`: `import.meta.env.DEV` 또는 `VITE_FRETLINE_QA=1`로 빌드한 경우에만 라우팅된다 (`VITE_FRETLINE_QA=1 bun run build`). 모든 토큰 swatch, 타입 스케일, 밀도, 각 primitive의 다섯 상태를 두 테마로 보여준다.
- `bun run lint:tokens [-- --root <dir>]`: `src/` 안에서 `tokens.css` 밖 raw 색(hex/rgb/hsl/oklch), 임의 Tailwind 색(`bg-[#…]`), Tailwind 팔레트 클래스, `src/renderer/ui/` 밖 radix import를 `file:line`으로 보고한다.
- `bun run test -- tests/ui/tokens.test.ts tests/ui/primitives.test.tsx`: 두 테마의 전 토큰 정의, WCAG 대비 계산(텍스트 4.5:1, 아이콘·테두리·선택 경계 3:1), 로컬 폰트 파일 존재, primitive 키보드·focus·disabled 동작.
- `bun run qa:electron -- --case design-specimen`: 실제 Electron에서 dark/light × 1x/2x 캡처(Checkpoint A).
