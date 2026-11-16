export const semanticTokens = [
  'bg-app', 'bg-toolbar', 'bg-panel', 'bg-panel-raised', 'bg-input', 'bg-hover', 'bg-pressed',
  'paper', 'paper-ink', 'paper-staff',
  'fg-default', 'fg-muted', 'fg-subtle', 'fg-on-accent',
  'border-default', 'border-strong',
  'accent', 'accent-hover', 'accent-active',
  'selection-fill', 'selection-edge', 'playback-cursor', 'loop-range', 'focus-ring',
  'danger', 'warning', 'success', 'lcd-bg', 'lcd-fg',
  'track-1', 'track-2', 'track-3', 'track-4', 'track-5', 'track-6', 'track-7', 'track-8', 'track-9', 'track-10', 'track-11', 'track-12',
  'shadow-popover', 'shadow-dialog',
] as const;
export type SemanticToken = (typeof semanticTokens)[number];

export const typeScale = [
  { utility: 'text-2xs', px: 11, use: '밀집 라벨, LCD 보조' },
  { utility: 'text-xs', px: 12, use: '기본 UI 텍스트' },
  { utility: 'text-sm', px: 13, use: '툴바 텍스트, 메뉴 제목' },
  { utility: 'text-base', px: 14, use: '대화상자 제목' },
  { utility: 'text-lg', px: 16, use: '섹션 제목' },
  { utility: 'text-xl', px: 20, use: '빈 상태 제목' },
] as const;

export const densityTokens = [
  ['--grid', '4px'], ['--control-compact', '22px'], ['--control-default', '26px'], ['--control-toolbar', '32px'],
  ['--icon-sm', '16px'], ['--icon-md', '20px'], ['--area-toolbar', '56px'], ['--area-tabs', '28px'],
  ['--area-palette', '220px'], ['--area-inspector', '260px'], ['--area-global-view', '190px'],
  ['--radius-sm', '2px'], ['--radius-md', '4px'], ['--radius-lg', '6px'], ['--motion-duration', '120ms'],
] as const;

export type Theme = 'dark' | 'light';
export const themes: readonly Theme[] = ['dark', 'light'];
