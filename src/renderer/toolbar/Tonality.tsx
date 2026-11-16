import { useT } from '../i18n/react';
import { CommandSlot } from './CommandButton';

export const tonalityIds = ['track.transpose', 'track.tuning', 'track.capo'] as const;

export function Tonality() {
  const t = useT();
  return <CommandSlot slot={t('toolbar.slot.tonality')} ids={tonalityIds} />;
}
