import { t } from '../../i18n';
import type { PaletteSection } from '../registry';

export const noteSection: PaletteSection = {
  id: 'note-expression', get title() { return t('palette.section.note'); }, order: 45,
  commandIds: ['effects.accent', 'effects.staccato', 'effects.ghost', 'effects.fingering', 'effects.audioSettings', 'effects.sustainPedal'],
};
