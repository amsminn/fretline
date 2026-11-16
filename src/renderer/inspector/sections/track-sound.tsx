import { t } from '../../i18n';
import { useT } from '../../i18n/react';
import { useMixer, useServices } from '../../shell/services';
import { Knob } from '../../ui/Knob';
import { Slider } from '../../ui/Slider';
import { Switch } from '../../ui/Switch';
import type { InspectorSection, InspectorSectionProps } from '../registry';
import { Field } from './Field';

export const panLabel = (value: number): string => (value === 0 ? 'C' : value < 0 ? `L${Math.round(-value * 100)}` : `R${Math.round(value * 100)}`);

function TrackSound({ track }: InspectorSectionProps) {
  const t = useT();
  const { mixer } = useServices();
  useMixer();
  if (!track) return null;
  const mix = mixer.track(track.id);
  return (
    <div className="flex flex-col gap-2">
      <Field label={t('inspector.sound.volume')}>{() => <Slider label={t('inspector.sound.trackVolume', { track: track.name })} value={[Math.round(mix.volume * 100)]} max={100} onValueChange={([value]) => { if (value !== undefined) mixer.setTrack(track.id, { volume: value / 100 }); }} />}</Field>
      <Field label={t('inspector.sound.pan')}>{() => <Knob label={t('inspector.sound.trackPan', { track: track.name })} value={mix.pan} formatValue={panLabel} onValueChange={pan => mixer.setTrack(track.id, { pan })} />}</Field>
      <Field label={t('inspector.sound.mute')}>{id => <Switch id={id} checked={mix.mute} onCheckedChange={mute => mixer.setTrack(track.id, { mute })} />}</Field>
      <Field label={t('inspector.sound.solo')}>{id => <Switch id={id} checked={mix.solo} onCheckedChange={solo => mixer.setTrack(track.id, { solo })} />}</Field>
    </div>
  );
}
export const trackSoundSection: InspectorSection = { id: 'track.sound', tab: 'track', get title() { return t('inspector.track.sound'); }, order: 20, Component: TrackSound };
