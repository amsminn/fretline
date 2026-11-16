import type { MessageTable } from '../index';

export const paletteMessages = {
  'palette.section.voices': ['성부', 'Voices'],
  'palette.section.text': ['가사 / 코드 / 섹션', 'Lyrics / Chords / Sections'],
  'palette.section.bar': ['마디', 'Bars'],
  'palette.section.duration': ['음 길이', 'Duration'],
  'palette.section.effects': ['주법 / 효과', 'Techniques / Effects'],
  'palette.section.note': ['음표 표현', 'Note Expression'],
  'palette.section.rhythm': ['복합 리듬', 'Complex Rhythm'],
  'palette.title': ['편집 팔레트', 'Editing Palette'],
} as const satisfies MessageTable;
