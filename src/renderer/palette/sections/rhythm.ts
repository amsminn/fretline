import { t } from '../../i18n';
import type { PaletteSection } from '../registry';

export const rhythmSection: PaletteSection = {
  id: 'rhythm', get title() { return t('palette.section.rhythm'); }, order: 45,
  commandIds: ['note.graceOnBeat', 'note.tieBeat', 'note.moveVoice', 'bar.rebar'],
};
