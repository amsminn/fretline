import { useMemo, useState } from 'react';
import { t } from '../../i18n';
import { useT } from '../../i18n/react';
import type { Track } from '../../../domain/document';
import type { StructureEdit } from '../../../domain/commands/structure';
import type { ArrangementDialogProps } from '../../commands/structure';
import { ArrangementChoice, ArrangementDialog, ArrangementNumber as NumberField } from '../../dialogs/Section';
import { Input } from '../../ui/Input';

const sounds = [
  [24, 'inspector.instrument.sound.nylon'], [25, 'inspector.instrument.sound.steel'], [27, 'inspector.instrument.sound.clean'],
  [28, 'inspector.instrument.sound.muted'], [29, 'inspector.instrument.sound.overdrive'], [30, 'inspector.instrument.sound.distortion'],
  [33, 'inspector.instrument.sound.fingerBass'], [34, 'inspector.instrument.sound.pickBass'],
] as const;

export function TrackInstrument(props: ArrangementDialogProps) {
  useT();
  const adding = props.draft.kind === 'addTrack';
  const [name, setName] = useState(adding ? t('inspector.instrument.newTrack') : props.draft.track.name);
  const [kind, setKind] = useState<Track['instrument']['kind']>(adding ? 'fretted' : props.draft.track.instrument.kind);
  const [program, setProgram] = useState(adding ? 25 : props.draft.track.instrument.program);
  const [bank, setBank] = useState(adding ? 0 : props.draft.track.instrument.bank);
  const edit = useMemo((): StructureEdit => adding ? { kind: 'addTrack', name, instrument: { kind, program, bank } } :
    { kind: 'instrument', trackId: props.draft.track.id, instrument: { kind, program, bank } }, [adding, name, kind, program, bank, props.draft]);
  return <ArrangementDialog {...props} title={adding ? t('inspector.instrument.addTitle') : t('inspector.instrument.title')} description={t('inspector.instrument.description')} edit={edit}>
    {adding && <label className="flex flex-col gap-1 text-xs">{t('inspector.instrument.trackName')}<Input aria-label={t('inspector.instrument.trackName')} value={name} onChange={e => setName(e.currentTarget.value)} /></label>}
    <ArrangementChoice label={t('inspector.instrument.kind')} value={kind} options={[['fretted', t('inspector.instrument.fretted')], ['pitched', t('inspector.instrument.pitched')], ['percussion', t('inspector.instrument.percussion')]]}
      onChange={v => { if (v === 'fretted' || v === 'pitched' || v === 'percussion') setKind(v); }} />
    {kind === 'fretted' && <ArrangementChoice label={t('inspector.instrument.sound')} value={sounds.some(([value]) => value === program) ? String(program) : 'other'}
      options={[...sounds.map(([value, label]): [string, string] => [String(value), t(label)]), ['other', t('inspector.instrument.sound.other')]]}
      onChange={v => { if (v !== 'other') setProgram(Number(v)); }} />}
    <NumberField label={t('inspector.instrument.program')} value={program} min={0} max={127} onValueChange={setProgram} />
    <NumberField label={t('inspector.instrument.bank')} value={bank} min={0} max={16383} onValueChange={setBank} />
  </ArrangementDialog>;
}
export function TrackTranspose(props: ArrangementDialogProps) {
  useT();
  const [semitones, setSemitones] = useState(0);
  const [policy, setPolicy] = useState<'notes' | 'instrument'>('notes');
  const edit = useMemo((): StructureEdit => ({ kind: 'transpose', trackIds: [props.draft.track.id], semitones, policy }), [props.draft, semitones, policy]);
  return <ArrangementDialog {...props} title={t('inspector.transpose.title')} description={t('inspector.transpose.description')} edit={edit}>
    <NumberField label={t('inspector.transpose.semitones')} value={semitones} min={-48} max={48} onValueChange={setSemitones} />
    <ArrangementChoice label={t('inspector.transpose.policy')} value={policy} options={[['notes', t('inspector.transpose.notes')], ['instrument', t('inspector.transpose.instrument')]]}
      onChange={v => { if (v === 'notes' || v === 'instrument') setPolicy(v); }} />
  </ArrangementDialog>;
}
