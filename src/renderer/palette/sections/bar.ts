import { t } from '../../i18n';
import type { PaletteSection } from '../registry';

export const barSection: PaletteSection = {
  id: 'bar', get title() { return t('palette.section.bar'); }, order: 30,
  commandIds: ['bar.meter', 'bar.key', 'bar.tempo', 'bar.repeatOpen', 'bar.repeatClose', 'bar.endings', 'bar.directions', 'bar.pickup', 'bar.freeTime'],
};
