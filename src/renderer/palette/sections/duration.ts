import { t } from '../../i18n';
import type { PaletteSection } from '../registry';

export const durationSection: PaletteSection = {
  id: 'duration', get title() { return t('palette.section.duration'); }, order: 40,
  commandIds: ['note.durationShorter', 'note.durationLonger', 'note.dot', 'note.tuplet', 'note.tie', 'note.rest', 'note.grace'],
};
