import { useMemo, useState } from 'react';
import { useT } from '../i18n/react';
import type { StructureEdit } from '../../domain/commands/structure';
import { matchingPreset, noteName, tuningPresets } from '../../domain/tuning-presets';
import type { ArrangementDialogProps } from '../commands/structure';
import { Input } from '../ui/Input';
import { ArrangementChoice, ArrangementDialog, ArrangementNumber as NumberField } from './Section';

const pitchRange = Array.from({ length: 97 }, (_, index) => index + 12);

export function Tuning(props: ArrangementDialogProps) {
  const t = useT();
  const staff = props.draft.track.staves[0];
  const [pitches, setPitches] = useState(staff?.tuning.join(' ') ?? '');
  const [capo, setCapo] = useState(staff?.capo ?? 0);
  const [policy, setPolicy] = useState<'preservePitch' | 'preserveFingering'>('preservePitch');
  const parsed = useMemo(() => pitches.trim().split(/\s+/).map(Number), [pitches]);
  const valid = pitches.trim() !== '' && parsed.every(pitch => Number.isInteger(pitch) && pitch >= 0 && pitch <= 127);
  const presets = tuningPresets(parsed.length);
  const edit = useMemo((): StructureEdit | null => staff && valid ? ({ kind: 'tuning', staffId: staff.id, tuning: parsed, capo, policy }) : null, [staff, valid, parsed, capo, policy]);
  const noteOptions = (pitch: number): readonly (readonly [string, string])[] =>
    [...(pitchRange.includes(pitch) ? pitchRange : [...pitchRange, pitch])].sort((a, b) => b - a).map(value => [String(value), noteName(value)] as const);
  return <ArrangementDialog {...props} title={t('dialog.tuning.title')} description={t('dialog.tuning.description')} edit={edit}>
    {presets.length ? <ArrangementChoice label={t('dialog.tuning.preset')} value={valid ? matchingPreset(parsed)?.id ?? 'custom' : 'custom'}
      options={[['custom', t('dialog.tuning.custom')], ...presets.map(preset => [preset.id, t(`dialog.tuning.preset.${preset.id}`)] as const)]}
      onChange={id => { const preset = presets.find(candidate => candidate.id === id); if (preset) setPitches(preset.pitches.join(' ')); }} /> : null}
    {valid ? <div className="grid grid-cols-3 gap-2" data-testid="tuning-strings">
      {parsed.map((pitch, index) => <ArrangementChoice key={index} label={t('dialog.tuning.string', { string: index + 1 })} value={String(pitch)}
        options={noteOptions(pitch)} onChange={value => { const next = [...parsed]; next[index] = Number(value); setPitches(next.join(' ')); }} />)}
    </div> : null}
    <label className="flex flex-col gap-1 text-xs">{t('dialog.tuning.midi')}<Input aria-label={t('dialog.tuning.midi')} value={pitches} onChange={e => setPitches(e.currentTarget.value)} /></label>
    <NumberField label={t('dialog.tuning.capo')} value={capo} min={0} max={36} onValueChange={setCapo} />
    <ArrangementChoice label={t('dialog.tuning.policy')} value={policy} options={[['preservePitch', t('dialog.tuning.preservePitch')], ['preserveFingering', t('dialog.tuning.preserveFingering')]]}
      onChange={v => { if (v === 'preservePitch' || v === 'preserveFingering') setPolicy(v); }} />
  </ArrangementDialog>;
}
