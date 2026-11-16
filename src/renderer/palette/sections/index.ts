import { voicesSection } from './voices';
import { textSection } from './text';
import { barSection } from './bar';
import { durationSection } from './duration';
import { effectsSection } from './effects';
import type { PaletteSection } from '../registry';

export const builtInPaletteSections: readonly PaletteSection[] = [voicesSection, textSection, barSection, durationSection, effectsSection];
