import { t } from '../../i18n';
import type { PaletteSection } from '../registry';

export const effectsSection: PaletteSection = {
  id: 'effects', get title() { return t('palette.section.effects'); }, order: 50,
  commandIds: ['effects.bend', 'effects.hammerPull', 'effects.legato', 'effects.slide', 'effects.palmMute', 'effects.letRing', 'effects.vibrato',
    'effects.harmonic', 'effects.dead', 'effects.tap', 'effects.slap', 'effects.pop', 'effects.trill', 'effects.tremoloPicking',
    'effects.tremoloBar', 'effects.brushDown', 'effects.brushUp', 'effects.pickDown', 'effects.pickUp', 'effects.rasgueado', 'effects.fadeIn', 'effects.fadeOut'],
};
