import { t } from '../../i18n';
import type { PaletteSection } from '../registry';

export const voicesSection: PaletteSection = {
  id: 'voices', get title() { return t('palette.section.voices'); }, order: 10,
  commandIds: ['note.voice.1', 'note.voice.2', 'note.voice.3', 'note.voice.4', 'note.multivoice'],
};
