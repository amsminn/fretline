import { t } from '../../i18n';
import type { PaletteSection } from '../registry';

export const textSection: PaletteSection = {
  id: 'text', get title() { return t('palette.section.text'); }, order: 20,
  commandIds: ['section.lyrics', 'section.chord', 'section.text', 'section.edit'],
};
