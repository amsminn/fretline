import type { MessageTable } from '../index';

export const prefsMessages = {
  'prefs.title': ['설정', 'Preferences'],
  'prefs.description': ['테마, 언어, 창과 패널 설정은 다시 시작해도 유지됩니다. 선택·반복 구간·믹서는 문서별 세션 상태라 저장되지 않습니다.',
    'Theme, language, window and panel settings persist across restarts. Selection, loop range and mixer are per-document session state and are not saved.'],
  'prefs.general': ['일반', 'General'],
  'prefs.window': ['창 / 패널', 'Window / Panels'],
  'prefs.theme': ['테마', 'Theme'],
  'prefs.theme.dark': ['어두움', 'Dark'],
  'prefs.theme.light': ['밝음', 'Light'],
  'prefs.language': ['언어', 'Language'],
  'prefs.language.ko': ['한국어', 'Korean'],
  'prefs.language.en': ['English', 'English'],
  'prefs.restoreWindow': ['마지막 창 크기와 위치 복원', 'Restore last window size and position'],
  'prefs.panels': ['시작 시 보이는 패널', 'Panels shown at startup'],
  'prefs.panel.palette': ['편집 팔레트 (F2)', 'Editing palette (F2)'],
  'prefs.panel.inspector': ['검사기 (F5 / F6)', 'Inspector (F5 / F6)'],
  'prefs.panel.globalView': ['Global View (F8)', 'Global View (F8)'],
  'prefs.saved': ['변경 즉시 저장됩니다.', 'Changes are saved immediately.'],
} as const satisfies MessageTable;
