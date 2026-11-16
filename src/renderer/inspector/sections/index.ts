import type { InspectorSection } from '../registry';
import { songInformationSection } from './song-information';
import { songNotationSection } from './song-notation';
import { trackInformationSection } from './track-information';
import { trackSoundSection } from './track-sound';

export const builtInInspectorSections: readonly InspectorSection[] = [songInformationSection, songNotationSection, trackInformationSection, trackSoundSection];
